import { describe, expect, it } from "vitest";

import { delayForExcess, THROTTLE } from "./throttle-policy";

describe("throttle policy", () => {
  it("uses the approved limits", () => {
    expect(THROTTLE.accountIpMaxFailures).toBe(5);
    expect(THROTTLE.accountIpWindowMs).toBe(15 * 60_000);
    expect(THROTTLE.accountMaxAttempts).toBe(100);
    expect(THROTTLE.accountWindowMs).toBe(60 * 60_000);
    expect(THROTTLE.maxDelayMs).toBe(15 * 60_000);
  });

  it("doubles from 30 seconds and is capped at 15 minutes", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => delayForExcess(n) / 1000)).toEqual([30, 60, 120, 240, 480, 900]);
    expect(delayForExcess(7)).toBe(15 * 60_000);
    expect(delayForExcess(10_000)).toBe(15 * 60_000);
    expect(delayForExcess(Number.MAX_SAFE_INTEGER)).toBe(15 * 60_000);
  });

  it("is zero for no excess", () => {
    expect(delayForExcess(0)).toBe(0);
    expect(delayForExcess(-3)).toBe(0);
    expect(delayForExcess(Number.NaN)).toBe(0);
  });
});
