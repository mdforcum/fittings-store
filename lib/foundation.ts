// The catalog foundation: ten structures every category is built on, and the
// rules that read them. Pure functions only, safe in server and browser code.
import { normPart } from "./match.ts";

export const SHIP_CLASSES = [
  { id: "parcel", label: "Parcel", hint: "UPS, FedEx or USPS box" },
  { id: "freight", label: "Freight", hint: "Pallet or crate by truck" },
  { id: "oversize", label: "Oversize", hint: "Too big for a pallet; quoted or picked up" },
  { id: "restricted", label: "Ground only", hint: "Aerosols and flammables: limited quantity, never air" },
  { id: "pickup", label: "Pickup only", hint: "Cannot be shipped" },
] as const;
export type ShipClass = (typeof SHIP_CLASSES)[number]["id"];

export const PRODUCT_KINDS = [
  { id: "part", label: "Part" },
  { id: "kit", label: "Kit (several parts sold as one)" },
  { id: "service", label: "Service (mounting, install)" },
] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number]["id"];

export const XREF_KINDS = [
  { id: "oem", label: "OEM number" },
  { id: "aftermarket", label: "Aftermarket equal" },
  { id: "supplier", label: "Supplier's number" },
  { id: "superseded", label: "Old number, replaced" },
  { id: "upc", label: "UPC barcode" },
] as const;
export type XrefKind = (typeof XREF_KINDS)[number]["id"];

export const SURCHARGE_KINDS = [
  { id: "core", label: "Core charge", refundable: true },
  { id: "deposit", label: "Container deposit", refundable: true },
  { id: "tire_fee", label: "Illinois tire user fee", refundable: false },
  { id: "hazmat", label: "Hazardous materials fee", refundable: false },
] as const;
export type SurchargeKind = (typeof SURCHARGE_KINDS)[number]["id"];

export const DOC_KINDS = [
  { id: "spec", label: "Spec sheet" },
  { id: "sds", label: "Safety data sheet (SDS)" },
  { id: "install", label: "Install guide" },
  { id: "manual", label: "Operator's manual" },
  { id: "parts_catalog", label: "Parts catalog" },
  { id: "other", label: "Other" },
] as const;
export type DocKind = (typeof DOC_KINDS)[number]["id"];

export type SpecField = {
  key: string;
  label: string;
  type: "text" | "number" | "choice" | "multi" | "bool";
  filter: "chips" | "list" | "range" | "toggle" | "search" | "none";
  unit?: string;
  choices?: string[];
  /** Stored in this product column instead of in specs (the fittings' size, dash, thread). */
  column?: string;
  note?: string;
};

export type Category = {
  id: string;
  parent_id: string | null;
  name: string;
  sort: number;
  spec_fields: SpecField[];
  fitment: "part_number" | "spec" | "size" | "none" | null;
  default_ship: ShipClass | null;
  live: boolean;
  note: string;
};

export type Xref = { kind: XrefKind; brand: string; number: string; number_norm: string };
export type Surcharge = { kind: SurchargeKind; amount_cents: number; refundable: boolean; label: string };
export type Doc = { kind: DocKind; title: string; url: string };
export type KitItem = { product_id: string; qty: number };
export type StockRow = { location_id: string; qty: number; counted_at: string; lead_days: number | null };
export type Location = { id: string; name: string; kind: "survey" | "dealer" | "supplier"; lead_days: number | null; phone: string };

export type SpecValue = string | number | boolean | string[];

/** What the details screen needs besides the item: the tree, the places, the other items. */
export type CatalogMeta = {
  categories: Category[];
  locations: Location[];
  items: Array<{ id: string; name: string; part_number: string; qty: number; kind: string }>;
};

/** Everything the foundation adds to an item, as the admin screen edits it. */
export type Details = {
  category_id: string | null;
  brand: string;
  family: string;
  variant_label: string;
  specs: Record<string, SpecValue>;
  kind: ProductKind;
  ship_class: ShipClass;
  weight_oz: number | null;
  length_in: number | null;
  width_in: number | null;
  height_in: number | null;
  freight_class: string;
  xrefs: Xref[];
  surcharges: Surcharge[];
  documents: Doc[];
  kit_items: KitItem[];
  stock: StockRow[];
};

export const EMPTY_DETAILS: Details = {
  category_id: null,
  brand: "",
  family: "",
  variant_label: "",
  specs: {},
  kind: "part",
  ship_class: "parcel",
  weight_oz: null,
  length_in: null,
  width_in: null,
  height_in: null,
  freight_class: "",
  xrefs: [],
  surcharges: [],
  documents: [],
  kit_items: [],
  stock: [],
};

