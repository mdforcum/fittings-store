// Weekly running-low lists for dealers (Vercel Cron, Mondays). Vercel sends
// CRON_SECRET as a bearer token; without it set, the job does nothing.
import crypto from "node:crypto";
import { queueLowStock, sendQueued } from "@/lib/notify";
import { adminDb, json } from "@/lib/server";

export const dynamic = "force-dynamic";

function allowed(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const got = req.headers.get("authorization") ?? "";
  const a = crypto.createHash("sha256").update(got).digest();
  const b = crypto.createHash("sha256").update(`Bearer ${secret}`).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  if (!allowed(req)) return json({ ok: false }, 401);
  const db = adminDb();
  const queued = await queueLowStock(db);
  // Also pick up any order alerts that couldn't go out earlier.
  const sent = await sendQueued(db, 100);
  return json({ ok: true, queued, ...sent });
}
