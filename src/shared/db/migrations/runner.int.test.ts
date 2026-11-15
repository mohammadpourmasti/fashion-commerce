import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MigrationDriftError,
  MigrationError,
  MigrationPolicyError,
  ProductionDownBlockedError,
  loadMigrations,
  migrateDown,
  migrateUp,
  migrationStatus,
} from "./index";
import { pgErrorCode } from "../errors";
import {
  migrationsWith,
  removeFixtureDirectories,
  schemaSnapshot,
} from "../testing/migration-fixtures";
import { createTestDatabase, type TestDatabase } from "../testing/test-database";

let db: TestDatabase;
// Holds the database only while it exists: set by beforeEach once createTestDatabase() succeeded,
// cleared by afterEach. If beforeEach fails before that, it stays undefined and afterEach skips cleanup
// (and a database from an earlier test is never cleaned twice).
let activeDb: TestDatabase | undefined;

beforeEach(async () => {
  activeDb = undefined;
  activeDb = await createTestDatabase();
  db = activeDb;
});

afterEach(async () => {
  const toClean = activeDb;
  activeDb = undefined;
  // Both steps always run: temp directories are removed even when the database cleanup throws,
  // and a directory problem cannot skip (or hide an error from) the database cleanup.
  const failures: unknown[] = [];
  try {
    if (toClean) await toClean.cleanup();
  } catch (error) {
    failures.push(error);
  }
  try {
    removeFixtureDirectories();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "afterEach cleanup failed in more than one step");
});

const tableExists = async (name: string) =>
  (await db.pool.query("SELECT to_regclass($1) AS t", [`public.${name}`])).rows[0].t !== null;

const addTable = {
  "0002_widgets": {
    up: "CREATE TABLE widgets (id int PRIMARY KEY, label text);",
    down: "SELECT fc_assert_table_empty('widgets');\nDROP TABLE widgets;",
  },
};

describe("migrateUp", () => {
  it("applies migrations, records checksums and is idempotent", async () => {
    const directory = migrationsWith(addTable);
    const first = await migrateUp(db.pool, { directory });
    expect(first.applied).toEqual(["0001_foundation", "0002_widgets"]);

    const rows = (await db.pool.query("SELECT id, checksum FROM schema_migrations ORDER BY id")).rows;
    expect(rows).toEqual(loadMigrations(directory).map((m) => ({ id: m.id, checksum: m.checksum })));
    expect(await tableExists("outbox_events")).toBe(true);
    expect(await tableExists("widgets")).toBe(true);

    expect((await migrateUp(db.pool, { directory })).applied).toEqual([]);
  });

  it("generates UUIDv7 primary keys in the database", async () => {
    await migrateUp(db.pool, { directory: migrationsWith() });
    const { rows } = await db.pool.query(
      "INSERT INTO outbox_events (type, payload) VALUES ('a.b', '{}') RETURNING substr(id::text, 15, 1) AS version",
    );
    expect(rows[0].version).toBe("7");
  });

  it("stops at --to", async () => {
    const directory = migrationsWith(addTable);
    expect((await migrateUp(db.pool, { directory, to: 1 })).applied).toEqual(["0001_foundation"]);
    expect(await tableExists("widgets")).toBe(false);
  });

  it("rolls a failing migration back completely and records nothing", async () => {
    const directory = migrationsWith({
      "0002_broken": { up: "CREATE TABLE half_done (id int); SELECT 1 / 0;", down: "DROP INDEX IF EXISTS nothing;" },
    });
    await expect(migrateUp(db.pool, { directory })).rejects.toThrow(/division by zero/);
    expect(await tableExists("half_done")).toBe(false);
    const ids = (await db.pool.query("SELECT id FROM schema_migrations")).rows.map((r) => r.id);
    expect(ids).toEqual(["0001_foundation"]);
  });

  it("applies each migration exactly once when two runners race", async () => {
    const directory = migrationsWith(addTable);
    const [a, b] = await Promise.all([
      migrateUp(db.pool, { directory }),
      migrateUp(db.pool, { directory }),
    ]);
    expect([...a.applied, ...b.applied].sort()).toEqual(["0001_foundation", "0002_widgets"]);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n).toBe(2);
  });

  it("refuses a migration that breaks the static policy before running anything", async () => {
    const directory = migrationsWith({
      "0002_drops": { up: "DROP TABLE outbox_events;", down: "SELECT 1;" },
    });
    await expect(migrateUp(db.pool, { directory })).rejects.toBeInstanceOf(MigrationPolicyError);
    expect(await tableExists("schema_migrations")).toBe(false);
  });
});

