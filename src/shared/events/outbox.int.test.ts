import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PG_ERROR, pgErrorCode } from "@/shared/db/errors";
import { migrateUp } from "@/shared/db/migrations";
import { REAL_MIGRATIONS } from "@/shared/db/testing/migration-fixtures";
import { createTestDatabase, type TestDatabase } from "@/shared/db/testing/test-database";
import { runInTransaction } from "@/shared/db/transaction";

import { InvalidEventError } from "./outbox";

let db: TestDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrateUp(db.pool, { directory: REAL_MIGRATIONS });
  await db.pool.query(`
    CREATE TABLE accounts (id serial PRIMARY KEY, name text NOT NULL);
    CREATE TABLE deferred_unique (n int, CONSTRAINT deferred_unique_n UNIQUE (n) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE skew (id int PRIMARY KEY);
  `);
});

afterEach(async () => {
  await db.cleanup();
});

const count = async (table: string) =>
  (await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;

describe("runInTransaction + outbox (atomicity)", () => {
  it("commits the business change and its event together", async () => {
    const eventId = await runInTransaction(db.pool, async (tx) => {
      await tx.db.execute(sql`INSERT INTO accounts (name) VALUES ('Atelier')`);
      return tx.events.add({
        type: "customers.account.created",
        aggregate: { type: "account", id: "1" },
        payload: { name: "Atelier" },
      });
    });

    expect(await count("accounts")).toBe(1);
    const { rows } = await db.pool.query("SELECT * FROM outbox_events");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: eventId,
      type: "customers.account.created",
      aggregate_type: "account",
      aggregate_id: "1",
      payload: { name: "Atelier" },
      attempts: 0,
      published_at: null,
      dead_at: null,
    });
  });

  it("leaves neither the change nor the event when the callback fails after both were written", async () => {
    await expect(
      runInTransaction(db.pool, async (tx) => {
        await tx.db.execute(sql`INSERT INTO accounts (name) VALUES ('ghost')`);
        await tx.events.add({ type: "customers.account.created", payload: {} });
        throw new Error("boom after writes");
      }),
    ).rejects.toThrow("boom after writes");
    expect(await count("accounts")).toBe(0);
    expect(await count("outbox_events")).toBe(0);
  });

  it("leaves neither when COMMIT itself fails (deferred constraint)", async () => {
    const error = await runInTransaction(db.pool, async (tx) => {
      await tx.db.execute(sql`INSERT INTO deferred_unique VALUES (1), (1)`);
      await tx.events.add({ type: "a.b", payload: {} });
    }).catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe(PG_ERROR.uniqueViolation);
    expect(await count("deferred_unique")).toBe(0);
    expect(await count("outbox_events")).toBe(0);
  });

  it("rolls the business change back when the event is invalid", async () => {
    await expect(
      runInTransaction(db.pool, async (tx) => {
        await tx.db.execute(sql`INSERT INTO accounts (name) VALUES ('x')`);
        await tx.events.add({ type: "Not Valid", payload: {} });
      }),
    ).rejects.toBeInstanceOf(InvalidEventError);
    expect(await count("accounts")).toBe(0);
  });

  it("enforces event shape in the database as well (defence in depth)", async () => {
    const insert = (type: string, payload: string) =>
      db.pool.query("INSERT INTO outbox_events (type, payload) VALUES ($1, $2::jsonb)", [type, payload]);
    expect(pgErrorCode(await insert("Bad Type", "{}").catch((e: unknown) => e))).toBe(PG_ERROR.checkViolation);
    expect(pgErrorCode(await insert("a.b", "[]").catch((e: unknown) => e))).toBe(PG_ERROR.checkViolation);
    expect(pgErrorCode(await db.pool.query("INSERT INTO outbox_events (type, payload, aggregate_type) VALUES ('a.b', '{}', 'x')").catch((e: unknown) => e))).toBe(
      PG_ERROR.checkViolation,
    );
  });

  it("does not keep a pooled connection hostage after failures", async () => {
    for (let i = 0; i < 25; i += 1) {
      await runInTransaction(db.pool, async () => {
        throw new Error(`fail ${i}`);
      }).catch(() => undefined);
    }
    expect(db.pool.waitingCount).toBe(0);
    expect((await db.pool.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
  });
});

describe("runInTransaction retries", () => {
  /** Two serializable transactions that both read before either writes: a write-skew conflict. */
  const racePair = (maxRetries: number) => {
    let readers = 0;
    let release: () => void = () => undefined;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    const runs: number[] = [];

    const attempt = (id: number) => {
      let tries = 0;
      return runInTransaction(
        db.pool,
        async (tx) => {
          tries += 1;
          runs.push(id);
          const seen = (await tx.db.execute(sql`SELECT count(*)::int AS n FROM skew`)).rows[0] as { n: number };
          if (tries === 1) {
            readers += 1;
            if (readers === 2) release();
            await bothRead;
          }
          await tx.db.execute(sql`INSERT INTO skew (id) VALUES (${seen.n + 1 + id * 100})`);
        },
        { isolation: "serializable", maxRetries },
      );
    };
    return { runs, a: attempt(0), b: attempt(1) };
  };

  it("re-runs the whole callback after a serialization failure and both succeed", async () => {
    const { runs, a, b } = racePair(2);
    await Promise.all([a, b]);
    expect(runs.length).toBeGreaterThanOrEqual(3); // at least one callback ran twice
    expect(await count("skew")).toBe(2);
  });

  it("surfaces the serialization failure when retries are disabled", async () => {
    const { a, b } = racePair(0);
    const results = await Promise.allSettled([a, b]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(pgErrorCode((rejected[0] as PromiseRejectedResult).reason)).toBe(PG_ERROR.serializationFailure);
    expect(await count("skew")).toBe(1);
  });

  it("does not retry ordinary errors", async () => {
    let runs = 0;
    await expect(
      runInTransaction(db.pool, async () => {
        runs += 1;
        throw new Error("not retryable");
      }),
    ).rejects.toThrow("not retryable");
    expect(runs).toBe(1);
  });
});
