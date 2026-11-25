// Server side of the catalog foundation: reading and saving an item's details.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DOC_KINDS,
  EMPTY_DETAILS,
  FREIGHT_CLASSES,
  PRODUCT_KINDS,
  SHIP_CLASSES,
  SURCHARGE_KINDS,
  TYPE_CATEGORY,
  XREF_KINDS,
  cleanSpecs,
  kitLoops,
  numberNorm,
  specFieldsFor,
  type CatalogMeta,
  type Category,
  type Details,
  type KitItem,
  type Location,
  type SpecValue,
} from "./foundation";

export const FT = {
  categories: "fittings_categories",
  xrefs: "fittings_xrefs",
  machines: "fittings_machines",
  fitment: "fittings_fitment",
  kits: "fittings_kit_items",
  stock: "fittings_stock",
  surcharges: "fittings_surcharges",
  documents: "fittings_documents",
} as const;

/** The database has not had the foundation section of supabase/schema.sql applied yet. */
export class SchemaMissing extends Error {
  constructor() {
    super("The catalog tables are not in the database yet. Run the catalog foundation section of supabase/schema.sql in Supabase.");
  }
}

type PgError = { code?: string; message: string } | null;

function check(error: PgError): void {
  if (!error) return;
  if (
    error.code === "42P01" ||
    error.code === "42703" ||
    error.code === "PGRST205" ||
    error.code === "PGRST204" ||
    error.code === "PGRST202" ||
    /could not find the (table|column|function)/i.test(error.message)
  ) {
    throw new SchemaMissing();
  }
  throw new Error(error.message);
}


export async function loadMeta(db: SupabaseClient): Promise<CatalogMeta> {
  const [c, l, p] = await Promise.all([
    db.from(FT.categories).select("*"),
    db.from("fittings_locations").select("id, name, kind, lead_days, phone").order("name"),
    db.from("fittings_products").select("id, name, part_number, qty, kind").order("sort"),
  ]);
  check(c.error);
  check(l.error);
  check(p.error);
  return {
    categories: (c.data ?? []).map(normalizeCategory),
    locations: (l.data ?? []).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      kind: (["dealer", "supplier"].includes(r.kind as string) ? r.kind : "survey") as Location["kind"],
      lead_days: typeof r.lead_days === "number" ? r.lead_days : null,
      phone: (r.phone as string) ?? "",
    })),
    items: (p.data ?? []).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      part_number: (r.part_number as string) ?? "",
      qty: (r.qty as number) ?? 0,
      kind: (r.kind as string) ?? "part",
    })),
  };
}

export function normalizeCategory(r: Record<string, unknown>): Category {
  return {
    id: String(r.id),
    parent_id: typeof r.parent_id === "string" ? r.parent_id : null,
    name: String(r.name ?? r.id),
    sort: typeof r.sort === "number" ? r.sort : 0,
    spec_fields: Array.isArray(r.spec_fields) ? (r.spec_fields as Category["spec_fields"]) : [],
    fitment: (r.fitment as Category["fitment"]) ?? null,
    default_ship: (r.default_ship as Category["default_ship"]) ?? null,
    live: r.live === true,
    note: typeof r.note === "string" ? r.note : "",
  };
}

const numOrNull = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export async function loadDetails(db: SupabaseClient, id: string): Promise<Details | null> {
  const [p, x, s, d, k, st] = await Promise.all([
    db
      .from("fittings_products")
      .select("category_id, brand, family, variant_label, specs, kind, ship_class, weight_oz, length_in, width_in, height_in, freight_class")
      .eq("id", id)
      .maybeSingle(),
    db.from(FT.xrefs).select("kind, brand, number, number_norm").eq("product_id", id),
    db.from(FT.surcharges).select("kind, amount_cents, refundable, label").eq("product_id", id),
    db.from(FT.documents).select("kind, title, url, sort").eq("product_id", id).order("sort"),
    db.from(FT.kits).select("product_id, qty, sort").eq("kit_id", id).order("sort"),
    db.from(FT.stock).select("location_id, qty, counted_at, lead_days").eq("product_id", id),
  ]);
  for (const r of [p, x, s, d, k, st]) check(r.error);
  if (!p.data) return null;
  const row = p.data as Record<string, unknown>;
  return {
    ...EMPTY_DETAILS,
    category_id: (row.category_id as string | null) ?? null,
    brand: (row.brand as string) ?? "",
    family: (row.family as string) ?? "",
    variant_label: (row.variant_label as string) ?? "",
    specs: (row.specs && typeof row.specs === "object" ? row.specs : {}) as Record<string, SpecValue>,
    kind: (row.kind as Details["kind"]) ?? "part",
    ship_class: (row.ship_class as Details["ship_class"]) ?? "parcel",
    weight_oz: numOrNull(row.weight_oz),
    length_in: numOrNull(row.length_in),
    width_in: numOrNull(row.width_in),
    height_in: numOrNull(row.height_in),
    freight_class: (row.freight_class as string) ?? "",
    xrefs: (x.data ?? []) as Details["xrefs"],
    surcharges: (s.data ?? []) as Details["surcharges"],
    documents: ((d.data ?? []) as Array<Details["documents"][number]>).map(({ kind, title, url }) => ({ kind, title, url })),
    kit_items: ((k.data ?? []) as KitItem[]).map(({ product_id, qty }) => ({ product_id, qty })),
    stock: (st.data ?? []) as Details["stock"],
  };
}