/** NMFC freight classes, for items that ship by truck. */
export const FREIGHT_CLASSES = [
  "50", "55", "60", "65", "70", "77.5", "85", "92.5", "100", "110", "125", "150", "175", "200", "250", "300", "400", "500",
];

/** The hydraulic fittings' old "type" decides their place on the tree. */
export const TYPE_CATEGORY: Record<string, string> = {
  "orb-plug": "orb-plugs",
  "jic-cap": "jic-caps",
  "jic-plug": "jic-plugs",
  "breather-plug": "breather-plugs",
  adapter: "adapters",
  other: "other-fittings",
};

// ---------------------------------------------------------------------------
// 1 and 2: the category tree and its spec templates
// ---------------------------------------------------------------------------

/** Root first: Filters, then Fuel. Stops on a loop or a missing parent. */
export function categoryPath(id: string | null | undefined, cats: Category[]): Category[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const out: Category[] = [];
  const seen = new Set<string>();
  let cur = id ? byId.get(id) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return out;
}

export function categoryLabel(id: string | null | undefined, cats: Category[]): string {
  return categoryPath(id, cats)
    .map((c) => c.name)
    .join(" › ");
}

/** A category's fields: its parents' first, then its own; the nearer definition of a key wins. */
export function specFieldsFor(id: string | null | undefined, cats: Category[]): SpecField[] {
  const out: SpecField[] = [];
  for (const c of categoryPath(id, cats)) {
    for (const f of c.spec_fields) {
      const at = out.findIndex((x) => x.key === f.key);
      if (at >= 0) out[at] = f;
      else out.push(f);
    }
  }
  return out;
}

/** The nearest setting up the tree: fitment kind, default shipping. */
export function inherited<K extends "fitment" | "default_ship">(
  id: string | null | undefined,
  cats: Category[],
  key: K,
): Category[K] {
  const path = categoryPath(id, cats);
  for (let i = path.length - 1; i >= 0; i--) if (path[i][key] != null) return path[i][key];
  return null as Category[K];
}

/** Categories in tree order, each with its depth, for a picker. */
export function flatTree(cats: Category[]): Array<Category & { depth: number; leaf: boolean }> {
  const kids = new Map<string | null, Category[]>();
  for (const c of cats) {
    const k = c.parent_id && cats.some((p) => p.id === c.parent_id) ? c.parent_id : null;
    kids.set(k, [...(kids.get(k) ?? []), c]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const out: Array<Category & { depth: number; leaf: boolean }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const c of kids.get(parent) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ ...c, depth, leaf: !(kids.get(c.id)?.length) });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * Cleans spec values against the template: unknown keys and column-backed
 * fields are dropped, numbers must be numbers, choices must be on the list.
 * Returns the clean values and a plain message per value that was refused.
 */
export function cleanSpecs(
  input: Record<string, unknown>,
  fields: SpecField[],
): { specs: Record<string, SpecValue>; problems: string[] } {
  const specs: Record<string, SpecValue> = {};
  const problems: string[] = [];
  for (const f of fields) {
    if (f.column) continue;
    const raw = input[f.key];
    if (raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0)) continue;
    switch (f.type) {
      case "number": {
        const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, "").trim());
        if (Number.isFinite(n)) specs[f.key] = n;
        else problems.push(`${f.label} must be a number.`);
        break;
      }
      case "bool":
        specs[f.key] = raw === true || raw === "true" || raw === "yes";
        break;
      case "choice": {
        const v = String(raw).trim();
        if (!f.choices || f.choices.includes(v)) specs[f.key] = v.slice(0, 80);
        else problems.push(`${f.label}: "${v}" is not one of the choices.`);
        break;
      }
      case "multi": {
        const list = (Array.isArray(raw) ? raw : String(raw).split(","))
          .map((x) => String(x).trim().slice(0, 60))
          .filter(Boolean);
        const uniq = [...new Set(list)].slice(0, 30);
        if (uniq.length) specs[f.key] = uniq;
        break;
      }
      default: {
        const v = String(raw).trim().slice(0, 120);
        if (v) specs[f.key] = v;
      }
    }
  }
  return { specs, problems };
}

// ---------------------------------------------------------------------------
// 4: cross-references and part-number search
// ---------------------------------------------------------------------------

/** "re-50483 " and "RE50483" are the same number. */
export const numberNorm = (s: string) => normPart(s);

