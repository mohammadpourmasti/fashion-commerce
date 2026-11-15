import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  // Mirrors the `@/*` path alias in tsconfig.json.
  "@": fileURLToPath(new URL("./src", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    unstubEnvs: true,
    unstubGlobals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.int.test.ts"],
        },
      },
      {
        // Real PostgreSQL. Needs TEST_DATABASE_URL (see .env.example); each test
        // file works in its own throwaway database. Run with `npm run test:db`.
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.int.test.ts"],
          globalSetup: ["./src/shared/db/testing/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
