import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateUp } from "@/shared/db/migrations";
import { REAL_MIGRATIONS } from "@/shared/db/testing/migration-fixtures";
import { createTestDatabase, type TestDatabase } from "@/shared/db/testing/test-database";
import { runInTransaction } from "@/shared/db/transaction";

import { dispatchPending, type EventConsumer, type OutboxEvent } from "./dispatcher";

let db: TestDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrateUp(db.pool, { directory: REAL_MIGRATIONS });
  await db.pool.query("CREATE TABLE effects (consumer text NOT NULL, event_id uuid NOT NULL)");
});

afterEach(async () => {
  await db.cleanup();
});

const emit = (type: string, payload: Record<string, unknown> = {}) =>
  runInTransaction(db.pool, (tx) => tx.events.add({ type, payload }));

const rows = async (query: string) => (await db.pool.query(query)).rows;
const eventRow = async (id: string) =>
  (await rows(`SELECT * FROM outbox_events WHERE id = '${id}'`))[0] as Record<string, unknown>;

/** A consumer that records an effect row through the dispatcher's transaction. */
function recorder(name: string, types: EventConsumer["types"] = "*", fail?: () => boolean): EventConsumer {
  return {
    name,
    types,
    async handle(event: OutboxEvent, tx) {
      await tx.db.execute(sql`INSERT INTO effects (consumer, event_id) VALUES (${name}, ${event.id}::uuid)`);
      if (fail?.()) throw new Error(`${name} failed`);
    },
  };
}

