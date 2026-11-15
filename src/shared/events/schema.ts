import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Table definitions for the transactional outbox. The SQL in
// drizzle/0001_foundation is the source of truth for the database; a test
// compares this file with the migrated schema so the two cannot drift.
// Keep this file free of `@/` imports: drizzle-kit loads it outside Next.js.

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    type: text("type").notNull(),
    aggregateType: text("aggregate_type"),
    aggregateId: text("aggregate_id"),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deadAt: timestamp("dead_at", { withTimezone: true }),
  },
  (table) => [
    check("outbox_events_type_format", sql`${table.type} ~ '^[a-z][a-z0-9_.-]{0,127}$'`),
    check("outbox_events_payload_is_object", sql`jsonb_typeof(${table.payload}) = 'object'`),
    check(
      "outbox_events_aggregate_pair",
      sql`(${table.aggregateType} IS NULL) = (${table.aggregateId} IS NULL)`,
    ),
    check("outbox_events_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check(
      "outbox_events_not_published_and_dead",
      sql`NOT (${table.publishedAt} IS NOT NULL AND ${table.deadAt} IS NOT NULL)`,
    ),
    index("outbox_events_pending_idx")
      .on(table.nextAttemptAt, table.id)
      .where(sql`${table.publishedAt} IS NULL AND ${table.deadAt} IS NULL`),
  ],
);

export const handledEvents = pgTable(
  "handled_events",
  {
    consumer: text("consumer").notNull(),
    eventId: uuid("event_id").notNull(),
    handledAt: timestamp("handled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.consumer, table.eventId] }),
    check("handled_events_consumer_format", sql`${table.consumer} ~ '^[a-z][a-z0-9_.-]{0,63}$'`),
  ],
);
