import { scanSql, type ScannedStatement } from "./sql-scan";

/**
 * Static checks for migration files. They catch the common ways a migration
 * can lose data or break the runner before anything touches a database. The
 * database-side guards (`fc_assert_*`) remain the runtime protection.
 */

export interface PolicyViolation {
  statement: string;
  message: string;
}

const MARKER = /fc:allow-destructive:\s*\S+/;
const TRANSACTION_CONTROL = new Set([
  "begin", "commit", "rollback", "start", "end", "savepoint", "release", "abort",
]);

const firstWord = (s: ScannedStatement) => s.normalized.split(" ", 1)[0] ?? "";
const preview = (s: ScannedStatement) => s.text.replace(/\s+/g, " ").slice(0, 80);

/** "public.Foo" / '"Foo"' -> "foo": how guards and drops are matched. */
export function normalizeTableName(name: string): string {
  return name.trim().replace(/"/g, "").replace(/^public\./i, "").toLowerCase();
}

function dropTableNames(normalized: string): string[] | null {
  const match = /^drop table (?:if exists )?(.+?)(?: cascade| restrict)?$/.exec(normalized);
  if (!match) return null;
  return (match[1] as string).split(",").map(normalizeTableName);
}

function dropColumns(normalized: string): { table: string; columns: string[] } | null {
  const table = /^alter table (?:if exists )?(?:only )?(\S+) /.exec(normalized);
  if (!table) return null;
  const columns = [...normalized.matchAll(/\bdrop column (?:if exists )?(\S+?)(?:,| cascade| restrict|$)/g)].map(
    (m) => normalizeTableName(m[1] as string),
  );
  return columns.length > 0 ? { table: normalizeTableName(table[1] as string), columns } : null;
}

export function lintUpSql(source: string): PolicyViolation[] {
  const { statements, comments } = scanSql(source);
  const violations: PolicyViolation[] = [];
  const allowed = comments.some((c) => MARKER.test(c));

  if (statements.length === 0) {
    violations.push({ statement: "", message: "migration.sql contains no statements" });
  }
  for (const s of statements) {
    const word = firstWord(s);
    if (TRANSACTION_CONTROL.has(word)) {
      violations.push({ statement: preview(s), message: "the runner owns the transaction; remove transaction control" });
    }
    if (/\bconcurrently\b/.test(s.normalized)) {
      violations.push({ statement: preview(s), message: "CONCURRENTLY cannot run inside the runner's transaction" });
    }
    const destructive =
      /^drop (table|schema|database)\b/.test(s.normalized) ||
      word === "truncate" ||
      /^delete from\b/.test(s.normalized) ||
      /^alter table .*\bdrop column\b/.test(s.normalized) ||
      /^alter table .*\balter column .*\btype\b/.test(s.normalized);
    if (destructive && !allowed) {
      violations.push({
        statement: preview(s),
        message:
          "destructive change: use expand/contract, or add `-- fc:allow-destructive: <reason>` after review",
      });
    }
  }
  return violations;
}

const ALLOWED_DOWN_FIRST_WORDS = new Set([
  "select", "drop", "alter", "create", "grant", "revoke", "comment", "set", "reset",
]);
const FORBIDDEN_DROP = /^drop (schema|database|owned|role|user|group|tablespace)\b/;

export function lintDownSql(source: string): PolicyViolation[] {
  const { statements } = scanSql(source);
  const violations: PolicyViolation[] = [];
  const emptyTables = new Set<string>();
  const emptyColumns = new Set<string>();

  if (statements.length === 0) {
    violations.push({ statement: "", message: "down.sql contains no statements" });
  }

  for (const s of statements) {
    const word = firstWord(s);
    const bad = (message: string) => violations.push({ statement: preview(s), message });

    if (s.hasDollarQuote) {
      bad("dollar-quoted bodies (DO blocks, function bodies) hide statements from review; not allowed in down.sql");
      continue;
    }
    if (TRANSACTION_CONTROL.has(word)) {
      bad("the runner owns the transaction; remove transaction control");
      continue;
    }
    if (!ALLOWED_DOWN_FIRST_WORDS.has(word)) {
      bad(`\`${word}\` is not allowed in down.sql (it can change or remove data)`);
      continue;
    }
    if (word === "select") {
      const table = /^select fc_assert_table_empty\(\s*''\s*\)$/.exec(s.normalized);
      const column = /^select fc_assert_column_empty\(\s*''\s*,\s*''\s*\)$/.exec(s.normalized);
      if (table && s.strings.length === 1) {
        emptyTables.add(normalizeTableName(s.strings[0] as string));
      } else if (column && s.strings.length === 2) {
        emptyColumns.add(`${normalizeTableName(s.strings[0] as string)}.${normalizeTableName(s.strings[1] as string)}`);
      } else {
        bad("only fc_assert_table_empty / fc_assert_column_empty guard calls may be SELECTed");
      }
      continue;
    }
    if (FORBIDDEN_DROP.test(s.normalized)) {
      bad("dropping schemas, databases, roles or owned objects is never allowed in down.sql");
      continue;
    }
    const tables = dropTableNames(s.normalized);
    if (tables) {
      for (const t of tables) {
        if (!emptyTables.has(t)) {
          bad(`DROP TABLE ${t} needs a preceding SELECT fc_assert_table_empty('${t}')`);
        }
      }
      continue;
    }
    const cols = dropColumns(s.normalized);
    if (cols) {
      for (const c of cols.columns) {
        if (!emptyColumns.has(`${cols.table}.${c}`)) {
          bad(`DROP COLUMN ${cols.table}.${c} needs a preceding SELECT fc_assert_column_empty('${cols.table}', '${c}')`);
        }
      }
    }
    if (/^alter table .*\balter column .*\btype\b/.test(s.normalized)) {
      bad("changing a column type can lose data; not allowed in down.sql");
    }
  }
  return violations;
}
