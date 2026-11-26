// Shared catalog types and rules. Safe to import from both server and browser code.

export type Product = {
  id: string;
  name: string;
  type: string;
  size: string;
  dash: string;
  thread: string;
  part_number: string;
  description: string;
  price_cents: number | null;
  qty: number;
  photos: string[];
  sort: number;
  // Catalog foundation fields. Absent on old rows: the defaults below apply.
  category_id: string | null;
  brand: string;
  /** Country of origin; "USA" shows the Made in USA badge. */
  origin: string;
  condition: string;
  universal: boolean;
  price_mode: "cart" | "quote";
  warranty_months: number | null;
  ship_class: "parcel" | "freight" | "oversize" | "restricted" | "pickup";
  /** Where it sits on our shelf (fittings_shelf_spots); null until placed. */
  spot_id: string | null;
};

export type Settings = {
  store_name: string;
  tagline: string;
  phone: string;
  email: string;
  low_stock: number;
  shipping_flat_cents: number;
  order_min_cents: number;
  free_ship_over_cents: number | null;
  /** Same-day cutoff, "14:00", in ship_tz. */
  ship_cutoff: string;
  ship_tz: string;
  /** How long checkout keeps the parts for a shopper. */
  hold_minutes: number;
  /** Extra time the parts stay kept after Stripe's page closes, for a late payment notice. */
  hold_grace_minutes: number;
};

export const SHIP_ZONES = [
  { id: "America/New_York", label: "Eastern" },
  { id: "America/Chicago", label: "Central" },
  { id: "America/Denver", label: "Mountain" },
  { id: "America/Los_Angeles", label: "Pacific" },
] as const;

export const DEFAULT_SETTINGS: Settings = {
  store_name: "Hydraulic Fittings",
  tagline: "Caps and plugs for open hydraulic lines",
  phone: "",
  email: "",
  low_stock: 3,
  shipping_flat_cents: 800,
  order_min_cents: 1500,
  free_ship_over_cents: null,
  ship_cutoff: "14:00",
  ship_tz: "America/Chicago",
  hold_minutes: 30,
  hold_grace_minutes: 5,
};

export const TYPES = [
  { id: "orb-plug", label: "O-Ring Boss Plug", plural: "O-ring boss plugs" },
  { id: "jic-cap", label: "37° JIC Cap", plural: "37° JIC caps" },
  { id: "jic-plug", label: "37° JIC Plug", plural: "37° JIC plugs" },
  { id: "breather-plug", label: "Breather Plug", plural: "Breather plugs" },
  { id: "adapter", label: "Adapter", plural: "Adapters" },
  { id: "other", label: "Other fitting", plural: "Other fittings" },
] as const;

export function typeOf(id: string) {
  return TYPES.find((t) => t.id === id) ?? TYPES[TYPES.length - 1];
}

/** THE RULE: nothing sells at zero quantity, and nothing sells without a price. */
export function sellable(p: Pick<Product, "qty" | "price_cents"> | undefined | null): boolean {
  return !!p && p.qty > 0 && (p.price_cents ?? 0) > 0;
}

