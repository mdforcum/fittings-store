// Server side of the catalog foundation: reading and saving an item's details.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONDITIONS,
  DOC_KINDS,
  MACHINE_KINDS,
  MachineProblem,
  PRICE_MODES,
  cleanMachine,
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
  type FitRow,
  type KitItem,
  type Machine,
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
  diagrams: "fittings_diagrams",
  quotes: "fittings_quote_requests",
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


export function normalizeMachine(r: Record<string, unknown>): Machine {
  const kind = MACHINE_KINDS.find((k) => k.id === r.kind)?.id ?? "other";
  return {
    id: String(r.id),
    make: String(r.make ?? ""),
    kind,
    series: typeof r.series === "string" ? r.series : "",
    model: String(r.model ?? ""),
    year_from: typeof r.year_from === "number" ? r.year_from : null,
    year_to: typeof r.year_to === "number" ? r.year_to : null,
    serial_prefixes: Array.isArray(r.serial_prefixes) ? (r.serial_prefixes as string[]) : [],
    serial_breaks: Array.isArray(r.serial_breaks) ? (r.serial_breaks as Machine["serial_breaks"]) : [],
    notes: typeof r.notes === "string" ? r.notes : "",
    sort: typeof r.sort === "number" ? r.sort : 0,
  };
}

export async function loadMachines(db: SupabaseClient): Promise<Machine[]> {
  const m = await db.from(FT.machines).select("*").order("make").order("sort").order("series").order("model");
  check(m.error);
  return (m.data ?? []).map(normalizeMachine);
}

