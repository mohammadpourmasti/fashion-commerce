import { and, eq, inArray, lt, sql } from "drizzle-orm";

import type { Database } from "@/shared/db/client";

import { delayForExcess, THROTTLE } from "../domain/throttle-policy";
import { authThrottle } from "../infrastructure/schema";

export type AttemptDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

interface Row {
  scope: string;
  keyHash: string;
  windowStartedAt: Date;
  count: number;
  blockedUntil: Date | null;
}

interface Rule {
  readonly scope: "account" | "account_ip";
  readonly limit: number;
  readonly windowMs: number;
}

const ACCOUNT_RULE: Rule = { scope: "account", limit: THROTTLE.accountMaxAttempts, windowMs: THROTTLE.accountWindowMs };
const ACCOUNT_IP_RULE: Rule = { scope: "account_ip", limit: THROTTLE.accountIpMaxFailures, windowMs: THROTTLE.accountIpWindowMs };

/**
 * Decides one rule against its (already locked) row and returns the new row state.
 * Waiting out a block pays for exactly one further attempt; refused attempts never count.
 */
function evaluate(row: Row, rule: Rule, now: Date): { next: Row; refusedForMs: number } {
  const next = { ...row };
  if (next.blockedUntil && next.blockedUntil.getTime() > now.getTime()) {
    return { next, refusedForMs: next.blockedUntil.getTime() - now.getTime() };
  }
  if (now.getTime() - next.windowStartedAt.getTime() >= rule.windowMs) {
    next.windowStartedAt = now;
    next.count = 0;
    next.blockedUntil = null;
  }
  if (next.blockedUntil) {
    // The imposed wait has elapsed: let one attempt through.
    next.blockedUntil = null;
    next.count += 1;
    return { next, refusedForMs: 0 };
  }
  if (next.count >= rule.limit) {
    const delay = delayForExcess(next.count - rule.limit + 1);
    next.blockedUntil = new Date(now.getTime() + delay);
    return { next, refusedForMs: delay };
  }
  next.count += 1;
  return { next, refusedForMs: 0 };
}

async function lockRows(db: Database, accountKey: string, accountIpKey: string, now: Date): Promise<Map<string, Row>> {
  for (const [scope, keyHash] of [["account", accountKey], ["account_ip", accountIpKey]] as const) {
    await db
      .insert(authThrottle)
      .values({ scope, keyHash, windowStartedAt: now, updatedAt: now })
      .onConflictDoNothing();
  }
  // One statement, fixed lock order (scope ascending) so concurrent attempts cannot deadlock.
  const rows = await db
    .select()
    .from(authThrottle)
    .where(
      sql`(${authThrottle.scope}, ${authThrottle.keyHash}) IN (('account', ${accountKey}), ('account_ip', ${accountIpKey}))`,
    )
    .orderBy(authThrottle.scope)
    .for("update");
  return new Map(rows.map((r) => [r.scope, r]));
}

/**
 * Reserves one login attempt. The failure is counted up front (pessimistically), so
 * concurrent guesses cannot all slip through before the first one is recorded.
 * Must run in its own committed transaction before the password is checked.
 */
export async function beginAttempt(
  db: Database,
  input: { accountKey: string; accountIpKey: string; now: Date },
): Promise<AttemptDecision> {
  const { accountKey, accountIpKey, now } = input;
  const rows = await lockRows(db, accountKey, accountIpKey, now);
  const accountRow = rows.get("account");
  const ipRow = rows.get("account_ip");
  if (!accountRow || !ipRow) throw new Error("throttle rows missing after upsert");

  const account = evaluate(accountRow, ACCOUNT_RULE, now);
  await save(db, account.next, now);
  if (account.refusedForMs > 0) return refuse(account.refusedForMs);

  const pair = evaluate(ipRow, ACCOUNT_IP_RULE, now);
  await save(db, pair.next, now);
  if (pair.refusedForMs > 0) {
    // The account counter must not be consumed by an attempt that was refused.
    await save(db, { ...account.next, count: Math.max(0, account.next.count - 1) }, now);
    return refuse(pair.refusedForMs);
  }
  return { allowed: true };
}

function refuse(ms: number): AttemptDecision {
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(ms / 1000)) };
}

async function save(db: Database, row: Row, now: Date): Promise<void> {
  await db
    .update(authThrottle)
    .set({ windowStartedAt: row.windowStartedAt, count: row.count, blockedUntil: row.blockedUntil, updatedAt: now })
    .where(and(eq(authThrottle.scope, row.scope), eq(authThrottle.keyHash, row.keyHash)));
}

/** A correct password clears the failure counter for that account and address. */
export async function recordSuccess(db: Database, accountIpKey: string, now: Date): Promise<void> {
  await db
    .update(authThrottle)
    .set({ count: 0, blockedUntil: null, windowStartedAt: now, updatedAt: now })
    .where(and(eq(authThrottle.scope, "account_ip"), eq(authThrottle.keyHash, accountIpKey)));
}

/** Housekeeping: removes rows not touched for `olderThanMs` and not currently blocking. */
export async function purgeThrottle(db: Database, now: Date, olderThanMs = 24 * 3_600_000): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const removed = await db
    .delete(authThrottle)
    .where(and(lt(authThrottle.updatedAt, cutoff), inArray(authThrottle.scope, ["account", "account_ip"])))
    .returning({ k: authThrottle.keyHash });
  return removed.length;
}
