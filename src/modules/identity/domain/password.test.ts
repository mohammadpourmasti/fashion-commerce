import { describe, expect, it } from "vitest";

import { checkPasswordPolicy, createPasswordHasher, DEFAULT_SCRYPT_PARAMS } from "./password";

// Cheap parameters: the tests exercise logic, not the cost of the production setting.
const FAST = { N: 2 ** 10, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const hasher = createPasswordHasher(FAST);

describe("scrypt password hashing", () => {
  it("round-trips and uses the documented format with a fresh salt each time", async () => {
    const a = await hasher.hash("correct horse battery");
    const b = await hasher.hash("correct horse battery");
    expect(a).toMatch(/^scrypt\$N=1024,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    await expect(hasher.verify("correct horse battery", a)).resolves.toBe(true);
    await expect(hasher.verify("correct horse batterY", a)).resolves.toBe(false);
  });

  it("does not leak the password into the stored value", async () => {
    const stored = await hasher.hash("a-very-unique-passphrase-123");
    expect(stored).not.toContain("a-very-unique-passphrase-123");
  });

  it("treats NFC and NFD spellings of the same password as equal", async () => {
    const stored = await hasher.hash("pässwörd-é-long-enough");
    await expect(hasher.verify("pässwörd-é-long-enough", stored)).resolves.toBe(true);
  });

  it.each([
    "", "plaintext", "scrypt$N=1024,r=8,p=1$$", "scrypt$N=1000,r=8,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA",
    "scrypt$N=1024,r=8,p=1$!!!$!!!", "bcrypt$whatever",
  ])("returns false (never throws) for malformed stored value %j", async (stored) => {
    await expect(hasher.verify("anything-at-all-123", stored)).resolves.toBe(false);
  });

  it("refuses absurd cost parameters from a tampered row instead of allocating memory", async () => {
    const stored = `scrypt$N=${2 ** 30},r=8,p=1$c2FsdHNhbHRzYWx0$${"a".repeat(43)}`;
    await expect(hasher.verify("anything-at-all-123", stored)).resolves.toBe(false);
    const bigR = `scrypt$N=1024,r=4096,p=1$c2FsdHNhbHRzYWx0$${"a".repeat(43)}`;
    await expect(hasher.verify("anything-at-all-123", bigR)).resolves.toBe(false);
  });

  it("verifies hashes made with older parameters and flags them for rehash", async () => {
    const old = await createPasswordHasher({ ...FAST, N: 2 ** 9 }).hash("old parameters password");
    await expect(hasher.verify("old parameters password", old)).resolves.toBe(true);
    expect(hasher.needsRehash(old)).toBe(true);
    expect(hasher.needsRehash(await hasher.hash("current parameters password"))).toBe(false);
    expect(hasher.needsRehash("garbage")).toBe(true);
  });

  it("verifyAgainstDummy completes without throwing", async () => {
    await expect(hasher.verifyAgainstDummy("whatever")).resolves.toBeUndefined();
  });

  it("the production defaults match the documented parameters", () => {
    expect(DEFAULT_SCRYPT_PARAMS).toMatchObject({ N: 32768, r: 8, p: 1 });
  });
});

describe("checkPasswordPolicy", () => {
  it("requires 12 to 128 characters, counted as code points", () => {
    expect(checkPasswordPolicy("short")).toEqual(["too_short"]);
    expect(checkPasswordPolicy("a".repeat(12))).toEqual([]);
    expect(checkPasswordPolicy("a".repeat(129))).toEqual(["too_long"]);
    expect(checkPasswordPolicy("😀".repeat(12))).toEqual([]);
  });

  it("refuses the email address or its local part as the password", () => {
    expect(checkPasswordPolicy("administrator@example.com", { email: "Administrator@example.com" })).toContain("same_as_email");
    expect(checkPasswordPolicy("administrator", { email: "administrator@example.com" })).toContain("same_as_email");
    expect(checkPasswordPolicy("a-different-passphrase", { email: "administrator@example.com" })).toEqual([]);
  });
});
