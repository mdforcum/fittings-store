// The back end's single API: GET returns everything the screens need,
// POST runs one named action and returns the refreshed data.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_PRESETS,
  EMPTY_SHIP_FROM,
  type AdminConfig,
  type AdminData,
  type Cost,
  type Mode,
  type Order,
  type OrderCharge,
  type ParcelPreset,
  type QuoteRequest,
  type ShipFrom,
  type Shipment,
  type StockMove,
} from "@/lib/admin-types";
import { isAdmin, sameOrigin } from "@/lib/auth";
import {
  SHIP_ZONES,
  TYPES,
  bySort,
  marginFrom,
  normalizeProduct,
  normalizeSettings,
  priceFromMargin,
} from "@/lib/catalog";
import { coreCredit, storeDate } from "@/lib/checkout-rules";
import { placeByType } from "@/lib/foundation-server";
import { heldMap } from "@/lib/holds";
import { monthOf, monthRange, readRouting, readSettlement } from "@/lib/settlements";
import { cleanHost, cleanLogo, normalizeStorefront, storefrontProblem } from "@/lib/storefront";
import {
  NO_PLACES,
  byLocationOrder,
  locationProblem,
  normCode,
  normalizeLocation,
  onhandMap,
  slugify,
  type Allocation,
  type Dealer,
} from "@/lib/places";
import { cardFee, getStripe } from "@/lib/payments";
import { locationShipFrom, mainLocationId } from "@/lib/operations";
import { ActionError, dealerContacts, opsStatus, runOps } from "@/lib/operations-server";
import { T, adminDb, env, getConfig, json, setConfig } from "@/lib/server";
import { buyLabel, freshLabelUrl, getRates } from "@/lib/shippo";

export const dynamic = "force-dynamic";

/** The database change this action needs hasn't been run yet (missing function or column). */
const notSetUp = (e: { code?: string; message?: string }) =>
  e.code === "PGRST202" || e.code === "42883" || e.code === "PGRST204" || /could not find the function/i.test(e.message ?? "");

const isId = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const fail = (message: string): never => {
  throw new ActionError(message);
};

type Payload = Record<string, unknown>;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function modeOf(key: string, live: string, test: string): Mode {
  if (!key) return null;
  if (key.includes(live)) return "live";
  if (key.includes(test)) return "test";
  return "live";
}

function cleanConfig(rows: Array<{ key: string; value: unknown }>): AdminConfig & { webhook: boolean } {
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const from = (get("ship_from") ?? {}) as Partial<ShipFrom>;
  const presets = get("presets");
  return {
    ship_from: { ...EMPTY_SHIP_FROM, ...from },
    presets: Array.isArray(presets) && presets.length ? (presets as ParcelPreset[]) : DEFAULT_PRESETS,
    tax_mode: get("tax_mode") === "stripe" ? "stripe" : "off",
    label_format: get("label_format") === "PDF_4x6" ? "PDF_4x6" : "PDF",
    webhook: !!(get("stripe_webhook") as { secret?: string } | undefined)?.secret,
  };
}

