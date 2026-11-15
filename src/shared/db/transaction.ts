import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";

import { createEventWriter, type EventWriter } from "@/shared/events/outbox";

import type { Database } from "./client";
import { isRetryableTransactionError } from "./errors";

/**
 * The only handle business code gets for writes. Everything done through it,
 * including events added with `tx.events`, commits or rolls back together.
 */
export interface Tx {
  readonly db: Database;
  readonly events: EventWriter;
}

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

export interface TransactionOptions {
  isolation?: IsolationLevel;
  /**
   * Re-runs the whole callback on serialization failures and deadlocks.
   * Callbacks must therefore have no side effects outside the database.
   */
  maxRetries?: number;
}

export function createTx(client: PoolClient): Tx {
  const db = drizzle(client);
  return { db, events: createEventWriter(db) };
}

const ISOLATION_SQL: Record<IsolationLevel, string> = {
  "read committed": "BEGIN ISOLATION LEVEL READ COMMITTED",
  "repeatable read": "BEGIN ISOLATION LEVEL REPEATABLE READ",
  serializable: "BEGIN ISOLATION LEVEL SERIALIZABLE",
};

async function attempt<T>(
  pool: Pool,
  fn: (tx: Tx) => Promise<T>,
  isolation: IsolationLevel,
): Promise<T> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query(ISOLATION_SQL[isolation]);
    const result = await fn(createTx(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // The connection is in an unknown state: make the pool discard it.
      releaseError = rollbackError instanceof Error ? rollbackError : new Error("rollback failed");
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export async function runInTransaction<T>(
  pool: Pool,
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const isolation = options.isolation ?? "read committed";
  const maxRetries = options.maxRetries ?? 2;
  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt(pool, fn, isolation);
    } catch (error) {
      if (tries >= maxRetries || !isRetryableTransactionError(error)) throw error;
      // Small jittered backoff before re-running.
      await new Promise((resolve) => setTimeout(resolve, 10 * (tries + 1) + Math.random() * 20));
    }
  }
}
