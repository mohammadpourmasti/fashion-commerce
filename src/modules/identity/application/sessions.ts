import { and, eq, isNull, lt, ne } from "drizzle-orm";

import type { Database } from "@/shared/db/client";

import { generateSessionToken, hashSessionToken, isWellFormedSessionToken, type IdentityKeys } from "../domain/keys";
import { sessions, users } from "../infrastructure/schema";

export const SESSION_POLICY = {
  absoluteMs: 7 * 24 * 3_600_000,
  idleMs: 8 * 3_600_000,
  rotateAfterMs: 3_600_000,
  touchEveryMs: 60_000,
} as const;

export type RevokeReason = "logout" | "rotated" | "password_changed" | "user_disabled" | "admin" | "expired";

export interface IssuedSession {
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly rotatedAt: Date;
}

export interface SessionMeta {
  readonly userAgent?: string | null;
  readonly ipHash?: string | null;
}

/** Creates a session and returns the raw token once. Only its keyed hash is stored. */
export async function issueSession(
  db: Database,
  keys: IdentityKeys,
  input: { userId: string; now: Date; expiresAt?: Date; rotatedFrom?: string } & SessionMeta,
): Promise<IssuedSession> {
  const token = generateSessionToken();
  const expiresAt = input.expiresAt ?? new Date(input.now.getTime() + SESSION_POLICY.absoluteMs);
  const [row] = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      tokenHash: hashSessionToken(token, keys),
      createdAt: input.now,
      lastSeenAt: input.now,
      rotatedAt: input.now,
      expiresAt,
      rotatedFrom: input.rotatedFrom ?? null,
      userAgent: input.userAgent?.slice(0, 256) ?? null,
      ipHash: input.ipHash ?? null,
    })
    .returning({ id: sessions.id });
  if (!row) throw new Error("session insert returned no row");
  return { token, sessionId: row.id, expiresAt };
}

/**
 * Looks a presented token up. Returns null for anything not currently valid: malformed,
 * unknown, revoked, past the absolute expiry, idle too long, or belonging to a disabled user.
 */
export async function resolveSession(
  db: Database,
  keys: IdentityKeys,
  token: string,
  now: Date,
): Promise<ResolvedSession | null> {
  if (!isWellFormedSessionToken(token)) return null;
  const [row] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      createdAt: sessions.createdAt,
      rotatedAt: sessions.rotatedAt,
      lastSeenAt: sessions.lastSeenAt,
      revokedAt: sessions.revokedAt,
      status: users.status,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashSessionToken(token, keys)))
    .limit(1);
  if (!row || row.revokedAt || row.status !== "active") return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  if (now.getTime() - row.lastSeenAt.getTime() >= SESSION_POLICY.idleMs) return null;

  if (now.getTime() - row.lastSeenAt.getTime() >= SESSION_POLICY.touchEveryMs) {
    await db.update(sessions).set({ lastSeenAt: now }).where(and(eq(sessions.id, row.id), isNull(sessions.revokedAt)));
  }
  return { sessionId: row.id, userId: row.userId, expiresAt: row.expiresAt, createdAt: row.createdAt, rotatedAt: row.rotatedAt };
}

export function shouldRotate(session: ResolvedSession, now: Date): boolean {
  return now.getTime() - session.rotatedAt.getTime() >= SESSION_POLICY.rotateAfterMs;
}

/**
 * Replaces a session with a fresh token, keeping the absolute expiry.
 * Returns null if another request already rotated or revoked it (exactly one wins).
 */
export async function rotateSession(
  db: Database,
  keys: IdentityKeys,
  session: ResolvedSession,
  now: Date,
  meta: SessionMeta = {},
): Promise<IssuedSession | null> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: now, revokedReason: "rotated" })
    .where(and(eq(sessions.id, session.sessionId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  if (revoked.length === 0) return null;
  return issueSession(db, keys, {
    userId: session.userId,
    now,
    expiresAt: session.expiresAt,
    rotatedFrom: session.sessionId,
    ...meta,
  });
}

export async function revokeSession(db: Database, sessionId: string, reason: RevokeReason, now: Date): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

export async function revokeUserSessions(
  db: Database,
  userId: string,
  reason: RevokeReason,
  now: Date,
  exceptSessionId?: string,
): Promise<number> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        ...(exceptSessionId ? [ne(sessions.id, exceptSessionId)] : []),
      ),
    )
    .returning({ id: sessions.id });
  return rows.length;
}

/** Housekeeping: deletes sessions that expired or were revoked more than `retainMs` ago. */
export async function purgeSessions(db: Database, now: Date, retainMs = 30 * 24 * 3_600_000): Promise<number> {
  const cutoff = new Date(now.getTime() - retainMs);
  const rows = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, cutoff))
    .returning({ id: sessions.id });
  return rows.length;
}
