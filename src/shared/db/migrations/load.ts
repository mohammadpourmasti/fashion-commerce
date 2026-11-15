import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { MigrationLayoutError } from "./errors";

export interface Migration {
  /** Directory name, e.g. `0001_foundation`. The primary key in `schema_migrations`. */
  id: string;
  number: number;
  name: string;
  upSql: string;
  downSql: string;
  /** SHA-256 of migration.sql with line endings normalized. */
  checksum: string;
}

const DIRECTORY_PATTERN = /^(\d{4})_([a-z][a-z0-9_]*)$/;

/**
 * Line endings are normalized so a checkout with CRLF (Windows autocrlf)
 * hashes the same as one with LF; a migration is never "changed" by git.
 */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export function loadMigrations(directory: string): Migration[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new MigrationLayoutError(`Migrations directory not found: ${directory}`);
  }
  const migrations: Migration[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Dot- and underscore-prefixed entries are tool scratch space (e.g. drizzle-kit output).
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    if (!entry.isDirectory()) {
      throw new MigrationLayoutError(`Unexpected file in migrations directory: ${entry.name}`);
    }
    const match = DIRECTORY_PATTERN.exec(entry.name);
    if (!match) {
      throw new MigrationLayoutError(
        `Migration directory "${entry.name}" must look like 0001_snake_case_name.`,
      );
    }
    const upPath = join(directory, entry.name, "migration.sql");
    const downPath = join(directory, entry.name, "down.sql");
    for (const path of [upPath, downPath]) {
      if (!existsSync(path)) {
        throw new MigrationLayoutError(`Missing ${path}: every migration needs migration.sql and down.sql.`);
      }
    }
    const upSql = readFileSync(upPath, "utf8");
    migrations.push({
      id: entry.name,
      number: Number(match[1]),
      name: match[2] as string,
      upSql,
      downSql: readFileSync(downPath, "utf8"),
      checksum: checksumOf(upSql),
    });
  }
  migrations.sort((a, b) => a.number - b.number);
  migrations.forEach((migration, index) => {
    if (migration.number !== index + 1) {
      throw new MigrationLayoutError(
        `Migration numbers must be contiguous from 0001; found ${migration.id} at position ${index + 1}.`,
      );
    }
  });
  return migrations;
}
