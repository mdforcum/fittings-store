// Back-end sign-in: one password (ADMIN_PASSWORD), kept as a signed, http-only cookie.
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { env } from "./server";

const COOKIE = "fittings_admin";
const MAX_AGE_S = 60 * 60 * 24 * 14;

function signingKey(): Buffer | null {
  if (!env.adminPassword) return null;
  // Changing the password or the database key signs everyone out.
  return crypto
    .createHash("sha256")
    .update(`fittings-admin:${env.adminPassword}:${env.secret}`)
    .digest();
}

function sign(payload: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(payload).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

export function passwordMatches(input: string): boolean {
  return !!env.adminPassword && safeEqual(input, env.adminPassword);
}

export async function isAdmin(): Promise<boolean> {
  const key = signingKey();
  if (!key) return false;
  const token = (await cookies()).get(COOKIE)?.value ?? "";
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  if (!safeEqual(sig, sign(exp, key))) return false;
  return Number(exp) > Date.now();
}

export async function startSession(): Promise<void> {
  const key = signingKey();
  if (!key) throw new Error("ADMIN_PASSWORD is not set");
  const exp = String(Date.now() + MAX_AGE_S * 1000);
  (await cookies()).set(COOKIE, `${exp}.${sign(exp, key)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/** Rejects cross-site form posts: a browser request must come from this site. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser client; the cookie check still applies
  try {
    return new URL(origin).host === (req.headers.get("host") ?? new URL(req.url).host);
  } catch {
    return false;
  }
}