export async function loadMeta(db: SupabaseClient): Promise<CatalogMeta> {
  const [c, l, p, machines] = await Promise.all([
    db.from(FT.categories).select("*"),
    db.from("fittings_locations").select("id, name, kind, lead_days, phone").order("name"),
    db.from("fittings_products").select("id, name, part_number, qty, kind").order("sort"),
    loadMachines(db),
  ]);
  check(c.error);
  check(l.error);
  check(p.error);
  return {
    machines,
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
  const [p, x, s, d, k, st, ft] = await Promise.all([
    db
      .from("fittings_products")
      .select(
        "category_id, brand, family, variant_label, specs, kind, ship_class, weight_oz, length_in, width_in, height_in, freight_class, condition, universal, warranty_months, price_mode",
      )
      .eq("id", id)
      .maybeSingle(),
    db.from(FT.xrefs).select("kind, brand, number, number_norm").eq("product_id", id),
    db.from(FT.surcharges).select("kind, amount_cents, refundable, label").eq("product_id", id),
    db.from(FT.documents).select("kind, title, url, sort").eq("product_id", id).order("sort"),
    db.from(FT.kits).select("product_id, qty, sort").eq("kit_id", id).order("sort"),
    db.from(FT.stock).select("location_id, qty, counted_at, lead_days").eq("product_id", id),
    db
      .from(FT.fitment)
      .select("machine_id, position, serial_prefix, serial_from, serial_to, engine, qty_used, strength, note")
      .eq("product_id", id),
  ]);
  for (const r of [p, x, s, d, k, st, ft]) check(r.error);
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
    condition: (CONDITIONS.find((c) => c.id === row.condition)?.id ?? "new") as Details["condition"],
    universal: row.universal === true,
    warranty_months: numOrNull(row.warranty_months),
    price_mode: row.price_mode === "quote" ? "quote" : "cart",
    fitment: (ft.data ?? []) as FitRow[],
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

  const condition = oneOf(CONDITIONS, raw.condition) ?? "new";
  const price_mode = oneOf(PRICE_MODES, raw.price_mode) ?? "cart";
  const universal = raw.universal === true;
  let warranty_months: number | null = null;
  if (raw.warranty_months != null && raw.warranty_months !== "") {
    const w = numOrNull(raw.warranty_months);
    if (w == null || !Number.isInteger(w) || w < 0 || w > 120) fail("Warranty must be a whole number of months, 0 to 120.");
    warranty_months = w;
  }

  const seen = new Set<string>();
  const fitment: FitRow[] = (Array.isArray(raw.fitment) ? raw.fitment : []).slice(0, 400).flatMap((r) => {
    const x = r as Record<string, unknown>;
    const machine_id = text(x.machine_id, 40);
    if (!machine_id) return [];
    const m = meta.machines.find((mm) => mm.id === machine_id);
    if (!m) fail("A machine on the fits list no longer exists. Remove it and save again.");
    const serial_prefix = numberNorm(text(x.serial_prefix, 8));
    if (serial_prefix && (serial_prefix.length < 2 || serial_prefix.length > 6)) fail(`"${serial_prefix}" is not a serial prefix.`);
    if (serial_prefix && m!.serial_prefixes.length && !m!.serial_prefixes.includes(serial_prefix)) {
      fail(`${m!.make} ${m!.model} has no serial prefix ${serial_prefix}. Add it to the machine first, or fix the typo.`);
    }
    const qty = numOrNull(x.qty_used) ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > 500) fail("Quantity used on a machine must be a whole number, 1 or more.");
    const row: FitRow = {
      machine_id,
      position: text(x.position, 60),
      serial_prefix,
      serial_from: text(x.serial_from, 40),
      serial_to: text(x.serial_to, 40),
      engine: text(x.engine, 60),
      qty_used: qty,
      strength: x.strength === "spec" ? "spec" : "confirmed",
      note: text(x.note, 200),
    };
    const key = [row.machine_id, row.position, row.serial_prefix, row.serial_from].join("|");
    if (seen.has(key)) return [];
    seen.add(key);
    return [row];
  });
  if (universal && fitment.length) fail("A universal part fits by spec, so it lists no machines. Untick universal or remove the machines.");

  return {
    condition,
    price_mode,
    universal,
    warranty_months,
    fitment,
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

// ---------------------------------------------------------------------------
// Machines: the lineup the machine picker and fitment rows point at.
// ---------------------------------------------------------------------------

export { MachineProblem };

/** Machines with how many items list each one, for the admin list. */
export async function machinesWithUse(db: SupabaseClient): Promise<Array<Machine & { parts: number }>> {
  const [machines, f] = await Promise.all([loadMachines(db), db.from(FT.fitment).select("machine_id")]);
  check(f.error);
  const used = new Map<string, number>();
  for (const r of f.data ?? []) used.set(r.machine_id as string, (used.get(r.machine_id as string) ?? 0) + 1);
  return machines.map((m) => ({ ...m, parts: used.get(m.id) ?? 0 }));
}

const machineRow = (m: ReturnType<typeof cleanMachine>) => ({
  make: m.make,
  kind: m.kind,
  series: m.series,
  model: m.model,
  year_from: m.year_from,
  year_to: m.year_to,
  serial_prefixes: m.serial_prefixes,
  serial_breaks: m.serial_breaks,
  notes: m.notes,
  sort: m.sort,
});

function duplicate(error: PgError, m: { make: string; model: string }): void {
  if (error?.code === "23505") throw new MachineProblem(`${m.make} ${m.model} is already on the list.`);
  check(error);
}

export async function saveMachine(db: SupabaseClient, raw: Record<string, unknown>): Promise<Machine> {
  const m = cleanMachine(raw);
  const q = m.id
    ? db.from(FT.machines).update(machineRow(m)).eq("id", m.id).select("*").maybeSingle()
    : db.from(FT.machines).insert(machineRow(m)).select("*").maybeSingle();
  const { data, error } = await q;
  duplicate(error, m);
  if (!data) throw new MachineProblem("That machine no longer exists.");
  return normalizeMachine(data as Record<string, unknown>);
}

/** Adds machines in one go. Ones already on the list (same make and model) are skipped, not changed. */
export async function addMachines(db: SupabaseClient, list: Array<ReturnType<typeof cleanMachine>>): Promise<{ added: number; skipped: string[] }> {
  if (!list.length) return { added: 0, skipped: [] };
  const have = await loadMachines(db);
  const key = (m: { make: string; model: string }) => `${m.make}|${m.model}`.toLowerCase();
  const known = new Set(have.map(key));
  const skipped: string[] = [];
  const fresh = list.filter((m) => {
    const k = key(m);
    if (known.has(k)) {
      skipped.push(`${m.make} ${m.model}`);
      return false;
    }
    known.add(k);
    return true;
  });
  if (fresh.length) {
    const { error } = await db.from(FT.machines).insert(fresh.map(machineRow));
    check(error);
  }
  return { added: fresh.length, skipped };
}

export async function deleteMachine(db: SupabaseClient, id: string): Promise<void> {
  const used = await db.from(FT.fitment).select("product_id", { count: "exact", head: true }).eq("machine_id", id);
  check(used.error);
  if ((used.count ?? 0) > 0) {
    throw new MachineProblem(`${used.count} item${used.count === 1 ? " lists" : "s list"} this machine. Take it off those items first.`);
  }
  const { error } = await db.from(FT.machines).delete().eq("id", id);
  check(error);
}
