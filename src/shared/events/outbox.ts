import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { outboxEvents } from "./schema";

/** Writes events inside the caller's transaction. There is no way to publish outside one. */

export interface DomainEventInput {
  /** Dotted lowercase name, e.g. `inventory.stock.changed`. */
  type: string;
  aggregate?: { type: string; id: string };
  /** JSON object. Keep it small and free of secrets or personal data. */
  payload: Record<string, unknown>;
}

export interface EventWriter {
  /** Inserts the event in the current transaction and returns its id. */
  add(event: DomainEventInput): Promise<string>;
}

export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEventError";
  }
}

export function validateEvent(event: DomainEventInput): string {
  if (!EVENT_TYPE_PATTERN.test(event.type)) {
    throw new InvalidEventError(`Invalid event type "${event.type}": use dotted lowercase names.`);
  }
  if (event.aggregate && (!event.aggregate.type || !event.aggregate.id)) {
    throw new InvalidEventError("An event aggregate needs both a type and an id.");
  }
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw new InvalidEventError("Event payload must be a JSON object.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(event.payload);
  } catch {
    throw new InvalidEventError("Event payload must be JSON-serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    throw new InvalidEventError(`Event payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes.`);
  }
  return serialized;
}

export function createEventWriter(db: NodePgDatabase): EventWriter {
  return {
    async add(event) {
      validateEvent(event);
      const [row] = await db
        .insert(outboxEvents)
        .values({
          type: event.type,
          aggregateType: event.aggregate?.type ?? null,
          aggregateId: event.aggregate?.id ?? null,
          payload: event.payload,
        })
        .returning({ id: outboxEvents.id });
      if (!row) throw new Error("Failed to insert outbox event");
      return row.id;
    },
  };
}
