import { hkdfSync, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const MIN_SECRET_LENGTH = 32;

export interface IdentityKeys {
  readonly sessionToken: Buffer;
  readonly throttle: Buffer;
  readonly ipHash: Buffer;
}

/** Separate keys per purpose, derived from AUTH_SECRET with HKDF, so one leak never reuses a key elsewhere. */
export function deriveKeys(secret: string): IdentityKeys {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", secret, "fashion-commerce/identity", info, 32));
  return {
    sessionToken: derive("session-token/v1"),
    throttle: derive("throttle-key/v1"),
    ipHash: derive("ip-hash/v1"),
  };
}

export const hmacHex = (key: Buffer, value: string): string => createHmac("sha256", key).update(value).digest("hex");

// ---------------------------------------------------------------------------
// Session tokens: 256 random bits, handed to the client once; only an HMAC is stored.
// ---------------------------------------------------------------------------

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isWellFormedSessionToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function hashSessionToken(token: string, keys: IdentityKeys): string {
  return hmacHex(keys.sessionToken, token);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
