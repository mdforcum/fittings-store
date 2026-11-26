// Back office: pick tickets. One order or a batch, routed through the shop by
// the shelf map (lib/picking.ts), with a check-off per item. Admin only.
//
// GET  ?orders=<id>,<id>      the ticket: the orders and the walk
// POST {action:"pick.mark", parts:[{order_item_id, product_id}], picked}
//                             check parts off (all of what each line needs) or back on
import { isAdmin, sameOrigin } from "@/lib/auth";
import { byLocationOrder, normalizeLocation, pickLocation, type Allocation } from "@/lib/places";
import { expandParts, routeByPlace, type PickKitItem, type PickMark, type PickOrderItem, type PickProduct } from "@/lib/picking";
import { adminDb, json } from "@/lib/server";
import type { Spot } from "@/lib/shelf";

export const dynamic = "force-dynamic";

const MAX_ORDERS = 25;
const MARKS = "fittings_pick_marks";
const SETUP = "Check-offs are not set up yet: run supabase/add-pick-marks.sql on the database.";
const bad = (message: string, status = 400) => json({ ok: false, message }, status);
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || e.code === "42703" || /does not exist|schema cache/i.test(e.message ?? ""));

type OrderRow = { id: string; number: number; status: string; customer_name: string | null; ship_method?: string | null; notes: string; paid_at: string | null };

/** Everything a ticket needs for these orders. Missing optional tables count as empty. */
async function load(orderIds: string[]) {
  const db = adminDb();
  const o = await db.from("fittings_orders").select("*").in("id", orderIds);
  if (o.error) throw new Error(o.error.message);
  const orders = ((o.data ?? []) as OrderRow[]).filter((r) => r.status === "paid" || r.status === "shipped");
  const ids = orders.map((r) => r.id);
  const numberOf = new Map(orders.map((r) => [r.id, r.number]));
  const it = ids.length
    ? await db.from("fittings_order_items").select("id, order_id, product_id, name, part_number, qty").in("order_id", ids)
    : { data: [], error: null };
  if (it.error) throw new Error(it.error.message);
  const items: PickOrderItem[] = ((it.data ?? []) as Array<Omit<PickOrderItem, "order_number">>).map((r) => ({
    ...r,
    id: Number(r.id),
    order_number: numberOf.get(r.order_id) ?? 0,
  }));
  const ordered = [...new Set(items.map((i) => i.product_id))];
  const kits = ordered.length
    ? await db.from("fittings_kit_items").select("kit_id, product_id, qty").in("kit_id", ordered)
    : { data: [], error: null };
  const kitItems = kits.error ? [] : ((kits.data ?? []) as PickKitItem[]);
  const wanted = [...new Set([...ordered, ...kitItems.map((k) => k.product_id)])];
  let products: PickProduct[] = [];
  if (wanted.length) {
    const p = await db.from("fittings_products").select("id, name, part_number, spot_id").in("id", wanted);
    if (missing(p.error)) {
      const q = await db.from("fittings_products").select("id, name, part_number").in("id", wanted);
      if (q.error) throw new Error(q.error.message);
      products = ((q.data ?? []) as Array<Omit<PickProduct, "spot_id">>).map((r) => ({ ...r, spot_id: null }));
    } else if (p.error) {
      throw new Error(p.error.message);
    } else {
      products = (p.data ?? []) as PickProduct[];
    }
  }
  const sp = await db.from("fittings_shelf_spots").select("id, parent_id, level, code, label, sort").limit(20000);
  const spots = sp.error ? [] : ((sp.data ?? []) as Spot[]);
  const itemIds = items.map((i) => i.id);
  const mk = itemIds.length ? await db.from(MARKS).select("order_item_id, product_id, picked_qty").in("order_item_id", itemIds) : { data: [], error: null };
  const marksReady = !missing(mk.error);
  if (mk.error && marksReady) throw new Error(mk.error.message);
  const marks = mk.error ? [] : ((mk.data ?? []) as PickMark[]).map((m) => ({ ...m, order_item_id: Number(m.order_item_id) }));
  // Where each order's items are pulled (per location), once locations exist.
  const al = ids.length
    ? await db.from("fittings_allocations").select("order_id, product_id, location_id, qty").in("order_id", ids)
    : { data: [], error: null };
  const allocations = al.error ? [] : ((al.data ?? []) as Allocation[]);
  const lo = allocations.length ? await db.from("fittings_locations").select("*").eq("kind", "store") : { data: [], error: null };
  const places = lo.error ? [] : ((lo.data ?? []) as Array<Record<string, unknown>>).map(normalizeLocation).sort(byLocationOrder);
  return { orders, items, products, kitItems, spots, marks, marksReady, allocations, places };
}

