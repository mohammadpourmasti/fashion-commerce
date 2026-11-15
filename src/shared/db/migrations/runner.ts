import type { Pool, PoolClient } from "pg";

import { PG_ERROR, pgErrorCode } from "../errors";

import {
  MigrationDriftError,
  MigrationError,
  MigrationPolicyError,
  ProductionDownBlockedError,
} from "./errors";
import { loadMigrations, type Migration } from "./load";
import { lintDownSql, lintUpSql, type PolicyViolation } from "./policy";

/**
 * Forward/backward migration runner with checksums and a data-safe `down`.
 *
 * - Each migration runs in its own transaction, serialized by an advisory
 *   lock, so concurrent runners (two deploy pods) apply it exactly once.
 * - An applied migration whose file changed, vanished or is out of order stops
 *   the run (drift). Checksums ignore CRLF/LF differences.
 * - `down` is refused in production unless explicitly allowed, its file must
 *   pass the static policy, and the SQL itself guards against dropping data.
 */

const ADVISORY_LOCK_KEY = 727_450_001;
const APP_ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export interface RunnerOptions {
  /** Directory holding `NNNN_name/{migration,down}.sql`. */
  directory: string;
  /**
   * Least-privilege role the application connects as. Migrations grant it
   * access with `fc_app_grant(...)`; unset means no grants are made.
   */
  appRole?: string;
}

export interface UpOptions extends RunnerOptions {
  /** Stop after this migration number. */
  to?: number;
}

export interface DownOptions extends RunnerOptions {
  /** How many of the most recent migrations to revert. Default 1. */
  steps?: number;
  /** True when running against a production database. */
  production: boolean;
  /** Explicit opt-in, required when `production` is true. */
  allowProduction?: boolean;
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
}

interface AppliedRow {
  id: string;
  checksum: string;
}

function assertAppRole(appRole: string | undefined): void {
  if (appRole !== undefined && !APP_ROLE_PATTERN.test(appRole)) {
    throw new MigrationError(`Invalid application role name "${appRole}".`);
  }
}

function formatViolations(id: string, file: string, violations: PolicyViolation[]): string {
  return [
    `${id}/${file} breaks the migration policy:`,
    ...violations.map((v) => `  - ${v.message}${v.statement ? `  [${v.statement}]` : ""}`),
  ].join("\n");
}

export function checkMigrationPolicy(migrations: readonly Migration[]): string[] {
  const problems: string[] = [];
  for (const m of migrations) {
    const up = lintUpSql(m.upSql);
    if (up.length > 0) problems.push(formatViolations(m.id, "migration.sql", up));
    const down = lintDownSql(m.downSql);
    if (down.length > 0) problems.push(formatViolations(m.id, "down.sql", down));
  }
  return problems;
}

async function beginLocked(client: PoolClient, appRole: string | undefined): Promise<void> {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);
  await client.query("SET LOCAL lock_timeout = '30s'");
  await client.query("SELECT set_config('app.role', $1, true)", [appRole ?? ""]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

async function readApplied(client: PoolClient): Promise<AppliedRow[]> {
  const { rows } = await client.query<AppliedRow>(
    "SELECT id, checksum FROM schema_migrations ORDER BY id",
  );
  return rows;
}

function verifyNoDrift(applied: readonly AppliedRow[], migrations: readonly Migration[]): void {
  const byId = new Map(migrations.map((m) => [m.id, m]));
  applied.forEach((row, index) => {
    const file = byId.get(row.id);
    if (!file) {
      throw new MigrationDriftError(`Applied migration ${row.id} is missing from the migrations directory.`);
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationDriftError(
        `Applied migration ${row.id} was modified after it ran (checksum mismatch). ` +
          "Never edit an applied migration; add a new one.",
      );
    }
    if (migrations[index]?.id !== row.id) {
      throw new MigrationDriftError(
        `Migration ${migrations[index]?.id ?? "?"} is unapplied but ${row.id} was applied after it (out of order).`,
      );
    }
  });
}

async function rollbackQuietly(client: PoolClient): Promise<Error | undefined> {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error("rollback failed");
  }
}