export function money(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** "12.50" for an input box; "" when there is no value. */
export function dollars(cents: number | null | undefined): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

/** Parses "$1,234.50" to cents. "" gives null, junk gives NaN. */
export function toCents(input: string): number | null {
  const t = input.replace(/[$,\s]/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export function shippingFor(subtotalCents: number, s: Settings): number {
  if (s.free_ship_over_cents != null && subtotalCents >= s.free_ship_over_cents) return 0;
  return s.shipping_flat_cents;
}

/** Margin is profit as a share of the sell price. */
export function priceFromMargin(costCents: number, margin: number): number {
  return Math.round(costCents / (1 - margin / 100));
}

export function marginFrom(costCents: number, priceCents: number): number {
  return Math.round(((priceCents - costCents) / priceCents) * 1000) / 10;
}

export function photoUrl(path: string): string {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/fittings-photos/${path}`;
}

export function specLine(p: Pick<Product, "thread" | "dash">): string {
  const bits: string[] = [];
  if (p.thread) bits.push(p.thread);
  if (p.dash) bits.push(`dash ${p.dash}`);
  return bits.join(" · ");
}

export type StockInfo = { tone: "ok" | "hold" | "muted" | "bad"; text: string };

export function stockInfo(p: Product, lowStock: number): StockInfo {
  if (p.qty <= 0) return { tone: "hold", text: "Temporarily out of stock" };
  if (!((p.price_cents ?? 0) > 0)) return { tone: "muted", text: "Price coming soon" };
  if (p.qty <= lowStock) return { tone: "ok", text: `In stock, only ${p.qty} left` };
  return { tone: "ok", text: "In stock" };
}

export function adminStatus(p: Product): StockInfo & { key: "live" | "out" | "noprice" } {
  if (p.qty <= 0) return { key: "out", tone: "hold", text: "Temp out of stock" };
  if (!((p.price_cents ?? 0) > 0)) return { key: "noprice", tone: "bad", text: "Needs a price" };
  return { key: "live", tone: "ok", text: "Live in shop" };
}

export function bySort(a: Product, b: Product): number {
  return a.sort - b.sort || a.name.localeCompare(b.name);
}

export function normalizeProduct(row: Record<string, unknown>): Product {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: s(row.id),
    name: s(row.name) || "Untitled item",
    type: TYPES.some((t) => t.id === row.type) ? s(row.type) : "other",
    size: s(row.size),
    dash: s(row.dash),
    thread: s(row.thread),
    part_number: s(row.part_number),
    description: s(row.description),
    price_cents: n(row.price_cents),
    qty: Math.max(0, Math.floor(n(row.qty) ?? 0)),
    photos: Array.isArray(row.photos) ? row.photos.filter((x): x is string => typeof x === "string") : [],
    sort: n(row.sort) ?? 0,
    category_id: typeof row.category_id === "string" && row.category_id ? row.category_id : null,
    brand: s(row.brand),
    origin: s(row.origin),
    condition: s(row.condition) || "new",
    universal: row.universal === true,
    price_mode: row.price_mode === "quote" ? "quote" : "cart",
    warranty_months: n(row.warranty_months),
    ship_class: (["parcel", "freight", "oversize", "restricted", "pickup"] as const).find((c) => c === row.ship_class) ?? "parcel",
    spot_id: typeof row.spot_id === "string" && row.spot_id ? row.spot_id : null,
  };
}

export function normalizeSettings(row: Record<string, unknown> | null | undefined): Settings {
  if (!row) return DEFAULT_SETTINGS;
  const s = (v: unknown, d: string) => (typeof v === "string" ? v : d);
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    store_name: s(row.store_name, "") || DEFAULT_SETTINGS.store_name,
    tagline: s(row.tagline, "") || DEFAULT_SETTINGS.tagline,
    phone: s(row.phone, ""),
    email: s(row.email, ""),
    low_stock: Math.max(0, n(row.low_stock, 3)),
    shipping_flat_cents: Math.max(0, n(row.shipping_flat_cents, 800)),
    order_min_cents: Math.max(0, n(row.order_min_cents, 1500)),
    free_ship_over_cents:
      typeof row.free_ship_over_cents === "number" ? Math.max(0, row.free_ship_over_cents) : null,
    ship_cutoff: /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(s(row.ship_cutoff, "")) ? s(row.ship_cutoff, "") : "14:00",
    ship_tz: SHIP_ZONES.some((z) => z.id === row.ship_tz) ? s(row.ship_tz, "") : "America/Chicago",
    hold_minutes: Math.min(1440, Math.max(30, Math.floor(n(row.hold_minutes, 30)))),
    hold_grace_minutes: Math.min(60, Math.max(0, Math.floor(n(row.hold_grace_minutes, 5)))),
  };
}
