import type { Database } from "@/shared/db/client";

import { auditEvents } from "../infrastructure/schema";

export interface AuditEntry {
  /** Dotted lowercase, e.g. `auth.login`. */
  readonly type: string;
  readonly actor: { readonly type: "anonymous" | "user" | "system"; readonly id?: string };
  readonly subject?: { readonly type: string; readonly id: string };
  readonly outcome: "success" | "failure" | "denied" | "throttled";
  readonly ipHash?: string | null;
  readonly requestId?: string | null;
  /** Small, non-secret facts. Never passwords, tokens, hashes or raw attempted emails. */
  readonly metadata?: Record<string, string | number | boolean | null>;
  readonly occurredAt?: Date;
}

/** Appends an audit event using the caller's handle (so it commits with the caller's transaction). */
export async function recordAudit(db: Database, entry: AuditEntry): Promise<void> {
  await db.insert(auditEvents).values({
    type: entry.type,
    actorType: entry.actor.type,
    actorId: entry.actor.id ?? null,
    subjectType: entry.subject?.type ?? null,
    subjectId: entry.subject?.id ?? null,
    outcome: entry.outcome,
    ipHash: entry.ipHash ?? null,
    requestId: entry.requestId?.slice(0, 128) ?? null,
    metadata: entry.metadata ?? {},
    ...(entry.occurredAt ? { occurredAt: entry.occurredAt } : {}),
  });
}
