// The back office's Home page: what needs doing now, worked out from the
// orders, stock and sales the shop already has. Pure rules; nothing is saved.

import type { LowLine } from "./operations";

export type PickProgress = Record<string, { need: number; picked: number }>;

type HomeOrder = {
  id: string;
  number: number;
  status: string;
  paid_at?: string | null;
  ship_method?: string | null;
  stock_short?: boolean;
  storefront_id?: string | null;
  from?: Array<{ location_id: string }>;
};

export type OrderNeeds = {
  /** Paid, with parts still to pull off the shelf. */
  toPull: number;
  /** Paid, every part checked off: pack it and ship it. */
  toShip: number;
  /** Paid, every part checked off, waiting for the customer to pick up. */
  toPickUp: number;
  /** Paid, but a shelf came up short when it was paid. */
  short: number;
  /** When the longest-waiting open order was paid. */
  oldestPaid: string | null;
};

/** Sorts paid orders into what is still to pull and what is ready to go. */
export function orderNeeds(orders: HomeOrder[], progress: PickProgress): OrderNeeds {
  const out: OrderNeeds = { toPull: 0, toShip: 0, toPickUp: 0, short: 0, oldestPaid: null };
  for (const o of orders) {
    if (o.status !== "paid") continue;
    const p = progress[o.id];
    const pulled = !!p && p.need > 0 && p.picked >= p.need;
    if (!pulled) out.toPull++;
    else if (o.ship_method === "pickup") out.toPickUp++;
    else out.toShip++;
    if (o.stock_short) out.short++;
    if (o.paid_at && (!out.oldestPaid || o.paid_at < out.oldestPaid)) out.oldestPaid = o.paid_at;
  }
  return out;
}

/**
 * Orders a dealer has fully pulled on the dealer page count as pulled here
 * too: every part taken for the order, at every location, is checked off.
 * Returns the ids of those orders.
 */
export function pulledByDealers(
  allocations: Array<{ order_id: string; location_id: string; product_id: string; qty: number }>,
  marks: Array<{ order_id: string; location_id: string; product_id: string; picked_qty: number }>,
): Set<string> {
  const got = new Map(marks.map((m) => [`${m.order_id}:${m.location_id}:${m.product_id}`, m.picked_qty]));
  const state = new Map<string, boolean>();
  for (const a of allocations) {
    const ok = (got.get(`${a.order_id}:${a.location_id}:${a.product_id}`) ?? 0) >= a.qty;
    state.set(a.order_id, (state.get(a.order_id) ?? true) && ok);
  }
  return new Set([...state].filter(([, ok]) => ok).map(([id]) => id));
}

export type NetworkOrders = {
  /** Backroad Iron store orders with parts coming off a dealer's shelf, by dealer. */
  out: Array<{ dealer_id: string; name: string; orders: number }>;
  outTotal: number;
  /** Dealer store orders with parts coming off Backroad Iron's shelf, by the dealer whose store sold it. */
  into: Array<{ dealer_id: string; name: string; orders: number }>;
  inTotal: number;
};

/**
 * Open orders that cross between Backroad Iron and its dealers. "Out": sold on
 * the Backroad Iron store, filled from a dealer's shelf. "In": sold on a
 * dealer's store, filled from Backroad Iron's shelf.
 */
export function networkOrders(
  orders: HomeOrder[],
  locations: Array<{ id: string; dealer_id: string }>,
  dealers: Array<{ id: string; name: string }>,
  storefronts: Array<{ id: string; dealer_id: string | null }>,
  houseDealerId: string | null,
): NetworkOrders {
  const res: NetworkOrders = { out: [], outTotal: 0, into: [], inTotal: 0 };
  if (!houseDealerId) return res;
  const dealerOf = new Map(locations.map((l) => [l.id, l.dealer_id]));
  const nameOf = new Map(dealers.map((d) => [d.id, d.name]));
  const sellerOf = new Map(storefronts.map((s) => [s.id, s.dealer_id]));
  const outBy = new Map<string, number>();
  const inBy = new Map<string, number>();
  for (const o of orders) {
    if (o.status !== "paid") continue;
    const seller: string = (o.storefront_id ? sellerOf.get(o.storefront_id) : null) ?? houseDealerId;
    const fillers = new Set((o.from ?? []).map((a) => dealerOf.get(a.location_id)).filter((d): d is string => !!d));
    if (seller === houseDealerId) {
      const others = [...fillers].filter((d) => d !== houseDealerId);
      if (others.length) res.outTotal++;
      for (const d of others) outBy.set(d, (outBy.get(d) ?? 0) + 1);
    } else if (fillers.has(houseDealerId)) {
      res.inTotal++;
      inBy.set(seller, (inBy.get(seller) ?? 0) + 1);
    }
  }
  const list = (m: Map<string, number>) =>
    [...m].map(([dealer_id, n]) => ({ dealer_id, name: nameOf.get(dealer_id) ?? "A dealer", orders: n })).sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name));
  res.out = list(outBy);
  res.into = list(inBy);
  return res;
}

