import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Pool } from "pg";

/** The project's real migrations directory. */
export const REAL_MIGRATIONS = resolve(process.cwd(), "drizzle");

const created: string[] = [];

/** Copies the real migrations into a temp directory and adds extra ones (e.g. a 0002 under test). */
export function migrationsWith(extra: Record<string, { up: string; down: string }> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "fc-int-mig-"));
  created.push(dir);
  cpSync(REAL_MIGRATIONS, dir, { recursive: true, filter: (src) => !src.includes("_generated") });
  for (const [name, { up, down }] of Object.entries(extra)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "migration.sql"), up);
    writeFileSync(join(dir, name, "down.sql"), down);
  }
  return dir;
}

export function removeFixtureDirectories(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A stable, comparable description of the public schema (tables, columns, indexes, constraints, functions). */
export async function schemaSnapshot(pool: Pool): Promise<string> {
  const q = async (sql: string) => (await pool.query(sql)).rows;
  return JSON.stringify({
    columns: await q(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = 'public'
       ORDER BY table_name, column_name`),
    indexes: await q("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname"),
    constraints: await q(`
      SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace
       ORDER BY conrelid::regclass::text, conname`),
    functions: await q(`
      SELECT proname, pg_get_function_identity_arguments(oid) AS args
        FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY proname, args`),
  });
}
