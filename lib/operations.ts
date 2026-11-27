// Day-to-day running of the network: where a label ships from, what a return
// refunds, counter sales, spreadsheet imports, running-low lists and dealer
// alerts. Plain functions, no database: the screens and API share them.
import type { OrderItem, ShipFrom } from "./admin-types";
import type { Allocation, Onhand, StoreLocation } from "./places";

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

// Ship-from ---------------------------------------------------------------------

export type LocationAddress = { street1: string; street2: string; phone: string };

/** A location's own address when it has a full one, otherwise the shop-wide ship-from. */
export function locationShipFrom(
  loc: (Pick<StoreLocation, "name" | "city" | "state" | "zip"> & Partial<LocationAddress>) | null | undefined,
  dealerName: string,
  fallback: ShipFrom,
): { from: ShipFrom; own: boolean } {
  if (!loc || !loc.street1 || !loc.city || !loc.state || !loc.zip) return { from: fallback, own: false };
  return {
    own: true,
    from: {
      name: loc.name,
      company: dealerName,
      street1: loc.street1,
      street2: loc.street2 ?? "",
      city: loc.city,
      state: loc.state,
      zip: loc.zip,
      phone: loc.phone || fallback.phone,
      email: fallback.email,
    },
  };
}

/** The location that pulled the most parts for an order (where its label ships from). */
export function mainLocationId(from: Allocation[]): string | null {
  const by = new Map<string, number>();
  for (const a of from) by.set(a.location_id, (by.get(a.location_id) ?? 0) + a.qty);
  let best: string | null = null;
  let most = 0;
  for (const [id, n] of by) if (n > most) [best, most] = [id, n];
  return best;
}

// Returns and refunds -------------------------------------------------------------

export type ReturnedLine = { product_id: string; qty: number };

/** How many of each item can still come back. */
export function stillOut(items: Pick<OrderItem, "product_id" | "qty">[], returned: ReturnedLine[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i.product_id] = (out[i.product_id] ?? 0) + i.qty;
  for (const r of returned) out[r.product_id] = Math.max(0, (out[r.product_id] ?? 0) - r.qty);
  return out;
}

export type RefundOrder = {
  items: Pick<OrderItem, "product_id" | "unit_price_cents" | "qty">[];
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  refunded_cents: number;
  /** Core credits already refunded. */
  core_refunded_cents: number;
};

/**
 * What a return should refund: the parts at what was paid, their share of the
 * tax, and the shipping when asked, never more than is left to refund.
 */
export function refundFor(order: RefundOrder, lines: ReturnedLine[], withShipping: boolean): { parts: number; tax: number; shipping: number; total: number; left: number } {
  const unit = (pid: string) => {
    const rows = order.items.filter((i) => i.product_id === pid);
    const qty = rows.reduce((s, i) => s + i.qty, 0);
    return qty ? Math.round(rows.reduce((s, i) => s + i.unit_price_cents * i.qty, 0) / qty) : 0;
  };
  const parts = lines.reduce((s, l) => s + unit(l.product_id) * l.qty, 0);
  const tax = order.subtotal_cents > 0 ? Math.round((order.tax_cents * parts) / order.subtotal_cents) : 0;
  const shipping = withShipping ? order.shipping_cents : 0;
  const left = Math.max(0, order.total_cents - order.core_refunded_cents - order.refunded_cents);
  return { parts, tax, shipping, total: Math.min(parts + tax + shipping, left), left };
}

// Counter sales --------------------------------------------------------------------

export type CounterLine = { product_id: string; qty: number; price_cents: number };

/** Lines for the same part merged; zero and bad lines dropped. */
export function counterLines(lines: CounterLine[]): CounterLine[] {
  const by = new Map<string, CounterLine>();
  for (const l of lines) {
    if (!l.product_id || !Number.isInteger(l.qty) || l.qty < 1) continue;
    const price = Number.isInteger(l.price_cents) && l.price_cents >= 0 ? l.price_cents : 0;
    const cur = by.get(l.product_id);
    by.set(l.product_id, cur ? { ...cur, qty: cur.qty + l.qty, price_cents: Math.max(cur.price_cents, price) } : { product_id: l.product_id, qty: l.qty, price_cents: price });
  }
  return [...by.values()];
}

export const counterTotal = (lines: CounterLine[]) => lines.reduce((s, l) => s + l.qty * l.price_cents, 0);

