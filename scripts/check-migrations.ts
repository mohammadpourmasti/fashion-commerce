import { checkMigrationPolicy, loadMigrations } from "@/shared/db/migrations";

import { MIGRATIONS_DIRECTORY } from "./db-env";

/** Static migration checks (no database needed): layout, numbering and the up/down policy. */
function main(): void {
  const migrations = loadMigrations(MIGRATIONS_DIRECTORY);
  const problems = checkMigrationPolicy(migrations);
  if (problems.length > 0) {
    console.error(problems.join("\n\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`OK: ${migrations.length} migration(s) pass layout and policy checks.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
