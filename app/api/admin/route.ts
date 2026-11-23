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
  type ParcelPreset,
  type ShipFrom,
} from "@/lib/admin-types";
import { isAdmin, sameOrigin } from "@/lib/auth";
import {
  TYPES,
  bySort,
  marginFrom,
  normalizeProduct,
  normalizeSettings,
  priceFromMargin,
} from "@/lib/catalog";
import { getStripe } from "@/lib/payments";
import { T, adminDb, env, getConfig, json, setConfig } from "@/lib/server";
import { buyLabel, freshLabelUrl, getRates } from "@/lib/shippo";

export const dynamic = "force-dynamic";

class ActionError extends Error {}
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
    orders: (o.data ?? []) as unknown as Order[],
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
      await must(db.from(T.products).insert({ id: newId, qty: 0, ...fields, sort }));
      return { id: newId };
    }

    case "product.update": {
      const fields = productFields(a.fields);
      if (Object.keys(fields).length === 0) return {};
      await must(db.from(T.products).update({ ...fields, updated_at: now() }).eq("id", id));
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
      await must(db.rpc("fittings_adjust_qty", { p_id: id, p_delta: delta }));
      return {};
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
      await must(
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
        }),
      );
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
      const from = config.ship_from;
      if (!from.name || !from.street1 || !from.city || !from.state || !from.zip) {
        fail("Add your ship-from address under Settings first.");
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
      return { rates: quote.rates };
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
      return fail("Unknown action.");
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
