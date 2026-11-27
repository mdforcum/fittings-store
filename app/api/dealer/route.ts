// The dealer portal's API: a dealer signs in with its own login and sees only
// orders with parts on its shelves, its pick lists and its statements.
import { sameOrigin } from "@/lib/auth";
import { currentDealer, dealerSignIn, dealerSignOut, type DealerSession } from "@/lib/dealer-session";
import type { ShipFrom } from "@/lib/admin-types";
import { LABELS_KEY, QUOTE_MINUTES, labelCharge, parcelFrom, quoteKey, readLabels, readQuote, signQuote } from "@/lib/labels";
import { locationShipFrom } from "@/lib/operations";
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
};

async function load(db: SupabaseClient, s: DealerSession): Promise<PortalData> {
  const [lo, st, lab] = await Promise.all([
    db.from("fittings_locations").select("id, name, code").eq("dealer_id", s.dealer.id).eq("kind", "store").order("sort"),
    db.from("fittings_settings").select("email").eq("id", 1).maybeSingle(),
    getConfig<unknown>(db, LABELS_KEY),
  ]);
  const locations = (lo.data ?? []) as PortalData["locations"];
  const mine = locations.map((l) => l.id);
  const base = {
    dealer: { name: s.dealer.name },
    user: { email: s.user.email, name: s.user.name },
    support_email: ((st.data as { email?: string } | null)?.email ?? "").trim(),
    labels: readLabels(lab).on && !!env.shippo && !!env.secret,
    locations,
    orders: [] as PortalOrder[],
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
async function labelSetup(db: SupabaseClient, s: DealerSession, a: Payload) {
  if (!isId(a.order_id) || !isId(a.location_id)) return bad("Pick the order.");
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

async function run(action: string, a: Payload, db: SupabaseClient, s: DealerSession): Promise<Response | null> {
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
    const r = await db.rpc("fittings_ship_from_location", {
      p_order_id: a.order_id,
      p_location: a.location_id,
      p_carrier: pickup ? "Picked up" : carrier,
      p_tracking: pickup ? "" : tracking,
      p_url: "",
      p_by: s.user.name || s.user.email,
    });
    if (r.error) return json({ ok: false, message: /no parts on this order|only a paid/.test(r.error.message) ? "That order can't be marked shipped from here." : "That didn't save. Try again." }, 400);
    return json({ ok: true, data: await load(db, s), result: { done: r.data === true } });
  }

  if (action === "statement") {
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
