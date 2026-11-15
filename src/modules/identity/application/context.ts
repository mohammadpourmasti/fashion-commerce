import type { Pool } from "pg";

import { ANONYMOUS, createRequestContext, type Actor, type RequestContext } from "@/shared/kernel/authorization";
import { runInTransaction } from "@/shared/db/transaction";

import { buildClearCookie, buildSessionCookie, readSessionCookie, type CookiePolicy } from "../domain/cookie";
import type { IdentityKeys } from "../domain/keys";

import { recordAudit } from "./audit";
import { ipHashOf } from "./login";
import { resolveSession, revokeSession, rotateSession, shouldRotate } from "./sessions";
import type { Authorizer } from "@/shared/kernel/authorization";

export interface ContextDeps {
  readonly pool: Pool;
  readonly keys: IdentityKeys;
  readonly cookie: CookiePolicy;
  readonly now: () => Date;
  readonly authorizer: Authorizer;
}

export interface AuthenticatedRequest {
  readonly context: RequestContext;
  /** `Set-Cookie` values the response must carry (a rotated session, or clearing a dead one). */
  readonly setCookies: readonly string[];
}

export interface AuthenticateInput {
  readonly cookieHeader: string | null;
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent?: string | null;
}

export function createContextFactory(deps: ContextDeps) {
  const { pool, keys, cookie, now, authorizer } = deps;

  function build(input: AuthenticateInput, actor: Actor): RequestContext {
    return createRequestContext({
      requestId: input.requestId,
      actor,
      ip: input.ip,
      authorizer,
      onDenied: async ({ actor: who, permission, scope, code }) => {
        // Best effort: a failure to audit must never change the decision.
        await runInTransaction(pool, (tx) =>
          recordAudit(tx.db, {
            type: "authz.denied",
            actor: who.kind === "user" ? { type: "user", id: who.userId } : { type: who.kind === "system" ? "system" : "anonymous" },
            outcome: "denied",
            ipHash: ipHashOf(keys, input.ip),
            requestId: input.requestId,
            metadata: { permission, scope: "id" in scope ? `${scope.type}:${scope.id}` : "global", code },
            occurredAt: now(),
          }),
        );
      },
    });
  }

  return {
    /** Turns the request's cookie into a RequestContext. Never throws for a bad or expired cookie. */
    async authenticate(input: AuthenticateInput): Promise<AuthenticatedRequest> {
      const token = readSessionCookie(input.cookieHeader, cookie);
      if (!token) return { context: build(input, ANONYMOUS), setCookies: [] };
      const at = now();
      const session = await runInTransaction(pool, (tx) => resolveSession(tx.db, keys, token, at));
      if (!session) return { context: build(input, ANONYMOUS), setCookies: [buildClearCookie(cookie)] };

      const setCookies: string[] = [];
      let sessionId = session.sessionId;
      if (shouldRotate(session, at)) {
        const issued = await runInTransaction(pool, (tx) =>
          rotateSession(tx.db, keys, session, at, { userAgent: input.userAgent ?? null, ipHash: ipHashOf(keys, input.ip) }),
        );
        if (issued) {
          sessionId = issued.sessionId;
          setCookies.push(buildSessionCookie(cookie, issued.token, issued.expiresAt, at));
        } else {
          // Another request rotated it first; this token is dead now.
          return { context: build(input, ANONYMOUS), setCookies: [buildClearCookie(cookie)] };
        }
      }
      return { context: build(input, { kind: "user", userId: session.userId, sessionId }), setCookies };
    },

    /** Ends the current session. Returns the cookie that clears it from the browser. */
    async logout(context: RequestContext): Promise<{ setCookies: readonly string[] }> {
      if (context.actor.kind === "user") {
        const { sessionId, userId } = context.actor;
        await runInTransaction(pool, async (tx) => {
          const at = now();
          await revokeSession(tx.db, sessionId, "logout", at);
          await recordAudit(tx.db, { type: "auth.logout", actor: { type: "user", id: userId }, outcome: "success", ipHash: ipHashOf(keys, context.ip), requestId: context.requestId, occurredAt: at });
        });
      }
      return { setCookies: [buildClearCookie(cookie)] };
    },
  };
}
