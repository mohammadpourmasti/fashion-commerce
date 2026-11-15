import { randomBytes } from "node:crypto";

import { Client, type Pool } from "pg";

import { createPool } from "../client";

/**
 * A throwaway database (and an optional least-privilege role) for integration
 * tests. Created from TEST_DATABASE_URL's server; removed on cleanup. The
 * server's other databases, including development data, are never touched.
 *
 * Lifecycle guarantees:
 *  - If setup fails part-way, only objects whose creation actually succeeded in this very
 *    call are removed (a failed creation never leads to a removal, so a pre-existing
 *    object can not be removed by accident). The ORIGINAL setup error is what the caller
 *    sees; a cleanup problem is only logged.
 *  - cleanup() attempts every step (close the pool, remove the database, remove
 *    the role) even when an earlier step fails, never hangs on a connection that
 *    is still checked out, and reports all failures together afterwards.
 *  - cleanup() is idempotent: a second call is a no-op.
 */
export interface TestDatabase {
  name: string;
  /** Pool connected as the administrative (owner) role. */
  pool: Pool;
  /** Role without login or ownership; `SET ROLE` to it to act as the application. */
  appRole: string;
  /** Connection string of the throwaway database. */
  url: string;
  cleanup(): Promise<void>;
}

/** Upper bound for waiting on pool.end(); the forced database removal below closes stuck sessions. */
const POOL_END_TIMEOUT_MS = 5_000;

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Resolves when `promise` settles or after `ms`, whichever is first. The timer never keeps the process alive. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** What this call actually created. A flag is set only after the corresponding statement succeeded. */
interface Created {
  role: boolean;
  database: boolean;
}

/**
 * The only place that removes a throwaway database and role, and only the ones flagged in
 * `created`. Each requested statement is attempted even if the other fails; failures are returned
 * (not thrown) so callers can combine them with other errors. The database goes first and
 * WITH (FORCE) so sessions that are still open cannot block it.
 */
async function removeThrowaway(
  adminUrl: string,
  name: string,
  appRole: string,
  created: Created,
): Promise<Error[]> {
  const errors: Error[] = [];
  const statements: string[] = [];
  if (created.database) statements.push(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  if (created.role) statements.push(`DROP ROLE IF EXISTS ${appRole}`);
  if (statements.length === 0) return errors;
  const cleaner = new Client({ connectionString: adminUrl });
  try {
    await cleaner.connect();
  } catch (error) {
    errors.push(toError(error));
    return errors;
  }
  try {
    for (const statement of statements) {
      try {
        await cleaner.query(statement);
      } catch (error) {
        errors.push(toError(error));
      }
    }
  } finally {
    await cleaner.end().catch(() => undefined);
  }
  return errors;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) throw new Error("TEST_DATABASE_URL is not set.");
  const suffix = randomBytes(6).toString("hex");
  const name = `fc_test_${suffix}`;
  const appRole = `fc_app_${suffix}`;

  // Each flag is set only AFTER its CREATE statement returned successfully.
  const created: Created = { role: false, database: false };
  let pool: Pool | undefined;
  try {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE ${appRole} NOLOGIN`);
      created.role = true;
      await admin.query(`CREATE DATABASE ${name}`);
      created.database = true;
    } finally {
      await admin.end().catch(() => undefined);
    }

    const url = withDatabase(adminUrl, name);
    const createdPool = createPool(url, { max: 8 });
    pool = createdPool;

    let cleaned = false;
    let inFlight: Promise<void> | undefined;

    const run = async (): Promise<void> => {
      const errors: Error[] = [];
      // 1. Close the pool, but do not wait forever on a client a failed test never released.
      const ended = createdPool.end().then(
        () => undefined,
        (error: unknown) => {
          errors.push(toError(error));
        },
      );
      await within(ended, POOL_END_TIMEOUT_MS);
      // 2. Remove database and role. FORCE terminates any session still open.
      errors.push(...(await removeThrowaway(adminUrl, name, appRole, created)));
      // 3. With sessions gone, a pool.end() that was still waiting can finish.
      await within(ended, POOL_END_TIMEOUT_MS);
      if (errors.length === 1 && errors[0]) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, `Cleanup of ${name} had ${errors.length} failures`);
    };

    return {
      name,
      pool: createdPool,
      appRole,
      url,
      cleanup() {
        if (cleaned) return Promise.resolve();
        inFlight ??= run().finally(() => {
          cleaned = true;
          inFlight = undefined;
        });
        return inFlight;
      },
    };
  } catch (error) {
    // Setup failed part-way: undo what exists. The caller still gets the original error.
    if (pool) await within(pool.end().catch(() => undefined), POOL_END_TIMEOUT_MS);
    for (const problem of await removeThrowaway(adminUrl, name, appRole, created)) {
      // Message only: never a connection string.
      console.error(`[test-db] could not undo failed setup of ${name}: ${problem.message}`);
    }
    throw error;
  }
}