export class DetailsError extends Error {}

const oneOf = <T extends string>(list: ReadonlyArray<{ id: T }>, v: unknown): T | null =>
  list.some((x) => x.id === v) ? (v as T) : null;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Checks an edited Details against the rules and the category's spec template,
 * and turns it into the payload fittings_save_details takes. Every refusal is
 * a sentence the admin screen can show as it is.
 */
export function prepareDetails(
  productId: string,
  raw: Record<string, unknown>,
  meta: CatalogMeta,
  kitsOf: (id: string) => KitItem[],
): Record<string, unknown> {
  const fail = (m: string): never => {
    throw new DetailsError(m);
  };
  const category_id = text(raw.category_id, 60) || null;
  if (category_id && !meta.categories.some((c) => c.id === category_id)) fail("That category no longer exists.");

  const { specs, problems } = cleanSpecs(
    (raw.specs && typeof raw.specs === "object" ? raw.specs : {}) as Record<string, unknown>,
    specFieldsFor(category_id, meta.categories),
  );
  if (problems.length) fail(problems[0]);

  const kind = oneOf(PRODUCT_KINDS, raw.kind) ?? "part";
  const ship_class = oneOf(SHIP_CLASSES, raw.ship_class) ?? "parcel";
  const dim = (key: string, label: string, max: number) => {
    const v = raw[key];
    if (v == null || v === "") return null;
    const n = numOrNull(v);
    if (n == null || n <= 0 || n > max) fail(`${label} must be a number above 0.`);
    return Math.round(n! * 100) / 100;
  };
  const freight_class = text(raw.freight_class, 6);
  if (freight_class && !FREIGHT_CLASSES.includes(freight_class)) fail("Pick a freight class from the list.");

  const xrefs = (Array.isArray(raw.xrefs) ? raw.xrefs : []).slice(0, 200).flatMap((r) => {
    const x = r as Record<string, unknown>;
    const k = oneOf(XREF_KINDS, x.kind);
    const number = text(x.number, 40);
    const number_norm = numberNorm(number);
    if (!k || !number_norm) return [];
    if (k === "upc" && !/^\d{8,14}$/.test(number_norm)) fail(`"${number}" is not a UPC. UPCs are 8 to 14 digits.`);
    return [{ kind: k, brand: text(x.brand, 40), number, number_norm }];
  });

  const surcharges = (Array.isArray(raw.surcharges) ? raw.surcharges : []).flatMap((r) => {
    const s = r as Record<string, unknown>;
    const k = oneOf(SURCHARGE_KINDS, s.kind);
    const cents = numOrNull(s.amount_cents);
    if (!k || cents == null) return [];
    if (cents < 0 || cents > 10_000_00) fail("A surcharge must be between $0 and $10,000.");
    const def = SURCHARGE_KINDS.find((d) => d.id === k)!;
    return [{ kind: k, amount_cents: Math.round(cents), refundable: def.refundable, label: text(s.label, 60) }];
  });

  const documents = (Array.isArray(raw.documents) ? raw.documents : []).slice(0, 40).flatMap((r) => {
    const d = r as Record<string, unknown>;
    const url = text(d.url, 600);
    if (!url) return [];
    if (!/^https?:\/\/[^\s]+$/i.test(url)) fail(`"${url.slice(0, 60)}" is not a web link. Links start with https://`);
    return [{ kind: oneOf(DOC_KINDS, d.kind) ?? "other", title: text(d.title, 120) || "Document", url }];
  });

  const kit_items: KitItem[] = (Array.isArray(raw.kit_items) ? raw.kit_items : []).slice(0, 60).flatMap((r) => {
    const k = r as Record<string, unknown>;
    const pid = text(k.product_id, 80);
    const qty = numOrNull(k.qty);
    if (!pid) return [];
    if (!meta.items.some((i) => i.id === pid)) fail("A kit part no longer exists. Remove it and save again.");
    if (pid === productId) fail("A kit cannot contain itself.");
    if (qty == null || qty < 1 || !Number.isInteger(qty)) fail("Each kit part needs a whole quantity of 1 or more.");
    return [{ product_id: pid, qty: qty! }];
  });
  if (kind === "kit" && kit_items.length === 0) fail("A kit needs at least one part.");
  if (kind !== "kit" && kit_items.length) fail("Only items marked as a kit can list kit parts.");
  if (kitLoops(productId, kit_items, kitsOf)) fail("That would put this kit inside itself through another kit.");

  const stock = (Array.isArray(raw.stock) ? raw.stock : []).flatMap((r) => {
    const s = r as Record<string, unknown>;
    const location_id = text(s.location_id, 60);
    const qty = numOrNull(s.qty);
    if (!location_id || qty == null) return [];
    if (!meta.locations.some((l) => l.id === location_id)) fail("A stock location no longer exists.");
    if (qty < 0 || !Number.isInteger(qty)) fail("Stock counts must be whole numbers, 0 or more.");
    const lead = s.lead_days == null || s.lead_days === "" ? null : numOrNull(s.lead_days);
    if (lead != null && (lead < 0 || lead > 120 || !Number.isInteger(lead))) fail("Lead time must be 0 to 120 business days.");
    const counted = typeof s.counted_at === "string" && !Number.isNaN(Date.parse(s.counted_at)) ? s.counted_at : new Date().toISOString();
    return [{ location_id, qty, lead_days: lead, counted_at: counted }];
  });

  return {
    category_id: category_id ?? "",
    brand: text(raw.brand, 60),
    family: text(raw.family, 80),
    variant_label: text(raw.variant_label, 60),
    specs,
    kind,
    ship_class,
    weight_oz: dim("weight_oz", "Weight", 100_000),
    length_in: dim("length_in", "Length", 1_000),
    width_in: dim("width_in", "Width", 1_000),
    height_in: dim("height_in", "Height", 1_000),
    freight_class,
    xrefs,
    surcharges,
    documents,
    kit_items,
    stock,
  };
}