async function ensureRoleExists(pool: Pool, appRole: string | undefined): Promise<void> {
  if (appRole === undefined) return;
  const { rowCount } = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [appRole]);
  if (rowCount === 0) {
    throw new MigrationError(`Application role "${appRole}" does not exist; create it before migrating.`);
  }
}

export async function migrateUp(pool: Pool, options: UpOptions): Promise<{ applied: string[] }> {
  assertAppRole(options.appRole);
  const migrations = loadMigrations(options.directory);
  const problems = checkMigrationPolicy(migrations);
  if (problems.length > 0) throw new MigrationPolicyError(problems.join("\n"));
  await ensureRoleExists(pool, options.appRole);

  const appliedNow: string[] = [];
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    for (;;) {
      await beginLocked(client, options.appRole);
      try {
        const applied = await readApplied(client);
        verifyNoDrift(applied, migrations);
        const next = migrations[applied.length];
        if (!next || (options.to !== undefined && next.number > options.to)) {
          await client.query("COMMIT");
          return { applied: appliedNow };
        }
        await client.query(next.upSql);
        await client.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", [
          next.id,
          next.checksum,
        ]);
        await client.query("COMMIT");
        appliedNow.push(next.id);
      } catch (error) {
        releaseError = await rollbackQuietly(client);
        throw error;
      }
    }
  } finally {
    client.release(releaseError);
  }
}

export async function migrateDown(pool: Pool, options: DownOptions): Promise<{ reverted: string[] }> {
  assertAppRole(options.appRole);
  if (options.production && options.allowProduction !== true) {
    throw new ProductionDownBlockedError(
      "Refusing to run a down migration in production. Roll forward with a corrective migration, " +
        "or restore from backup. (Explicit override: allowProduction.)",
    );
  }
  const steps = options.steps ?? 1;
  if (!Number.isInteger(steps) || steps < 1) throw new MigrationError("steps must be a positive integer.");
  const migrations = loadMigrations(options.directory);

  const reverted: string[] = [];
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    for (let step = 0; step < steps; step += 1) {
      await beginLocked(client, options.appRole);
      try {
        const applied = await readApplied(client);
        verifyNoDrift(applied, migrations);
        const last = applied[applied.length - 1];
        if (!last) {
          await client.query("COMMIT");
          return { reverted };
        }
        const migration = migrations.find((m) => m.id === last.id) as Migration;
        const violations = lintDownSql(migration.downSql);
        if (violations.length > 0) {
          throw new MigrationPolicyError(formatViolations(migration.id, "down.sql", violations));
        }
        try {
          await client.query(migration.downSql);
        } catch (error) {
          if (pgErrorCode(error) === PG_ERROR.downMigrationRefused) {
            throw new MigrationError(
              `Down migration ${migration.id} refused: ${(error as Error).message}. No data was changed.`,
            );
          }
          throw error;
        }
        await client.query("DELETE FROM schema_migrations WHERE id = $1", [migration.id]);
        await client.query("COMMIT");
        reverted.push(migration.id);
      } catch (error) {
        releaseError = await rollbackQuietly(client);
        throw error;
      }
    }
    return { reverted };
  } finally {
    client.release(releaseError);
  }
}

export async function migrationStatus(pool: Pool, options: RunnerOptions): Promise<MigrationStatus> {
  const migrations = loadMigrations(options.directory);
  const exists = await pool.query("SELECT to_regclass('public.schema_migrations') AS t");
  if (exists.rows[0]?.t == null) {
    return { applied: [], pending: migrations.map((m) => m.id) };
  }
  const { rows } = await pool.query<AppliedRow>("SELECT id, checksum FROM schema_migrations ORDER BY id");
  verifyNoDrift(rows, migrations);
  return {
    applied: rows.map((r) => r.id),
    pending: migrations.slice(rows.length).map((m) => m.id),
  };
}
