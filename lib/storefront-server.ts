// Server side of storefronts: which store this request is for.
import { headers } from "next/headers";
import { isAdmin } from "./auth";
import { adminDb, env } from "./server";
import { hostOf, normalizeStorefront, pickStorefront, type StoreLook, type Storefront } from "./storefront";

export type RequestStore = { look: StoreLook | null; storefront: Storefront | null };

/** Every storefront. Empty before supabase/add-storefronts.sql has run, or without the server key. */
export async function loadStorefronts(): Promise<Storefront[]> {
  if (!env.secret) return [];
  const { data, error } = await adminDb().from("fittings_storefronts").select("*");
  if (error) return [];
  return ((data ?? []) as Array<Record<string, unknown>>).map(normalizeStorefront);
}

/**
 * The storefront for this request: the live one at the address it came in on,
 * or, for signed-in staff, the one named by ?storefront=<slug>.
 */
export async function storeForRequest(previewSlug?: string | null): Promise<RequestStore> {
  const h = await headers();
  const host = hostOf(h.get("x-forwarded-host") ?? h.get("host"));
  const all = await loadStorefronts();
  if (!all.length) return { look: null, storefront: null };
  const staff = previewSlug ? await isAdmin() : false;
  const look = pickStorefront(all, host, previewSlug ?? null, staff);
  const storefront = look ? (all.find((f) => f.slug === look.slug) ?? null) : null;
  return { look, storefront };
}