export type SaleRow = { at: string; cents: number; kind: "web" | "counter"; refunded?: number };
export type SalesSpan = { web: { n: number; cents: number }; counter: { n: number; cents: number }; refunded: number };
export type SalesSummary = { today: SalesSpan; week: SalesSpan; month: SalesSpan };

const span = (): SalesSpan => ({ web: { n: 0, cents: 0 }, counter: { n: 0, cents: 0 }, refunded: 0 });

/**
 * Sales today, in the last 7 days and in the last 30. `dayStart` is midnight
 * where the person is looking; `now` is the moment they looked.
 */
export function salesSummary(rows: SaleRow[], now: number, dayStart: number): SalesSummary {
  const out: SalesSummary = { today: span(), week: span(), month: span() };
  const DAY = 86400_000;
  for (const r of rows) {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || t > now || !Number.isFinite(r.cents)) continue;
    const add = (s: SalesSpan) => {
      s[r.kind].n++;
      s[r.kind].cents += r.cents;
      s.refunded += Math.max(0, r.refunded ?? 0);
    };
    if (t >= dayStart) add(out.today);
    if (t >= now - 7 * DAY) add(out.week);
    if (t >= now - 30 * DAY) add(out.month);
  }
  return out;
}

export type StockNeeds = { out: number; noPrice: number; low: number; top: LowLine[] };

/** Stock that needs a look: out everywhere, in the catalog with no price, or running low at a location. */
export function stockNeeds(products: Array<{ qty: number; price_cents: number | null }>, low: LowLine[], show = 5): StockNeeds {
  let out = 0;
  let noPrice = 0;
  for (const p of products) {
    if (p.qty <= 0) out++;
    else if (!((p.price_cents ?? 0) > 0)) noPrice++;
  }
  return { out, noPrice, low: low.length, top: low.slice(0, show) };
}

/** "2 days", "3 hours", "20 minutes": how long ago, in plain words. */
export function waited(fromIso: string | null, now: number): string {
  if (!fromIso) return "";
  const ms = now - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60_000);
  const say = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (mins < 60) return say(Math.max(1, mins), "minute");
  if (mins < 48 * 60) return say(Math.floor(mins / 60), "hour");
  return say(Math.floor(mins / 1440), "day");
}

/**
 * Dealer alerts (order and running-low messages) that haven't gone out. With no
 * email or text service set up they wait in the outbox; a failed one needs a retry.
 */
export function alertsWaiting(a: { queued: number; failed: number }, canSend: boolean): { n: number; failed: boolean; detail: string } {
  const queued = Math.max(0, a.queued || 0);
  const failed = Math.max(0, a.failed || 0);
  const detail = failed
    ? `${failed} failed. Open the outbox to try again`
    : canSend
      ? "Waiting in the outbox. Open it to send"
      : "No email or text service is set up yet";
  return { n: queued + failed, failed: failed > 0, detail };
}

type DealerOrder = { status: string; created_at: string; lines: Array<{ location_id: string; qty?: number; picked?: number }>; shipped: Array<{ location_id: string; shipped_at: string }> };

export type DealerNeeds = {
  /** Orders with parts on this dealer's shelf that haven't shipped from there. */
  open: number;
  /** When the longest-waiting open order came in. */
  oldest: string | null;
  /** Orders this dealer finished in the last 7 days. */
  shipped7: number;
  /** Of the open orders: every part checked off, ready to pack and ship. */
  pulled: number;
};

/** A dealer's own quick look: what is waiting on their shelf, and what went out this week. */
export function dealerNeeds(orders: DealerOrder[], now: number): DealerNeeds {
  const out: DealerNeeds = { open: 0, oldest: null, shipped7: 0, pulled: 0 };
  const week = now - 7 * 86400_000;
  for (const o of orders) {
    const isOpen = o.lines.some((l) => !o.shipped.some((s) => s.location_id === l.location_id));
    if (isOpen) {
      out.open++;
      const left = o.lines.filter((l) => !o.shipped.some((s) => s.location_id === l.location_id));
      if (left.every((l) => (l.picked ?? 0) >= (l.qty ?? 1))) out.pulled++;
      if (!out.oldest || o.created_at < out.oldest) out.oldest = o.created_at;
    } else if (o.shipped.length && Math.max(...o.shipped.map((s) => Date.parse(s.shipped_at) || 0)) >= week) {
      out.shipped7++;
    }
  }
  return out;
}
