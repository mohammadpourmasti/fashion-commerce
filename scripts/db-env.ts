import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Loads .env.local when present (Node >= 20.12), without overriding real environment variables. */
export function loadLocalEnv(): void {
  const file = resolve(process.cwd(), ".env.local");
  if (existsSync(file) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(file);
  }
}

export const MIGRATIONS_DIRECTORY = resolve(process.cwd(), "drizzle");

export function migrationConnectionString(): string {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Set MIGRATION_DATABASE_URL (or DATABASE_URL for local development).");
  }
  if (process.env.NODE_ENV === "production" && !process.env.MIGRATION_DATABASE_URL) {
    throw new Error("In production, migrations must use MIGRATION_DATABASE_URL (the owner role), not the app role.");
  }
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error("The database URL must be a PostgreSQL URL.");
  return url;
}
