// Dealer logins: password hashes and the signed session token. Node crypto
// only; nothing here reads cookies or the database.
import crypto from "node:crypto";

const N = 16384;
const KEYLEN = 32;

export const MIN_PASSWORD = 10;

/** Plain words for a password that won't do; null when it is fine. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return "Use 200 characters or fewer.";
  if (/^(.)\1+$/.test(pw)) return "Use more than one repeated character.";
  return null;
}

/** "scrypt$<salt>$<hash>" */
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, KEYLEN, { N });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [kind, saltHex, hashHex] = stored.split("$");
  if (kind !== "scrypt" || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, "hex");
  if (want.length !== KEYLEN) return false;
  const got = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), KEYLEN, { N });
  return crypto.timingSafeEqual(got, want);
}

/** A tag that changes when the password does, so a new password signs old sessions out. */
export const passwordTag = (stored: string) => crypto.createHash("sha256").update(stored).digest("hex").slice(0, 16);

const sign = (payload: string, key: Buffer) => crypto.createHmac("sha256", key).update(payload).digest("hex");

/** "<user id>.<expires ms>.<signature>" */
export function makeToken(userId: string, expiresMs: number, tag: string, key: Buffer): string {
  const body = `${userId}.${expiresMs}`;
  return `${body}.${sign(`${body}.${tag}`, key)}`;
}

/** The user id in a token, or null when it is unsigned, expired or malformed. */
export function tokenUser(token: string, now: number): { userId: string; expires: number; sig: string } | null {
  const m = /^([0-9a-f-]{36})\.(\d{10,16})\.([0-9a-f]{64})$/i.exec(token);
  if (!m) return null;
  const expires = Number(m[2]);
  if (!(expires > now)) return null;
  return { userId: m[1], expires, sig: m[3] };
}

export function tokenSigned(token: string, tag: string, key: Buffer): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const want = Buffer.from(sign(`${parts[0]}.${parts[1]}.${tag}`, key), "hex");
  const got = Buffer.from(parts[2], "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Waiting time after repeated misses: none for the first 5, then 15 minutes. */
export const lockMinutes = (failed: number) => (failed >= 5 ? 15 : 0);
