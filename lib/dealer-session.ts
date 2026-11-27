// Dealer portal sign-in: each dealer user has an email and password; the
// session is a signed, http-only cookie kept apart from the staff one.
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { lockMinutes, makeToken, passwordTag, tokenSigned, tokenUser, verifyPassword } from "./passwords";
import { env } from "./server";

const COOKIE = "fittings_dealer";
const MAX_AGE_S = 60 * 60 * 24 * 14;

export type DealerUser = { id: string; dealer_id: string; email: string; name: string };
export type DealerSession = { user: DealerUser; dealer: { id: string; name: string; slug: string } };

function key(): Buffer | null {
  if (!env.secret) return null;
  return crypto.createHash("sha256").update(`fittings-dealer:${env.secret}`).digest();
}

type UserRow = DealerUser & { password_hash: string; disabled: boolean; failed_logins: number; locked_until: string | null };

async function userById(db: SupabaseClient, id: string): Promise<UserRow | null> {
  const r = await db.from("fittings_dealer_users").select("*").eq("id", id).maybeSingle();
  return r.error || !r.data ? null : (r.data as UserRow);
}

export async function currentDealer(db: SupabaseClient): Promise<DealerSession | null> {
  const k = key();
  if (!k) return null;
  const token = (await cookies()).get(COOKIE)?.value ?? "";
  const t = tokenUser(token, Date.now());
  if (!t) return null;
  const user = await userById(db, t.userId);
  if (!user || user.disabled || !tokenSigned(token, passwordTag(user.password_hash), k)) return null;
  const d = await db.from("fittings_dealers").select("id, name, slug").eq("id", user.dealer_id).maybeSingle();
  if (d.error || !d.data) return null;
  return { user: { id: user.id, dealer_id: user.dealer_id, email: user.email, name: user.name }, dealer: d.data as DealerSession["dealer"] };
}

/** Checks the password; on success sets the cookie. Returns plain words when it fails. */
export async function dealerSignIn(db: SupabaseClient, email: string, password: string): Promise<string | null> {
  const k = key();
  if (!k) return "Dealer sign-in isn't set up yet.";
  const r = await db.from("fittings_dealer_users").select("*").eq("email", email.trim().toLowerCase()).maybeSingle();
  const user = r.error ? null : (r.data as UserRow | null);
  const wrong = "That email and password don't match.";
  if (!user) {
    // Same work either way, so a wrong email takes as long as a wrong password.
    verifyPassword(password, "scrypt$00$" + "0".repeat(64));
    return wrong;
  }
  if (user.disabled) return wrong;
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) return "Too many tries. Wait 15 minutes, then try again.";
  if (!verifyPassword(password, user.password_hash)) {
    const failed = (user.failed_logins ?? 0) + 1;
    const wait = lockMinutes(failed);
    await db
      .from("fittings_dealer_users")
      .update({ failed_logins: wait ? 0 : failed, locked_until: wait ? new Date(Date.now() + wait * 60_000).toISOString() : null })
      .eq("id", user.id);
    return wait ? "Too many tries. Wait 15 minutes, then try again." : wrong;
  }
  await db.from("fittings_dealer_users").update({ failed_logins: 0, locked_until: null, last_login_at: new Date().toISOString() }).eq("id", user.id);
  const expires = Date.now() + MAX_AGE_S * 1000;
  (await cookies()).set(COOKIE, makeToken(user.id, expires, passwordTag(user.password_hash), k), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_S,
  });
  return null;
}

export async function dealerSignOut(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
