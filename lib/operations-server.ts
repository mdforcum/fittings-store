// Back-office actions for running the network day to day: returns and
// refunds, counter sales, spreadsheet imports, running-low lists, dealer
// logins and the alert outbox. Called from the back end's single API.
import type { SupabaseClient } from "@supabase/supabase-js";
import { TYPE_CATEGORY } from "./foundation";
import { counterLines, IMPORT_LIMIT, okEmail, refundFor, runningLow, stillOut, toE164, zipRows, type LowLine } from "./operations";
import { LABELS_KEY, MAX_FLAT_CENTS, MAX_MARKUP_BPS, readLabels } from "./labels";
import { buildIndex, linkUpc, readPartPhoto } from "./lookup-server";
import { hashPassword, passwordProblem } from "./passwords";
import { env, setConfig } from "./server";
import { refundLabel, type RefundStatus } from "./shippo";
import { getStripe } from "./payments";
import { onhandMap } from "./places";
import { expandParts, type PickKitItem, type PickMark, type PickOrderItem, type PickProduct } from "./picking";
import type { PickProgress, SaleRow } from "./home";
import { emailReady, queueLowStock, sendQueued, textReady } from "./notify";

export class ActionError extends Error {}
const fail = (message: string): never => {
  throw new ActionError(message);
};
type Payload = Record<string, unknown>;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "PGRST202" || e.code === "42883" || e.code === "PGRST205" || e.code === "42P01" || /could not find the (function|table)|does not exist|schema cache/i.test(e.message ?? ""));
const NOT_SET_UP = "Run supabase/add-operations.sql in the Supabase SQL Editor first.";

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function opsStatus(ready: boolean, labelsReady = false, labelConfig: unknown = null, zips: { ready: boolean; count: number } = { ready: false, count: 0 }) {
  return { ready, email: emailReady(), text: textReady(), labels: { ...readLabels(labelConfig), ready: labelsReady, shippo: !!env.shippo }, zips };
}

/** Parts running low at every active store location. */
export async function loadRunningLow(db: SupabaseClient): Promise<LowLine[]> {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [p, oh, lo, mv, s] = await Promise.all([
    db.from("fittings_products").select("id, name, part_number"),
    db.from("fittings_onhand").select("product_id, location_id, qty").limit(50000),
    db.from("fittings_locations").select("id, active").eq("kind", "store"),
    db.from("fittings_stock_moves").select("product_id, location_id, delta").eq("kind", "sale").gte("created_at", since).limit(50000),
    db.from("fittings_settings").select("low_stock").eq("id", 1).maybeSingle(),
  ]);
  if (p.error || oh.error || lo.error) fail("Locations aren't set up yet.");
  const sold: Record<string, Record<string, number>> = {};
  for (const m of mv.error ? [] : (mv.data ?? [])) {
    if (!m.location_id) continue;
    const row = (sold[m.product_id as string] ??= {});
    row[m.location_id as string] = (row[m.location_id as string] ?? 0) - (m.delta as number);
  }
  return runningLow(
    (p.data ?? []).map((r) => ({ id: r.id as string, name: (r.name as string) ?? "", part_number: (r.part_number as string) ?? "" })),
    onhandMap(oh.data as Array<{ product_id: unknown; location_id: unknown; qty: unknown }>),
    sold,
    (lo.data ?? []).map((l) => ({ id: l.id as string, active: l.active !== false })),
    Number((s.data as { low_stock?: number } | null)?.low_stock ?? 2),
  );
}

/**
 * What Home shows that the store data doesn't already hold: how far each open
 * order is pulled, what's running low, and the last 30 days of sales. Every
 * piece is optional: a table that isn't there yet just leaves its part empty.
 */
