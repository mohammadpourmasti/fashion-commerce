import { describe, expect, it } from "vitest";

import { InvalidEventError, MAX_EVENT_PAYLOAD_BYTES, validateEvent } from "./outbox";

describe("validateEvent", () => {
  it("accepts a well-formed event", () => {
    expect(() =>
      validateEvent({ type: "inventory.stock.changed", aggregate: { type: "stock", id: "x" }, payload: { qty: 1 } }),
    ).not.toThrow();
  });

  it.each(["", "Inventory.Changed", "1abc", "has space", "a".repeat(129)])("rejects type %j", (type) => {
    expect(() => validateEvent({ type, payload: {} })).toThrow(InvalidEventError);
  });

  it("rejects non-object, array and non-serializable payloads", () => {
    expect(() => validateEvent({ type: "a.b", payload: [] as unknown as Record<string, unknown> })).toThrow(/object/);
    expect(() => validateEvent({ type: "a.b", payload: null as unknown as Record<string, unknown> })).toThrow(/object/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateEvent({ type: "a.b", payload: cyclic })).toThrow(/serializable/);
    expect(() => validateEvent({ type: "a.b", payload: { n: 1n } })).toThrow(/serializable/);
  });

  it("rejects an oversized payload", () => {
    expect(() => validateEvent({ type: "a.b", payload: { blob: "x".repeat(MAX_EVENT_PAYLOAD_BYTES) } })).toThrow(
      /exceeds/,
    );
  });

  it("requires both halves of an aggregate reference", () => {
    expect(() => validateEvent({ type: "a.b", aggregate: { type: "t", id: "" }, payload: {} })).toThrow(/aggregate/);
  });
});
