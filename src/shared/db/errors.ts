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

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export const isUniqueViolation = (error: unknown) => pgErrorCode(error) === PG_ERROR.uniqueViolation;
export const isCheckViolation = (error: unknown) => pgErrorCode(error) === PG_ERROR.checkViolation;

/** Errors a whole transaction may safely be re-run after. */
export function isRetryableTransactionError(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code === PG_ERROR.serializationFailure || code === PG_ERROR.deadlockDetected;
}
