import { eq } from "drizzle-orm";
import type { Pool } from "pg";

import { runInTransaction } from "@/shared/db/transaction";

import { normalizeEmail } from "../domain/email";
import { hmacHex, type IdentityKeys } from "../domain/keys";
import type { PasswordHasher } from "../domain/password";
import { credentials, users } from "../infrastructure/schema";

import { recordAudit } from "./audit";
import { issueSession } from "./sessions";
import { beginAttempt, recordSuccess } from "./throttle";

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly ip: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

export type LoginResult =
  | { readonly ok: true; readonly token: string; readonly expiresAt: Date; readonly userId: string }
  | { readonly ok: false; readonly reason: "invalid_credentials" }
  | { readonly ok: false; readonly reason: "throttled"; readonly retryAfterSeconds: number };

export interface LoginDeps {
  readonly pool: Pool;
  readonly keys: IdentityKeys;
  readonly hasher: PasswordHasher;
  readonly now: () => Date;
}

export const MAX_LOGIN_PASSWORD_LENGTH = 1024;

export function ipHashOf(keys: IdentityKeys, ip: string | null): string {
  return hmacHex(keys.ipHash, ip ?? "unknown");
}

/**
 * Email + password login. Every failure looks the same to the caller (`invalid_credentials`),
 * work is done for unknown accounts too, and attempts are throttled and audited.
 */
export function createLogin({ pool, keys, hasher, now }: LoginDeps) {
  return async function login(input: LoginInput): Promise<LoginResult> {
    const normalized = normalizeEmail(input.email);
    // Throttle on something even for malformed input, without storing it raw.
    const accountSubject = normalized ?? `invalid:${String(input.email).slice(0, 254).toLowerCase()}`;
    const accountKey = hmacHex(keys.throttle, `account:${accountSubject}`);
    const accountIpKey = hmacHex(keys.throttle, `account_ip:${accountSubject}|${input.ip ?? "unknown"}`);
    const ipHash = ipHashOf(keys, input.ip);
    const base = { actor: { type: "anonymous" } as const, ipHash, requestId: input.requestId ?? null };

    const decision = await runInTransaction(pool, async (tx) => {
      const at = now();
      const result = await beginAttempt(tx.db, { accountKey, accountIpKey, now: at });
      if (!result.allowed) {
        await recordAudit(tx.db, { ...base, type: "auth.login", outcome: "throttled", metadata: { retryAfterSeconds: result.retryAfterSeconds }, occurredAt: at });
      }
      return result;
    });
    if (!decision.allowed) return { ok: false, reason: "throttled", retryAfterSeconds: decision.retryAfterSeconds };

    const fail = async (why: string): Promise<LoginResult> => {
      await runInTransaction(pool, (tx) =>
        recordAudit(tx.db, { ...base, type: "auth.login", outcome: "failure", metadata: { why }, occurredAt: now() }),
      );
      return { ok: false, reason: "invalid_credentials" };
    };

    if (typeof input.password !== "string" || input.password.length === 0 || input.password.length > MAX_LOGIN_PASSWORD_LENGTH) {
      await hasher.verifyAgainstDummy("x");
      return fail("bad_input");
    }

    const [row] = normalized
      ? await pool
          .query<{ id: string; status: string; password_hash: string }>(
            "SELECT u.id, u.status, c.password_hash FROM users u JOIN credentials c ON c.user_id = u.id WHERE u.email_normalized = $1",
            [normalized],
          )
          .then((r) => r.rows)
      : [];
    if (!row) {
      await hasher.verifyAgainstDummy(input.password);
      return fail("unknown_account");
    }
    const passwordOk = await hasher.verify(input.password, row.password_hash);
    if (!passwordOk) return fail("wrong_password");
    if (row.status !== "active") return fail("disabled");

    // Rehash with current parameters when the stored ones are older (best effort, inside the success transaction).
    const upgraded = hasher.needsRehash(row.password_hash) ? await hasher.hash(input.password) : null;

    return runInTransaction(pool, async (tx) => {
      const at = now();
      await recordSuccess(tx.db, accountIpKey, at);
      if (upgraded) {
        await tx.db.update(credentials).set({ passwordHash: upgraded }).where(eq(credentials.userId, row.id));
      }
      const [stillActive] = await tx.db.select({ s: users.status }).from(users).where(eq(users.id, row.id)).limit(1);
      if (stillActive?.s !== "active") return { ok: false, reason: "invalid_credentials" } as const;
      const session = await issueSession(tx.db, keys, { userId: row.id, now: at, userAgent: input.userAgent ?? null, ipHash });
      await recordAudit(tx.db, {
        type: "auth.login",
        actor: { type: "user", id: row.id },
        outcome: "success",
        ipHash,
        requestId: input.requestId ?? null,
        metadata: { rehashed: upgraded !== null },
        occurredAt: at,
      });
      return { ok: true, token: session.token, expiresAt: session.expiresAt, userId: row.id } as const;
    });
  };
}
