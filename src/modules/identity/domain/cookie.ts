/**
 * Session cookie rules (ADR-017).
 *
 *  HTTPS (production):          __Host-session; Secure; Path=/; no Domain; HttpOnly; SameSite=Lax
 *  HTTP on loopback (dev only): session;        no Secure; Path=/; no Domain; HttpOnly; SameSite=Lax
 *
 * The `__Host-` prefix makes browsers refuse the cookie unless it is Secure, has Path=/ and
 * has no Domain, so it cannot be planted from a sibling subdomain. Browser behaviour for
 * Secure cookies on localhost is deliberately not relied on: loopback HTTP uses the plain name.
 */

export const SECURE_COOKIE_NAME = "__Host-session";
export const LOOPBACK_COOKIE_NAME = "session";

export class InsecureSiteUrlError extends Error {
  constructor(siteUrl: string) {
    super(
      `NEXT_PUBLIC_SITE_URL must use https:// in production (got "${new URL(siteUrl).origin}"). ` +
        "Plain http is only accepted for localhost, 127.0.0.1 and [::1].",
    );
    this.name = "InsecureSiteUrlError";
  }
}

export interface CookiePolicy {
  readonly name: string;
  readonly secure: boolean;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");
}

/** Chooses the cookie name and flags from the public site URL. Throws for http on a non-loopback host. */
export function resolveCookiePolicy(siteUrl: string): CookiePolicy {
  const url = new URL(siteUrl);
  if (url.protocol === "https:") return { name: SECURE_COOKIE_NAME, secure: true };
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return { name: LOOPBACK_COOKIE_NAME, secure: false };
  throw new InsecureSiteUrlError(siteUrl);
}

/** Startup check: in production the site URL must be https, or http on loopback (local smoke tests). */
export function assertSecureSiteUrl(siteUrl: string, nodeEnv: string | undefined): void {
  if (nodeEnv === "production") resolveCookiePolicy(siteUrl);
}

export function buildSessionCookie(policy: CookiePolicy, token: string, expiresAt: Date, now: Date): string {
  if (policy.name.startsWith("__Host-") && !policy.secure) {
    throw new Error("A __Host- cookie must be Secure");
  }
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  const parts = [
    `${policy.name}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (policy.secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearCookie(policy: CookiePolicy): string {
  const parts = [`${policy.name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (policy.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Returns the session token from a Cookie header, or null when absent or ambiguous (the name appearing twice). */
export function readSessionCookie(cookieHeader: string | null | undefined, policy: CookiePolicy): string | null {
  if (!cookieHeader) return null;
  let found: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== policy.name) continue;
    if (found !== null) return null;
    found = part.slice(index + 1).trim();
  }
  return found || null;
}
