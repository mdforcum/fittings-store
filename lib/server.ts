// Server-only helpers: environment, database clients, config storage.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SETTINGS,
  bySort,
  normalizeProduct,
  normalizeSettings,
  type Product,
  type Settings,
} from "./catalog";
import type { ShopCharge, ShopFit, ShopXref } from "./browse";
import type { Category } from "./foundation";

// Pasted values often pick up stray spaces, line breaks or wrapping quotes.
const clean = (v: string | undefined) =>
  (v ?? "")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();

export const env = {
  get url() {
    return clean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  },
  get publishable() {
    return clean(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  },
  get secret() {
    return clean(process.env.SUPABASE_SECRET_KEY);
  },
  get adminPassword() {
    return (process.env.ADMIN_PASSWORD ?? "").trim();
  },
  get stripe() {
    return clean(process.env.STRIPE_SECRET_KEY);
  },
  get shippo() {
    return clean(process.env.SHIPPO_API_TOKEN);
  },
  /** Anthropic API key: lets the survey read photos of inventory cards and bins. */
  get anthropic() {
    return clean(process.env.ANTHROPIC_API_KEY);
  },
  get anthropicBase() {
    return (clean(process.env.ANTHROPIC_BASE_URL) || "https://api.anthropic.com").replace(/\/+$/, "");
  },
  get anthropicModel() {
    return clean(process.env.ANTHROPIC_MODEL) || "claude-sonnet-5-5";
  },
};

/**
 * Asks Supabase whether it accepts the saved secret key. Returns a plain
 * description of what is wrong (never the key itself), or null when it works.
 */
export async function secretKeyProblem(): Promise<string | null> {
  const key = env.secret;
  if (!key || !env.url) return null;
  const odd = (key.match(/[^A-Za-z0-9_.-]/g) ?? []).length;
  let rejected = odd > 0;
  if (!rejected) {
    try {
      const res = await fetch(`${env.url}/rest/v1/fittings_settings?select=id&limit=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        cache: "no-store",
      });
      rejected = res.status === 401 || res.status === 403;
    } catch {
      return null; // network trouble, not a key problem
    }
  }
  if (!rejected) return null;
  const kind = key.startsWith("sb_secret_")
    ? "secret key"
    : key.startsWith("sb_publishable_")
      ? "publishable key, which is the wrong kind"
      : key.startsWith("eyJ")
        ? "legacy key"
        : "value, which does not look like a Supabase key";
  const oddNote = odd
    ? ` and contains ${odd} character${odd === 1 ? "" : "s"} a key never has (dots, spaces or symbols)`
    : "";
  // A real key is random throughout. A copied on-screen placeholder repeats one symbol.
  const tail = key.slice(15);
  const masked = tail.length > 6 && new Set(tail).size <= 2;
  const verdict = masked
    ? " Everything after the first few characters is one repeated symbol, so this is the hidden placeholder Supabase shows on screen and not the key itself."
    : /^sb_secret_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$/.test(key)
      ? " It has the right shape for a key, so it most likely belongs to a different Supabase project or has been deleted there."
      : " A complete secret key is sb_secret_ followed by about 31 more letters, digits and underscores, roughly 41 characters in all.";
  return `Supabase rejected the saved ${kind}. It is ${key.length} characters long${oddNote}.${verdict}`;
}

export const T = {
  products: "fittings_products",
  costs: "fittings_product_costs",
  settings: "fittings_settings",
  config: "fittings_private_config",
  orders: "fittings_orders",
  items: "fittings_order_items",
  bucket: "fittings-photos",
  locations: "fittings_locations",
  captures: "fittings_captures",
  supplierIndex: "fittings_supplier_index",
  supplierPhotos: "fittings_supplier_photos",
  /** Private: survey photos and supplier photos still on hold. */
  privateBucket: "fittings-private",
} as const;

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

/** Read-only client for the public catalog. Null until the public keys are set. */
export function publicDb(): SupabaseClient | null {
  if (!env.url || !env.publishable) return null;
  return createClient(env.url, env.publishable, clientOptions);
}

/** Full-access client. Only ever used on the server. */
export function adminDb(): SupabaseClient {
  if (!env.url || !env.secret) throw new Error("SUPABASE_SECRET_KEY is not set");
  return createClient(env.url, env.secret, clientOptions);
}

export async function getCatalog(): Promise<{ products: Product[]; settings: Settings; ok: boolean }> {
  const db = publicDb();
  if (!db) return { products: [], settings: DEFAULT_SETTINGS, ok: false };
  const [p, s] = await Promise.all([
    db.from(T.products).select("*"),
    db.from(T.settings).select("*").eq("id", 1).maybeSingle(),
  ]);
  if (p.error) return { products: [], settings: normalizeSettings(s.data), ok: false };
  return {
    products: (p.data ?? []).map(normalizeProduct).sort(bySort),
    settings: normalizeSettings(s.data),
    ok: true,
  };
}

export async function getConfig<V>(db: SupabaseClient, key: string): Promise<V | null> {
  const { data } = await db.from(T.config).select("value").eq("key", key).maybeSingle();
  return data ? (data.value as V) : null;
}

export async function setConfig(db: SupabaseClient, key: string, value: unknown): Promise<void> {
  const { error } = await db
    .from(T.config)
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

export type { ShipFrom, ParcelPreset } from "./admin-types";

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export type ShopCatalog = {
  products: Product[];
  settings: Settings;
  ok: boolean;
  categories: Category[];
  xrefs: Record<string, ShopXref[]>;
  fits: Record<string, ShopFit[]>;
  /** Cores and other charges, by item. */
  charges: Record<string, ShopCharge[]>;
};

/**
 * Everything the shop page needs in one read: items, settings, the live
 * category tree, the numbers each item replaces, and which machines each
 * fits. The catalog tables are optional: without them the shop still sells.
 */
export async function getShopCatalog(): Promise<ShopCatalog> {
  const base = await getCatalog();
  const empty = { categories: [], xrefs: {}, fits: {}, charges: {} };
  const db = publicDb();
  if (!db || !base.ok) return { ...base, ...empty };
  const ids = new Set(base.products.map((p) => p.id));
  const [c, x, f, sc] = await Promise.all([
    db.from("fittings_categories").select("id, parent_id, name, sort, spec_fields, fitment, default_ship, live, note").eq("live", true),
    db.from("fittings_xrefs").select("product_id, kind, brand, number, number_norm").limit(20000),
    db.from("fittings_fitment").select("product_id, machine_id, serial_prefix, serial_from, serial_to, position").limit(20000),
    db.from("fittings_surcharges").select("product_id, kind, amount_cents, refundable, label").gt("amount_cents", 0).limit(20000),
  ]);
  const group = <T extends { product_id: string }>(rows: T[] | null) => {
    const out: Record<string, Array<Omit<T, "product_id">>> = {};
    for (const { product_id, ...rest } of rows ?? []) if (ids.has(product_id)) (out[product_id] ??= []).push(rest);
    return out;
  };
  return {
    ...base,
    categories: c.error ? [] : ((c.data ?? []) as Category[]),
    xrefs: x.error ? {} : (group(x.data as Array<ShopXref & { product_id: string }>) as Record<string, ShopXref[]>),
    fits: f.error ? {} : (group(f.data as Array<ShopFit & { product_id: string }>) as Record<string, ShopFit[]>),
    charges: sc.error ? {} : (group(sc.data as Array<ShopCharge & { product_id: string }>) as Record<string, ShopCharge[]>),
  };
}