async function loadHome(db: SupabaseClient): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const CAP = 5000;
  const [open, web, counter, low, hoses, waiting] = await Promise.all([
    db.from("fittings_orders").select("id, number").eq("status", "paid").limit(500),
    db.from("fittings_orders").select("*").in("status", ["paid", "shipped"]).gte("paid_at", since).limit(CAP),
    db.from("fittings_counter_sales").select("total_cents, created_at").gte("created_at", since).limit(CAP),
    loadRunningLow(db).catch(() => [] as LowLine[]),
    db.from("fittings_hose_requests").select("id", { count: "exact" }).eq("status", "new").limit(1),
    db.from("fittings_alerts").select("status").in("status", ["queued", "failed"]).limit(2000),
  ]);
  const alertRows = (waiting.error ? [] : (waiting.data ?? [])) as Array<{ status: string }>;

  // Pull progress, by the same rules as the pick ticket (a kit with no bin of its own is pulled as its parts).
  const progress: PickProgress = {};
  const orders = (open.error ? [] : (open.data ?? [])) as Array<{ id: string; number: number }>;
  if (orders.length) {
    const ids = orders.map((o) => o.id);
    const numberOf = new Map(orders.map((o) => [o.id, o.number]));
    const it = await db.from("fittings_order_items").select("id, order_id, product_id, name, part_number, qty").in("order_id", ids);
    const items: PickOrderItem[] = ((it.error ? [] : (it.data ?? [])) as Array<Omit<PickOrderItem, "order_number">>).map((r) => ({ ...r, id: Number(r.id), order_number: numberOf.get(r.order_id) ?? 0 }));
    const ordered = [...new Set(items.map((i) => i.product_id))];
    const kits = ordered.length ? await db.from("fittings_kit_items").select("kit_id, product_id, qty").in("kit_id", ordered) : { data: [], error: null };
    const kitItems = (kits.error ? [] : (kits.data ?? [])) as PickKitItem[];
    const wanted = [...new Set([...ordered, ...kitItems.map((k) => k.product_id)])];
    let products: PickProduct[] = [];
    if (wanted.length) {
      const p = await db.from("fittings_products").select("id, name, part_number, spot_id").in("id", wanted);
      if (p.error) {
        const q = await db.from("fittings_products").select("id, name, part_number").in("id", wanted);
        products = ((q.data ?? []) as Array<Omit<PickProduct, "spot_id">>).map((r) => ({ ...r, spot_id: null }));
      } else products = (p.data ?? []) as PickProduct[];
    }
    const itemIds = items.map((i) => i.id);
    const mk = itemIds.length ? await db.from("fittings_pick_marks").select("order_item_id, product_id, picked_qty").in("order_item_id", itemIds) : { data: [], error: null };
    const marks = (mk.error ? [] : (mk.data ?? [])) as PickMark[];
    for (const part of expandParts(items, products, kitItems, marks)) {
      const row = (progress[part.order_id] ??= { need: 0, picked: 0 });
      row.need += part.qty;
      row.picked += part.picked_qty;
    }
  }

  const sales: SaleRow[] = [];
  for (const o of (web.error ? [] : (web.data ?? [])) as Array<Record<string, unknown>>) {
    if (typeof o.paid_at !== "string") continue;
    sales.push({ at: o.paid_at, cents: Number(o.subtotal_cents ?? 0), kind: "web", refunded: Number(o.refunded_cents ?? 0) });
  }
  for (const c of (counter.error ? [] : (counter.data ?? [])) as Array<Record<string, unknown>>) {
    if (typeof c.created_at === "string") sales.push({ at: c.created_at, cents: Number(c.total_cents ?? 0), kind: "counter" });
  }
  return {
    progress,
    low,
    sales,
    capped: (web.data?.length ?? 0) >= CAP || (counter.data?.length ?? 0) >= CAP,
    hoses: hoses.error ? 0 : (hoses.count ?? 0),
    alerts: { queued: alertRows.filter((r) => r.status === "queued").length, failed: alertRows.filter((r) => r.status === "failed").length },
  };
}

