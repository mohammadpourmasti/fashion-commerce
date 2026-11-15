import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against the production build (`next start`), so
 * `npm run build` must have completed first. Port 3100 keeps them clear of a
 * dev server on 3000. Playwright starts its own server and never reuses one.
 *
 * PLAYWRIGHT_CHANNEL (e.g. "chrome") runs the tests in an installed browser
 * instead of the bundled Chromium; CI does not set it.
 */
const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : undefined,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: process.env.PLAYWRIGHT_CHANNEL || undefined },
    },
  ],
  webServer: {
    command: `npm run start -- --port ${port}`,
    url: `${baseURL}/fa`,
    // Always start a fresh server: reusing one could silently test a stale build.
    // If the port is taken the run fails loudly; stop the old process or set E2E_PORT.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
