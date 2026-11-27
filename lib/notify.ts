// Dealer alerts: every message is written to the outbox (fittings_alerts)
// first, then sent by email (Resend) or text (Twilio) when those services'
// keys are in Vercel. With no keys, messages wait in the outbox and dealers
// still see their orders in the portal.
import type { SupabaseClient } from "@supabase/supabase-js";
import { lowStockText, okEmail, orderAlert, runningLow, toE164, type AlertLine } from "./operations";
import { onhandMap } from "./places";

const clean = (v: string | undefined) => (v ?? "").trim().replace(/^["']+|["']+$/g, "").trim();

export const notifyEnv = {
  get resend() {
    return clean(process.env.RESEND_API_KEY);
  },
  get fromEmail() {
    return clean(process.env.ALERT_FROM_EMAIL);
  },
  get twilioSid() {
    return clean(process.env.TWILIO_ACCOUNT_SID);
  },
  get twilioToken() {
    return clean(process.env.TWILIO_AUTH_TOKEN);
  },
  get twilioFrom() {
    return clean(process.env.TWILIO_FROM);
  },
};

export const emailReady = () => !!(notifyEnv.resend && notifyEnv.fromEmail);
export const textReady = () => !!(notifyEnv.twilioSid && notifyEnv.twilioToken && notifyEnv.twilioFrom);

/** The site's own address, for links in messages. */
export function siteUrl(origin?: string | null): string {
  const set = clean(process.env.SITE_URL) || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${clean(process.env.VERCEL_PROJECT_PRODUCTION_URL)}` : "");
  return (set || origin || "").replace(/\/+$/, "");
}

type AlertRow = { id: number; channel: string; send_to: string; subject: string; body: string };

async function deliver(a: AlertRow): Promise<string | null> {
  try {
    if (a.channel === "email") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${notifyEnv.resend}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: notifyEnv.fromEmail, to: [a.send_to], subject: a.subject, text: a.body }),
      });
      return res.ok ? null : `The email service said ${res.status}.`;
    }
    if (a.channel === "sms") {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(notifyEnv.twilioSid)}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${notifyEnv.twilioSid}:${notifyEnv.twilioToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: a.send_to, From: notifyEnv.twilioFrom, Body: a.body.slice(0, 600) }).toString(),
      });
      return res.ok ? null : `The text service said ${res.status}.`;
    }
    return "Unknown channel.";
  } catch {
    return "Couldn't reach the service.";
  }
}

/**
 * Sends what's waiting in the outbox for the channels that are set up. Each
 * message is claimed before it is sent, so two callers can't both send it.
 */
export async function sendQueued(db: SupabaseClient, limit = 25): Promise<{ sent: number; failed: number }> {
  const channels = [...(emailReady() ? ["email"] : []), ...(textReady() ? ["sms"] : [])];
  if (!channels.length) return { sent: 0, failed: 0 };
  const q = await db.from("fittings_alerts").select("id, channel, send_to, subject, body").eq("status", "queued").in("channel", channels).order("id").limit(limit);
  if (q.error) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (const a of (q.data ?? []) as AlertRow[]) {
    const claim = await db.from("fittings_alerts").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", a.id).eq("status", "queued").select("id");
    if (claim.error || !claim.data?.length) continue;
    const problem = await deliver(a);
    if (problem) {
      failed++;
      await db.from("fittings_alerts").update({ status: "failed", error: problem, sent_at: null }).eq("id", a.id);
    } else sent++;
  }
  return { sent, failed };
}

type Contact = { id: string; name: string; alert_email?: string; alert_phone?: string };

function messagesFor(d: Contact, subject: string, body: string, sms: string) {
  const out: Array<{ channel: "email" | "sms"; send_to: string; subject: string; body: string }> = [];
  for (const email of (d.alert_email ?? "").split(/[,;\s]+/).filter(okEmail).slice(0, 3)) out.push({ channel: "email", send_to: email, subject, body });
  const phone = toE164(d.alert_phone ?? "");
  if (phone) out.push({ channel: "sms", send_to: phone, subject, body: sms });
  return out;
}

/**
 * After an order is paid: each outside dealer with parts to pull for it gets
 * one alert per contact. Safe to call twice (the outbox keeps one per order,
 * dealer, channel). Never throws; a paid order must not fail over an alert.
 */
export async function queueOrderAlerts(db: SupabaseClient, orderId: string, origin?: string | null): Promise<void> {
  try {
    const [o, al, s] = await Promise.all([
      db.from("fittings_orders").select("id, number, ship_method, items:fittings_order_items(product_id, name, part_number, qty)").eq("id", orderId).maybeSingle(),
      db.from("fittings_allocations").select("product_id, location_id, qty").eq("order_id", orderId),
      db.from("fittings_settings").select("house_dealer_id").eq("id", 1).maybeSingle(),
    ]);
    if (o.error || !o.data || al.error || !(al.data ?? []).length) return;
    const locIds = [...new Set((al.data ?? []).map((a) => a.location_id as string))];
    const locs = await db.from("fittings_locations").select("id, name, dealer_id").in("id", locIds);
    if (locs.error) return;
    const house = (s.data as { house_dealer_id?: string } | null)?.house_dealer_id ?? null;
    const dealerIds = [...new Set((locs.data ?? []).map((l) => l.dealer_id as string))].filter((d) => d !== house);
    if (!dealerIds.length) return;
    const ds = await db.from("fittings_dealers").select("id, name, alert_email, alert_phone").in("id", dealerIds);
    if (ds.error) return;
    const order = o.data as { id: string; number: number; ship_method: string; items: Array<{ product_id: string; name: string; part_number: string | null; qty: number }> };
    const rows: Array<Record<string, unknown>> = [];
    for (const d of (ds.data ?? []) as Contact[]) {
      const mine = (locs.data ?? []).filter((l) => l.dealer_id === d.id);
      const lines: AlertLine[] = (al.data ?? [])
        .filter((a) => mine.some((l) => l.id === a.location_id))
        .map((a) => {
          const it = order.items.find((i) => i.product_id === a.product_id);
          return { name: it?.name ?? String(a.product_id), part_number: it?.part_number ?? "", qty: a.qty as number, location: (mine.find((l) => l.id === a.location_id)?.name as string) ?? "" };
        });
      if (!lines.length) continue;
      const msg = orderAlert(order.number, lines, order.ship_method === "pickup", `${siteUrl(origin)}/dealer`);
      for (const m of messagesFor(d, msg.subject, msg.body, msg.sms)) rows.push({ dealer_id: d.id, order_id: order.id, topic: "routed_order", ...m });
    }
    if (rows.length) await db.from("fittings_alerts").upsert(rows, { onConflict: "order_id,dealer_id,channel,topic", ignoreDuplicates: true });
    await sendQueued(db);
  } catch (e) {
    console.error("order alerts failed", orderId, e);
  }
}

/** A running-low list for each dealer with alert contacts. Returns how many messages were queued. */
export async function queueLowStock(db: SupabaseClient): Promise<number> {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [p, oh, lo, ds, mv, s] = await Promise.all([
    db.from("fittings_products").select("id, name, part_number"),
    db.from("fittings_onhand").select("product_id, location_id, qty").limit(50000),
    db.from("fittings_locations").select("id, name, dealer_id, active").eq("kind", "store"),
    db.from("fittings_dealers").select("id, name, alert_email, alert_phone"),
    db.from("fittings_stock_moves").select("product_id, location_id, delta").eq("kind", "sale").gte("created_at", since).limit(50000),
    db.from("fittings_settings").select("low_stock").eq("id", 1).maybeSingle(),
  ]);
  if (p.error || oh.error || lo.error || ds.error || mv.error) return 0;
  const sold: Record<string, Record<string, number>> = {};
  for (const m of mv.data ?? []) {
    if (!m.location_id) continue;
    const row = (sold[m.product_id as string] ??= {});
    row[m.location_id as string] = (row[m.location_id as string] ?? 0) - (m.delta as number);
  }
  const onhand = onhandMap(oh.data as Array<{ product_id: unknown; location_id: unknown; qty: unknown }>);
  const low = Number((s.data as { low_stock?: number } | null)?.low_stock ?? 2);
  const products = (p.data ?? []).map((r) => ({ id: r.id as string, name: (r.name as string) ?? "", part_number: (r.part_number as string) ?? "" }));
  const rows: Array<Record<string, unknown>> = [];
  for (const d of (ds.data ?? []) as Contact[]) {
    const mine = (lo.data ?? []).filter((l) => l.dealer_id === d.id).map((l) => ({ id: l.id as string, active: l.active !== false, name: l.name as string }));
    const lines = runningLow(products, onhand, sold, mine, low);
    if (!lines.length) continue;
    const body = lowStockText(d.name, lines, (id) => mine.find((l) => l.id === id)?.name ?? "");
    const subject = `Running low: ${lines.length} part${lines.length === 1 ? "" : "s"}`;
    for (const m of messagesFor(d, subject, body, `${subject} at ${d.name}. Open the dealer page for the list.`)) rows.push({ dealer_id: d.id, topic: "low_stock", ...m });
  }
  if (rows.length) {
    const r = await db.from("fittings_alerts").insert(rows);
    if (r.error) return 0;
    await sendQueued(db, 100);
  }
  return rows.length;
}
