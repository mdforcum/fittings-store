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

/** Condition is a filter on every list and a line on every product page. */
export const CONDITIONS = [
  { id: "new", label: "New" },
  { id: "reman", label: "Remanufactured" },
  { id: "rebuilt", label: "Rebuilt" },
  { id: "used", label: "Used" },
  { id: "surplus", label: "Surplus (genuine OEM, never used)" },
] as const;
export type Condition = (typeof CONDITIONS)[number]["id"];

export const PRICE_MODES = [
  { id: "cart", label: "Sold online: price and cart button" },
  { id: "quote", label: "Quoted: \u201cRequest a price\u201d instead of the cart" },
] as const;
export type PriceMode = (typeof PRICE_MODES)[number]["id"];

/** Machine types, in picker order: ag first, then construction equipment. */
export const MACHINE_KINDS = [
  { id: "tractor", label: "Tractor", group: "ag" },
  { id: "combine", label: "Combine", group: "ag" },
  { id: "header", label: "Header", group: "ag" },
  { id: "hay", label: "Hay and forage", group: "ag" },
  { id: "planter", label: "Planter or drill", group: "ag" },
  { id: "tillage", label: "Tillage", group: "ag" },
  { id: "sprayer", label: "Sprayer", group: "ag" },
  { id: "backhoe", label: "Backhoe loader", group: "construction" },
  { id: "excavator", label: "Excavator", group: "construction" },
  { id: "dozer", label: "Dozer", group: "construction" },
  { id: "wheel-loader", label: "Wheel loader", group: "construction" },
  { id: "skid-steer", label: "Skid steer", group: "construction" },
  { id: "track-loader", label: "Compact track loader", group: "construction" },
  { id: "articulated-truck", label: "Articulated truck", group: "construction" },
  { id: "other", label: "Other", group: "other" },
] as const;
export type MachineKind = (typeof MACHINE_KINDS)[number]["id"];

export type SerialBreak = { serial: string; note: string };
export type Machine = {
  id: string;
  make: string;
  kind: MachineKind;
  series: string;
  model: string;
  year_from: number | null;
  year_to: number | null;
  serial_prefixes: string[];
  serial_breaks: SerialBreak[];
  notes: string;
  sort: number;
};

/** One "fits this machine" row on an item. */
export type FitRow = {
  machine_id: string;
  position: string;
  serial_prefix: string;
  serial_from: string;
  serial_to: string;
  engine: string;
  qty_used: number;
  strength: "confirmed" | "spec";
  note: string;
};

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
  machines: Machine[];
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
  condition: Condition;
  universal: boolean;
  warranty_months: number | null;
  price_mode: PriceMode;
  fitment: FitRow[];
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
  condition: "new",
  universal: false,
  warranty_months: null,
  price_mode: "cart",
  fitment: [],
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

/**
 * The part of a serial number the maker's parts data goes by. Cat's 17-character
 * PIN (CAT + model + check letter + prefix + sequence) ends with the same
 * three-character prefix and five-digit sequence as its older 8-character
 * serials, so both are read as those last 8 characters.
 */
export function serialKey(serial: string): string {
  const s = numberNorm(serial);
  return s.length === 17 && s.startsWith("CAT") ? s.slice(-8) : s;
}

/**
 * Whether a machine with this serial is covered by a fitment row. With a
 * prefix, the serial must start with it and the range counts the digits after
 * it ("prefix ABC, 1 to 4999"); without one, the whole serial is compared.
 * No serial given: a row with no limits fits, a limited one is "check your serial".
 */
export function fitsSerial(serial: string, row: Pick<FitRow, "serial_prefix" | "serial_from" | "serial_to">): boolean {
  const prefix = numberNorm(row.serial_prefix);
  if (!prefix) return serialInRange(serial, row.serial_from, row.serial_to);
  const s = serialKey(serial);
  if (!s) return false;
  if (!s.startsWith(prefix)) return false;
  const seq = s.slice(prefix.length).replace(/^0+/, "") || "0";
  const from = numberNorm(row.serial_from).replace(/^0+/, "");
  const to = numberNorm(row.serial_to).replace(/^0+/, "");
  if (!from && !to) return true;
  const n = Number(seq);
  if (!Number.isFinite(n)) return false;
  if (from && n < Number(from)) return false;
  if (to && n > Number(to)) return false;
  return true;
}

export const machineName = (m: Pick<Machine, "make" | "model">) => `${m.make} ${m.model}`.trim();

