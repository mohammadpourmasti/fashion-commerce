import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `env.ts` validates the public variables when it is imported, so each test
 * stubs the environment, resets the module cache and imports it fresh.
 */

const managedKeys = [
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_DEFAULT_CURRENCY",
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "DB_APP_ROLE",
  "DATABASE_POOL_MAX",
  "AUTH_SECRET",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

async function loadEnv(values: Partial<Record<(typeof managedKeys)[number], string>> = {}) {
  vi.resetModules();
  for (const key of managedKeys) vi.stubEnv(key, values[key] ?? "");
  return import("./env");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("publicEnv", () => {
  it("falls back to defaults when variables are unset or empty", async () => {
    const { publicEnv } = await loadEnv();
    expect(publicEnv).toEqual({
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
      NEXT_PUBLIC_DEFAULT_CURRENCY: "IRR",
    });
  });

  it("accepts valid values", async () => {
    const { publicEnv } = await loadEnv({
      NEXT_PUBLIC_SITE_URL: "https://shop.example.com",
      NEXT_PUBLIC_DEFAULT_CURRENCY: "USD",
    });
    expect(publicEnv.NEXT_PUBLIC_SITE_URL).toBe("https://shop.example.com");
    expect(publicEnv.NEXT_PUBLIC_DEFAULT_CURRENCY).toBe("USD");
  });

  it.each(["IRR", "USD", "EUR", "AED"])("accepts currency %s", async (currency) => {
    const { publicEnv } = await loadEnv({ NEXT_PUBLIC_DEFAULT_CURRENCY: currency });
    expect(publicEnv.NEXT_PUBLIC_DEFAULT_CURRENCY).toBe(currency);
  });

  it("rejects an unsupported currency with a readable message", async () => {
    await expect(loadEnv({ NEXT_PUBLIC_DEFAULT_CURRENCY: "GBP" })).rejects.toThrow(
      /Invalid public environment variables[\s\S]*NEXT_PUBLIC_DEFAULT_CURRENCY/,
    );
  });

  it("rejects a malformed site URL", async () => {
    await expect(loadEnv({ NEXT_PUBLIC_SITE_URL: "not a url" })).rejects.toThrow(
      /NEXT_PUBLIC_SITE_URL/,
    );
  });
});

describe("getServerEnv", () => {
  it("treats every integration variable as optional", async () => {
    const { getServerEnv } = await loadEnv();
    const env = getServerEnv();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AUTH_SECRET).toBeUndefined();
    expect(env.S3_BUCKET).toBeUndefined();
  });

  it("reads NODE_ENV (the test runner sets it to \"test\")", async () => {
    const { getServerEnv } = await loadEnv();
    expect(getServerEnv().NODE_ENV).toBe("test");
  });

  it("accepts postgres:// and postgresql:// URLs", async () => {
    for (const url of [
      "postgres://user:pw@localhost:5432/db",
      "postgresql://user:pw@localhost:5432/db",
    ]) {
      const { getServerEnv } = await loadEnv({ DATABASE_URL: url });
      expect(getServerEnv().DATABASE_URL).toBe(url);
    }
  });

  it("rejects a non-PostgreSQL DATABASE_URL", async () => {
    const { getServerEnv } = await loadEnv({ DATABASE_URL: "mysql://user:pw@localhost:3306/db" });
    expect(() => getServerEnv()).toThrow(/DATABASE_URL: Must be a PostgreSQL connection URL/);
  });

  it("rejects an AUTH_SECRET shorter than 32 characters", async () => {
    const { getServerEnv } = await loadEnv({ AUTH_SECRET: "too-short" });
    expect(() => getServerEnv()).toThrow(/AUTH_SECRET must be at least 32 characters/);
  });

  it("rejects an AUTH_SECRET of 31 characters (boundary)", async () => {
    const { getServerEnv } = await loadEnv({ AUTH_SECRET: "x".repeat(31) });
    expect(() => getServerEnv()).toThrow(/AUTH_SECRET/);
  });

  it("accepts an AUTH_SECRET of 32 characters", async () => {
    const secret = "x".repeat(32);
    const { getServerEnv } = await loadEnv({ AUTH_SECRET: secret });
    expect(getServerEnv().AUTH_SECRET).toBe(secret);
  });

  it("validates the S3 endpoint as a URL", async () => {
    const { getServerEnv } = await loadEnv({ S3_ENDPOINT: "storage.internal" });
    expect(() => getServerEnv()).toThrow(/S3_ENDPOINT/);
  });

  it("validates the migration URL, app role and pool size", async () => {
    const ok = await loadEnv({
      MIGRATION_DATABASE_URL: "postgresql://owner@db.internal:5432/app",
      DB_APP_ROLE: "fashion_app",
      DATABASE_POOL_MAX: "20",
    });
    expect(ok.getServerEnv()).toMatchObject({ DB_APP_ROLE: "fashion_app", DATABASE_POOL_MAX: 20 });

    const bad = await loadEnv({
      MIGRATION_DATABASE_URL: "mysql://x/y",
      DB_APP_ROLE: "Fashion App",
      DATABASE_POOL_MAX: "0",
    });
    expect(() => bad.getServerEnv()).toThrow(
      /MIGRATION_DATABASE_URL[\s\S]*DB_APP_ROLE[\s\S]*DATABASE_POOL_MAX/,
    );
  });

  it("lists every invalid variable in one error", async () => {
    const { getServerEnv } = await loadEnv({ DATABASE_URL: "http://x", AUTH_SECRET: "short" });
    expect(() => getServerEnv()).toThrow(/Invalid server environment variables[\s\S]*DATABASE_URL[\s\S]*AUTH_SECRET/);
  });

  it("caches the first successful result", async () => {
    const { getServerEnv } = await loadEnv({ S3_BUCKET: "first" });
    const first = getServerEnv();
    vi.stubEnv("S3_BUCKET", "second");
    expect(getServerEnv()).toBe(first);
    expect(getServerEnv().S3_BUCKET).toBe("first");
  });

  it("refuses to run in the browser", async () => {
    const { getServerEnv } = await loadEnv();
    vi.stubGlobal("window", {});
    expect(() => getServerEnv()).toThrow(/must not be called in the browser/);
  });
});
