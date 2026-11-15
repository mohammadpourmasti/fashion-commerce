/**
 * Runs once when a server instance boots. Validating env here makes a
 * misconfigured deployment fail fast instead of on the first request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getServerEnv } = await import("@/config/env");
    const env = getServerEnv();
    // Production must serve the session cookie over HTTPS (ADR-017); refuse to boot otherwise.
    const { assertSecureSiteUrl } = await import("@/modules/identity");
    assertSecureSiteUrl(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000", env.NODE_ENV);
  }
}