export type NumberHit = { product_id: string; matched: string; via: XrefKind | "listed" };

/**
 * Finds items by any number they go by: the number they are listed under,
 * OEM numbers, aftermarket equals, supplier numbers, old numbers and UPCs.
 * Exact matches come first, then numbers that start with what was typed.
 */
export function findByNumber(
  query: string,
  products: Array<{ id: string; part_number: string }>,
  xrefs: Array<Pick<Xref, "kind" | "number" | "number_norm"> & { product_id: string }>,
): NumberHit[] {
  const q = numberNorm(query);
  if (q.length < 2) return [];
  const exact: NumberHit[] = [];
  const starts: NumberHit[] = [];
  const seen = new Set<string>();
  const add = (hit: NumberHit, norm: string) => {
    if (seen.has(hit.product_id)) return;
    if (norm === q) {
      seen.add(hit.product_id);
      exact.push(hit);
    } else if (norm.startsWith(q) && q.length >= 3) {
      starts.push(hit);
    }
  };
  for (const p of products) add({ product_id: p.id, matched: p.part_number, via: "listed" }, numberNorm(p.part_number));
  for (const x of xrefs) add({ product_id: x.product_id, matched: x.number, via: x.kind }, x.number_norm);
  const out = [...exact];
  for (const h of starts) {
    if (seen.has(h.product_id)) continue;
    seen.add(h.product_id);
    out.push(h);
  }
  return out;
}

/** Parses "Baldwin B7299" or "B7299" lines. The brand is everything before the last word. */
export function parseXrefLine(line: string, kind: XrefKind): Xref | null {
  const t = line.trim().replace(/\s+/g, " ");
  if (!t) return null;
  const at = t.lastIndexOf(" ");
  const number = (at < 0 ? t : t.slice(at + 1)).slice(0, 40);
  const brand = (at < 0 ? "" : t.slice(0, at)).slice(0, 40);
  const number_norm = numberNorm(number);
  if (!number_norm) return null;
  if (kind === "upc" && !/^\d{8,14}$/.test(number_norm)) return null;
  return { kind, brand, number, number_norm };
}

// ---------------------------------------------------------------------------
// 6: kits
// ---------------------------------------------------------------------------

/** A kit is in stock only as far as its scarcest part goes. */
export function kitAvailable(items: KitItem[], qtyOf: (productId: string) => number): number {
  if (items.length === 0) return 0;
  let n = Infinity;
  for (const it of items) n = Math.min(n, Math.floor(Math.max(0, qtyOf(it.product_id)) / it.qty));
  return Number.isFinite(n) ? n : 0;
}

/** True when adding these components would put the kit inside itself, directly or through another kit. */
export function kitLoops(kitId: string, items: KitItem[], kitsOf: (id: string) => KitItem[]): boolean {
  const stack = items.map((i) => i.product_id);
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === kitId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const it of kitsOf(id)) stack.push(it.product_id);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 7: stock by location and the delivery promise
// ---------------------------------------------------------------------------

/** How long a counted shelf stays trusted before the page asks the customer to call. */
export const STALE_DAYS = 30;
/** Business days to pick, pack and hand to the carrier from our own shelf. */
export const OWN_HANDLING_DAYS = 1;
const DEFAULT_LEAD: Record<Location["kind"], number> = { dealer: 2, supplier: 5, survey: 3 };

export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = Math.max(0, Math.ceil(days));
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

export type Source = {
  from: "own" | Location["kind"];
  location_id: string | null;
  name: string;
  qty: number;
  ready_days: number;
  stale: boolean;
  counted_at: string | null;
};

/**
 * Every place that can supply the quantity asked for, fastest first.
 * Our shelf wins ties. A count older than STALE_DAYS still counts, but is
 * marked so the page says "call to confirm" instead of promising a date.
 */
export function sources(
  need: number,
  ownQty: number,
  stock: StockRow[],
  locations: Location[],
  now: Date = new Date(),
): Source[] {
  const out: Source[] = [];
  if (ownQty >= need) {
    out.push({ from: "own", location_id: null, name: "Our shelf", qty: ownQty, ready_days: OWN_HANDLING_DAYS, stale: false, counted_at: null });
  }
  for (const s of stock) {
    const loc = locations.find((l) => l.id === s.location_id);
    if (!loc || s.qty < need) continue;
    const age = (now.getTime() - new Date(s.counted_at).getTime()) / 86_400_000;
    out.push({
      from: loc.kind,
      location_id: loc.id,
      name: loc.name,
      qty: s.qty,
      ready_days: s.lead_days ?? loc.lead_days ?? DEFAULT_LEAD[loc.kind],
      stale: !(age <= STALE_DAYS),
      counted_at: s.counted_at,
    });
  }
  return out.sort(
    (a, b) => Number(a.stale) - Number(b.stale) || a.ready_days - b.ready_days || Number(b.from === "own") - Number(a.from === "own"),
  );
}