/** How a machine reads in a list: "Case IH 1066 · 66 series · 1967–1971". */
export function machineLabel(m: Pick<Machine, "make" | "model" | "series" | "year_from" | "year_to">): string {
  const years = m.year_from && m.year_to ? `${m.year_from}\u2013${m.year_to}` : m.year_from ? `${m.year_from} on` : m.year_to ? `to ${m.year_to}` : "";
  return [machineName(m), m.series, years].filter(Boolean).join(" \u00b7 ");
}

export class MachineProblem extends Error {}

const words = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Checks one machine as the admin typed it. Every refusal is a sentence the screen shows as it is. */
export function cleanMachine(raw: Record<string, unknown>): Omit<Machine, "id"> & { id?: string } {
  const fail = (m: string): never => {
    throw new MachineProblem(m);
  };
  const make = words(raw.make, 40);
  const model = words(raw.model, 40);
  if (!make) fail("Every machine needs a make, like Case IH or Cat.");
  if (!model) fail("Every machine needs a model, like 1066 or D6T.");
  const kind = (MACHINE_KINDS.find((k) => k.id === raw.kind)?.id ?? null) as MachineKind | null;
  if (!kind) fail(`Pick what kind of machine the ${make} ${model} is.`);
  const year = (v: unknown, label: string) => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (!Number.isInteger(n) || n < 1900 || n > 2100) fail(`${label} must be a year like 1971.`);
    return n;
  };
  const year_from = year(raw.year_from, "First year");
  const year_to = year(raw.year_to, "Last year");
  if (year_from && year_to && year_from > year_to) fail("The first year comes after the last year.");
  const list = Array.isArray(raw.serial_prefixes) ? raw.serial_prefixes : String(raw.serial_prefixes ?? "").split(/[\s,]+/);
  const serial_prefixes = [...new Set(list.map((p) => numberNorm(String(p))).filter(Boolean))].slice(0, 40);
  for (const p of serial_prefixes) if (p.length < 2 || p.length > 6) fail(`"${p}" is not a serial prefix. Cat prefixes are three letters or digits, like ABC.`);
  const serial_breaks = (Array.isArray(raw.serial_breaks) ? raw.serial_breaks : []).slice(0, 40).flatMap((b) => {
    const r = b as Record<string, unknown>;
    const serial = words(r.serial, 40);
    const note = words(r.note, 200);
    if (!serial && !note) return [];
    if (!serial) fail("Each serial break needs the serial number where the change starts.");
    return [{ serial, note }];
  });
  const id = typeof raw.id === "string" && /^[0-9a-f-]{36}$/i.test(raw.id) ? raw.id : undefined;
  return {
    ...(id ? { id } : {}),
    make: make!,
    model: model!,
    kind: kind!,
    series: words(raw.series, 40),
    year_from,
    year_to,
    serial_prefixes,
    serial_breaks,
    notes: words(raw.notes, 400),
    sort: typeof raw.sort === "number" && Number.isInteger(raw.sort) ? raw.sort : 0,
  };
}

/**
 * One machine per line, for loading a lineup in one go:
 * "Make, kind, series, model, first year, last year, prefixes".
 * Everything after the model may be left off. Kinds match by label or id.
 */
export function parseMachineLines(text: string): { machines: Array<ReturnType<typeof cleanMachine>>; problems: string[] } {
  const machines: Array<ReturnType<typeof cleanMachine>> = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith("#")) return;
    const [make, kindText, series, model, from, to, prefixes] = line.split(/\t|,/).map((c) => c.trim());
    const k = (kindText ?? "").toLowerCase();
    const kind = k ? (MACHINE_KINDS.find((m) => m.id === k || m.label.toLowerCase() === k || m.label.toLowerCase().startsWith(k))?.id ?? kindText) : "";
    try {
      machines.push(cleanMachine({ make, kind, series, model, year_from: from, year_to: to, serial_prefixes: prefixes ?? "" }));
    } catch (e) {
      problems.push(`Line ${i + 1}: ${(e as Error).message}`);
    }
  });
  return { machines, problems };
}

/** True when a serial number falls inside a fitment's serial range (either end may be open). */
export function serialInRange(serial: string, from: string, to: string): boolean {
  const s = numberNorm(serial);
  if (!s) return !from && !to;
  const cmp = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
  if (from && cmp(s, numberNorm(from)) < 0) return false;
  if (to && cmp(s, numberNorm(to)) > 0) return false;
  return true;
}