export async function saveDetails(db: SupabaseClient, id: string, raw: Record<string, unknown>): Promise<Details> {
  const meta = await loadMeta(db);
  if (!meta.items.some((i) => i.id === id)) throw new DetailsError("That item no longer exists.");
  const all = await db.from(FT.kits).select("kit_id, product_id, qty");
  check(all.error);
  const kits = new Map<string, KitItem[]>();
  for (const r of all.data ?? []) {
    const k = r.kit_id as string;
    kits.set(k, [...(kits.get(k) ?? []), { product_id: r.product_id as string, qty: r.qty as number }]);
  }
  const payload = prepareDetails(id, raw, meta, (k) => kits.get(k) ?? []);
  const { error } = await db.rpc("fittings_save_details", { p_id: id, p_details: payload });
  check(error);
  return (await loadDetails(db, id))!;
}

/** Numbers our items go by, for matching survey cards and searches: normalized number → item id. */
export async function numberIndex(db: SupabaseClient): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const x = await db.from(FT.xrefs).select("product_id, number_norm");
  if (x.error) return out; // before the foundation is set up, the listed part numbers are enough
  for (const r of x.data ?? []) {
    const k = r.number_norm as string;
    if (k && !out.has(k)) out.set(k, r.product_id as string);
  }
  return out;
}

/**
 * Keeps a hydraulic fitting on the tree when it is added or its type changes.
 * Items placed elsewhere by hand are left alone. Never fails the caller: before
 * the foundation is set up there is simply nothing to place.
 */
export async function placeByType(db: SupabaseClient, id: string, type: string): Promise<void> {
  const target = TYPE_CATEGORY[type] ?? TYPE_CATEGORY.other;
  const fittingLeaves = Object.values(TYPE_CATEGORY);
  try {
    const cur = await db.from("fittings_products").select("category_id").eq("id", id).maybeSingle();
    if (cur.error || !cur.data) return;
    const now = cur.data.category_id as string | null;
    if (now && !fittingLeaves.includes(now)) return;
    if (now === target) return;
    await db.from("fittings_products").update({ category_id: target }).eq("id", id);
  } catch {
    /* nothing to place yet */
  }
}