/**
 * Lines that would dip into parts held in shoppers' checkouts. The sale can
 * still go through (the part is in the customer's hand), but staff are told.
 */
export function counterWarnings(lines: CounterLine[], onShelf: Record<string, number>, held: Record<string, number>, total: Record<string, number>): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const have = onShelf[l.product_id] ?? 0;
    if (l.qty > have) out.push(`${l.product_id}: only ${have} on this shelf.`);
    else if ((held[l.product_id] ?? 0) > (total[l.product_id] ?? 0) - l.qty) out.push(`${l.product_id}: this cuts into parts held in an online checkout.`);
  }
  return out;
}

// Spreadsheet import ------------------------------------------------------------------

export const IMPORT_LIMIT = 2000;

/** Splits CSV text into rows. Handles quotes, doubled quotes and line breaks in quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const HEADERS: Record<"part" | "name" | "qty" | "price", RegExp> = {
  part: /^(part\s*(number|no\.?|num|#)?|part_number|sku|item\s*(number|no\.?|#)|number|p\/n|pn)$/i,
  name: /^(name|description|desc|item|item\s*name|title)$/i,
  qty: /^(qty|quantity|count|on\s*hand|onhand|stock|in\s*stock)$/i,
  price: /^(price|sell\s*price|retail|list|list\s*price|unit\s*price)$/i,
};

export type ImportColumns = { part: number; name: number; qty: number; price: number };

/** Finds the columns by their headings; -1 where a column isn't there. */
export function importColumns(header: string[]): ImportColumns {
  const find = (re: RegExp) => header.findIndex((h) => re.test(h.trim()));
  return { part: find(HEADERS.part), name: find(HEADERS.name), qty: find(HEADERS.qty), price: find(HEADERS.price) };
}

export type ImportProduct = { id: string; name: string; part_number: string };

export type ImportLine = {
  row: number;
  part_number: string;
  name: string;
  qty: number | null;
  price_cents: number | null;
  /** The item it matches by part number; null for a new item. */
  product_id: string | null;
  /** Count at the location now (matched items). */
  now: number;
  problem: string;
};

export const normPart = (s: string) => s.toUpperCase().replace(/[\s\-_.\/]/g, "");

/** "12.50", "$1,200" → cents; null when blank; NaN when it isn't money. */
export function priceCents(text: string): number | null {
  const t = text.replace(/[$,\s]/g, "");
  if (!t) return null;
  return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : Number.NaN;
}

/**
 * Turns spreadsheet rows into a preview: each line matched to an item by part
 * number, with the count it will become at the location. Nothing is saved.
 */
export function importPlan(rows: string[][], products: ImportProduct[], onhand: Onhand, locationId: string): { lines: ImportLine[]; problem: string } {
  if (rows.length < 2) return { lines: [], problem: "The file needs a heading row and at least one part." };
  const cols = importColumns(rows[0]);
  if (cols.part < 0) return { lines: [], problem: "Add a column headed Part number." };
  if (cols.qty < 0) return { lines: [], problem: "Add a column headed Qty." };
  const body = rows.slice(1);
  if (body.length > IMPORT_LIMIT) return { lines: [], problem: `Import up to ${IMPORT_LIMIT} rows at a time. This file has ${body.length}.` };
  const byPart = new Map<string, ImportProduct>();
  for (const p of products) if (p.part_number) byPart.set(normPart(p.part_number), p);
  const seen = new Set<string>();
  const lines = body.map((r, i): ImportLine => {
    const part = (r[cols.part] ?? "").trim().slice(0, 60);
    const name = cols.name >= 0 ? (r[cols.name] ?? "").trim().slice(0, 120) : "";
    const qtyText = (r[cols.qty] ?? "").replace(/[,\s]/g, "");
    const qty = /^\d+$/.test(qtyText) ? Number(qtyText) : null;
    const price = cols.price >= 0 ? priceCents(r[cols.price] ?? "") : null;
    const match = byPart.get(normPart(part)) ?? null;
    let problem = "";
    if (!part) problem = "No part number.";
    else if (seen.has(normPart(part))) problem = "This part is on an earlier row too.";
    else if (qty == null) problem = "The count isn't a whole number.";
    else if (qty > 100000) problem = "That count looks too big.";
    else if (price != null && Number.isNaN(price)) problem = "The price isn't a dollar amount.";
    else if (!match && !name) problem = "New part: give it a name.";
    if (part) seen.add(normPart(part));
    return {
      row: i + 2,
      part_number: part,
      name: match ? match.name : name,
      qty,
      price_cents: price != null && Number.isNaN(price) ? null : price,
      product_id: match?.id ?? null,
      now: match ? (onhand[match.id]?.[locationId] ?? 0) : 0,
      problem,
    };
  });
  return { lines, problem: "" };
}

