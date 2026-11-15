/**
 * A small SQL scanner: just enough to split a migration file into statements
 * and to read each statement's keywords without being fooled by comments,
 * string literals or dollar-quoted bodies. It is used for static policy
 * checks only; it is not a SQL parser and never a security boundary (the
 * runtime guards in the database are).
 */

export interface ScannedStatement {
  /** Statement with comments removed and string literal contents blanked to ''. */
  text: string;
  /** Lowercased text with identifier quotes removed, whitespace collapsed. */
  normalized: string;
  /** Contents of the string literals, in order of appearance. */
  strings: string[];
  hasDollarQuote: boolean;
}

export interface ScanResult {
  statements: ScannedStatement[];
  /** Text of every comment, so policy markers such as `fc:allow-destructive` can be read. */
  comments: string[];
}

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_\u0080-￿]/;

export function scanSql(source: string): ScanResult {
  const statements: ScannedStatement[] = [];
  const comments: string[] = [];

  let text = "";
  let strings: string[] = [];
  let hasDollarQuote = false;

  const flush = () => {
    const trimmed = text.trim();
    if (trimmed !== "") {
      statements.push({
        text: trimmed,
        normalized: trimmed.replace(/"/g, "").replace(/\s+/g, " ").toLowerCase(),
        strings,
        hasDollarQuote,
      });
    }
    text = "";
    strings = [];
    hasDollarQuote = false;
  };

  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i] as string;
    const next = source[i + 1];

    if (c === "-" && next === "-") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      comments.push(source.slice(i + 2, stop));
      text += " ";
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (source[j] === "/" && source[j + 1] === "*") {
          depth += 1;
          j += 2;
        } else if (source[j] === "*" && source[j + 1] === "/") {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      comments.push(source.slice(i + 2, Math.max(i + 2, j - 2)));
      text += " ";
      i = j;
      continue;
    }
    if (c === "'") {
      const escapeString = /[eE]$/.test(text) && !IDENT_PART.test(text.slice(-2, -1) || " ");
      let j = i + 1;
      let literal = "";
      while (j < n) {
        const ch = source[j] as string;
        if (escapeString && ch === "\\") {
          literal += source[j + 1] ?? "";
          j += 2;
        } else if (ch === "'" && source[j + 1] === "'") {
          literal += "'";
          j += 2;
        } else if (ch === "'") {
          break;
        } else {
          literal += ch;
          j += 1;
        }
      }
      strings.push(literal);
      text += "''";
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let ident = "";
      while (j < n) {
        if (source[j] === '"' && source[j + 1] === '"') {
          ident += '"';
          j += 2;
        } else if (source[j] === '"') {
          break;
        } else {
          ident += source[j];
          j += 1;
        }
      }
      text += `"${ident}"`;
      i = j + 1;
      continue;
    }
    if (c === "$") {
      // $tag$ ... $tag$ (a tag cannot start with a digit; $1 is a parameter).
      let j = i + 1;
      if (j < n && IDENT_START.test(source[j] as string)) {
        while (j < n && IDENT_PART.test(source[j] as string)) j += 1;
      }
      if (source[j] === "$" && (j === i + 1 || IDENT_START.test(source[i + 1] as string))) {
        const tag = source.slice(i, j + 1);
        const close = source.indexOf(tag, j + 1);
        hasDollarQuote = true;
        text += "''";
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }
    if (c === ";") {
      flush();
      i += 1;
      continue;
    }
    text += c;
    i += 1;
  }
  flush();
  return { statements, comments };
}