describe("drift detection", () => {
  it("rejects an applied migration whose content changed", async () => {
    const directory = migrationsWith();
    await migrateUp(db.pool, { directory });
    const file = join(directory, "0001_foundation", "migration.sql");
    writeFileSync(file, readFileSync(file, "utf8") + "\n-- tampered\n");
    await expect(migrateUp(db.pool, { directory })).rejects.toBeInstanceOf(MigrationDriftError);
    await expect(migrationStatus(db.pool, { directory })).rejects.toThrow(/modified after it ran/);
  });

  it("does not treat a CRLF checkout of the same content as a change", async () => {
    const directory = migrationsWith();
    await migrateUp(db.pool, { directory });
    const file = join(directory, "0001_foundation", "migration.sql");
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
    await expect(migrateUp(db.pool, { directory })).resolves.toEqual({ applied: [] });
  });

  it("rejects an applied migration that disappeared from disk", async () => {
    const full = migrationsWith(addTable);
    await migrateUp(db.pool, { directory: full });
    await expect(migrateUp(db.pool, { directory: migrationsWith() })).rejects.toThrow(/missing from the migrations directory/);
  });
});

describe("migrationStatus", () => {
  it("reports applied and pending, also before anything ran", async () => {
    const directory = migrationsWith(addTable);
    expect(await migrationStatus(db.pool, { directory })).toEqual({
      applied: [],
      pending: ["0001_foundation", "0002_widgets"],
    });
    await migrateUp(db.pool, { directory, to: 1 });
    expect(await migrationStatus(db.pool, { directory })).toEqual({
      applied: ["0001_foundation"],
      pending: ["0002_widgets"],
    });
  });
});

