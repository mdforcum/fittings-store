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

export const env = {
  get url() {
    return process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  },
  get publishable() {
    return process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  },
  get secret() {
    return process.env.SUPABASE_SECRET_KEY ?? "";
  },
  get adminPassword() {
    return process.env.ADMIN_PASSWORD ?? "";
  },
  get stripe() {
    return process.env.STRIPE_SECRET_KEY ?? "";
  },
  get shippo() {
    return process.env.SHIPPO_API_TOKEN ?? "";
  },
};

export const T = {
  products: "fittings_products",
  costs: "fittings_product_costs",
  settings: "fittings_settings",
  config: "fittings_private_config",
  orders: "fittings_orders",
  items: "fittings_order_items",
  bucket: "fittings-photos",
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