export function importSummary(lines: ImportLine[]): { update: number; add: number; same: number; skip: number } {
  const s = { update: 0, add: 0, same: 0, skip: 0 };
  for (const l of lines) {
    if (l.problem) s.skip++;
    else if (!l.product_id) s.add++;
    else if (l.qty === l.now && l.price_cents == null) s.same++;
    else s.update++;
  }
  return s;
}

// Running low ----------------------------------------------------------------------------

export type LowLine = {
  product_id: string;
  name: string;
  part_number: string;
  location_id: string;
  qty: number;
  sold30: number;
  /** Rough days left at the last 30 days' pace; null when none sold. */
  days_left: number | null;
};

/**
 * Parts running low at each location: at or under the shop's low-stock number,
 * or with less than a month left at the pace of the last 30 days. Only parts
 * a location stocks or sold are listed.
 */
export function runningLow(
  products: Array<{ id: string; name: string; part_number: string; active?: boolean }>,
  onhand: Onhand,
  sold30: Record<string, Record<string, number>>,
  locations: Array<Pick<StoreLocation, "id" | "active">>,
  lowStock: number,
): LowLine[] {
  const out: LowLine[] = [];
  for (const loc of locations) {
    if (!loc.active) continue;
    for (const p of products) {
      if (p.active === false) continue;
      const qty = onhand[p.id]?.[loc.id];
      const sold = sold30[p.id]?.[loc.id] ?? 0;
      if (qty == null && sold === 0) continue;
      const have = qty ?? 0;
      const daysLeft = sold > 0 ? Math.floor((have * 30) / sold) : null;
      if (have <= lowStock || (daysLeft != null && daysLeft < 30)) {
        out.push({ product_id: p.id, name: p.name, part_number: p.part_number, location_id: loc.id, qty: have, sold30: sold, days_left: daysLeft });
      }
    }
  }
  return out.sort((a, b) => (a.days_left ?? 9999) - (b.days_left ?? 9999) || a.qty - b.qty || a.name.localeCompare(b.name));
}

export function lowStockText(dealerName: string, lines: LowLine[], locName: (id: string) => string): string {
  const head = `Running low at ${dealerName}: ${lines.length} part${lines.length === 1 ? "" : "s"}.`;
  const body = lines
    .slice(0, 60)
    .map((l) => `- ${l.part_number || l.product_id} ${l.name}: ${l.qty} left at ${locName(l.location_id)}${l.sold30 ? `, ${l.sold30} sold in 30 days` : ""}`);
  return [head, "", ...body, ...(lines.length > 60 ? [`...and ${lines.length - 60} more.`] : [])].join("\n");
}

// Dealer alerts ---------------------------------------------------------------------------

export type AlertLine = { name: string; part_number: string; qty: number; location: string };

/** The plain-words message a dealer gets when an order needs parts from its shelves. */
export function orderAlert(orderNumber: number, lines: AlertLine[], pickup: boolean, portalUrl: string): { subject: string; body: string; sms: string } {
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const subject = `Order #${orderNumber}: pull ${count} part${count === 1 ? "" : "s"}`;
  const body = [
    `Order #${orderNumber} needs ${count} part${count === 1 ? "" : "s"} from your shelves.`,
    pickup ? "The customer will pick it up." : "Pack it to ship.",
    "",
    ...lines.map((l) => `- ${l.qty} x ${l.part_number ? `${l.part_number} ` : ""}${l.name} (${l.location})`),
    "",
    `Open the pick list and mark it shipped here: ${portalUrl}`,
  ].join("\n");
  const sms = `Backroad Iron order #${orderNumber}: pull ${count} part${count === 1 ? "" : "s"}. ${portalUrl}`;
  return { subject, body, sms };
}

export const okEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/** A US phone number as +1XXXXXXXXXX; "" when it isn't one. */
export function toE164(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return "";
}

export { money };
