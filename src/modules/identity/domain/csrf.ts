/**
 * CSRF defence for state-changing requests (ADR-017), on top of SameSite=Lax:
 * the request must demonstrably come from our own origin. Stateless, so it needs no token storage.
 *
 *  1. Safe methods (GET, HEAD, OPTIONS) are not checked; they must never change state.
 *  2. Sec-Fetch-Site, when the browser sends it, must be "same-origin".
 *  3. Otherwise Origin must equal the site origin; failing that, the Referer's origin must.
 *  4. No evidence at all means refusal.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface CsrfInput {
  method: string;
  origin?: string | null;
  referer?: string | null;
  secFetchSite?: string | null;
  /** The configured public site URL; its origin is the only one accepted. */
  siteUrl: string;
}

export type CsrfResult = { ok: true } | { ok: false; reason: "cross_site" | "origin_mismatch" | "no_origin" };

const originOf = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.origin === "null" ? null : url.origin;
  } catch {
    return null;
  }
};

export function checkCsrf(input: CsrfInput): CsrfResult {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  const site = originOf(input.siteUrl);
  if (!site) return { ok: false, reason: "origin_mismatch" };

  if (input.secFetchSite) {
    return input.secFetchSite === "same-origin" ? { ok: true } : { ok: false, reason: "cross_site" };
  }
  if (input.origin) {
    return originOf(input.origin) === site ? { ok: true } : { ok: false, reason: "origin_mismatch" };
  }
  if (input.referer) {
    return originOf(input.referer) === site ? { ok: true } : { ok: false, reason: "origin_mismatch" };
  }
  return { ok: false, reason: "no_origin" };
}
