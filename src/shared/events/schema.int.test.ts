import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateUp } from "@/shared/db/migrations";
import { REAL_MIGRATIONS } from "@/shared/db/testing/migration-fixtures";
import { createTestDatabase, type TestDatabase } from "@/shared/db/testing/test-database";

import { handledEvents, outboxEvents } from "./schema";

/**
 * The SQL migrations are the source of truth; the Drizzle table definitions
 * are what code queries through. This keeps the two from drifting apart:
 * columns, types, nullability, primary keys, CHECK constraints and indexes.
 */

let db: TestDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrateUp(db.pool, { directory: REAL_MIGRATIONS });
});

afterEach(async () => {
  await db.cleanup();
});

const DRIZZLE_TO_INFORMATION_SCHEMA: Record<string, string> = {
  PgUUID: "uuid",
  PgText: "text",
  PgJsonb: "jsonb",
  PgInteger: "integer",
  PgTimestamp: "timestamp with time zone",
};

describe.each([
  ["outbox_events", outboxEvents],
  ["handled_events", handledEvents],
] as [string, PgTable][])("Drizzle definition of %s matches the migrated database", (tableName, table) => {
  const config = getTableConfig(table);

  it("has the same columns, types and nullability", async () => {
    const { rows } = await db.pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY column_name`,
      [tableName],
    );
    const expected = config.columns
      .map((column) => ({
        column_name: column.name,
        data_type: DRIZZLE_TO_INFORMATION_SCHEMA[column.columnType] ?? `unmapped:${column.columnType}`,
        is_nullable: column.notNull ? "NO" : "YES",
      }))
      .sort((a, b) => a.column_name.localeCompare(b.column_name));
    expect(rows).toEqual(expected);
  });

  it("has the same primary key", async () => {
    const { rows } = await db.pool.query(
      `SELECT a.attname FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary
        ORDER BY a.attname`,
      [`public.${tableName}`],
    );
    const fromDrizzle =
      config.primaryKeys.length > 0
        ? config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name))
        : config.columns.filter((c) => c.primary).map((c) => c.name);
    expect(rows.map((r) => r.attname)).toEqual([...fromDrizzle].sort());
  });

  it("declares every CHECK constraint and index the database has", async () => {
    const checks = await db.pool.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c' ORDER BY conname",
      [`public.${tableName}`],
    );
    expect(checks.rows.map((r) => r.conname)).toEqual(config.checks.map((c) => c.name).sort());

    const indexes = await db.pool.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 AND indexname NOT LIKE '%_pkey' ORDER BY indexname",
      [tableName],
    );
    expect(indexes.rows.map((r) => r.indexname)).toEqual(config.indexes.map((i) => i.config.name).sort());
  });
});
