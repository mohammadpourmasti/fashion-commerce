import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

export interface ScryptParams {
  /** CPU/memory cost, a power of two. */
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
  readonly saltLength: number;
}

/** OWASP-aligned: N=2^15, r=8, p=1 (about 32 MiB per hash). */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1, keyLength: 64, saltLength: 16 };

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// Upper bounds applied when PARSING a stored hash, so a tampered row cannot make us allocate gigabytes.
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 4;

const FORMAT = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

interface Parsed {
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
}

function parse(stored: string): Parsed | null {
  const match = FORMAT.exec(stored);
  if (!match) return null;
  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (!Number.isInteger(N) || N < 2 || N > MAX_N || (N & (N - 1)) !== 0) return null;
  if (r < 1 || r > MAX_R || p < 1 || p > MAX_P) return null;
  const salt = Buffer.from(match[4] as string, "base64url");
  const hash = Buffer.from(match[5] as string, "base64url");
  if (salt.length < 8 || hash.length < 16) return null;
  return { params: { N, r, p, keyLength: hash.length, saltLength: salt.length }, salt, hash };
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * params.N * params.r * 2 + 1024 * 1024,
  };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, params.keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export type PasswordPolicyIssue = "too_short" | "too_long" | "same_as_email";

/**
 * Length-based policy (NIST 800-63B style): no composition rules, long passwords welcome.
 * Length is counted in code points after NFKC normalization.
 */
export function checkPasswordPolicy(password: string, context: { email?: string } = {}): PasswordPolicyIssue[] {
  const issues: PasswordPolicyIssue[] = [];
  const length = [...password.normalize("NFKC")].length;
  if (length < PASSWORD_MIN_LENGTH) issues.push("too_short");
  if (length > PASSWORD_MAX_LENGTH) issues.push("too_long");
  if (context.email) {
    const email = context.email.toLowerCase();
    const candidate = password.normalize("NFKC").toLowerCase();
    if (candidate === email || candidate === email.split("@")[0]) issues.push("same_as_email");
  }
  return issues;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** False for a wrong password and for any malformed stored value; never throws on bad input. */
  verify(password: string, stored: string): Promise<boolean>;
  /** True when the stored hash was made with weaker parameters than the current ones. */
  needsRehash(stored: string): boolean;
  /** Does the same amount of work as verify against an unknown account, so timing does not reveal it. */
  verifyAgainstDummy(password: string): Promise<void>;
}

export function createPasswordHasher(params: ScryptParams = DEFAULT_SCRYPT_PARAMS): PasswordHasher {
  const encode = (salt: Buffer, hash: Buffer) =>
    `scrypt$N=${params.N},r=${params.r},p=${params.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;

  let dummy: Promise<Parsed> | undefined;
  const getDummy = (): Promise<Parsed> => {
    dummy ??= (async () => {
      const salt = randomBytes(params.saltLength);
      return { params, salt, hash: await derive(randomBytes(24).toString("base64url"), salt, params) };
    })();
    return dummy;
  };

  return {
    async hash(password) {
      const salt = randomBytes(params.saltLength);
      return encode(salt, await derive(password, salt, params));
    },
    async verify(password, stored) {
      const parsed = parse(stored);
      if (!parsed) {
        await this.verifyAgainstDummy(password);
        return false;
      }
      const actual = await derive(password, parsed.salt, parsed.params);
      return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
    },
    needsRehash(stored) {
      const parsed = parse(stored);
      if (!parsed) return true;
      const p = parsed.params;
      return p.N < params.N || p.r < params.r || p.p < params.p || p.keyLength < params.keyLength;
    },
    async verifyAgainstDummy(password) {
      const d = await getDummy();
      await derive(password, d.salt, d.params);
    },
  };
}
