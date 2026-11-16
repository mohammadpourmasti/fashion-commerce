import { describe, expect, it } from "vitest";

import { isRetryableTransactionError, isUniqueViolation, pgErrorCode, pgErrorConstraint } from "./errors";

const pg = (code: string, constraint?: string) => Object.assign(new Error("db"), { code, constraint });
/** The shape Drizzle throws: its own error, with the driver's error as `cause`. */
const drizzleWrapped = (cause: Error) => Object.assign(new Error("Failed query: select 1"), { query: "select 1", params: [], cause });

describe("PostgreSQL error helpers", () => {
  it("read the code and constraint of a driver error", () => {
    expect(pgErrorCode(pg("23505", "users_email_normalized_unique"))).toBe("23505");
    expect(pgErrorConstraint(pg("23505", "users_email_normalized_unique"))).toBe("users_email_normalized_unique");
  });

  it("see through Drizzle's query wrapper", () => {
    const wrapped = drizzleWrapped(pg("23505", "brands_key_unique"));
    expect(pgErrorCode(wrapped)).toBe("23505");
    expect(pgErrorConstraint(wrapped)).toBe("brands_key_unique");
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("detect retryable transaction errors even when wrapped", () => {
    expect(isRetryableTransactionError(drizzleWrapped(pg("40001")))).toBe(true);
    expect(isRetryableTransactionError(drizzleWrapped(pg("40P01")))).toBe(true);
    expect(isRetryableTransactionError(drizzleWrapped(pg("23505")))).toBe(false);
  });

  it("return undefined for non-database errors and stop on cyclic causes", () => {
    expect(pgErrorCode(new Error("boom"))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(pgErrorCode(cyclic)).toBeUndefined();
    expect(pgErrorConstraint(pg("23505"))).toBeUndefined();
  });
});
