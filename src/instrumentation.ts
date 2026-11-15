/**
 * Runs once when a server instance boots. Validating env here makes a
 * misconfigured deployment fail fast instead of on the first request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getServerEnv } = await import("@/config/env");
    getServerEnv();
  }
}