function parseIds(raw: string | null): string[] | null {
  const ids = [...new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (!ids.length || ids.length > MAX_ORDERS || !ids.every(isUuid)) return null;
  return ids;
}

export async function GET(req: Request) {
  if (!(await isAdmin())) return bad("Please sign in again.", 401);
  const ids = parseIds(new URL(req.url).searchParams.get("orders"));
  if (!ids) return bad(`Pick 1 to ${MAX_ORDERS} orders.`);
  try {
    const d = await load(ids);
    if (!d.orders.length) return bad("None of those orders are paid and waiting.", 404);
    // A part is pulled where its order line was taken from (a kit's parts with the kit).
    const lineOf = new Map(d.items.map((i) => [i.id, i]));
    const route = routeByPlace(
      expandParts(d.items, d.products, d.kitItems, d.marks),
      d.products,
      d.spots,
      (part) => {
        const line = lineOf.get(part.order_item_id);
        return line ? pickLocation(d.allocations, line.order_id, line.product_id) : null;
      },
      d.places,
    );
    return json({
      ok: true,
      orders: d.orders
        .sort((a, b) => a.number - b.number)
        .map((r) => ({ id: r.id, number: r.number, status: r.status, customer_name: r.customer_name, ship_method: r.ship_method ?? "parcel", notes: r.notes, paid_at: r.paid_at })),
      route,
      marks_ready: d.marksReady,
      mapped: d.spots.length > 0,
    });
  } catch (e) {
    console.error("pick ticket load failed", e);
    return bad("The pick ticket could not be loaded.", 500);
  }
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return bad("That request came from somewhere else.", 403);
  if (!(await isAdmin())) return bad("Please sign in again.", 401);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("That request was not readable.");
  }
  if (body.action !== "pick.mark") return bad("Unknown action.");
  const asked = Array.isArray(body.parts) ? body.parts.slice(0, 500) : [];
  const parts = asked
    .map((p) => p as Record<string, unknown>)
    .map((p) => ({ order_item_id: Number(p.order_item_id), product_id: typeof p.product_id === "string" ? p.product_id.slice(0, 80) : "" }))
    .filter((p) => Number.isSafeInteger(p.order_item_id) && p.order_item_id > 0 && p.product_id);
  if (!parts.length) return bad("Pick at least one item.");
  const picked = body.picked === true;
  try {
    const db = adminDb();
    // Which orders the parts belong to, so the server, not the page, says what each line needs.
    const it = await db.from("fittings_order_items").select("order_id").in("id", [...new Set(parts.map((p) => p.order_item_id))]);
    if (it.error) throw new Error(it.error.message);
    const orderIds = [...new Set(((it.data ?? []) as Array<{ order_id: string }>).map((r) => r.order_id))];
    if (!orderIds.length) return bad("Those items are no longer on an order.");
    const d = await load(orderIds);
    if (!d.marksReady) return bad(SETUP, 503);
    const needed = new Map(expandParts(d.items, d.products, d.kitItems, []).map((p) => [p.key, p.qty]));
    const rows = parts
      .filter((p) => needed.has(`${p.order_item_id}:${p.product_id}`))
      .map((p) => ({
        order_item_id: p.order_item_id,
        product_id: p.product_id,
        picked_qty: picked ? needed.get(`${p.order_item_id}:${p.product_id}`)! : 0,
        picked_at: new Date().toISOString(),
      }));
    if (!rows.length) return bad("Those items are not on a paid order any more.");
    const { error } = await db.from(MARKS).upsert(rows, { onConflict: "order_item_id,product_id" });
    if (missing(error)) return bad(SETUP, 503);
    if (error) throw new Error(error.message);
    return json({ ok: true, marked: rows.length });
  } catch (e) {
    console.error("pick mark failed", e);
    return bad("That did not save. Try again.", 500);
  }
}