describe("migrateDown (data-safe)", () => {
  const dev = { production: false } as const;

  it("round-trips up -> down -> up to an identical schema", async () => {
    const directory = migrationsWith(addTable);
    await migrateUp(db.pool, { directory });
    const before = await schemaSnapshot(db.pool);

    expect((await migrateDown(db.pool, { directory, steps: 2, ...dev })).reverted).toEqual([
      "0002_widgets",
      "0001_foundation",
    ]);
    expect(await tableExists("outbox_events")).toBe(false);
    expect(await tableExists("widgets")).toBe(false);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n).toBe(0);

    await migrateUp(db.pool, { directory });
    expect(await schemaSnapshot(db.pool)).toBe(before);
  });

  it("refuses to drop a table that still has data, and changes nothing", async () => {
    const directory = migrationsWith();
    await migrateUp(db.pool, { directory });
    await db.pool.query("INSERT INTO outbox_events (type, payload) VALUES ('inventory.stock.changed', '{\"q\":1}')");
    await db.pool.query("INSERT INTO handled_events (consumer, event_id) VALUES ('c', uuidv7())");

    await expect(migrateDown(db.pool, { directory, ...dev })).rejects.toThrow(/refused.*still contains data/s);

    expect((await db.pool.query("SELECT count(*)::int AS n FROM outbox_events")).rows[0].n).toBe(1);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM handled_events")).rows[0].n).toBe(1);
    expect((await migrationStatus(db.pool, { directory })).applied).toEqual(["0001_foundation"]);
  });

  it("is atomic: a refusal on a later guard undoes the earlier drops", async () => {
    const directory = migrationsWith();
    await migrateUp(db.pool, { directory });
    // handled_events is empty (its guard passes and the DROP runs), outbox_events is not (its guard raises).
    await db.pool.query("INSERT INTO outbox_events (type, payload) VALUES ('a.b', '{}')");

    await expect(migrateDown(db.pool, { directory, ...dev })).rejects.toThrow(/refused/);

    expect(await tableExists("handled_events")).toBe(true);
    expect(await tableExists("outbox_events")).toBe(true);
    expect((await db.pool.query("SELECT proname FROM pg_proc WHERE proname = 'fc_assert_table_empty'")).rowCount).toBe(1);
  });

  it("succeeds once the data is gone", async () => {
    const directory = migrationsWith();
    await migrateUp(db.pool, { directory });
    await db.pool.query("INSERT INTO outbox_events (type, payload) VALUES ('a.b', '{}')");
    await expect(migrateDown(db.pool, { directory, ...dev })).rejects.toThrow(/refused/);
    await db.pool.query("DELETE FROM outbox_events");
    await expect(migrateDown(db.pool, { directory, ...dev })).resolves.toEqual({ reverted: ["0001_foundation"] });
  });

  it("raises the dedicated SQLSTATE from the SQL guard itself", async () => {
    await migrateUp(db.pool, { directory: migrationsWith() });
    await db.pool.query("INSERT INTO outbox_events (type, payload) VALUES ('a.b', '{}')");
    const error = await db.pool.query("SELECT fc_assert_table_empty('outbox_events')").catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe("FCD01");
  });

  it("guards individual columns too", async () => {
    await migrateUp(db.pool, { directory: migrationsWith() });
    await db.pool.query("INSERT INTO outbox_events (type, payload) VALUES ('a.b', '{}')");
    await expect(db.pool.query("SELECT fc_assert_column_empty('outbox_events', 'last_error')")).resolves.toBeDefined();
    await expect(db.pool.query("SELECT fc_assert_column_empty('outbox_events', 'type')")).rejects.toThrow(/still contains data/);
  });

  it("is blocked in production without the explicit flag, before touching the database", async () => {
    const directory = migrationsWith();
    await migrateUp(db.pool, { directory });
    await expect(migrateDown(db.pool, { directory, production: true })).rejects.toBeInstanceOf(
      ProductionDownBlockedError,
    );
    expect(await tableExists("outbox_events")).toBe(true);
  });

  it("still refuses to lose data in production even with the explicit flag", async () => {
    const directory = migrationsWith();
    await migrateUp(db.pool, { directory });
    await db.pool.query("INSERT INTO outbox_events (type, payload) VALUES ('a.b', '{}')");
    await expect(
      migrateDown(db.pool, { directory, production: true, allowProduction: true }),
    ).rejects.toThrow(/refused/);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM outbox_events")).rows[0].n).toBe(1);
  });

  it("runs in production with the flag when no data would be lost", async () => {
    const directory = migrationsWith();
    await migrateUp(db.pool, { directory });
    await expect(
      migrateDown(db.pool, { directory, production: true, allowProduction: true }),
    ).resolves.toEqual({ reverted: ["0001_foundation"] });
  });

  it("refuses a down.sql that lost its guard after the migration was applied, before executing any of it", async () => {
    const directory = migrationsWith(addTable);
    await migrateUp(db.pool, { directory });
    await db.pool.query("INSERT INTO widgets VALUES (1, 'keep me')");
    // down.sql is not checksummed, so it can be edited later; the policy check must still catch it.
    writeFileSync(join(directory, "0002_widgets", "down.sql"), "DROP TABLE widgets;");

    await expect(migrateDown(db.pool, { directory, ...dev })).rejects.toBeInstanceOf(MigrationPolicyError);
    expect((await db.pool.query("SELECT label FROM widgets")).rows).toEqual([{ label: "keep me" }]);
  });

  it("refuses to apply a migration whose down.sql breaks the policy", async () => {
    const directory = migrationsWith({
      "0002_widgets": { up: addTable["0002_widgets"].up, down: "DROP TABLE widgets;" },
    });
    await expect(migrateUp(db.pool, { directory })).rejects.toBeInstanceOf(MigrationPolicyError);
    expect(await tableExists("schema_migrations")).toBe(false);
  });

  it("validates step counts and does nothing on an empty database", async () => {
    const directory = migrationsWith();
    await expect(migrateDown(db.pool, { directory, steps: 0, ...dev })).rejects.toBeInstanceOf(MigrationError);
    await db.pool.query("CREATE TABLE schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    await expect(migrateDown(db.pool, { directory, ...dev })).resolves.toEqual({ reverted: [] });
  });
});

