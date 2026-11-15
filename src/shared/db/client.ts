import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type PoolConfig } from "pg";

import { getServerEnv } from "@/config/env";

import { DatabaseNotConfiguredError } from "./errors";

/** The Drizzle handle used across the data layer. Modules own their tables; this type owns none. */
export type Database = NodePgDatabase;

export function createPool(
  connectionString: string,
  options: Omit<PoolConfig, "connectionString"> = {},
): Pool {
  const pool = new Pool({
    application_name: "fashion-commerce",
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...options,
    connectionString,
  });
  // An error on an idle client must not crash the process. Log the message only:
  // never the connection string or query text.
  pool.on("error", (error) => {
    console.error("[db] idle client error:", error.message);
  });
  return pool;
}

export function createDatabase(client: Pool | PoolClient): Database {
  return drizzle(client);
}

// Next.js dev reloads modules; keep one pool per process.
const globalForPool = globalThis as typeof globalThis & { __fashionCommercePool?: Pool };

/** The process-wide pool, created from the validated server environment on first use. */
export function getPool(): Pool {
  if (!globalForPool.__fashionCommercePool) {
    const env = getServerEnv();
    if (!env.DATABASE_URL) throw new DatabaseNotConfiguredError("DATABASE_URL");
    globalForPool.__fashionCommercePool = createPool(env.DATABASE_URL, {
      max: env.DATABASE_POOL_MAX ?? 10,
    });
  }
  return globalForPool.__fashionCommercePool;
}

export async function closePool(): Promise<void> {
  const pool = globalForPool.__fashionCommercePool;
  globalForPool.__fashionCommercePool = undefined;
  await pool?.end();
}
