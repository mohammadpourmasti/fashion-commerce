/** Approved limits (ADR-017). Changing them is a decision, not a tuning knob. */
export const THROTTLE = {
  /** Failures allowed per account + client address within the window. The next attempt is refused. */
  accountIpMaxFailures: 5,
  accountIpWindowMs: 15 * 60_000,
  /** Attempts of any kind per account within the window, whatever the address. */
  accountMaxAttempts: 100,
  accountWindowMs: 60 * 60_000,
  /** First refusal lasts this long and doubles with each further refusal, up to the cap. */
  baseDelayMs: 30_000,
  maxDelayMs: 15 * 60_000,
} as const;

/** `excess` is 1 for the first refused attempt, 2 for the next, and so on. */
export function delayForExcess(excess: number): number {
  if (!Number.isFinite(excess) || excess < 1) return 0;
  // Clamp the exponent first so large counters cannot overflow.
  return Math.min(THROTTLE.maxDelayMs, THROTTLE.baseDelayMs * 2 ** Math.min(excess - 1, 16));
}
