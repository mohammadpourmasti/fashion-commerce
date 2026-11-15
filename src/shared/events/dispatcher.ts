import type { Pool } from "pg";

import { createTx, type Tx } from "@/shared/db/transaction";

/**
 * In-process outbox dispatcher: at-least-once delivery, exactly-once effect
 * for writes made through the `Tx` handed to handlers.
 *
 * Each event is handled inside a savepoint of the claiming transaction. A
 * handler's database writes and its `handled_events` row commit together or
 * not at all, so a retry after failure never double-applies them. Effects
 * outside the database (HTTP calls, mail) are at-least-once and must be
 * idempotent. Ordering between events is not guaranteed.
 */

export interface OutboxEvent {
  id: string;
  type: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
}

export interface EventConsumer {
  /** Stable lowercase name; it keys `handled_events`, so never rename it casually. */
  name: string;
  /** Event types handled, or "*" for all. */
  types: readonly string[] | "*";
  handle(event: OutboxEvent, tx: Tx): Promise<void>;
}

export interface DispatchOptions {
  batchSize?: number;
  /** After this many failed attempts an event is parked as dead. */
  maxAttempts?: number;
}

export interface DispatchResult {
  claimed: number;
  published: number;
  retried: number;
  dead: number;
}

const CONSUMER_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

interface EventRow {
  id: string;
  type: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
}

function matches(consumer: EventConsumer, type: string): boolean {
  return consumer.types === "*" || consumer.types.includes(type);
}

export async function dispatchPending(
  pool: Pool,
  consumers: readonly EventConsumer[],
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  for (const consumer of consumers) {
    if (!CONSUMER_NAME.test(consumer.name)) {
      throw new Error(`Invalid consumer name "${consumer.name}".`);
    }
  }
  const batchSize = options.batchSize ?? 50;
  const maxAttempts = options.maxAttempts ?? 8;
  const result: DispatchResult = { claimed: 0, published: 0, retried: 0, dead: 0 };

  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<EventRow>(
      `SELECT id, type, aggregate_type, aggregate_id, payload, occurred_at, attempts
         FROM outbox_events
        WHERE published_at IS NULL AND dead_at IS NULL AND next_attempt_at <= now()
        ORDER BY id
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    result.claimed = rows.length;
    const tx = createTx(client);

    for (const [index, row] of rows.entries()) {
      const event: OutboxEvent = {
        id: row.id,
        type: row.type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        occurredAt: row.occurred_at,
        attempts: row.attempts,
      };
      const savepoint = `ev_${index}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        for (const consumer of consumers.filter((c) => matches(c, event.type))) {
          const claimed = await client.query(
            `INSERT INTO handled_events (consumer, event_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING RETURNING 1`,
            [consumer.name, event.id],
          );
          if (claimed.rowCount === 1) await consumer.handle(event, tx);
        }
        await client.query("UPDATE outbox_events SET published_at = now() WHERE id = $1", [event.id]);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        result.published += 1;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
        const attempts = event.attempts + 1;
        const dead = attempts >= maxAttempts;
        await client.query(
          `UPDATE outbox_events
              SET attempts = $2::int,
                  last_error = $3::text,
                  dead_at = CASE WHEN $4::boolean THEN now() END,
                  next_attempt_at = now() + least(power(2, $2::int) * interval '5 seconds', interval '15 minutes')
            WHERE id = $1`,
          [event.id, attempts, message, dead],
        );
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        if (dead) result.dead += 1;
        else result.retried += 1;
      }
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = rollbackError instanceof Error ? rollbackError : new Error("rollback failed");
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
