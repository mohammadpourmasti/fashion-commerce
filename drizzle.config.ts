import { defineConfig } from "drizzle-kit";

// drizzle-kit is a drafting tool here: `npm run db:generate` diffs the TypeScript
// schema and writes SQL to drizzle/_generated (git-ignored). Copy what you want
// into a new drizzle/NNNN_name/migration.sql, hand-write its down.sql, and let
// `npm run db:check` and the integration tests verify it. The runner in
// src/shared/db/migrations is what actually applies migrations.
export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/shared/events/schema.ts", "./src/modules/*/infrastructure/schema*.ts"],
  out: "./drizzle/_generated",
  dbCredentials: {
    url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
