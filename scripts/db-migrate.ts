import { createPool } from "@/shared/db/client";
import { migrateDown, migrateUp, migrationStatus } from "@/shared/db/migrations";

import { loadLocalEnv, MIGRATIONS_DIRECTORY, migrationConnectionString } from "./db-env";

/**
 *   npm run db:migrate                 apply pending migrations
 *   npm run db:status                  show applied / pending
 *   npm run db:migrate:down -- --steps 1 [--allow-production]
 *
 * Never run against a database you have not chosen: it uses MIGRATION_DATABASE_URL,
 * or DATABASE_URL in local development.
 */
async function main(): Promise<void> {
  loadLocalEnv();
  const [command = "", ...args] = process.argv.slice(2);
  const appRole = process.env.DB_APP_ROLE || undefined;
  const pool = createPool(migrationConnectionString(), { max: 2 });
  try {
    if (command === "up") {
      const { applied } = await migrateUp(pool, { directory: MIGRATIONS_DIRECTORY, appRole });
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Nothing to apply.");
    } else if (command === "status") {
      const { applied, pending } = await migrationStatus(pool, { directory: MIGRATIONS_DIRECTORY });
      console.log(`Applied (${applied.length}): ${applied.join(", ") || "-"}`);
      console.log(`Pending (${pending.length}): ${pending.join(", ") || "-"}`);
    } else if (command === "down") {
      const stepsIndex = args.indexOf("--steps");
      const steps = stepsIndex === -1 ? 1 : Number(args[stepsIndex + 1]);
      const { reverted } = await migrateDown(pool, {
        directory: MIGRATIONS_DIRECTORY,
        appRole,
        steps,
        production: process.env.NODE_ENV === "production",
        allowProduction: args.includes("--allow-production"),
      });
      console.log(reverted.length ? `Reverted: ${reverted.join(", ")}` : "Nothing to revert.");
    } else {
      console.error("Usage: db-migrate <up|status|down [--steps N] [--allow-production]>");
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
