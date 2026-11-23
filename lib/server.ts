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
  return `Supabase rejected the saved ${kind}. It is ${key.length} characters long${oddNote}. A complete secret key is sb_secret_ followed by about 31 more letters, digits and underscores, roughly 41 characters in all.`;
}

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