/** Runs an operations action; undefined when the action isn't one of these. */
export async function runOps(action: string, a: Payload, db: SupabaseClient): Promise<Record<string, unknown> | undefined> {
  switch (action) {
    // Returns, cancellations and refunds ----------------------------------------------
    case "order.return": {
      if (!isId(a.order_id)) fail("Pick the order.");
      const orderId = a.order_id as string;
      const ord = await db
        .from("fittings_orders")
        .select("*, items:fittings_order_items(product_id, name, unit_price_cents, qty)")
        .eq("id", orderId)
        .maybeSingle();
      if (ord.error || !ord.data) fail("That order was not found.");
      const o = ord.data as Record<string, unknown> & { items: Array<{ product_id: string; name: string; unit_price_cents: number; qty: number }> };
      if (!["paid", "shipped", "cancelled"].includes(o.status as string)) fail("Only a paid order can be returned or refunded.");
      if (!("refunded_cents" in o)) fail(NOT_SET_UP);
      const ret = await db.from("fittings_returns").select("product_id, qty").eq("order_id", orderId);
      if (missing(ret.error)) fail(NOT_SET_UP);
      const out = stillOut(o.items, (ret.data ?? []) as Array<{ product_id: string; qty: number }>);
      const lines = (Array.isArray(a.lines) ? a.lines : [])
        .map((l: Payload) => ({ product_id: str(l?.product_id, 80), qty: int(l?.qty) ?? 0 }))
        .filter((l) => l.product_id && l.qty > 0);
      for (const l of lines) {
        const left = out[l.product_id] ?? 0;
        if (l.qty > left) fail(`Only ${left} of ${o.items.find((i) => i.product_id === l.product_id)?.name ?? l.product_id} can still come back.`);
      }
      const cancel = a.cancel === true;
      const ch = await db.from("fittings_order_charges").select("refunded_cents").eq("order_id", orderId);
      const coreRefunded = (ch.error ? [] : (ch.data ?? [])).reduce((s, r) => s + ((r.refunded_cents as number) ?? 0), 0);
      const plan = refundFor(
        {
          items: o.items,
          subtotal_cents: (o.subtotal_cents as number) ?? 0,
          shipping_cents: (o.shipping_cents as number) ?? 0,
          tax_cents: (o.tax_cents as number) ?? 0,
          total_cents: (o.total_cents as number) ?? 0,
          refunded_cents: (o.refunded_cents as number) ?? 0,
          core_refunded_cents: coreRefunded,
        },
        lines,
        a.refund_shipping === true,
      );
      const amount = a.refund_cents === undefined ? plan.total : int(a.refund_cents);
      if (amount == null || amount < 0) fail("Enter the refund as dollars, 0 or more.");
      if (amount! > plan.left) fail(`Only $${(plan.left / 100).toFixed(2)} is left to refund on this order.`);
      if (!lines.length && amount === 0 && !cancel) fail("Pick parts coming back, a refund, or both.");
      const allBack = o.items.every((i) => (out[i.product_id] ?? 0) - (lines.find((l) => l.product_id === i.product_id)?.qty ?? 0) <= 0);

      // Money first: if Stripe says no, nothing else changes.
      let refundId: string | null = null;
      if (amount! > 0) {
        const stripe = getStripe();
        const pi = o.stripe_payment_intent as string | null;
        if (!stripe || !pi) fail("This order has no Stripe payment to refund. Refund it by hand, then record the return with a $0 refund.");
        try {
          const r = await stripe!.refunds.create(
            { payment_intent: pi!, amount: amount!, reason: "requested_by_customer", metadata: { order_id: orderId, order_number: String(o.number), kind: "return" } },
            { idempotencyKey: `ret-${orderId}-${o.refunded_cents}-${amount}` },
          );
          refundId = r.id;
        } catch (e) {
          fail(`Stripe did not take the refund: ${(e as Error).message}`);
        }
        const rec = await db.rpc("fittings_record_refund", { p_order_id: orderId, p_amount: amount, p_stripe_id: refundId, p_reason: str(a.reason, 200), p_cancel: cancel });
        if (rec.error) fail(`Stripe refunded $${(amount! / 100).toFixed(2)}, but it wasn't recorded here: ${rec.error.message}. Tell Matt before trying again.`);
      } else if (cancel) {
        const u = await db.from("fittings_orders").update({ status: "cancelled" }).eq("id", orderId);
        if (u.error) fail(u.error.message);
      }
      if (lines.length) {
        const r = await db.rpc("fittings_return_items", {
          p_order_id: orderId,
          p_items: lines,
          p_restock: a.restock !== false,
          p_reason: str(a.reason, 200),
          p_restock_shipping: allBack && a.refund_shipping === true,
        });
        if (r.error) fail(`${amount ? "The refund went through, but the" : "The"} parts weren't put back: ${r.error.message}`);
      }
      return { refunded_cents: amount, returned: lines.reduce((s, l) => s + l.qty, 0) };
    }

    // Counter sales --------------------------------------------------------------------------
    case "counter.sale": {
      if (!isId(a.location_id)) fail("Pick the location you're selling from.");
      const lines = counterLines(
        (Array.isArray(a.lines) ? a.lines : []).map((l: Payload) => ({ product_id: str(l?.product_id, 80), qty: int(l?.qty) ?? 0, price_cents: int(l?.price_cents) ?? 0 })),
      );
      if (!lines.length) fail("Add at least one part.");
      if (lines.length > 200) fail("Ring up 200 parts or fewer at a time.");
      const paidBy = ["cash", "card", "check", "account"].includes(a.paid_by as string) ? (a.paid_by as string) : "";
      const r = await db.rpc("fittings_counter_sale", { p_location: a.location_id, p_lines: lines, p_paid_by: paidBy, p_note: str(a.note, 200), p_by: str(a.by, 80) });
      if (missing(r.error)) fail(NOT_SET_UP);
      if (r.error) {
        const m = /only (\d+) of (.+) on this shelf/.exec(r.error.message);
        fail(m ? `Only ${m[1]} of ${m[2]} on this shelf.` : r.error.message);
      }
      return { sale_id: r.data };
    }

    case "counter.list": {
      const r = await db.from("fittings_counter_sales").select("*").order("id", { ascending: false }).limit(30);
      if (missing(r.error)) fail(NOT_SET_UP);
      return { sales: r.data ?? [] };
    }

    // Spreadsheet import ------------------------------------------------------------------------
    case "import.apply": {
      if (!isId(a.location_id)) fail("Pick the location this count is for.");
      const raw = Array.isArray(a.lines) ? (a.lines as Payload[]) : [];
      if (!raw.length) fail("There's nothing to import.");
      if (raw.length > IMPORT_LIMIT) fail(`Import up to ${IMPORT_LIMIT} rows at a time.`);
      const rows = raw.map((l) => ({
        product_id: str(l.product_id, 80) || null,
        part_number: str(l.part_number, 60),
        name: str(l.name, 120),
        qty: int(l.qty),
        price_cents: l.price_cents === null || l.price_cents === undefined ? null : int(l.price_cents),
        upc: /^\d{6,14}$/.test(str(l.upc, 20)) ? str(l.upc, 20) : "",
      }));
      if (rows.some((r) => r.qty == null || r.qty < 0)) fail("Every count must be a whole number, 0 or more.");
      if (rows.some((r) => r.price_cents != null && r.price_cents < 0)) fail("Prices must be 0 or more.");
      // New parts first, with no stock; the count below sets it at this location.
      const fresh = rows.filter((r) => !r.product_id);
      if (fresh.some((r) => !r.name || !r.part_number)) fail("Every new part needs a part number and a name.");
      const taken = new Set<string>();
      if (fresh.length) {
        const ids = await db.from("fittings_products").select("id, part_number");
        for (const p of ids.data ?? []) taken.add(p.id as string);
        const byPart = new Map((ids.data ?? []).map((p) => [String(p.part_number ?? "").toUpperCase(), p.id as string]));
        const top = await db.from("fittings_products").select("sort").order("sort", { ascending: false }).limit(1);
        let sort = ((top.data?.[0]?.sort as number | undefined) ?? 0) + 10;
        const inserts: Array<Record<string, unknown>> = [];
        for (const r of fresh) {
          const known = byPart.get(r.part_number.toUpperCase());
          if (known) {
            r.product_id = known;
            continue;
          }
          let id = slug(r.part_number) || "item";
          while (taken.has(id)) id = `${slug(r.part_number).slice(0, 42) || "item"}-${Math.random().toString(36).slice(2, 6)}`;
          taken.add(id);
          byPart.set(r.part_number.toUpperCase(), id);
          r.product_id = id;
          inserts.push({ id, name: r.name, part_number: r.part_number, qty: 0, sort, ...(r.price_cents ? { price_cents: r.price_cents } : {}), category_id: TYPE_CATEGORY.other });
          sort += 10;
        }
        for (let i = 0; i < inserts.length; i += 500) {
          const chunk = inserts.slice(i, i + 500);
          let ins = await db.from("fittings_products").insert(chunk);
          if (ins.error && /category/i.test(ins.error.message)) ins = await db.from("fittings_products").insert(chunk.map((row) => {
            const copy = { ...row };
            delete copy.category_id;
            return copy;
          }));
          if (ins.error) fail(`${i ? `Added ${i} new parts, then stopped` : "No new parts were added"}: ${ins.error.message}`);
        }
      }
      const r = await db.rpc("fittings_import_counts", {
        p_location: a.location_id,
        p_lines: rows.map((x) => ({ product_id: x.product_id, qty: x.qty, price_cents: x.price_cents })),
        p_note: str(a.note, 120) || "Spreadsheet import",
      });
      if (missing(r.error)) fail(NOT_SET_UP);
      if (r.error) fail(r.error.message);
      // Barcodes from a UPC column: link each to its part so a scan finds it. A barcode that already
      // belongs to another part is left alone and counted, never moved.
      const wanted = rows.filter((x) => x.upc && x.product_id).map((x) => ({ product_id: x.product_id as string, upc: x.upc }));
      let linked = 0;
      let barcodesLeft = 0;
      if (wanted.length) {
        const owner = new Map<string, string>();
        for (let i = 0; i < wanted.length; i += 200) {
          const have = await db.from("fittings_xrefs").select("product_id, number_norm").eq("kind", "upc").in("number_norm", wanted.slice(i, i + 200).map((w) => w.upc));
          for (const h of have.data ?? []) owner.set(String(h.number_norm), String(h.product_id));
        }
        const links: Array<Record<string, string>> = [];
        for (const w of wanted) {
          const has = owner.get(w.upc);
          if (has && has !== w.product_id) barcodesLeft++;
          else if (!has) {
            owner.set(w.upc, w.product_id);
            links.push({ product_id: w.product_id, kind: "upc", brand: "", number: w.upc, number_norm: w.upc });
          }
        }
        for (let i = 0; i < links.length; i += 500) {
          const up = await db.from("fittings_xrefs").upsert(links.slice(i, i + 500), { onConflict: "product_id,kind,brand,number_norm", ignoreDuplicates: true });
          if (up.error) {
            barcodesLeft += links.length - i;
            break;
          }
          linked += Math.min(500, links.length - i);
        }
      }
      return { changed: r.data, added: fresh.length, linked, barcodes_left: barcodesLeft };
    }

    // Running low ---------------------------------------------------------------------------------
    case "lowstock.load":
      return { lines: await loadRunningLow(db) };

    // Home: what the dashboard needs beyond the store data already loaded ------------------------
    case "home.load":
      return await loadHome(db);

    case "lowstock.send": {
      const queued = await queueLowStock(db);
      return { queued };
    }

    // Dealer logins -------------------------------------------------------------------------------
    case "dealer_user.list": {
      if (!isId(a.dealer_id)) fail("Pick a dealer.");
      const r = await db
        .from("fittings_dealer_users")
        .select("id, email, name, disabled, created_at, last_login_at")
        .eq("dealer_id", a.dealer_id as string)
        .order("created_at");
      if (missing(r.error)) fail(NOT_SET_UP);
      return { users: r.data ?? [] };
    }

    case "dealer_user.save": {
      if (!isId(a.dealer_id)) fail("Pick a dealer.");
      const email = str(a.email, 120).toLowerCase();
      if (!okEmail(email)) fail("Enter the person's email address.");
      const pw = typeof a.password === "string" ? a.password : "";
      const problem = passwordProblem(pw);
      if (problem) fail(problem);
      const cur = await db.from("fittings_dealer_users").select("id, dealer_id").eq("email", email).maybeSingle();
      if (missing(cur.error)) fail(NOT_SET_UP);
      if (cur.data && cur.data.dealer_id !== a.dealer_id) fail("That email already signs in for another dealer.");
      const row = { dealer_id: a.dealer_id, email, name: str(a.name, 80), password_hash: hashPassword(pw), disabled: false, failed_logins: 0, locked_until: null };
      const r = cur.data
        ? await db.from("fittings_dealer_users").update(row).eq("id", cur.data.id as string)
        : await db.from("fittings_dealer_users").insert(row);
      if (r.error) fail(r.error.message);
      return { saved: email, reset: !!cur.data };
    }

    case "dealer_user.disable": {
      if (!isId(a.user_id)) fail("Pick the login.");
      const r = await db.from("fittings_dealer_users").update({ disabled: a.disabled !== false }).eq("id", a.user_id as string);
      if (r.error) fail(r.error.message);
      return {};
    }

    // Part finder: scan, search, photo ------------------------------------------------------------
    case "lookup.index":
      return { index: await buildIndex(db, { supplier: true }) };

    case "lookup.photo": {
      const r = await readPartPhoto(a.image, a.type);
      if ("problem" in r) fail(r.problem);
      return r as { read: unknown };
    }

    case "upc.link": {
      const problem = await linkUpc(db, str(a.product_id, 80), str(a.code, 20));
      if (problem) fail(problem);
      return { index: await buildIndex(db, { supplier: true }) };
    }

    // Real mileage for routing: fills the ZIP code table from the open-source "zipcodes" package.
    case "zips.load": {
      const probe = await db.from("fittings_zip_points").select("zip").limit(1);
      if (missing(probe.error)) fail("Run supabase/add-zip-miles.sql in the Supabase SQL Editor first.");
      const { default: zipcodes } = await import("zipcodes");
      const rows = zipRows(zipcodes.codes);
      if (!rows.length) fail("The ZIP code list came back empty. Nothing was changed.");
      const chunks: Array<typeof rows> = [];
      for (let i = 0; i < rows.length; i += 2000) chunks.push(rows.slice(i, i + 2000));
      // A few at a time, so the load is quick without flooding the database.
      for (let i = 0; i < chunks.length; i += 4) {
        const done = await Promise.all(chunks.slice(i, i + 4).map((c) => db.from("fittings_zip_points").upsert(c, { onConflict: "zip" })));
        const bad = done.find((r) => r.error);
        if (bad?.error) fail(`The ZIP code table stopped part way: ${bad.error.message}. It's safe to load it again.`);
      }
      return { loaded: rows.length };
    }

    // Dealer shipping labels ------------------------------------------------------------------------
    case "labels.save": {
      const bps = int(a.markup_bps);
      const flat = int(a.flat_cents);
      if (bps == null || bps < 0 || bps > MAX_MARKUP_BPS) fail("The markup is a percent from 0 to 50.");
      if (flat == null || flat < 0 || flat > MAX_FLAT_CENTS) fail(`The flat amount per label is $0 to $${MAX_FLAT_CENTS / 100}.`);
      const probe = await db.from("fittings_shipments").select("shippo_transaction_id").limit(1);
      if (probe.error) fail("Run supabase/add-dealer-labels.sql in the Supabase SQL Editor first.");
      const next = { on: a.on === true, markup_bps: bps as number, flat_cents: flat as number };
      await setConfig(db, LABELS_KEY, next);
      return { labels: next };
    }

    case "label.void": {
      if (!isId(a.order_id) || !isId(a.location_id)) fail("Pick the shipment.");
      const sh = await db.from("fittings_shipments").select("*").eq("order_id", a.order_id as string).eq("location_id", a.location_id as string).maybeSingle();
      const tx = sh.error ? null : ((sh.data?.shippo_transaction_id as string | null | undefined) ?? null);
      if (!tx) fail("There's no bought label on this shipment. A tracking number that was typed in can be changed by moving the order back to To ship.");
      const probe = await db.from("fittings_label_voids").select("id").limit(1);
      if (missing(probe.error)) fail("Run supabase/add-label-voids.sql in the Supabase SQL Editor first.");
      let status: RefundStatus;
      try {
        status = await refundLabel(tx as string);
      } catch (e) {
        return fail(`Shippo didn't take the refund request, so nothing changed: ${(e as Error).message}`);
      }
      if (status === "ERROR") fail("Shippo turned the refund down: the label looks used. Nothing changed.");
      const r = await db.rpc("fittings_void_label", { p_order_id: a.order_id, p_location: a.location_id, p_refund_status: status, p_by: str(a.by, 80) || "Back office", p_reason: str(a.reason, 200) });
      if (r.error) fail(`Shippo took the refund request, but the void wasn't saved here: ${r.error.message}. Tell Matt before trying again.`);
      return { refund_status: status, credit_cents: (r.data as { credit_cents?: number } | null)?.credit_cents ?? 0 };
    }

    // Alert outbox ----------------------------------------------------------------------------------
    case "alerts.list": {
      const r = await db.from("fittings_alerts").select("id, dealer_id, order_id, topic, channel, send_to, subject, status, error, created_at, sent_at").order("id", { ascending: false }).limit(60);
      if (missing(r.error)) fail(NOT_SET_UP);
      return { alerts: r.data ?? [] };
    }

    case "alerts.send": {
      if (!emailReady() && !textReady()) fail("No email or text service is set up yet. See the note under Dealer alerts.");
      return await sendQueued(db, 100);
    }

    case "alerts.retry": {
      const r = await db.from("fittings_alerts").update({ status: "queued", error: "" }).eq("status", "failed");
      if (r.error) fail(r.error.message);
      return await sendQueued(db, 100);
    }

    default:
      return undefined;
  }
}

/** Dealer alert contacts, cleaned. */
export function dealerContacts(a: Payload): { alert_email: string; alert_phone: string } {
  const emails = str(a.alert_email, 300)
    .split(/[,;\s]+/)
    .filter(Boolean);
  const bad = emails.find((e) => !okEmail(e));
  if (bad) fail(`${bad} isn't an email address.`);
  if (emails.length > 3) fail("Up to 3 alert emails.");
  const phone = str(a.alert_phone, 30);
  if (phone && !toE164(phone)) fail("Enter a 10-digit US phone number for text alerts.");
  return { alert_email: emails.map((e) => e.toLowerCase()).join(", "), alert_phone: phone };
}
