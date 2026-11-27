// Dealer shipping labels: the markup setting, what a dealer is charged for a
// label, the package a dealer types in, and the signed quote that ties a
// price to one order and location. No database here.
import crypto from "node:crypto";
import type { Parcel } from "./shippo";

/** Stored in the private config under this key. */
export const LABELS_KEY = "dealer_labels";

export type LabelSettings = {
  /** Dealers can buy labels on Backroad Iron's shipping account. */
  on: boolean;
  /** Markup on the label's cost, in basis points. Starts at zero. */
  markup_bps: number;
  /** Flat amount added per label, in cents. Starts at zero. */
  flat_cents: number;
};

export const NO_LABELS: LabelSettings = { on: false, markup_bps: 0, flat_cents: 0 };

export const MAX_MARKUP_BPS = 5000;
export const MAX_FLAT_CENTS = 2000;

export function readLabels(value: unknown): LabelSettings {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const whole = (x: unknown, max: number) => (typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= max ? x : 0);
  return { on: v.on === true, markup_bps: whole(v.markup_bps, MAX_MARKUP_BPS), flat_cents: whole(v.flat_cents, MAX_FLAT_CENTS) };
}

/** What the dealer pays for a label that costs `cost` cents. Never less than the cost. */
export function labelCharge(costCents: number, s: Pick<LabelSettings, "markup_bps" | "flat_cents">): number {
  return costCents + Math.round((costCents * s.markup_bps) / 10000) + s.flat_cents;
}

export const MAX_POUNDS = 150;
export const MAX_INCHES = 108;

/** The package a dealer typed (pounds and inches) as a parcel, or plain words about what's wrong. */
export function parcelFrom(p: { weight_lb?: unknown; length?: unknown; width?: unknown; height?: unknown }): Parcel | string {
  const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : Number.NaN);
  const lb = n(p.weight_lb);
  const dims = [n(p.length), n(p.width), n(p.height)];
  if (!(lb > 0)) return "Enter the weight in pounds.";
  if (lb > MAX_POUNDS) return `Packages over ${MAX_POUNDS} lb need freight. Enter the tracking number yourself.`;
  if (dims.some((d) => !(d > 0))) return "Enter the box length, width and height in inches.";
  if (dims.some((d) => d > MAX_INCHES)) return `A side over ${MAX_INCHES} inches needs freight. Enter the tracking number yourself.`;
  return { length: dims[0], width: dims[1], height: dims[2], weight_oz: Math.round(lb * 16 * 10) / 10 };
}

/** A price offered to a dealer for one order and location. Good for half an hour. */
export type Quote = {
  order_id: string;
  location_id: string;
  rate_id: string;
  carrier: string;
  service: string;
  /** What the label costs Backroad Iron. */
  cost_cents: number;
  /** What the dealer is charged. */
  charge_cents: number;
  expires: number;
};

export const QUOTE_MINUTES = 30;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const sign = (body: string, key: Buffer) => crypto.createHmac("sha256", key).update(body).digest("base64url");

export function quoteKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(`fittings-label-quote:${secret}`).digest();
}

/** The quote as a token the dealer's browser hands back to buy it. */
export function signQuote(q: Quote, key: Buffer): string {
  const body = b64(JSON.stringify(q));
  return `${body}.${sign(body, key)}`;
}

/** The quote in a token, or null when it was changed, is for something else, or ran out. */
export function readQuote(token: string, key: Buffer, orderId: string, locationId: string, now: number): Quote | null {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(sign(body, key));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let q: Quote;
  try {
    q = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Quote;
  } catch {
    return null;
  }
  if (q.order_id !== orderId || q.location_id !== locationId) return null;
  if (!(q.expires > now)) return null;
  if (!Number.isInteger(q.cost_cents) || !Number.isInteger(q.charge_cents) || q.cost_cents < 0 || q.charge_cents < q.cost_cents) return null;
  if (typeof q.rate_id !== "string" || !q.rate_id) return null;
  return q;
}

/** A part's saved shipping details, as far as they are filled in. */
export type PartShipping = { qty: number; weight_oz: number | null; length_in: number | null; width_in: number | null; height_in: number | null };

/**
 * A starting point for the package boxes, from the parts' saved details.
 * Weight: the parts added up, only when every part has one. Box size: only
 * for a single part, since nobody can guess how several parts get packed.
 * Blank strings mean "the dealer fills this in".
 */
export function packageGuess(lines: PartShipping[]): { weight_lb: string; length: string; width: string; height: string } {
  const blank = { weight_lb: "", length: "", width: "", height: "" };
  if (!lines.length) return blank;
  const out = { ...blank };
  if (lines.every((l) => l.qty > 0 && typeof l.weight_oz === "number" && l.weight_oz > 0)) {
    const oz = lines.reduce((s, l) => s + l.qty * (l.weight_oz as number), 0);
    const lb = Math.ceil((oz / 16) * 10) / 10;
    if (lb <= MAX_POUNDS) out.weight_lb = String(lb);
  }
  const only = lines.length === 1 && lines[0].qty === 1 ? lines[0] : null;
  if (only && [only.length_in, only.width_in, only.height_in].every((d) => typeof d === "number" && d > 0 && d <= MAX_INCHES)) {
    out.length = String(only.length_in);
    out.width = String(only.width_in);
    out.height = String(only.height_in);
  }
  return out;
}
