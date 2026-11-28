// The dealer portal's API: a dealer signs in with its own login and sees only
// orders with parts on its shelves, its pick lists and its statements.
import { sameOrigin } from "@/lib/auth";
import { currentDealer, dealerSignIn, dealerSignOut, type DealerSession } from "@/lib/dealer-session";
import type { ShipFrom } from "@/lib/admin-types";
import { LABELS_KEY, QUOTE_MINUTES, labelCharge, packageGuess, parcelFrom, quoteKey, readLabels, readQuote, signQuote, type PartShipping } from "@/lib/labels";
import { DEALER_REFRESH_KEY, IMPORT_LIMIT, locationShipFrom, readDealerRefresh, runningLow, type LowLine } from "@/lib/operations";
import { buildIndex, readPartPhoto } from "@/lib/lookup-server";
import { onhandMap } from "@/lib/places";
import { OVERRIDE_MIN, checkProblem, readRules, splitCounts, type DealerRules, type Role, type ShipCheck } from "@/lib/roles";
import { normalizeLocation } from "@/lib/places";
import { monthOf, monthRange, readSettlement } from "@/lib/settlements";
import { adminDb, env, getConfig, json } from "@/lib/server";
import { buyLabel, freshLabelUrl, getRates, type ShipTo } from "@/lib/shippo";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

type Payload = Record<string, unknown>;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export type PortalOrder = {
  id: string;
  number: number;
  status: string;
  ship_method: string;
  created_at: string;
  customer_name: string | null;
  phone: string | null;
  ship_to: Record<string, string> | null;
  notes: string;
  /** Only the parts this dealer pulls, by location. */
  lines: Array<{ product_id: string; name: string; part_number: string; qty: number; location_id: string }>;
  shipped: Array<{ location_id: string; carrier: string; tracking_number: string; shipped_at: string; has_label: boolean }>;
  /** A starting package for each location, from the parts' saved weight and box size. Blank where unknown. */
  packages: Record<string, { weight_lb: string; length: string; width: string; height: string }>;
  /** Who packed and who checked, by location, when the dealer asks for a second check. */
  checks: Record<string, ShipCheck>;
};

/** A count waiting for a manager's yes or no. */
export type PortalWaiting = {
  id: number;
  location_id: string;
  product_id: string;
  name: string;
  part_number: string;
  from_qty: number;
  to_qty: number;
  /** The count on the shelf right now, which may have moved since it was asked. */
  now: number;
  asked_name: string;
  asked_at: string;
  mine: boolean;
};

/** One line of the dealer's activity log. */
export type PortalEvent = { id: number; action: string; user_name: string; role: string; order_number: number | null; detail: Record<string, unknown>; created_at: string };

/** The dealer's own shelves: the catalog, the counts at its locations, and what's running low there. */
export type PortalStock = {
  products: Array<{ id: string; name: string; part_number: string; price_cents: number | null }>;
  /** part → location → count, for this dealer's locations only. */
  onhand: Record<string, Record<string, number>>;
  low: LowLine[];
};

/** A label price offered to the dealer; the token buys it. */
export type PortalQuote = { carrier: string; service: string; days: number | null; price_cents: number; token: string };

export type PortalData = {
  dealer: { name: string };
  user: { email: string; name: string };
  /** Backroad Iron's support email, from Settings. */
  support_email: string;
  /** The dealer can buy labels here on Backroad Iron's shipping account. */
  labels: boolean;
  locations: Array<{ id: string; name: string; code: string }>;
  orders: PortalOrder[];
  /** Minutes between the page's own reloads while it is on screen; 0 is off. */
  refresh_minutes: number;
  /** The signed-in person and what they may do. */
  me: { id: string; name: string; role: Role };
  /** This dealer's own rules: the second check and held counts. */
  rules: DealerRules;
  /** Counts waiting for a manager: all of them for a manager, a worker's own for a worker. */
  waiting: PortalWaiting[];
};