describe("application role grants", () => {
  const actAsApp = async <T>(fn: (sql: (text: string) => Promise<unknown>) => Promise<T>): Promise<T> => {
    const client = await db.pool.connect();
    try {
      await client.query(`SET ROLE ${db.appRole}`);
      return await fn((text) => client.query(text));
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
  };
  const denied = async (sql: string) => {
    const error = await actAsApp((run) => run(sql)).catch((e: unknown) => e);
    return pgErrorCode(error);
  };

  it("grants exactly the declared privileges and nothing structural", async () => {
    await migrateUp(db.pool, { directory: migrationsWith(), appRole: db.appRole });

    await actAsApp(async (run) => {
      await run("INSERT INTO outbox_events (type, payload) VALUES ('a.b', '{}')");
      await run("SELECT * FROM outbox_events");
      await run("UPDATE outbox_events SET attempts = 1");
      await run("INSERT INTO handled_events (consumer, event_id) VALUES ('c', uuidv7())");
      await run("SELECT * FROM handled_events");
    });

    // Not granted: UPDATE/DELETE on handled_events, DELETE on outbox, TRUNCATE, DDL, internals.
    expect(await denied("UPDATE handled_events SET consumer = 'x'")).toBe("42501");
    expect(await denied("DELETE FROM handled_events")).toBe("42501");
    expect(await denied("DELETE FROM outbox_events")).toBe("42501");
    expect(await denied("TRUNCATE outbox_events")).toBe("42501");
    expect(await denied("DROP TABLE outbox_events")).toBe("42501");
    expect(await denied("CREATE TABLE sneaky (id int)")).toBe("42501");
    expect(await denied("SELECT * FROM schema_migrations")).toBe("42501");
    expect(await denied(`SELECT fc_app_grant('outbox_events', 'DELETE')`)).toBe("42501");
  });

  it("grants nothing when no application role is configured", async () => {
    await migrateUp(db.pool, { directory: migrationsWith() });
    expect(await denied("SELECT * FROM outbox_events")).toBe("42501");
    expect(await denied("INSERT INTO outbox_events (type, payload) VALUES ('a.b', '{}')")).toBe("42501");
  });

  it("cannot be used to grant anything beyond plain DML", async () => {
    await migrateUp(db.pool, { directory: migrationsWith(), appRole: db.appRole });
    await expect(db.pool.query("SELECT fc_app_grant('outbox_events', 'ALL')")).rejects.toThrow(/unsupported privilege/);
    await expect(db.pool.query("SELECT fc_app_grant('outbox_events', 'SELECT; DROP TABLE outbox_events')")).rejects.toThrow(
      /unsupported privilege/,
    );
  });

  it("has no CREATE privilege on the public schema", async () => {
    await migrateUp(db.pool, { directory: migrationsWith(), appRole: db.appRole });
    const { rows } = await db.pool.query("SELECT has_schema_privilege($1, 'public', 'CREATE') AS can", [db.appRole]);
    expect(rows[0].can).toBe(false);
  });

  it("rejects a role that does not exist or has an unsafe name", async () => {
    const directory = migrationsWith();
    await expect(migrateUp(db.pool, { directory, appRole: "no_such_role" })).rejects.toThrow(/does not exist/);
    await expect(migrateUp(db.pool, { directory, appRole: "x; DROP DATABASE y" })).rejects.toThrow(/Invalid application role/);
  });
});
