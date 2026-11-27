// The list of pages for search engines: the shop's front page and one page
// per part this store sells. Built for whichever store's address was asked.
import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { listable, originOf, partPath } from "@/lib/seo";
import { getShopCatalog } from "@/lib/server";
import { storeForRequest } from "@/lib/storefront-server";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const h = await headers();
  const origin = originOf(h.get("x-forwarded-host") ?? h.get("host"), h.get("x-forwarded-proto"));
  if (!origin) return [];
  const { look, storefront } = await storeForRequest(null);
  const ownDealer = storefront && storefront.stock_scope === "own" ? storefront.dealer_id : null;
  const catalog = await getShopCatalog(ownDealer, storefront?.dealer_id ?? null);
  return [
    { url: `${origin}/`, changeFrequency: "daily", priority: 1 },
    ...(look ? [] : [{ url: `${origin}/hose`, changeFrequency: "monthly" as const, priority: 0.5 }]),
    ...catalog.products.filter(listable).slice(0, 45000).map((p) => ({ url: `${origin}${partPath(p.id)}`, changeFrequency: "weekly" as const, priority: 0.8 })),
  ];
}
