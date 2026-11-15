/** Canonical form used for uniqueness and lookups: trimmed, NFKC, lower-cased. Null when it is not a plausible address. */
export function normalizeEmail(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  const email = raw.normalize("NFKC").trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(email)) return null;
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@")) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64) return null;
  if (!/^[^.]+\.[^.]+/.test(domain) || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return null;
  return email;
}
