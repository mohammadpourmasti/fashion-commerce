import { describe, expect, it } from "vitest";

import { constantTimeEqual, deriveKeys, generateSessionToken, hashSessionToken, hmacHex, isWellFormedSessionToken } from "./keys";

const SECRET = "x".repeat(40);

describe("deriveKeys", () => {
  it("rejects short secrets", () => {
    expect(() => deriveKeys("short")).toThrow(/at least 32/);
  });

  it("is deterministic, and every purpose gets its own key", () => {
    const a = deriveKeys(SECRET);
    const b = deriveKeys(SECRET);
    expect(a.sessionToken.equals(b.sessionToken)).toBe(true);
    expect(a.sessionToken.length).toBe(32);
    expect(a.sessionToken.equals(a.throttle)).toBe(false);
    expect(a.throttle.equals(a.ipHash)).toBe(false);
    expect(a.sessionToken.equals(deriveKeys("y".repeat(40)).sessionToken)).toBe(false);
  });
});

describe("session tokens", () => {
  it("are 256 random bits in unpadded base64url", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url").length).toBe(32);
    expect(isWellFormedSessionToken(token)).toBe(true);
  });

  it("do not repeat", () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => generateSessionToken()));
    expect(tokens.size).toBe(2000);
  });

  it("reject malformed input before any hashing", () => {
    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}!`, " ".repeat(43)]) {
      expect(isWellFormedSessionToken(bad)).toBe(false);
    }
  });

  it("are stored as a keyed HMAC-SHA256: deterministic per key, different across keys, not the token", () => {
    const keys = deriveKeys(SECRET);
    const token = generateSessionToken();
    const hash = hashSessionToken(token, keys);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashSessionToken(token, keys));
    expect(hash).not.toBe(hashSessionToken(token, deriveKeys("z".repeat(40))));
    expect(hash).not.toContain(token);
    expect(hash).toBe(hmacHex(keys.sessionToken, token));
  });
});

describe("constantTimeEqual", () => {
  it("compares equal and unequal strings, including different lengths", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
