// Checkout holds: how long the parts in a checkout are kept for the shopper,
// what other shoppers can still buy, and the countdown the cart shows.
//
// The hold starts when checkout starts, never when something is added to the
// cart. The clock is the server's: the countdown counts toward a time the
// server gave, corrected for any difference in the shopper's clock.

/** Stripe's checkout page must stay open at least 30 minutes; a minute's margin covers the request. */
export const STRIPE_MIN_MINUTES = 31;

export type HoldWindow = {
  /** When Stripe closes the checkout page, in Unix seconds. */
  stripeExpiresAt: number;
  /** How long the database keeps the parts: the page's life plus the grace for a late payment notice. */
  dbMinutes: number;
  /** When the shopper is told the hold ends, ISO time. */
  endsAt: string;
};

export function holdWindow(holdMinutes: number, graceMinutes: number, nowMs: number): HoldWindow {
  const minutes = Math.max(STRIPE_MIN_MINUTES, Math.min(1440, Math.floor(holdMinutes) || 0));
  const grace = Math.max(0, Math.min(60, Math.floor(graceMinutes) || 0));
  const endsMs = nowMs + minutes * 60_000;
  return { stripeExpiresAt: Math.floor(endsMs / 1000), dbMinutes: minutes + grace, endsAt: new Date(endsMs).toISOString() };
}

/** What a shopper can buy: on the shelf, less what sits in other people's checkouts. */
export function availableQty(onHand: number, held: number | undefined): number {
  return Math.max(0, Math.floor(onHand) - Math.max(0, Math.floor(held ?? 0)));
}

export function heldMap(rows: Array<{ product_id: unknown; held: unknown }> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows ?? []) {
    const n = Number(r.held);
    if (typeof r.product_id === "string" && Number.isFinite(n) && n > 0) out[r.product_id] = (out[r.product_id] ?? 0) + Math.floor(n);
  }
  return out;
}

/** "27:05" until the hold ends, or null once it has. */
export function countdown(endsAtMs: number, nowMs: number): string | null {
  const left = Math.ceil((endsAtMs - nowMs) / 1000);
  if (!(left > 0)) return null;
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The line Stripe shows above the Pay button. */
export function holdMessage(endsAtIso: string, timeZone: string, pickup: boolean): string {
  let when: string;
  try {
    when = new Date(endsAtIso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" });
  } catch {
    when = new Date(endsAtIso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago", timeZoneName: "short" });
  }
  const held = `We're holding these parts for you until ${when}.`;
  return pickup ? `${held} Pickup order: we'll call when it's ready at the counter.` : held;
}

/** A cart reduced to a stable string, so a saved checkout can tell whether the cart has changed since. */
export function cartSignature(lines: Array<{ id: string; qty: number }>): string {
  return [...lines]
    .filter((l) => l.qty > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((l) => `${l.id}*${l.qty}`)
    .join(",");
}

/** Where the browser keeps the checkout it last started. */
export const HELD_KEY = "fittings-held-v1";

export type HeldCheckout = {
  order_id: string;
  url: string;
  ends_at: string;
  /** Server time minus browser time when the hold was placed, in ms. */
  skew: number;
  sig: string;
  /** What is held, by item, so the shop can count those parts as the shopper's own. */
  items: Record<string, number>;
};

/** What the browser saves after checkout starts, with its clock difference from the server. */
export function heldFromReply(
  reply: { order_id: string; url: string; held_until: string; now: string },
  lines: Array<{ id: string; qty: number }>,
  browserNowMs: number = Date.now(),
): HeldCheckout {
  const server = Date.parse(reply.now);
  const items: Record<string, number> = {};
  for (const l of lines) if (l.qty > 0) items[l.id] = (items[l.id] ?? 0) + l.qty;
  return {
    order_id: reply.order_id,
    url: reply.url,
    ends_at: reply.held_until,
    skew: Number.isNaN(server) ? 0 : server - browserNowMs,
    sig: cartSignature(lines),
    items,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isOrderId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Reads a saved checkout back, refusing anything malformed or pointing off Stripe. */
export function readHeld(raw: string | null): HeldCheckout | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<HeldCheckout>;
    if (!isOrderId(v.order_id) || typeof v.url !== "string" || typeof v.ends_at !== "string" || typeof v.sig !== "string") return null;
    if (!/^https:\/\/checkout\.stripe\.com\//.test(v.url)) return null;
    if (Number.isNaN(Date.parse(v.ends_at))) return null;
    const items: Record<string, number> = {};
    if (v.items && typeof v.items === "object") {
      for (const [id, q] of Object.entries(v.items)) if (Number.isInteger(q) && (q as number) > 0 && (q as number) < 1000) items[id] = q as number;
    }
    return { order_id: v.order_id, url: v.url, ends_at: v.ends_at, skew: Number.isFinite(v.skew) ? Number(v.skew) : 0, sig: v.sig, items };
  } catch {
    return null;
  }
}

/** The saved checkout still applies: same cart, and time left on the hold. */
export function heldStillGood(h: HeldCheckout | null, sig: string, browserNowMs: number): h is HeldCheckout {
  return !!h && h.sig === sig && countdown(Date.parse(h.ends_at), browserNowMs + h.skew) !== null;
}