async function load(db: SupabaseClient, s: DealerSession): Promise<PortalData> {
  const [lo, st, lab, every, dl] = await Promise.all([
    db.from("fittings_locations").select("id, name, code").eq("dealer_id", s.dealer.id).eq("kind", "store").order("sort"),
    db.from("fittings_settings").select("email").eq("id", 1).maybeSingle(),
    getConfig<unknown>(db, LABELS_KEY),
    getConfig<unknown>(db, DEALER_REFRESH_KEY),
    db.from("fittings_dealers").select("*").eq("id", s.dealer.id).maybeSingle(),
  ]);
  const locations = (lo.data ?? []) as PortalData["locations"];
  const mine = locations.map((l) => l.id);
  // Second checks and held counts came with supabase/add-dealer-roles.sql; without it there are no rules.
  const [ck, cr] = mine.length
    ? await Promise.all([
        db.from("fittings_ship_checks").select("*").in("location_id", mine).limit(5000),
        db.from("fittings_count_requests").select("*").eq("dealer_id", s.dealer.id).eq("status", "pending").order("id").limit(500),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  const rules = readRules(dl.error ? null : (dl.data as Record<string, unknown> | null), !ck.error && !cr.error);
  const checkRows = (ck.error ? [] : (ck.data ?? [])) as Array<Record<string, unknown>>;
  const checksFor = (orderId: string) => {
    const out: PortalOrder["checks"] = {};
    for (const c of checkRows) {
      if (c.order_id !== orderId) continue;
      out[String(c.location_id)] = {
        packed_by: typeof c.packed_by === "string" ? c.packed_by : null,
        packed_name: String(c.packed_name ?? ""),
        packed_at: String(c.packed_at ?? ""),
        checked_name: String(c.checked_name ?? ""),
        checked_at: typeof c.checked_at === "string" ? c.checked_at : null,
        override_reason: String(c.override_reason ?? ""),
      };
    }
    return out;
  };
  const waiting = await waitingCounts(db, s, rules.ready ? ((cr.data ?? []) as Array<Record<string, unknown>>) : []);
  const base = {
    dealer: { name: s.dealer.name },
    user: { email: s.user.email, name: s.user.name },
    support_email: ((st.data as { email?: string } | null)?.email ?? "").trim(),
    labels: readLabels(lab).on && !!env.shippo && !!env.secret,
    locations,
    orders: [] as PortalOrder[],
    refresh_minutes: readDealerRefresh(every),
    me: { id: s.user.id, name: s.user.name || s.user.email, role: s.user.role },
    rules,
    waiting,
  };
  if (!mine.length) return base;
  const al = await db.from("fittings_allocations").select("order_id, product_id, location_id, qty").in("location_id", mine).limit(5000);
  const ids = [...new Set((al.data ?? []).map((a) => a.order_id as string))];
  if (!ids.length) return base;
  const since = new Date(Date.now() - 90 * 86400_000).toISOString();
  const shipments = async () => {
    const q = (cols: string) => db.from("fittings_shipments").select(cols).in("order_id", ids.slice(0, 1000)).in("location_id", mine);
    // The label column came with supabase/add-dealer-labels.sql.
    const full = await q("order_id, location_id, carrier, tracking_number, shipped_at, shippo_transaction_id");
    return full.error ? await q("order_id, location_id, carrier, tracking_number, shipped_at") : full;
  };
  const [o, sh] = await Promise.all([
    db
      .from("fittings_orders")
      .select("id, number, status, ship_method, created_at, customer_name, phone, ship_to, notes, items:fittings_order_items(product_id, name, part_number)")
      .in("id", ids.slice(0, 1000))
      .in("status", ["paid", "shipped"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(150),
    shipments(),
  ]);
  const shipRows = (sh.error ? [] : (sh.data ?? [])) as unknown as Array<Record<string, unknown>>;
  // Saved shipping details for the parts on these orders (blank when a part has none).
  const partIds = [...new Set((al.data ?? []).map((a) => a.product_id as string))];
  const pd = partIds.length ? await db.from("fittings_products").select("id, weight_oz, length_in, width_in, height_in").in("id", partIds.slice(0, 1000)) : { data: [], error: null };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const details = new Map<string, Omit<PartShipping, "qty">>();
  for (const p of (pd.error ? [] : (pd.data ?? [])) as Array<Record<string, unknown>>) {
    details.set(String(p.id), { weight_oz: num(p.weight_oz), length_in: num(p.length_in), width_in: num(p.width_in), height_in: num(p.height_in) });
  }
  const packagesFor = (orderId: string) => {
    const out: PortalOrder["packages"] = {};
    for (const a of al.data ?? []) {
      if (a.order_id !== orderId) continue;
      const loc = a.location_id as string;
      const lines = (al.data ?? [])
        .filter((x) => x.order_id === orderId && x.location_id === loc)
        .map((x) => ({ qty: x.qty as number, ...(details.get(x.product_id as string) ?? { weight_oz: null, length_in: null, width_in: null, height_in: null }) }));
      out[loc] ??= packageGuess(lines);
    }
    return out;
  };
  const orders = ((o.data ?? []) as Array<Record<string, unknown> & { items: Array<{ product_id: string; name: string; part_number: string | null }> }>).map(
    (r): PortalOrder => ({
      id: r.id as string,
      number: r.number as number,
      status: r.status as string,
      ship_method: r.ship_method === "pickup" ? "pickup" : "parcel",
      created_at: r.created_at as string,
      customer_name: (r.customer_name as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      ship_to: (r.ship_to as Record<string, string> | null) ?? null,
      notes: (r.notes as string) ?? "",
      lines: (al.data ?? [])
        .filter((a) => a.order_id === r.id)
        .map((a) => {
          const it = r.items.find((i) => i.product_id === a.product_id);
          return { product_id: a.product_id as string, name: it?.name ?? (a.product_id as string), part_number: it?.part_number ?? "", qty: a.qty as number, location_id: a.location_id as string };
        }),
      shipped: shipRows
        .filter((x) => x.order_id === r.id)
        .map((x) => ({
          location_id: x.location_id as string,
          carrier: x.carrier as string,
          tracking_number: x.tracking_number as string,
          shipped_at: x.shipped_at as string,
          has_label: typeof x.shippo_transaction_id === "string" && x.shippo_transaction_id !== "",
        })),
      packages: packagesFor(r.id as string),
      checks: checksFor(r.id as string),
    }),
  );
  return { ...base, orders };
}

const bad = (message: string, status = 400) => json({ ok: false, message }, status);

/**
 * Everything a label needs, checked: the location is this dealer's, labels
 * are on, the order ships by parcel, this location pulled parts for it and
 * hasn't shipped them yet.
 */
/** Counts waiting for a manager, with the part's name and the count on the shelf now. A worker sees only their own. */
async function waitingCounts(db: SupabaseClient, s: DealerSession, rows: Array<Record<string, unknown>>): Promise<PortalWaiting[]> {
  const mineOnly = s.user.role !== "manager";
  const list = rows.filter((r) => !mineOnly || r.asked_by === s.user.id);
  if (!list.length) return [];
  const ids = [...new Set(list.map((r) => String(r.product_id)))].slice(0, 500);
  const [p, oh] = await Promise.all([
    db.from("fittings_products").select("id, name, part_number").in("id", ids),
    db.from("fittings_onhand").select("product_id, location_id, qty").in("product_id", ids).in("location_id", [...new Set(list.map((r) => String(r.location_id)))]),
  ]);
  const named = new Map(((p.data ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.id), r]));
  const have = onhandMap((oh.error ? [] : (oh.data ?? [])) as Array<{ product_id: unknown; location_id: unknown; qty: unknown }>);
  return list.map((r) => ({
    id: Number(r.id),
    location_id: String(r.location_id),
    product_id: String(r.product_id),
    name: String(named.get(String(r.product_id))?.name ?? r.product_id),
    part_number: String(named.get(String(r.product_id))?.part_number ?? ""),
    from_qty: Number(r.from_qty ?? 0),
    to_qty: Number(r.to_qty ?? 0),
    now: have[String(r.product_id)]?.[String(r.location_id)] ?? 0,
    asked_name: String(r.asked_name ?? ""),
    asked_at: String(r.asked_at ?? ""),
    mine: r.asked_by === s.user.id,
  }));
}

/** Writes one line to the dealer's activity log. Best effort: a missing table never stops the work itself. */
async function logEvent(db: SupabaseClient, s: DealerSession, action: string, extra: { order_id?: string; location_id?: string; detail?: Record<string, unknown> } = {}) {
  await db.from("fittings_dealer_events").insert({
    dealer_id: s.dealer.id,
    user_id: s.user.id,
    user_name: s.user.name || s.user.email,
    role: s.user.role,
    action,
    order_id: extra.order_id ?? null,
    location_id: extra.location_id ?? null,
    detail: extra.detail ?? {},
  });
}

/** True when the dealer asks for a second check and this order hasn't had it at this location. */
async function checkNeeded(db: SupabaseClient, orderId: string, locationId: string): Promise<boolean> {
  const r = await db.rpc("fittings_ship_check_needed", { p_order: orderId, p_location: locationId });
  return !r.error && r.data === true;
}

async function labelSetup(db: SupabaseClient, s: DealerSession, a: Payload) {
  if (!isId(a.order_id) || !isId(a.location_id)) return bad("Pick the order.");
  if (await checkNeeded(db, a.order_id, a.location_id)) return bad(checkProblem("ship check needed"));
  const settings = readLabels(await getConfig<unknown>(db, LABELS_KEY));
  if (!settings.on || !env.shippo || !env.secret) return bad("Buying labels here isn't turned on. Enter the tracking number instead.");
  const [loc, ord, al, sh] = await Promise.all([
    db.from("fittings_locations").select("*").eq("id", a.location_id).maybeSingle(),
    db.from("fittings_orders").select("id, number, status, ship_method, ship_to, email").eq("id", a.order_id).maybeSingle(),
    db.from("fittings_allocations").select("qty").eq("order_id", a.order_id).eq("location_id", a.location_id).limit(1),
    db.from("fittings_shipments").select("location_id").eq("order_id", a.order_id).eq("location_id", a.location_id).limit(1),
  ]);
  if (loc.data?.dealer_id !== s.dealer.id) return bad("That isn't one of your locations.", 403);
  const o = ord.data as { id: string; number: number; status: string; ship_method: string; ship_to: ShipTo | null; email: string | null } | null;
  if (!o || !(al.data ?? []).length) return bad("That order has no parts at this location.", 403);
  if (o.status !== "paid" && o.status !== "shipped") return bad("That order can't ship right now.");
  if (o.ship_method === "pickup" || !o.ship_to) return bad("This order is a pickup, so it doesn't need a label.");
  if (sh.error) return bad("Labels aren't set up yet.");
  if ((sh.data ?? []).length) return bad("This part of the order is already marked shipped.");
  return { settings, order: o, to: o.ship_to, location: normalizeLocation(loc.data as Record<string, unknown>) };
}

async function myLocations(db: SupabaseClient, s: DealerSession): Promise<Array<{ id: string; active: boolean }>> {
  const lo = await db.from("fittings_locations").select("id, active").eq("dealer_id", s.dealer.id).eq("kind", "store");
  return ((lo.data ?? []) as Array<{ id: string; active?: boolean }>).map((l) => ({ id: l.id, active: l.active !== false }));
}

async function loadStock(db: SupabaseClient, s: DealerSession): Promise<PortalStock> {
  const locs = await myLocations(db, s);
  const mine = locs.map((l) => l.id);
  if (!mine.length) return { products: [], onhand: {}, low: [] };
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [p, oh, mv, st] = await Promise.all([
    db.from("fittings_products").select("id, name, part_number, price_cents").order("sort").limit(5000),
    db.from("fittings_onhand").select("product_id, location_id, qty").in("location_id", mine).limit(50000),
    db.from("fittings_stock_moves").select("product_id, location_id, delta").eq("kind", "sale").in("location_id", mine).gte("created_at", since).limit(50000),
    db.from("fittings_settings").select("low_stock").eq("id", 1).maybeSingle(),
  ]);
  const products = ((p.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    name: typeof r.name === "string" ? r.name : "",
    part_number: typeof r.part_number === "string" ? r.part_number : "",
    price_cents: typeof r.price_cents === "number" ? r.price_cents : null,
  }));
  const onhand = onhandMap((oh.error ? [] : (oh.data ?? [])) as Array<{ product_id: unknown; location_id: unknown; qty: unknown }>);
  const sold: Record<string, Record<string, number>> = {};
  for (const m of mv.error ? [] : (mv.data ?? [])) {
    if (!m.location_id) continue;
    const row = (sold[m.product_id as string] ??= {});
    row[m.location_id as string] = (row[m.location_id as string] ?? 0) - (m.delta as number);
  }
  const low = runningLow(products, onhand, sold, locs, Number((st.data as { low_stock?: number } | null)?.low_stock ?? 2));
  return { products, onhand, low };
}

/** Running low at this dealer's locations, without loading the whole catalog: only the parts on its shelves or sold there. */
async function loadLow(db: SupabaseClient, s: DealerSession): Promise<LowLine[]> {
  const locs = await myLocations(db, s);
  const mine = locs.map((l) => l.id);
  if (!mine.length) return [];
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [oh, mv, st] = await Promise.all([
    db.from("fittings_onhand").select("product_id, location_id, qty").in("location_id", mine).limit(50000),
    db.from("fittings_stock_moves").select("product_id, location_id, delta").eq("kind", "sale").in("location_id", mine).gte("created_at", since).limit(50000),
    db.from("fittings_settings").select("low_stock").eq("id", 1).maybeSingle(),
  ]);
  if (oh.error) return [];
  const onhand = onhandMap(oh.data as Array<{ product_id: unknown; location_id: unknown; qty: unknown }>);
  const sold: Record<string, Record<string, number>> = {};
  for (const m of mv.error ? [] : (mv.data ?? [])) {
    if (!m.location_id) continue;
    const row = (sold[m.product_id as string] ??= {});
    row[m.location_id as string] = (row[m.location_id as string] ?? 0) - (m.delta as number);
  }
  const ids = [...new Set([...Object.keys(onhand), ...Object.keys(sold)])];
  const products: Array<{ id: string; name: string; part_number: string }> = [];
  for (let i = 0; i < ids.length; i += 300) {
    const p = await db.from("fittings_products").select("id, name, part_number").in("id", ids.slice(i, i + 300));
    for (const r of (p.error ? [] : (p.data ?? [])) as Array<Record<string, unknown>>) {
      products.push({ id: String(r.id), name: typeof r.name === "string" ? r.name : "", part_number: typeof r.part_number === "string" ? r.part_number : "" });
    }
  }
  return runningLow(products, onhand, sold, locs, Number((st.data as { low_stock?: number } | null)?.low_stock ?? 2));
}

async function run(action: string, a: Payload, db: SupabaseClient, s: DealerSession): Promise<Response | null> {
  // Part finder: the dealer's own bins and sales, and no supplier numbers.
  if (action === "lookup.index") {
    return json({ ok: true, result: { index: await buildIndex(db, { supplier: false, locations: (await myLocations(db, s)).map((l) => l.id) }) } });
  }
  if (action === "lookup.photo") {
    const r = await readPartPhoto(a.image, a.type);
    return "problem" in r ? bad(r.problem) : json({ ok: true, result: r });
  }

  // The dealer's own shelves -------------------------------------------------------------
  if (action === "stock.load") return json({ ok: true, result: { stock: await loadStock(db, s) } });

  // The second check before shipping -------------------------------------------------
  if (action === "check.pack" || action === "check.pass") {
    if (!isId(a.order_id) || !isId(a.location_id)) return bad("Pick the order.");
    const reason = str(a.reason, 300);
    if (action === "check.pass" && a.override === true && reason.length < OVERRIDE_MIN) return bad(checkProblem("give a reason"));
    const r =
      action === "check.pack"
        ? await db.rpc("fittings_ship_check_pack", { p_order: a.order_id, p_location: a.location_id, p_user: s.user.id })
        : await db.rpc("fittings_ship_check_pass", { p_order: a.order_id, p_location: a.location_id, p_user: s.user.id, p_reason: a.override === true ? reason : "" });
    if (r.error) return bad(/does not exist|schema cache|PGRST20/.test(`${r.error.code} ${r.error.message}`) ? "The second check isn't set up yet." : checkProblem(r.error.message));
    return json({ ok: true, data: await load(db, s), result: { how: action === "check.pack" ? "packed" : r.data } });
  }

  // A manager sets the shop's own rules ---------------------------------------------
  if (action === "rules.save") {
    if (s.user.role !== "manager") return bad("Only a manager can change the shop rules.", 403);
    const mode = a.ship_check === "any" || a.ship_check === "manager" ? a.ship_check : a.ship_check === "off" ? "off" : null;
    const hold = typeof a.count_hold_over === "number" && Number.isInteger(a.count_hold_over) ? a.count_hold_over : -1;
    if (!mode) return bad("Pick how orders are checked.");
    if (hold < 0 || hold > 100000) return bad("Enter a whole number, 0 or more.");
    const r = await db.from("fittings_dealers").update({ ship_check: mode, count_hold_over: hold }).eq("id", s.dealer.id);
    if (r.error) return bad("The shop rules aren't set up yet.");
    await logEvent(db, s, "rules", { detail: { ship_check: mode, count_hold_over: hold } });
    return json({ ok: true, data: await load(db, s) });
  }

  // A manager answers a held count -----------------------------------------------------
  if (action === "count.decide") {
    const id = typeof a.id === "number" && Number.isInteger(a.id) ? a.id : 0;
    if (!id) return bad("Pick the count.");
    if (s.user.role !== "manager") return bad(checkProblem("manager needed"), 403);
    const r = await db.rpc("fittings_count_decide", { p_id: id, p_user: s.user.id, p_approve: a.approve === true });
    if (r.error) return bad(checkProblem(r.error.message));
    return json({ ok: true, data: await load(db, s), result: { how: r.data } });
  }

  // Who did what, for managers ---------------------------------------------------------
  if (action === "events.list") {
    if (s.user.role !== "manager") return bad(checkProblem("manager needed"), 403);
    const r = await db.from("fittings_dealer_events").select("*").eq("dealer_id", s.dealer.id).order("id", { ascending: false }).limit(60);
    if (r.error) return json({ ok: true, result: { events: [] } });
    const rows = (r.data ?? []) as Array<Record<string, unknown>>;
    const orderIds = [...new Set(rows.map((e) => e.order_id).filter((v): v is string => typeof v === "string"))];
    const nums = new Map<string, number>();
    if (orderIds.length) for (const o of (await db.from("fittings_orders").select("id, number").in("id", orderIds)).data ?? []) nums.set(o.id as string, o.number as number);
    const events: PortalEvent[] = rows.map((e) => ({
      id: Number(e.id),
      action: String(e.action),
      user_name: String(e.user_name ?? ""),
      role: String(e.role ?? ""),
      order_number: typeof e.order_id === "string" ? (nums.get(e.order_id) ?? null) : null,
      detail: (e.detail as Record<string, unknown>) ?? {},
      created_at: String(e.created_at ?? ""),
    }));
    return json({ ok: true, result: { events } });
  }

  // Home's quick look: what's running low on this dealer's own shelves.
  if (action === "home") return json({ ok: true, result: { low: await loadLow(db, s) } });

  if (action === "stock.count" || action === "stock.sold") {
    if (!isId(a.location_id)) return bad("Pick the location.");
    if (!(await myLocations(db, s)).some((l) => l.id === a.location_id)) return bad("That isn't one of your locations.", 403);
    const who = s.user.name || s.user.email;

    if (action === "stock.count") {
      const raw = Array.isArray(a.lines) ? (a.lines as Payload[]) : [];
      if (!raw.length) return bad("There's nothing to save.");
      if (raw.length > IMPORT_LIMIT) return bad(`Save up to ${IMPORT_LIMIT} counts at a time.`);
      const lines = raw.map((l) => ({ product_id: str(l?.product_id, 80), qty: typeof l?.qty === "number" && Number.isInteger(l.qty) ? l.qty : -1 }));
      if (lines.some((l) => !l.product_id || l.qty < 0 || l.qty > 100000)) return bad("Every count must be a whole number, 0 or more.");
      // What's on the shelf now, to tell a small correction from a big one and to log the change.
      const ids = [...new Set(lines.map((l) => l.product_id))];
      const have = new Map<string, number>();
      const named = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 300) {
        const chunk = ids.slice(i, i + 300);
        const [oh, pn] = await Promise.all([
          db.from("fittings_onhand").select("product_id, qty").eq("location_id", a.location_id).in("product_id", chunk),
          db.from("fittings_products").select("id, name").in("id", chunk),
        ]);
        for (const r of (oh.data ?? []) as Array<{ product_id: string; qty: number }>) have.set(r.product_id, r.qty);
        for (const r of (pn.data ?? []) as Array<{ id: string; name: string }>) named.set(r.id, r.name);
      }
      if (ids.some((id) => !named.has(id))) return bad("One of those parts isn't in the catalog. Email Backroad Iron to add it.");
      const dealer = s.user.role === "worker" ? await db.from("fittings_dealers").select("*").eq("id", s.dealer.id).maybeSingle() : null;
      const rules = readRules(dealer?.data as Record<string, unknown> | null, true);
      const split = splitCounts(lines, (id) => have.get(id) ?? 0, s.user.role, rules);
      // Counts only: a dealer can't change a price or add a part to the catalog here.
      let changed = 0;
      if (split.apply.length) {
        const r = await db.rpc("fittings_import_counts", {
          p_location: a.location_id,
          p_lines: split.apply.map((l) => ({ product_id: l.product_id, qty: l.qty, price_cents: null })),
          p_note: `Dealer page count by ${who}`.slice(0, 120),
        });
        if (r.error) {
          return bad(/no item/.test(r.error.message) ? "One of those parts isn't in the catalog. Email Backroad Iron to add it." : "The counts didn't save. Try again.");
        }
        changed = Number(r.data ?? 0);
      }
      // Big changes by a worker wait for a manager: one open request per part, the newest count wins.
      for (const h of split.hold) {
        const row = { from_qty: h.from, to_qty: h.to, asked_by: s.user.id, asked_name: who, asked_at: new Date().toISOString() };
        const open = await db.from("fittings_count_requests").select("id").eq("location_id", a.location_id).eq("product_id", h.product_id).eq("status", "pending").maybeSingle();
        const saved = open.data
          ? await db.from("fittings_count_requests").update(row).eq("id", open.data.id as number)
          : await db.from("fittings_count_requests").insert({ ...row, dealer_id: s.dealer.id, location_id: a.location_id, product_id: h.product_id });
        if (saved.error) return bad("A count that needed a manager's OK didn't save. Try again.");
      }
      const moved = split.apply.filter((l) => (have.get(l.product_id) ?? 0) !== l.qty);
      if (moved.length > 20) await logEvent(db, s, "counts", { location_id: a.location_id, detail: { lines: moved.length } });
      else for (const l of moved) await logEvent(db, s, "count", { location_id: a.location_id, detail: { product_id: l.product_id, name: named.get(l.product_id), from: have.get(l.product_id) ?? 0, to: l.qty } });
      for (const h of split.hold.slice(0, 50)) await logEvent(db, s, "count_held", { location_id: a.location_id, detail: { product_id: h.product_id, name: named.get(h.product_id), from: h.from, to: h.to } });
      return json({ ok: true, result: { changed, waiting: split.hold.length, hold_over: rules.count_hold_over, stock: await loadStock(db, s) } });
    }

    const pid = str(a.product_id, 80);
    const qty = typeof a.qty === "number" && Number.isInteger(a.qty) ? a.qty : 0;
    if (!pid || qty < 1 || qty > 1000) return bad("Enter how many were sold.");
    const pr = await db.from("fittings_products").select("price_cents").eq("id", pid).maybeSingle();
    if (pr.error || !pr.data) return bad("That part isn't in the catalog.");
    const r = await db.rpc("fittings_counter_sale", {
      p_location: a.location_id,
      p_lines: [{ product_id: pid, qty, price_cents: typeof pr.data.price_cents === "number" ? pr.data.price_cents : 0 }],
      p_paid_by: "",
      p_note: "Dealer page",
      p_by: who,
    });
    if (r.error) {
      const m = /only (\d+) of/.exec(r.error.message);
      return bad(m ? `Only ${m[1]} on this shelf. Set the count first if that's wrong.` : "The sale didn't save. Try again.");
    }
    await logEvent(db, s, "sold", { location_id: a.location_id, detail: { product_id: pid, qty } });
    return json({ ok: true, result: { sale_id: r.data, stock: await loadStock(db, s) } });
  }

  if (action === "label.rates") {
    const setup = await labelSetup(db, s, a);
    if (setup instanceof Response) return setup;
    const parcel = parcelFrom((a.parcel ?? {}) as Record<string, unknown>);
    if (typeof parcel === "string") return bad(parcel);
    const shop = (await getConfig<Partial<ShipFrom>>(db, "ship_from")) ?? {};
    const fallback: ShipFrom = { name: "", company: "", street1: "", street2: "", city: "", state: "", zip: "", phone: "", email: "", ...shop };
    const { from, own } = locationShipFrom(setup.location, s.dealer.name, fallback);
    if (!own) return bad("Your location needs a street address before a label can print. Email Backroad Iron to add it.");
    let quote: Awaited<ReturnType<typeof getRates>>;
    try {
      quote = await getRates(from, setup.to, parcel, setup.order.email);
    } catch (e) {
      console.error("dealer label rates failed", setup.order.id, (e as Error).message);
      return bad("Rates could not be loaded. Check the package size and try again.");
    }
    if (!quote.rates.length) return bad(quote.note || "No rates came back for that package. Check the size and weight.");
    const key = quoteKey(env.secret);
    const expires = Date.now() + QUOTE_MINUTES * 60_000;
    const quotes: PortalQuote[] = quote.rates.slice(0, 12).map((r) => {
      const charge = labelCharge(r.amount_cents, setup.settings);
      const token = signQuote(
        { order_id: setup.order.id, location_id: setup.location.id, rate_id: r.id, carrier: r.carrier, service: r.service, cost_cents: r.amount_cents, charge_cents: charge, expires },
        key,
      );
      return { carrier: r.carrier, service: r.service, days: r.days, price_cents: charge, token };
    });
    return json({ ok: true, result: { quotes, from: `${from.street1}, ${from.city} ${from.state}` } });
  }

  if (action === "label.buy") {
    const setup = await labelSetup(db, s, a);
    if (setup instanceof Response) return setup;
    const q = readQuote(str(a.token, 4000), quoteKey(env.secret), setup.order.id, setup.location.id, Date.now());
    if (!q) return bad("That price ran out. Get rates again.");
    const format = (await getConfig<string>(db, "label_format")) === "PDF_4x6" ? "PDF_4x6" : "PDF";
    let label: Awaited<ReturnType<typeof buyLabel>>;
    try {
      label = await buyLabel(q.rate_id, format);
    } catch (e) {
      console.error("dealer label buy failed", setup.order.id, (e as Error).message);
      return bad("The label could not be bought. Get rates and try again, or enter the tracking number yourself.");
    }
    const rec = await db.rpc("fittings_dealer_label", {
      p_order_id: setup.order.id,
      p_location: setup.location.id,
      p_carrier: q.carrier,
      p_service: q.service,
      p_tracking: label.tracking_number,
      p_url: label.tracking_url,
      p_transaction: label.transaction_id,
      p_cost: q.cost_cents,
      p_charge: q.charge_cents,
      p_by: s.user.name || s.user.email,
    });
    const result = { label_url: label.label_url, tracking_number: label.tracking_number, carrier: q.carrier, charge_cents: q.charge_cents };
    if (!rec.error) await logEvent(db, s, "label", { order_id: setup.order.id, location_id: setup.location.id, detail: { carrier: q.carrier, tracking: label.tracking_number, charge_cents: q.charge_cents } });
    if (rec.error) {
      // The label exists and was paid for: hand it over, and say plainly it isn't on the order yet.
      console.error("dealer label bought but not recorded", setup.order.id, setup.location.id, label.transaction_id, rec.error.message);
      return json({
        ok: true,
        data: await load(db, s),
        result: { ...result, warning: `The label was bought, but it wasn't saved to order #${setup.order.number}. Print it now, then email Backroad Iron with the order number.` },
      });
    }
    return json({ ok: true, data: await load(db, s), result });
  }

  if (action === "label.url") {
    if (!isId(a.order_id) || !isId(a.location_id)) return bad("Pick the order.");
    const loc = await db.from("fittings_locations").select("dealer_id").eq("id", a.location_id).maybeSingle();
    if (loc.data?.dealer_id !== s.dealer.id) return bad("That isn't one of your locations.", 403);
    const sh = await db.from("fittings_shipments").select("shippo_transaction_id").eq("order_id", a.order_id).eq("location_id", a.location_id).maybeSingle();
    const tx = sh.error ? null : ((sh.data?.shippo_transaction_id as string | null) ?? null);
    if (!tx) return bad("There's no label saved for this shipment.");
    try {
      return json({ ok: true, result: { label_url: await freshLabelUrl(tx) } });
    } catch (e) {
      console.error("dealer label url failed", (e as Error).message);
      return bad("The label could not be opened. Try again.");
    }
  }
  return null;
}

export async function GET() {
  const db = adminDb();
  const s = await currentDealer(db);
  if (!s) return json({ ok: false, message: "Please sign in." }, 401);
  try {
    return json({ ok: true, data: await load(db, s) });
  } catch (e) {
    console.error("dealer load failed", e);
    return json({ ok: false, message: "Your orders could not be loaded. Try again." }, 500);
  }
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ ok: false, message: "Please sign in again." }, 401);
  let a: Payload;
  try {
    a = (await req.json()) as Payload;
  } catch {
    return json({ ok: false, message: "That request could not be read." }, 400);
  }
  const db = adminDb();
  const action = str(a.action, 30);

  if (action === "login") {
    const problem = await dealerSignIn(db, str(a.email, 120), typeof a.password === "string" ? a.password.slice(0, 200) : "");
    return problem ? json({ ok: false, message: problem }, 401) : json({ ok: true });
  }
  if (action === "logout") {
    await dealerSignOut();
    return json({ ok: true });
  }

  const s = await currentDealer(db);
  if (!s) return json({ ok: false, message: "Please sign in again." }, 401);

  if (action === "ship") {
    if (!isId(a.order_id) || !isId(a.location_id)) return json({ ok: false, message: "Pick the order." }, 400);
    const loc = await db.from("fittings_locations").select("dealer_id").eq("id", a.location_id).maybeSingle();
    if (loc.data?.dealer_id !== s.dealer.id) return json({ ok: false, message: "That isn't one of your locations." }, 403);
    const carrier = str(a.carrier, 40);
    const tracking = str(a.tracking_number, 80);
    const pickup = a.pickup === true;
    if (!pickup && !tracking) return json({ ok: false, message: "Enter the tracking number." }, 400);
    if (await checkNeeded(db, a.order_id, a.location_id)) return json({ ok: false, message: checkProblem("ship check needed") }, 400);
    const r = await db.rpc("fittings_ship_from_location", {
      p_order_id: a.order_id,
      p_location: a.location_id,
      p_carrier: pickup ? "Picked up" : carrier,
      p_tracking: pickup ? "" : tracking,
      p_url: "",
      p_by: s.user.name || s.user.email,
    });
    if (r.error) {
      const message = /ship check needed/.test(r.error.message)
        ? checkProblem(r.error.message)
        : /no parts on this order|only a paid/.test(r.error.message)
          ? "That order can't be marked shipped from here."
          : "That didn't save. Try again.";
      return json({ ok: false, message }, 400);
    }
    await logEvent(db, s, "shipped", { order_id: a.order_id, location_id: a.location_id, detail: pickup ? { carrier: "Picked up" } : { carrier, tracking } });
    return json({ ok: true, data: await load(db, s), result: { done: r.data === true } });
  }

  if (action === "statement") {
    if (s.user.role !== "manager") return json({ ok: false, message: "The statement is for managers. Ask your manager." }, 403);
    const month = /^\d{4}-\d{2}$/.test(str(a.month, 7)) ? str(a.month, 7) : monthOf(new Date().toISOString());
    const { from, to } = monthRange(month);
    const q = await db.from("fittings_settlements").select("*").eq("dealer_id", s.dealer.id).gte("created_at", from).lt("created_at", to).order("created_at");
    if (q.error) return json({ ok: false, message: "Statements aren't ready yet." }, 400);
    const ids = [...new Set((q.data ?? []).map((r) => r.order_id as string))];
    const nums: Record<string, number> = {};
    if (ids.length) for (const o of (await db.from("fittings_orders").select("id, number").in("id", ids)).data ?? []) nums[o.id as string] = o.number as number;
    const rows = (q.data ?? []).map((r) => readSettlement(r, nums[r.order_id as string] ?? null)).filter((r) => monthOf(r.created_at) === month);
    return json({ ok: true, result: { month, rows } });
  }

  return (await run(action, a, db, s)) ?? json({ ok: false, message: "Unknown action." }, 400);
}
