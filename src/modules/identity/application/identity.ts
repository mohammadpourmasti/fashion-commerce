import type { Pool } from "pg";

import { getServerEnv } from "@/config/env";
import { createDatabase, getPool } from "@/shared/db/client";
import type { Authorizer } from "@/shared/kernel/authorization";

import { identityCatalog } from "../domain/catalog";
import { resolveCookiePolicy } from "../domain/cookie";
import { deriveKeys } from "../domain/keys";
import { createPasswordHasher, DEFAULT_SCRYPT_PARAMS, type PasswordHasher, type ScryptParams } from "../domain/password";

import { createAuthorizer } from "./authorizer";
import { syncAuthorizationCatalog } from "./catalog-sync";
import { createContextFactory } from "./context";
import { createLogin } from "./login";
import { purgeSessions } from "./sessions";
import { purgeThrottle } from "./throttle";
import { createUserService } from "./users";

export interface IdentityOptions {
  readonly pool: Pool;
  readonly authSecret: string;
  readonly siteUrl: string;
  readonly hasher?: PasswordHasher;
  readonly scrypt?: ScryptParams;
  readonly now?: () => Date;
}

/** Composition of the identity module. Everything is injected, so tests use a throwaway database and a fake clock. */
export function createIdentity(options: IdentityOptions) {
  const now = options.now ?? (() => new Date());
  const keys = deriveKeys(options.authSecret);
  const cookie = resolveCookiePolicy(options.siteUrl);
  const hasher = options.hasher ?? createPasswordHasher(options.scrypt ?? DEFAULT_SCRYPT_PARAMS);
  const authorizer: Authorizer = createAuthorizer(createDatabase(options.pool));
  const contexts = createContextFactory({ pool: options.pool, keys, cookie, now, authorizer });

  return {
    cookiePolicy: cookie,
    authorizer,
    login: createLogin({ pool: options.pool, keys, hasher, now }),
    authenticate: contexts.authenticate,
    logout: contexts.logout,
    users: createUserService({ pool: options.pool, hasher, now }),
    syncCatalog: (catalog = identityCatalog) => syncAuthorizationCatalog(options.pool, catalog),
    /** Housekeeping, safe to run from a scheduled job. */
    async purge(): Promise<{ throttle: number; sessions: number }> {
      const db = createDatabase(options.pool);
      const at = now();
      return { throttle: await purgeThrottle(db, at), sessions: await purgeSessions(db, at) };
    },
  };
}

export type Identity = ReturnType<typeof createIdentity>;

const globalForIdentity = globalThis as typeof globalThis & { __fashionCommerceIdentity?: Identity };

/** Process-wide instance built from the validated server environment. */
export function getIdentity(): Identity {
  if (!globalForIdentity.__fashionCommerceIdentity) {
    const env = getServerEnv();
    if (!env.AUTH_SECRET) throw new Error("AUTH_SECRET is required for authentication");
    globalForIdentity.__fashionCommerceIdentity = createIdentity({
      pool: getPool(),
      authSecret: env.AUTH_SECRET,
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
    });
  }
  return globalForIdentity.__fashionCommerceIdentity;
}
