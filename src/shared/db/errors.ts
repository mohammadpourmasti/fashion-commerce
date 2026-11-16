/** Errors and PostgreSQL error-code helpers shared by the data layer. */

export class DatabaseNotConfiguredError extends Error {
  constructor(variable = "DATABASE_URL") {
    super(`${variable} is not set. Start the dev database with \`docker compose up -d\` and copy .env.example to .env.local.`);
    this.name = "DatabaseNotConfiguredError";
  }
}

/** SQLSTATE codes this codebase reacts to. */
export const PG_ERROR = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  serializationFailure: "40001",
  deadlockDetected: "40P01",
  /** Raised by the `fc_assert_*` guards when a down migration would lose data. */
  downMigrationRefused: "FCD01",
} as const;

/**
 * The PostgreSQL error behind `error`. Drizzle wraps driver errors in a DrizzleQueryError
 * ("Failed query: ...") whose `cause` is the original error, so the cause chain is followed
 * (a few levels at most).
 */
function findPgError(error: unknown): { code: string; constraint?: unknown } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return current as { code: string; constraint?: unknown };
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function pgErrorCode(error: unknown): string | undefined {
  return findPgError(error)?.code;
}

/** Name of the violated constraint, when PostgreSQL reported one. */
export function pgErrorConstraint(error: unknown): string | undefined {
  const constraint = findPgError(error)?.constraint;
  return typeof constraint === "string" ? constraint : undefined;
}

export const isUniqueViolation = (error: unknown) => pgErrorCode(error) === PG_ERROR.uniqueViolation;
export const isCheckViolation = (error: unknown) => pgErrorCode(error) === PG_ERROR.checkViolation;

/** Errors a whole transaction may safely be re-run after. */
export function isRetryableTransactionError(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code === PG_ERROR.serializationFailure || code === PG_ERROR.deadlockDetected;
}