export type Promise_ =
  | { kind: "date"; source: Source; ships_by: Date; arrives_from: Date; arrives_to: Date }
  | { kind: "confirm"; source: Source }
  | { kind: "none" };

/**
 * The delivery promise shown on the page: the fastest place that has it,
 * plus the carrier's transit days. Never "in stock" for something only a
 * supplier has, and never a date for a stale count.
 */
export function deliveryPromise(
  options: Source[],
  transit: { min: number; max: number },
  now: Date = new Date(),
): Promise_ {
  const best = options[0];
  if (!best) return { kind: "none" };
  if (best.stale) return { kind: "confirm", source: best };
  const ships_by = addBusinessDays(now, best.ready_days);
  return {
    kind: "date",
    source: best,
    ships_by,
    arrives_from: addBusinessDays(ships_by, transit.min),
    arrives_to: addBusinessDays(ships_by, transit.max),
  };
}

// ---------------------------------------------------------------------------
// 8: shipping profile
// ---------------------------------------------------------------------------

/**
 * How a whole cart ships. One freight item puts the order on a truck; one
 * pickup-only item means the order is picked up; ground-only keeps parcel off air.
 */
export function cartShipping(classes: ShipClass[]): {
  method: "parcel" | "freight" | "pickup";
  groundOnly: boolean;
  quote: boolean;
} {
  const has = (c: ShipClass) => classes.includes(c);
  if (has("pickup")) return { method: "pickup", groundOnly: false, quote: false };
  if (has("oversize")) return { method: "freight", groundOnly: true, quote: true };
  if (has("freight")) return { method: "freight", groundOnly: true, quote: false };
  return { method: "parcel", groundOnly: has("restricted"), quote: false };
}

/** What still has to be filled in before an item can ship the way it is marked. */
export function shippingGaps(d: Pick<Details, "ship_class" | "weight_oz" | "length_in" | "width_in" | "height_in" | "freight_class">): string[] {
  const gaps: string[] = [];
  if (d.ship_class === "pickup") return gaps;
  if (!(d.weight_oz && d.weight_oz > 0)) gaps.push("weight");
  if (!(d.length_in && d.width_in && d.height_in)) gaps.push("box size");
  if ((d.ship_class === "freight" || d.ship_class === "oversize") && !d.freight_class) gaps.push("freight class");
  return gaps;
}

// ---------------------------------------------------------------------------
// 9: surcharges
// ---------------------------------------------------------------------------

export type SurchargeLine = {
  product_id: string;
  kind: SurchargeKind;
  label: string;
  unit_cents: number;
  qty: number;
  total_cents: number;
  refundable: boolean;
};

/** The extra lines a cart carries, one per item and kind, each shown on its own. */
export function surchargeLines(
  items: Array<{ product_id: string; qty: number }>,
  charges: Array<Surcharge & { product_id: string }>,
): SurchargeLine[] {
  const out: SurchargeLine[] = [];
  for (const it of items) {
    for (const c of charges) {
      if (c.product_id !== it.product_id || c.amount_cents <= 0 || it.qty <= 0) continue;
      const kind = SURCHARGE_KINDS.find((k) => k.id === c.kind);
      out.push({
        product_id: it.product_id,
        kind: c.kind,
        label: c.label || kind?.label || c.kind,
        unit_cents: c.amount_cents,
        qty: it.qty,
        total_cents: c.amount_cents * it.qty,
        refundable: c.refundable,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5: fitment
// ---------------------------------------------------------------------------

export const FIT_TEXT = {
  confirmed: "Fits, per the maker's parts data",
  spec: "Meets the spec this machine calls for",
  unknown: "Fit not confirmed for this machine",
} as const;

/** True when a serial number falls inside a fitment's serial range (either end may be open). */
export function serialInRange(serial: string, from: string, to: string): boolean {
  const s = numberNorm(serial);
  if (!s) return !from && !to;
  const cmp = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
  if (from && cmp(s, numberNorm(from)) < 0) return false;
  if (to && cmp(s, numberNorm(to)) > 0) return false;
  return true;
}
