// The dealer portal's API: a dealer signs in with its own login and sees only
// orders with parts on its shelves, its pick lists and its statements.
import { sameOrigin } from "@/lib/auth";
import { currentDealer, dealerSignIn, dealerSignOut, type DealerSession } from "@/lib/dealer-session";
import { monthOf, monthRange, readSettlement } from "@/lib/settlements";
import { adminDb, json } from "@/lib/server";
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
  shipped: Array<{ location_id: string; carrier: string; tracking_number: string; shipped_at: string }>;
};

export type PortalData = {
  dealer: { name: string };
  user: { email: string; name: string };
  /** Backroad Iron's support email, from Settings. */
  support_email: string;
  locations: Array<{ id: string; name: string; code: string }>;
  orders: PortalOrder[];
};

async function load(db: SupabaseClient, s: DealerSession): Promise<PortalData> {
  const [lo, st] = await Promise.all([
    db.from("fittings_locations").select("id, name, code").eq("dealer_id", s.dealer.id).eq("kind", "store").order("sort"),
    db.from("fittings_settings").select("email").eq("id", 1).maybeSingle(),
  ]);
  const locations = (lo.data ?? []) as PortalData["locations"];
  const mine = locations.map((l) => l.id);
  const base = {
    dealer: { name: s.dealer.name },
    user: { email: s.user.email, name: s.user.name },
    support_email: ((st.data as { email?: string } | null)?.email ?? "").trim(),
    locations,
    orders: [] as PortalOrder[],
  };
  if (!mine.length) return base;
  const al = await db.from("fittings_allocations").select("order_id, product_id, location_id, qty").in("location_id", mine).limit(5000);
  const ids = [...new Set((al.data ?? []).map((a) => a.order_id as string))];
  if (!ids.length) return base;
  const since = new Date(Date.now() - 90 * 86400_000).toISOString();
  const [o, sh] = await Promise.all([
    db
      .from("fittings_orders")
      .select("id, number, status, ship_method, created_at, customer_name, phone, ship_to, notes, items:fittings_order_items(product_id, name, part_number)")
      .in("id", ids.slice(0, 1000))
      .in("status", ["paid", "shipped"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(150),
    db.from("fittings_shipments").select("order_id, location_id, carrier, tracking_number, shipped_at").in("order_id", ids.slice(0, 1000)).in("location_id", mine),
  ]);
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
      shipped: ((sh.error ? [] : sh.data) ?? [])
        .filter((x) => x.order_id === r.id)
        .map((x) => ({ location_id: x.location_id as string, carrier: x.carrier as string, tracking_number: x.tracking_number as string, shipped_at: x.shipped_at as string })),
    }),
  );
  return { ...base, orders };
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

  return json({ ok: false, message: "Unknown action." }, 400);
}