describe("dispatchPending", () => {
  it("delivers each event to its matching consumers once and marks it published", async () => {
    const stock = await emit("inventory.stock.changed", { q: 1 });
    const order = await emit("commerce.order.placed");

    const consumers = [recorder("stock-reader", ["inventory.stock.changed"]), recorder("auditor", "*")];
    const result = await dispatchPending(db.pool, consumers);

    expect(result).toEqual({ claimed: 2, published: 2, retried: 0, dead: 0 });
    const effects = await rows("SELECT consumer, event_id FROM effects ORDER BY consumer, event_id");
    expect(effects.filter((e) => e.consumer === "stock-reader")).toEqual([{ consumer: "stock-reader", event_id: stock }]);
    expect(effects.filter((e) => e.consumer === "auditor").map((e) => e.event_id).sort()).toEqual([stock, order].sort());
    expect((await eventRow(stock)).published_at).not.toBeNull();
    expect(await rows("SELECT 1 FROM handled_events")).toHaveLength(3);

    expect(await dispatchPending(db.pool, consumers)).toEqual({ claimed: 0, published: 0, retried: 0, dead: 0 });
  });

  it("publishes events nobody consumes instead of retrying them forever", async () => {
    const id = await emit("analytics.page.viewed");
    const result = await dispatchPending(db.pool, [recorder("x", ["other.type"])]);
    expect(result.published).toBe(1);
    expect((await eventRow(id)).published_at).not.toBeNull();
  });

  it("skips a consumer that already handled the event (de-duplication)", async () => {
    const id = await emit("a.b");
    await db.pool.query("INSERT INTO handled_events (consumer, event_id) VALUES ('c1', $1)", [id]);
    await dispatchPending(db.pool, [recorder("c1"), recorder("c2")]);
    const effects = await rows("SELECT consumer FROM effects");
    expect(effects).toEqual([{ consumer: "c2" }]);
    expect((await eventRow(id)).published_at).not.toBeNull();
  });

  it("rolls a failed handler's writes back and schedules a retry with backoff", async () => {
    const id = await emit("a.b");
    const result = await dispatchPending(db.pool, [recorder("c1", "*", () => true)]);

    expect(result).toEqual({ claimed: 1, published: 0, retried: 1, dead: 0 });
    expect(await rows("SELECT 1 FROM effects")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM handled_events")).toHaveLength(0);
    const row = await eventRow(id);
    expect(row).toMatchObject({ attempts: 1, published_at: null, dead_at: null });
    expect(row.last_error).toBe("c1 failed");
    expect(new Date(row.next_attempt_at as string).getTime()).toBeGreaterThan(Date.now());

    // Not due yet: an immediate second run claims nothing.
    expect((await dispatchPending(db.pool, [recorder("c1")])).claimed).toBe(0);
  });

  it("is exactly-once for database effects across a failure of a later consumer", async () => {
    const id = await emit("a.b");
    let failSecond = true;
    const consumers = [recorder("first"), recorder("second", "*", () => failSecond)];

    await dispatchPending(db.pool, consumers);
    expect(await rows("SELECT 1 FROM effects")).toHaveLength(0); // first's write was undone too

    failSecond = false;
    await db.pool.query("UPDATE outbox_events SET next_attempt_at = now() WHERE id = $1", [id]);
    await dispatchPending(db.pool, consumers);

    const effects = await rows("SELECT consumer FROM effects ORDER BY consumer");
    expect(effects).toEqual([{ consumer: "first" }, { consumer: "second" }]); // one each, never duplicated
    expect((await eventRow(id)).published_at).not.toBeNull();
  });

  it("parks an event as dead after maxAttempts and never claims it again", async () => {
    const id = await emit("a.b");
    const failing = [recorder("c1", "*", () => true)];
    const opts = { maxAttempts: 2 };

    expect((await dispatchPending(db.pool, failing, opts)).retried).toBe(1);
    await db.pool.query("UPDATE outbox_events SET next_attempt_at = now() WHERE id = $1", [id]);
    expect(await dispatchPending(db.pool, failing, opts)).toEqual({ claimed: 1, published: 0, retried: 0, dead: 1 });

    const row = await eventRow(id);
    expect(row.dead_at).not.toBeNull();
    expect(row.attempts).toBe(2);
    await db.pool.query("UPDATE outbox_events SET next_attempt_at = now() WHERE id = $1", [id]);
    expect((await dispatchPending(db.pool, failing, opts)).claimed).toBe(0);
  });

  it("lets two dispatchers work at the same time without handling any event twice", async () => {
    for (let i = 0; i < 40; i += 1) await emit("load.test", { i });
    const seen: string[] = [];
    const consumer: EventConsumer = {
      name: "slow",
      types: "*",
      async handle(event) {
        seen.push(event.id);
        await new Promise((resolve) => setTimeout(resolve, 3));
      },
    };

    const results = await Promise.all(
      Array.from({ length: 4 }, () => dispatchPending(db.pool, [consumer], { batchSize: 10 })),
    );

    expect(seen).toHaveLength(40);
    expect(new Set(seen).size).toBe(40);
    expect(results.reduce((sum, r) => sum + r.published, 0)).toBe(40);
    expect(await rows("SELECT 1 FROM handled_events WHERE consumer = 'slow'")).toHaveLength(40);
  });

  it("does not wait for rows another dispatcher has locked (SKIP LOCKED)", async () => {
    await emit("a.b");
    await emit("a.b");
    let unblock: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (unblock = resolve));
    let entered: () => void = () => undefined;
    const inHandler = new Promise<void>((resolve) => (entered = resolve));
    const blocking: EventConsumer = {
      name: "blocker",
      types: "*",
      async handle() {
        entered();
        await gate;
      },
    };

    const first = dispatchPending(db.pool, [blocking], { batchSize: 10 });
    await inHandler; // the first dispatcher now holds row locks inside an open transaction

    const second = dispatchPending(db.pool, [recorder("other")], { batchSize: 10 });
    const outcome = await Promise.race([
      second.then((result) => ({ finished: true as const, result })),
      new Promise<{ finished: false }>((resolve) => setTimeout(() => resolve({ finished: false }), 2_000)),
    ]);
    unblock();
    await first;
    await second;

    expect(outcome).toEqual({ finished: true, result: { claimed: 0, published: 0, retried: 0, dead: 0 } });
  });

  it("commits follow-up events made by a handler together with its other writes", async () => {
    const id = await emit("order.placed");
    const consumer: EventConsumer = {
      name: "follower",
      types: ["order.placed"],
      async handle(_event, tx) {
        await tx.events.add({ type: "order.confirmed", payload: {} });
      },
    };
    await dispatchPending(db.pool, [consumer]);
    expect(await rows("SELECT type FROM outbox_events ORDER BY type")).toEqual([
      { type: "order.confirmed" },
      { type: "order.placed" },
    ]);
    expect((await eventRow(id)).published_at).not.toBeNull();
  });

  it("drops a follow-up event when the handler then fails", async () => {
    await emit("order.placed");
    const consumer: EventConsumer = {
      name: "follower",
      types: ["order.placed"],
      async handle(_event, tx) {
        await tx.events.add({ type: "order.confirmed", payload: {} });
        throw new Error("nope");
      },
    };
    await dispatchPending(db.pool, [consumer]);
    expect(await rows("SELECT type FROM outbox_events")).toEqual([{ type: "order.placed" }]);
  });

  it("respects the batch size and processes oldest first", async () => {
    const ids = [] as string[];
    for (let i = 0; i < 5; i += 1) ids.push(await emit("a.b", { i }));
    const handled: string[] = [];
    const consumer: EventConsumer = { name: "c", types: "*", handle: async (e) => void handled.push(e.id) };

    expect((await dispatchPending(db.pool, [consumer], { batchSize: 2 })).claimed).toBe(2);
    expect(handled).toEqual([...ids].sort().slice(0, 2));
  });

  it("rejects invalid consumer names before touching the database", async () => {
    await expect(dispatchPending(db.pool, [{ name: "Bad Name", types: "*", handle: async () => undefined }])).rejects.toThrow(
      /Invalid consumer name/,
    );
  });
});
