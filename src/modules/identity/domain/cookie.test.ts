import { describe, expect, it } from "vitest";

import {
  assertSecureSiteUrl,
  buildClearCookie,
  buildSessionCookie,
  InsecureSiteUrlError,
  isLoopbackHost,
  readSessionCookie,
  resolveCookiePolicy,
} from "./cookie";

const NOW = new Date("2026-01-01T00:00:00Z");
const LATER = new Date("2026-01-01T08:00:00Z");
const TOKEN = "T".repeat(43);

describe("resolveCookiePolicy", () => {
  it("https uses __Host-session with Secure", () => {
    expect(resolveCookiePolicy("https://shop.example.com")).toEqual({ name: "__Host-session", secure: true });
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "http://dev.localhost:3000"])(
    "http on loopback (%s) uses the plain name without Secure",
    (url) => {
      expect(resolveCookiePolicy(url)).toEqual({ name: "session", secure: false });
    },
  );

  it.each(["http://shop.example.com", "http://192.168.1.10:3000", "http://localhost.evil.com"])(
    "http on a non-loopback host (%s) is refused",
    (url) => {
      expect(() => resolveCookiePolicy(url)).toThrow(InsecureSiteUrlError);
    },
  );

  it("isLoopbackHost is exact, not a substring match", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("notlocalhost")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.com")).toBe(false);
  });
});

describe("assertSecureSiteUrl (startup check)", () => {
  it("production: https and loopback http pass, other http fails", () => {
    expect(() => assertSecureSiteUrl("https://shop.example.com", "production")).not.toThrow();
    expect(() => assertSecureSiteUrl("http://localhost:3000", "production")).not.toThrow();
    expect(() => assertSecureSiteUrl("http://shop.example.com", "production")).toThrow(/https/);
  });

  it("development and test do not enforce it", () => {
    expect(() => assertSecureSiteUrl("http://shop.example.com", "development")).not.toThrow();
    expect(() => assertSecureSiteUrl("http://shop.example.com", "test")).not.toThrow();
    expect(() => assertSecureSiteUrl("http://shop.example.com", undefined)).not.toThrow();
  });
});

describe("buildSessionCookie", () => {
  const attributes = (cookie: string) => cookie.split("; ").slice(1);

  it("production cookie: __Host- name, Secure, Path=/, HttpOnly, SameSite=Lax, no Domain", () => {
    const cookie = buildSessionCookie({ name: "__Host-session", secure: true }, TOKEN, LATER, NOW);
    expect(cookie.startsWith(`__Host-session=${TOKEN};`)).toBe(true);
    expect(attributes(cookie)).toEqual(
      expect.arrayContaining(["Path=/", "HttpOnly", "SameSite=Lax", "Secure", "Max-Age=28800"]),
    );
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("loopback http cookie: plain name and no Secure", () => {
    const cookie = buildSessionCookie({ name: "session", secure: false }, TOKEN, LATER, NOW);
    expect(cookie.startsWith(`session=${TOKEN};`)).toBe(true);
    expect(cookie).not.toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it("refuses to build a __Host- cookie that is not Secure", () => {
    expect(() => buildSessionCookie({ name: "__Host-session", secure: false }, TOKEN, LATER, NOW)).toThrow(/Secure/);
  });

  it("never emits a negative Max-Age", () => {
    expect(buildSessionCookie({ name: "session", secure: false }, TOKEN, NOW, LATER)).toMatch(/Max-Age=0/);
  });

  it("the clearing cookie expires immediately with the same name and flags", () => {
    const cookie = buildClearCookie({ name: "__Host-session", secure: true });
    expect(cookie).toMatch(/^__Host-session=;/);
    expect(cookie).toMatch(/Max-Age=0/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/Path=\//);
  });
});

describe("readSessionCookie", () => {
  const policy = { name: "__Host-session", secure: true };

  it("finds the cookie among others", () => {
    expect(readSessionCookie(`a=1; __Host-session=${TOKEN}; b=2`, policy)).toBe(TOKEN);
  });

  it("returns null when absent, empty, or for another cookie name", () => {
    expect(readSessionCookie(null, policy)).toBeNull();
    expect(readSessionCookie("", policy)).toBeNull();
    expect(readSessionCookie(`session=${TOKEN}`, policy)).toBeNull();
    expect(readSessionCookie("__Host-session=", policy)).toBeNull();
  });

  it("returns null when the name appears twice (ambiguous)", () => {
    expect(readSessionCookie(`__Host-session=${TOKEN}; __Host-session=other`, policy)).toBeNull();
  });
});
