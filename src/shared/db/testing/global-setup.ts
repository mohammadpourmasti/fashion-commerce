import { Client } from "pg";

/** Fails fast, with a readable message, when the integration tests have no database. */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Start PostgreSQL (`docker compose up -d`) and point it at an " +
        "administrative connection, e.g. postgresql://USER:PASSWORD@localhost:5432/postgres. " +
        "Each test file creates and drops its own database; your development database is not touched.",
    );
  }
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
      "SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user",
    );
    const role = rows[0];
    if (!role || !(role.rolsuper || (role.rolcreaterole && role.rolcreatedb))) {
      throw new Error("TEST_DATABASE_URL's role needs CREATEDB and CREATEROLE (or superuser).");
    }
  } catch (error) {
    throw new Error(
      `Cannot use TEST_DATABASE_URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