async function loadData(db: SupabaseClient): Promise<AdminData> {
  const [p, c, s, cfg, o] = await Promise.all([
    db.from(T.products).select("*"),
    db.from(T.costs).select("*"),
    db.from(T.settings).select("*").eq("id", 1).maybeSingle(),
    db.from(T.config).select("key, value"),
    db
      .from(T.orders)
      .select("*, items:fittings_order_items(product_id, name, part_number, unit_price_cents, qty)")
      .in("status", ["paid", "shipped", "cancelled"])
      .order("created_at", { ascending: false })
      .limit(150),
  ]);
  const firstError = p.error ?? c.error ?? s.error ?? cfg.error ?? o.error;
  if (firstError) throw new Error(firstError.message);

  // Charges and quotes came later: if their tables are missing the rest of the
  // back office still loads, with these lists empty.
  const orderIds = (o.data ?? []).map((r) => r.id as string);
  const [ch, q, h, dl, lo, oh, al, sf, rt, sh] = await Promise.all([
    orderIds.length
      ? db.from("fittings_order_charges").select("*, returns:fittings_core_returns(*)").in("order_id", orderIds)
      : Promise.resolve({ data: [], error: null }),
    db.from("fittings_quote_requests").select("*").order("created_at", { ascending: false }).limit(200),
    db.rpc("fittings_held"),
    // Dealers and locations came later still: missing tables mean one place.
    db.from("fittings_dealers").select("*").order("created_at"),
    db.from("fittings_locations").select("*").eq("kind", "store"),
    db.from("fittings_onhand").select("product_id, location_id, qty").limit(50000),
    orderIds.length
      ? db.from("fittings_allocations").select("order_id, product_id, location_id, qty").in("order_id", orderIds)
      : Promise.resolve({ data: [], error: null }),
    db.from("fittings_storefronts").select("*").order("created_at"),
    // Returns and per-location shipments came with supabase/add-operations.sql.
    orderIds.length
      ? db.from("fittings_returns").select("order_id, product_id, qty").in("order_id", orderIds)
      : db.from("fittings_returns").select("order_id").limit(1),
    orderIds.length
      ? db.from("fittings_shipments").select("order_id, location_id, carrier, tracking_number, tracking_url, shipped_by, shipped_at").in("order_id", orderIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const opsReady = !rt.error;
  const returnedBy = new Map<string, Array<{ product_id: string; qty: number }>>();
  for (const r of rt.error ? [] : ((rt.data ?? []) as Array<{ order_id: string; product_id: string; qty: number }>)) {
    if (!r.product_id) continue;
    const list = returnedBy.get(r.order_id) ?? [];
    const cur = list.find((x) => x.product_id === r.product_id);
    if (cur) cur.qty += r.qty;
    else list.push({ product_id: r.product_id, qty: r.qty });
    returnedBy.set(r.order_id, list);
  }
  const shippedBy = new Map<string, Shipment[]>();
  for (const r of sh.error ? [] : ((sh.data ?? []) as Array<Shipment & { order_id: string }>)) {
    const { order_id, ...rest } = r;
    shippedBy.set(order_id, [...(shippedBy.get(order_id) ?? []), rest]);
  }
  const placesReady = !dl.error && !lo.error && !oh.error;
  const fromBy = new Map<string, Allocation[]>();
  for (const a of al.error ? [] : ((al.data ?? []) as Allocation[])) fromBy.set(a.order_id, [...(fromBy.get(a.order_id) ?? []), a]);
  const chargesBy = new Map<string, OrderCharge[]>();
  for (const row of ch.error ? [] : (ch.data ?? [])) {
    const r = row as OrderCharge & { order_id: string };
    const list = chargesBy.get(r.order_id) ?? [];
    list.push({ ...r, returns: [...(r.returns ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)) });
    chargesBy.set(r.order_id, list);
  }

  const costs: Record<string, Cost> = {};
  for (const row of c.data ?? []) {
    costs[row.product_id as string] = {
      cost_cents: int(row.cost_cents),
      margin: row.margin == null ? null : Number(row.margin),
    };
  }
  const { webhook, ...config } = cleanConfig((cfg.data ?? []) as Array<{ key: string; value: unknown }>);
  return {
    products: (p.data ?? []).map(normalizeProduct).sort(bySort),
    costs,
    settings: normalizeSettings(s.data),
    config,
    orders: ((o.data ?? []) as unknown as Order[]).map((ord) => ({
      ...ord,
      charges_cents: ord.charges_cents ?? 0,
      ship_method: ord.ship_method === "pickup" ? "pickup" : "parcel",
      charges: (chargesBy.get(ord.id) ?? []).sort((a, b) => a.id - b.id),
      from: fromBy.get(ord.id) ?? [],
      refunded_cents: ord.refunded_cents ?? 0,
      returned: returnedBy.get(ord.id) ?? [],
      shipments: shippedBy.get(ord.id) ?? [],
    })),
    quotes: q.error ? [] : ((q.data ?? []) as QuoteRequest[]),
    held: heldMap(h.error ? [] : (h.data as Array<{ product_id: unknown; held: unknown }>)),
    places: placesReady
      ? {
          ready: true,
          dealers: ((dl.data ?? []) as Array<Record<string, unknown>>).map((d) => ({
            id: String(d.id),
            name: String(d.name ?? ""),
            slug: String(d.slug ?? ""),
            alert_email: typeof d.alert_email === "string" ? d.alert_email : "",
            alert_phone: typeof d.alert_phone === "string" ? d.alert_phone : "",
          })) as Dealer[],
          locations: ((lo.data ?? []) as Array<Record<string, unknown>>).map(normalizeLocation).sort(byLocationOrder),
          default_location_id: ((s.data as { default_location_id?: string | null } | null)?.default_location_id ?? null),
          onhand: onhandMap(oh.data as Array<{ product_id: unknown; location_id: unknown; qty: unknown }>),
        }
      : NO_PLACES,
    storefronts: sf.error ? [] : ((sf.data ?? []) as Array<Record<string, unknown>>).map(normalizeStorefront),
    routing: readRouting(s.data as Record<string, unknown> | null),
    ops: opsStatus(opsReady),
    integrations: {
      stripe: modeOf(env.stripe, "_live_", "_test_"),
      webhook: webhook || !!process.env.STRIPE_WEBHOOK_SECRET,
      shippo: modeOf(env.shippo, "shippo_live_", "shippo_test_"),
    },
  };
}

function productFields(input: unknown): Record<string, unknown> {
  const src = (input ?? {}) as Payload;
  const out: Record<string, unknown> = {};
  const text: Array<[string, number]> = [
    ["name", 80],
    ["size", 12],
    ["dash", 8],
    ["thread", 30],
    ["part_number", 40],
    ["description", 600],
  ];
  for (const [key, max] of text) if (typeof src[key] === "string") out[key] = str(src[key], max);
  if ("name" in out && !out.name) fail("Give the item a name.");
  if (typeof src.type === "string") {
    out.type = TYPES.some((t) => t.id === src.type) ? src.type : "other";
  }
  if ("qty" in src) {
    const q = int(src.qty);
    if (q == null || q < 0) fail("Quantity must be 0 or more.");
    out.qty = q;
  }
  return out;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function getProduct(db: SupabaseClient, id: string) {
  const { data } = await db.from(T.products).select("*").eq("id", id).maybeSingle();
  return data ? normalizeProduct(data) : fail("That item no longer exists.");
}

async function getCost(db: SupabaseClient, id: string): Promise<Cost> {
  const { data } = await db.from(T.costs).select("*").eq("product_id", id).maybeSingle();
  return {
    cost_cents: data ? int(data.cost_cents) : null,
    margin: data?.margin == null ? null : Number(data.margin),
  };
}

async function must(q: PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await q;
  if (error) throw new Error(error.message);
}

const now = () => new Date().toISOString();

/**
 * Where an order's label ships from: the location staff picked, or else the
 * one that pulled the most parts, when it has its own street address;
 * otherwise the shop-wide ship-from in Settings.
 */
async function labelFrom(db: SupabaseClient, orderId: string, fallback: ShipFrom, picked: string | null) {
  const al = await db.from("fittings_allocations").select("order_id, product_id, location_id, qty").eq("order_id", orderId);
  const locId = picked ?? mainLocationId(al.error ? [] : ((al.data ?? []) as Allocation[]));
  if (!locId) return { from: fallback, own: false };
  const loc = await db.from("fittings_locations").select("*").eq("id", locId).maybeSingle();
  if (loc.error || !loc.data) return { from: fallback, own: false };
  const dealer = await db.from("fittings_dealers").select("name").eq("id", loc.data.dealer_id as string).maybeSingle();
  return locationShipFrom(normalizeLocation(loc.data as Record<string, unknown>), (dealer.data?.name as string) ?? fallback.company, fallback);
}

async function run(action: string, a: Payload, db: SupabaseClient, origin: string) {
  const id = str(a.id, 80);

  switch (action) {
    case "product.create": {
      const fields = productFields(a.fields);
      if (!fields.name) fail("Give the item a name.");
      let newId = slug(String(fields.part_number || fields.name)) || "item";
      const clash = await db.from(T.products).select("id").eq("id", newId).maybeSingle();
      if (clash.data) newId = `${newId}-${Math.random().toString(36).slice(2, 6)}`;
      const top = await db.from(T.products).select("sort").order("sort", { ascending: false }).limit(1);
      const sort = ((top.data?.[0]?.sort as number | undefined) ?? 0) + 10;
      // Starting stock goes to the location staff are working at, when they picked one.
      const startAt = isId(a.location_id) ? (a.location_id as string) : null;
      const startQty = typeof fields.qty === "number" ? fields.qty : 0;
      await must(db.from(T.products).insert({ id: newId, ...fields, qty: startAt ? 0 : startQty, sort }));
      if (startAt && startQty > 0) {
        const r = await db.rpc("fittings_count_qty", { p_id: newId, p_qty: startQty, p_note: "New item", p_location: startAt });
        if (r.error) fail(`The item was added, but its count wasn't saved: ${r.error.message}`);
      }
      await placeByType(db, newId, String(fields.type ?? "other"));
      return { id: newId };
    }

    case "product.update": {
      const fields = productFields(a.fields);
      if (Object.keys(fields).length === 0) return {};
      await must(db.from(T.products).update({ ...fields, updated_at: now() }).eq("id", id));
      if (typeof fields.type === "string") await placeByType(db, id, fields.type);
      return {};
    }

    case "product.delete": {
      const p = await getProduct(db, id);
      await must(db.from(T.products).delete().eq("id", id));
      if (p.photos.length) await db.storage.from(T.bucket).remove(p.photos);
      return {};
    }

    case "qty.adjust": {
      const delta = int(a.delta);
      if (delta == null || delta === 0) return {};
      const kind = a.kind === "receive" || a.kind === "return" ? a.kind : "adjust";
      if (kind !== "adjust" && delta < 0) fail("A shipment or return adds parts. Use the count to take parts off.");
      const loc = isId(a.location_id) ? (a.location_id as string) : null;
      const r = await db.rpc("fittings_adjust_qty", { p_id: id, p_delta: delta, p_kind: kind, p_note: str(a.note, 200), ...(loc ? { p_location: loc } : {}) });
      // Before supabase/add-stock-holds.sql runs, only the two-value version exists.
      if (r.error && notSetUp(r.error)) await must(db.rpc("fittings_adjust_qty", { p_id: id, p_delta: delta }));
      else if (r.error) throw new Error(r.error.message);
      return {};
    }

    case "qty.count": {
      const n = int(a.qty);
      if (n == null || n < 0) fail("Quantity must be a whole number, 0 or more.");
      const loc = isId(a.location_id) ? (a.location_id as string) : null;
      const r = await db.rpc("fittings_count_qty", { p_id: id, p_qty: n, p_note: str(a.note, 200), ...(loc ? { p_location: loc } : {}) });
      if (r.error && notSetUp(r.error)) await must(db.from(T.products).update({ qty: n }).eq("id", id));
      else if (r.error) throw new Error(r.error.message);
      return {};
    }

    case "qty.transfer": {
      const n = int(a.qty);
      if (n == null || n < 1) fail("Move at least one.");
      if (!isId(a.from) || !isId(a.to)) fail("Pick where the parts are and where they go.");
      if (a.from === a.to) fail("Pick two different locations.");
      const r = await db.rpc("fittings_transfer", { p_id: id, p_from: a.from, p_to: a.to, p_qty: n, p_note: str(a.note, 200) });
      if (r.error) fail(/only \d+ there/.test(r.error.message) ? `Only ${r.error.message.match(/only (\d+)/)![1]} there to move.` : r.error.message);
      return {};
    }

    case "qty.transfer_many": {
      // Move several items from one location to another; stops at the first one that can't move.
      if (!isId(a.from) || !isId(a.to)) fail("Pick where the parts are and where they go.");
      if (a.from === a.to) fail("Pick two different locations.");
      const lines = (Array.isArray(a.lines) ? a.lines : [])
        .map((l: { id?: unknown; qty?: unknown }) => ({ id: typeof l?.id === "string" ? l.id : "", qty: int(l?.qty) ?? 0 }))
        .filter((l: { id: string; qty: number }) => l.id && l.qty > 0);
      if (lines.length === 0) fail("Add at least one item and how many to move.");
      if (lines.length > 500) fail("Move up to 500 items at a time.");
      const note = str(a.note, 200);
      let moved = 0;
      for (const l of lines) {
        const r = await db.rpc("fittings_transfer", { p_id: l.id, p_from: a.from, p_to: a.to, p_qty: l.qty, p_note: note });
        if (r.error) {
          const name = (await db.from(T.products).select("name").eq("id", l.id).maybeSingle()).data?.name ?? l.id;
          const only = r.error.message.match(/only (\d+)/)?.[1];
          fail(`${moved ? `Moved ${moved} of ${lines.length} items, then stopped` : "Nothing moved"}: ${name}${only != null ? ` has only ${only} there` : ` (${r.error.message})`}.`);
        }
        moved++;
      }
      return { moved };
    }

    case "dealer.save": {
      const name = str(a.name, 80).trim();
      if (!name) fail("Give the dealer a name.");
      if (isId(a.dealer_id)) {
        // Alert contacts: only sent once supabase/add-operations.sql has run.
        const contacts = typeof a.alert_email === "string" || typeof a.alert_phone === "string" ? dealerContacts(a) : {};
        await must(db.from("fittings_dealers").update({ name, ...contacts }).eq("id", a.dealer_id as string));
        return {};
      }
      const slug = slugify(name);
      if (slug.length < 2) fail("Give the dealer a name with letters or numbers.");
      const ins = await db.from("fittings_dealers").insert({ name, slug }).select("id").single();
      if (ins.error) fail(/duplicate|unique/i.test(ins.error.message) ? "A dealer with that name is already set up." : ins.error.message);
      return { dealer_id: ins.data!.id };
    }

    case "routing.save": {
      const cut = int(a.route_cut_bps);
      const fee = int(a.storefront_fee_bps);
      const network = int(a.network_fee_bps);
      if (cut == null || cut < 0 || cut > 5000) fail("The selling share is 0 to 50%.");
      if (network == null || network < 0 || network > 5000) fail("The network fee is 0 to 50%.");
      if (fee == null || fee < 0 || fee > 5000) fail("The fee on a dealer's own-store sales is 0 to 50%.");
      if (!isId(a.house_dealer_id)) fail("Pick which dealer is Backroad Iron.");
      const r = await db
        .from(T.settings)
        .update({ route_orders: a.route_orders === true, route_cut_bps: cut, network_fee_bps: network, storefront_fee_bps: fee, house_dealer_id: a.house_dealer_id })
        .eq("id", 1);
      if (r.error) fail(/route_orders|route_cut|network_fee|storefront_fee|house_dealer/.test(r.error.message) ? "Routing isn't set up in the database yet." : r.error.message);
      return {};
    }

    case "statements.load": {
      if (!isId(a.dealer_id)) fail("Pick a dealer.");
      const month = /^\d{4}-\d{2}$/.test(String(a.month)) ? String(a.month) : null;
      const q = db.from("fittings_settlements").select("*").eq("dealer_id", a.dealer_id as string).order("created_at");
      const { data, error } = month ? await q.gte("created_at", monthRange(month).from).lt("created_at", monthRange(month).to) : await q.limit(5000);
      if (error) fail("Dealer statements aren't set up in the database yet.");
      const all = (data ?? []) as Array<Record<string, unknown>>;
      const ids = [...new Set(all.map((r) => r.order_id as string))];
      const nums: Record<string, number> = {};
      if (ids.length) for (const o of (await db.from(T.orders).select("id, number").in("id", ids)).data ?? []) nums[o.id as string] = o.number as number;
      const rows = all
        .map((r) => readSettlement(r, nums[r.order_id as string] ?? null))
        .filter((r) => !month || monthOf(r.created_at) === month);
      return { rows, months: month ? [] : [...new Set(rows.map((r) => monthOf(r.created_at)))].sort().reverse() };
    }

    case "statements.fees": {
      // Fill in Stripe's fee for paid orders that don't have it yet.
      const { data, error } = await db.from(T.orders).select("id, stripe_payment_intent").is("card_fee_cents", null).in("status", ["paid", "shipped"]).limit(100);
      if (error) fail("Dealer statements aren't set up in the database yet.");
      let filled = 0;
      for (const o of data ?? []) {
        const fee = await cardFee((o.stripe_payment_intent as string | null) ?? null);
        if (fee == null) continue;
        const r = await db.rpc("fittings_record_card_fee", { p_order_id: o.id, p_fee: fee });
        if (!r.error) filled++;
      }
      return { filled };
    }

    case "statements.pay": {
      if (!isId(a.dealer_id)) fail("Pick a dealer.");
      const month = /^\d{4}-\d{2}$/.test(String(a.month)) ? String(a.month) : fail("Pick a month.");
      const note = str(a.note, 120).trim();
      if (!note) fail("Say how it was paid, like Check 1041 or ACH Dec 5.");
      const { from, to } = monthRange(month);
      const { data, error } = await db
        .from("fittings_settlements")
        .select("order_id, created_at, net_cents")
        .eq("dealer_id", a.dealer_id as string)
        .is("paid_at", null)
        .gte("created_at", from)
        .lt("created_at", to);
      if (error) fail(error.message);
      const due = (data ?? []).filter((r) => monthOf(r.created_at as string) === month);
      if (due.some((r) => r.net_cents == null)) fail("Some lines are still waiting on Stripe's card fee. Use Fill in card fees first.");
      if (!due.length) fail("Nothing unpaid for that month.");
      const when = new Date().toISOString();
      for (const r of due) {
        await must(db.from("fittings_settlements").update({ paid_at: when, paid_note: note }).eq("order_id", r.order_id as string).eq("dealer_id", a.dealer_id as string).is("paid_at", null));
      }
      return { paid: due.length };
    }

    case "storefront.save": {
      const all = await db.from("fittings_storefronts").select("*");
      if (all.error) fail("Storefronts aren't set up yet.");
      const others = ((all.data ?? []) as Array<Record<string, unknown>>).map(normalizeStorefront);
      const sfId = isId(a.storefront_id) ? (a.storefront_id as string) : "";
      const name = str(a.name, 60).trim();
      const row = {
        dealer_id: isId(a.dealer_id) ? (a.dealer_id as string) : fail("Pick the dealer this store sells for."),
        slug: sfId ? (others.find((o) => o.id === sfId)?.slug ?? slugify(name)) : slugify(name),
        host: cleanHost(str(a.host, 120)) || null,
        name,
        tagline: str(a.tagline, 90).trim(),
        phone: str(a.phone, 30).trim(),
        email: str(a.email, 80).trim(),
        logo_url: cleanLogo(str(a.logo_url, 300)),
        color_header: str(a.color_header, 7).toLowerCase(),
        color_accent: str(a.color_accent, 7).toLowerCase(),
        color_button: str(a.color_button, 7).toLowerCase(),
        live: a.live === true,
      };
      if (str(a.logo_url, 300).trim() && !row.logo_url) fail("The logo must be a file in /brands/ or an https:// image address.");
      if (!/^#[0-9a-f]{6}$/.test(row.color_accent)) fail("Colors are written like #1a1a1a.");
      const problem = storefrontProblem({ ...row, id: sfId }, others);
      if (problem) fail(problem);
      if (row.live && !row.host) fail("Add the web address before turning the store on.");
      // Stock, location filter and shipping choices (supabase/add-storefront-options.sql).
      const centsOr = (v: unknown, what: string, nullable: boolean): number | null => {
        if (v == null || v === "") return nullable ? null : 0;
        const n = int(v);
        if (n == null || n < 0 || n > 10_000_000) fail(`Check the ${what}.`);
        return n;
      };
      const options = {
        stock_scope: a.stock_scope === "network" ? "network" : "own",
        location_filter: a.location_filter === true,
        ship_own: a.ship_own === true,
        ship_flat_cents: centsOr(a.ship_flat_cents, "shipping charge", false) as number,
        free_ship_over_cents: centsOr(a.free_ship_over_cents, "free-shipping amount", true),
        order_min_cents: centsOr(a.order_min_cents, "order minimum", false) as number,
      };
      if (options.ship_flat_cents > 100_000) fail("Shipping per order can be up to $1,000.");
      const write = (withOptions: boolean) =>
        sfId
          ? db.from("fittings_storefronts").update(withOptions ? { ...row, ...options } : row).eq("id", sfId).select("id").single()
          : db.from("fittings_storefronts").insert(withOptions ? { ...row, ...options } : row).select("id").single();
      if (sfId && !others.some((o) => o.id === sfId)) fail("That store is gone. Reload the page.");
      let saved = await write(true);
      // Before the options exist in the database, save the rest.
      if (saved.error && /stock_scope|location_filter|ship_own|ship_flat_cents|free_ship_over|order_min_cents/.test(saved.error.message)) {
        saved = await write(false);
        if (!saved.error) return { storefront_id: saved.data!.id, options_saved: false };
      }
      if (saved.error) fail(saved.error.message);
      return { storefront_id: saved.data!.id };
    }

    case "location.save": {
      const all = await db.from("fittings_locations").select("*").eq("kind", "store");
      if (all.error) fail("Locations aren't set up yet.");
      const others = ((all.data ?? []) as Array<Record<string, unknown>>).map(normalizeLocation);
      const locId = isId(a.location_id) ? (a.location_id as string) : "";
      const row = {
        dealer_id: isId(a.dealer_id) ? (a.dealer_id as string) : "",
        name: str(a.name, 60).trim(),
        code: normCode(str(a.code, 12)),
        city: str(a.city, 50).trim(),
        state: str(a.state, 2).toUpperCase(),
        zip: str(a.zip, 5),
        ships: a.ships !== false,
        pickup: a.pickup !== false,
        active: a.active !== false,
        sort: int(a.sort) ?? (locId ? others.find((o) => o.id === locId)?.sort ?? 0 : others.length),
        // Only sent once routing is set up in the database.
        ...(typeof a.takes_routed === "boolean" ? { takes_routed: a.takes_routed } : {}),
        // Ship-from street and phone: only sent once supabase/add-operations.sql has run.
        ...(typeof a.street1 === "string" ? { street1: str(a.street1, 80), street2: str(a.street2, 80), phone: str(a.phone, 30) } : {}),
      };
      const problem = locationProblem({ ...row, id: locId }, others);
      if (problem) fail(problem);
      let savedId = locId;
      if (locId) {
        const cur = others.find((o) => o.id === locId);
        if (!cur) fail("That location is gone. Reload the page.");
        await must(db.from("fittings_locations").update(row).eq("id", locId).eq("kind", "store"));
      } else {
        if (row.street1 && !row.city) fail("Add the city for this address.");
        const ins = await db.from("fittings_locations").insert({ ...row, kind: "store" }).select("id").single();
        if (ins.error) fail(ins.error.message);
        savedId = ins.data!.id as string;
      }
      if (a.make_default === true) await must(db.from(T.settings).update({ default_location_id: savedId }).eq("id", 1));
      return { location_id: savedId };
    }

    case "stock.history": {
      const { data, error } = await db
        .from("fittings_stock_moves")
        .select("*")
        .eq("product_id", id)
        .order("id", { ascending: false })
        .limit(50);
      if (error) fail("Stock history isn't set up yet.");
      const ids = [...new Set((data ?? []).map((m) => m.order_id).filter(Boolean))] as string[];
      const numbers: Record<string, number> = {};
      if (ids.length) {
        const o = await db.from(T.orders).select("id, number").in("id", ids);
        for (const r of o.data ?? []) numbers[r.id as string] = r.number as number;
      }
      return { moves: (data ?? []) as StockMove[], numbers };
    }

    case "cost.set": {
      const cost = a.cost_cents === null ? null : int(a.cost_cents);
      if (cost != null && cost < 0) fail("Cost must be 0 or more.");
      const cur = await getCost(db, id);
      await must(db.from(T.costs).upsert({ product_id: id, cost_cents: cost, margin: cur.margin }));
      // Hold the margin: a new cost moves the sell price.
      if (cost != null && cost > 0 && cur.margin != null && cur.margin < 100) {
        const price = priceFromMargin(cost, cur.margin);
        await must(db.from(T.products).update({ price_cents: price, updated_at: now() }).eq("id", id));
        return { repriced: price, margin: cur.margin };
      }
      return {};
    }

    case "margin.set": {
      const cur = await getCost(db, id);
      if (a.margin === null) {
        await must(db.from(T.costs).upsert({ product_id: id, cost_cents: cur.cost_cents, margin: null }));
        return {};
      }
      const margin = num(a.margin);
      if (margin == null || margin >= 100 || margin <= -1000) fail("Margin must be below 100%.");
      if (!(cur.cost_cents && cur.cost_cents > 0)) fail("Enter the cost first, then the margin.");
      await must(db.from(T.costs).upsert({ product_id: id, cost_cents: cur.cost_cents, margin }));
      await must(
        db
          .from(T.products)
          .update({ price_cents: priceFromMargin(cur.cost_cents!, margin!), updated_at: now() })
          .eq("id", id),
      );
      return {};
    }

    case "price.set": {
      const price = a.price_cents === null ? null : int(a.price_cents);
      if (price != null && price < 0) fail("Price must be 0 or more.");
      const value = price === 0 ? null : price;
      await must(db.from(T.products).update({ price_cents: value, updated_at: now() }).eq("id", id));
      const cur = await getCost(db, id);
      if (value != null && cur.cost_cents && cur.cost_cents > 0) {
        await must(
          db
            .from(T.costs)
            .upsert({ product_id: id, cost_cents: cur.cost_cents, margin: marginFrom(cur.cost_cents, value) }),
        );
      }
      return {};
    }

    case "price.bulk": {
      const margin = num(a.margin);
      if (margin == null || margin < 0 || margin >= 100) fail("Enter a margin from 0 to 99.");
      const costs = await db.from(T.costs).select("*").gt("cost_cents", 0);
      const rows = costs.data ?? [];
      if (rows.length === 0) fail("No items have a cost yet. Enter costs first.");
      for (const row of rows) {
        const pid = row.product_id as string;
        await must(db.from(T.costs).update({ margin }).eq("product_id", pid));
        await must(
          db
            .from(T.products)
            .update({ price_cents: priceFromMargin(row.cost_cents as number, margin!), updated_at: now() })
            .eq("id", pid),
        );
      }
      return { repriced: rows.length };
    }

    case "photo.delete": {
      const path = str(a.path, 200);
      const p = await getProduct(db, id);
      if (!p.photos.includes(path)) return {};
      await must(
        db
          .from(T.products)
          .update({ photos: p.photos.filter((x) => x !== path), updated_at: now() })
          .eq("id", id),
      );
      await db.storage.from(T.bucket).remove([path]);
      return {};
    }

    case "photo.first": {
      const path = str(a.path, 200);
      const p = await getProduct(db, id);
      if (!p.photos.includes(path)) return {};
      await must(
        db
          .from(T.products)
          .update({ photos: [path, ...p.photos.filter((x) => x !== path)], updated_at: now() })
          .eq("id", id),
      );
      return {};
    }

    case "settings.save": {
      const s = (a.settings ?? {}) as Payload;
      const cents = (v: unknown, label: string, allowNull = false): number | null => {
        if (v === null && allowNull) return null;
        const n = int(v);
        return n == null || n < 0 ? fail(`${label} must be 0 or more.`) : n;
      };
      const holdMinutes = ((n) => (n != null && n >= 30 && n <= 1440 ? n : fail("Hold parts in checkout for 30 to 1440 minutes.")))(int(s.hold_minutes ?? 30));
      const saveSettings = (withHold: boolean) =>
        db.from(T.settings).upsert({
          id: 1,
          store_name: str(s.store_name, 60) || "Hydraulic Fittings",
          tagline: str(s.tagline, 90),
          phone: str(s.phone, 30),
          email: str(s.email, 80),
          low_stock: cents(s.low_stock, "The low-stock number"),
          shipping_flat_cents: cents(s.shipping_flat_cents, "The shipping fee"),
          order_min_cents: cents(s.order_min_cents, "The order minimum"),
          free_ship_over_cents: cents(s.free_ship_over_cents, "The free-shipping amount", true),
          ship_cutoff: /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(str(s.ship_cutoff, 5))
            ? str(s.ship_cutoff, 5)
            : fail("Give the same-day cutoff as a time, like 14:00."),
          ship_tz: SHIP_ZONES.some((z) => z.id === s.ship_tz) ? s.ship_tz : "America/Chicago",
          ...(withHold ? { hold_minutes: holdMinutes, location_filter: s.location_filter === true } : {}),
        });
      const saved = await saveSettings(true);
      // Before supabase/add-stock-holds.sql runs there is no hold_minutes column.
      if (saved.error && /hold_minutes|location_filter/.test(saved.error.message)) await must(saveSettings(false));
      else if (saved.error) throw new Error(saved.error.message);
      const c = (a.config ?? {}) as Payload;
      const from = (c.ship_from ?? {}) as Payload;
      const shipFrom: ShipFrom = {
        name: str(from.name, 60),
        company: str(from.company, 60),
        street1: str(from.street1, 80),
        street2: str(from.street2, 80),
        city: str(from.city, 50),
        state: str(from.state, 2).toUpperCase(),
        zip: str(from.zip, 10),
        phone: str(from.phone, 30),
        email: str(from.email, 80),
      };
      const presets: ParcelPreset[] = (Array.isArray(c.presets) ? c.presets : [])
        .slice(0, 12)
        .map((raw) => {
          const r = raw as Payload;
          return {
            name: str(r.name, 40),
            length: num(r.length) ?? 0,
            width: num(r.width) ?? 0,
            height: num(r.height) ?? 0,
            weight_oz: num(r.weight_oz) ?? 0,
          };
        })
        .filter((r) => r.name && r.length > 0 && r.width > 0 && r.height > 0);
      await setConfig(db, "ship_from", shipFrom);
      await setConfig(db, "presets", presets);
      await setConfig(db, "tax_mode", c.tax_mode === "stripe" ? "stripe" : "off");
      await setConfig(db, "label_format", c.label_format === "PDF_4x6" ? "PDF_4x6" : "PDF");
      return {};
    }

    case "order.update": {
      const patch: Record<string, unknown> = {};
      if (typeof a.notes === "string") patch.notes = str(a.notes, 1000);
      if (typeof a.tracking_number === "string") patch.tracking_number = str(a.tracking_number, 60);
      if (typeof a.carrier === "string") patch.carrier = str(a.carrier, 40);
      if (a.status === "shipped") {
        patch.status = "shipped";
        patch.shipped_at = now();
      } else if (a.status === "paid") {
        patch.status = "paid";
        patch.shipped_at = null;
      } else if (a.status === "cancelled") {
        patch.status = "cancelled";
      }
      if (Object.keys(patch).length) await must(db.from(T.orders).update(patch).eq("id", id));
      return {};
    }

    case "core.return": {
      // A core came back: work out the credit by the policy, refund it to the
      // card, and record it. The idempotency key makes a double tap harmless.
      const chargeId = int(a.charge_id);
      const qty = int(a.qty);
      const on = str(a.returned_on, 10);
      if (chargeId == null) fail("Pick the core that came back.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || Number.isNaN(Date.parse(`${on}T12:00:00Z`))) fail("Give the day the core arrived.");
      const ch = await db.from("fittings_order_charges").select("*").eq("id", chargeId!).maybeSingle();
      if (ch.error || !ch.data) fail("That charge was not found.");
      const charge = ch.data as OrderCharge & { order_id: string };
      if (charge.kind !== "core") fail("Only core charges are refunded this way.");
      const left = charge.qty - charge.returned_qty;
      if (qty == null || qty < 1 || qty > left) fail(left > 0 ? `Between 1 and ${left} can still come back on this line.` : "Every core on this line is already back.");
      const ord = await db.from(T.orders).select("id, number, paid_at, created_at, stripe_payment_intent, status").eq("id", charge.order_id).maybeSingle();
      if (ord.error || !ord.data) fail("The order was not found.");
      const order = ord.data as { id: string; number: number; paid_at: string | null; created_at: string; stripe_payment_intent: string | null; status: string };
      if (order.status === "cancelled") fail("This order was cancelled. Settle its cores in Stripe.");
      const soldAt = new Date(order.paid_at ?? order.created_at);
      const set = await db.from(T.settings).select("ship_tz").eq("id", 1).maybeSingle();
      const tz = normalizeSettings({ ...(set.data ?? {}), id: 1 }).ship_tz;
      if (on < storeDate(soldAt, tz)) fail("The core can't arrive before the order was placed.");
      if (on > storeDate(new Date(), tz)) fail("That day hasn't happened yet.");
      const credit = coreCredit(charge.unit_cents * qty!, soldAt, on, tz);
      const cents = Math.min(credit.cents, charge.total_cents - charge.refunded_cents);

      let refundId: string | null = null;
      if (cents > 0) {
        const stripe = getStripe();
        if (!stripe || !order.stripe_payment_intent) fail("This order has no Stripe payment to refund. Refund it by hand and add a note.");
        try {
          const refund = await stripe!.refunds.create(
            {
              payment_intent: order.stripe_payment_intent!,
              amount: cents,
              reason: "requested_by_customer",
              metadata: { order_id: order.id, order_number: String(order.number), charge_id: String(charge.id), kind: "core_return" },
            },
            { idempotencyKey: `core-${charge.id}-${charge.returned_qty}-${qty}` },
          );
          refundId = refund.id;
        } catch (e) {
          fail(`Stripe did not take the refund: ${(e as Error).message}`);
        }
      }
      await must(
        db.from("fittings_core_returns").insert({
          charge_id: charge.id,
          qty,
          returned_on: on,
          days: credit.days,
          credit_cents: cents,
          stripe_refund_id: refundId,
          note: str(a.note, 300),
        }),
      );
      await must(
        db
          .from("fittings_order_charges")
          .update({ returned_qty: charge.returned_qty + qty!, refunded_cents: charge.refunded_cents + cents })
          .eq("id", charge.id),
      );
      return { credit_cents: cents, text: credit.text };
    }

    case "quote.update": {
      const status = ["new", "quoted", "won", "lost", "cancelled"].includes(a.status as string) ? (a.status as string) : null;
      const patch: Record<string, unknown> = { updated_at: now() };
      if (status) patch.status = status;
      if (typeof a.answer === "string") patch.answer = str(a.answer, 2000);
      await must(db.from("fittings_quote_requests").update(patch).eq("id", id));
      return {};
    }

    case "stripe.webhook": {
      const stripe = getStripe() ?? fail("Add STRIPE_SECRET_KEY in Vercel first, then redeploy.");
      const url = `${origin}/api/stripe/webhook`;
      const prev = await getConfig<{ id?: string }>(db, "stripe_webhook");
      if (prev?.id) {
        try {
          await stripe.webhookEndpoints.del(prev.id);
        } catch {
          /* already gone */
        }
      }
      const endpoint = await stripe.webhookEndpoints.create({
        url,
        description: "Fittings store orders",
        enabled_events: [
          "checkout.session.completed",
          "checkout.session.async_payment_succeeded",
          "checkout.session.expired",
        ],
      });
      await setConfig(db, "stripe_webhook", { id: endpoint.id, secret: endpoint.secret, url });
      return { url };
    }

    case "label.rates": {
      const order = await db.from(T.orders).select("*").eq("id", str(a.order_id, 60)).maybeSingle();
      const o = (order.data as Order | null) ?? fail("That order was not found.");
      const to = o.ship_to ?? fail("This order has no shipping address.");
      const config = cleanConfig(
        ((await db.from(T.config).select("key, value")).data ?? []) as Array<{ key: string; value: unknown }>,
      );
      const { from, own } = await labelFrom(db, o.id, config.ship_from, isId(a.location_id) ? (a.location_id as string) : null);
      if (!from.name || !from.street1 || !from.city || !from.state || !from.zip) {
        fail("Add your ship-from address under Settings first, or a street address on the location.");
      }
      const parcel = (a.parcel ?? {}) as Payload;
      const dims = {
        length: num(parcel.length) ?? 0,
        width: num(parcel.width) ?? 0,
        height: num(parcel.height) ?? 0,
        weight_oz: num(parcel.weight_oz) ?? 0,
      };
      if (!(dims.length > 0 && dims.width > 0 && dims.height > 0 && dims.weight_oz > 0)) {
        fail("Enter the package size and weight.");
      }
      const quote = await getRates(from, to, dims, o.email);
      if (quote.rates.length === 0) fail(quote.note || "No rates came back for that package. Check the address and size.");
      return { rates: quote.rates, from: `${from.name}, ${from.city} ${from.state}`, own_address: own };
    }

    case "label.buy": {
      const orderId = str(a.order_id, 60);
      const order = await db.from(T.orders).select("*").eq("id", orderId).maybeSingle();
      const o = (order.data as Order | null) ?? fail("That order was not found.");
      if (o.shippo_transaction_id && a.again !== true) fail("This order already has a label.");
      const format = (await getConfig<string>(db, "label_format")) === "PDF_4x6" ? "PDF_4x6" : "PDF";
      const label = await buyLabel(str(a.rate_id, 80), format);
      await must(
        db
          .from(T.orders)
          .update({
            status: "shipped",
            shipped_at: now(),
            carrier: str(a.carrier, 40),
            service: str(a.service, 60),
            tracking_number: label.tracking_number,
            tracking_url: label.tracking_url,
            shippo_transaction_id: label.transaction_id,
            label_cost_cents: int(a.amount_cents),
          })
          .eq("id", orderId),
      );
      return { label_url: label.label_url, order_id: orderId };
    }

    case "label.url": {
      const order = await db.from(T.orders).select("shippo_transaction_id").eq("id", str(a.order_id, 60)).maybeSingle();
      const tx = (order.data?.shippo_transaction_id as string | null) ?? fail("This order has no label yet.");
      return { label_url: await freshLabelUrl(tx!), order_id: str(a.order_id, 60) };
    }

    default:
      return (await runOps(action, a, db)) ?? fail("Unknown action.");
  }
}

export async function GET() {
  if (!(await isAdmin())) return json({ ok: false, message: "Please sign in again." }, 401);
  try {
    return json({ ok: true, data: await loadData(adminDb()) });
  } catch (e) {
    console.error("admin load failed", e);
    return json({ ok: false, message: "The store data could not be loaded." }, 500);
  }
}

export async function POST(req: Request) {
  if (!sameOrigin(req) || !(await isAdmin())) return json({ ok: false, message: "Please sign in again." }, 401);
  let body: Payload;
  try {
    body = (await req.json()) as Payload;
  } catch {
    return json({ ok: false, message: "That request could not be read." }, 400);
  }
  const db = adminDb();
  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  try {
    const result = await run(str(body.action, 40), body, db, origin);
    return json({ ok: true, data: await loadData(db), result });
  } catch (e) {
    if (e instanceof ActionError) return json({ ok: false, message: e.message }, 400);
    console.error("admin action failed", body.action, e);
    // Stripe and Shippo explain their own refusals well; pass those through.
    const external = /^(stripe|label)\./.test(str(body.action, 40));
    const message =
      external && e instanceof Error ? e.message.slice(0, 300) : "That change did not save. Try again.";
    return json({ ok: false, message }, 500);
  }
}
