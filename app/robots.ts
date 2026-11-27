// What search engines may read: the shop and its part pages, not the back
// office, the dealer page or order pages.
import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { originOf } from "@/lib/seo";

export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const h = await headers();
  const origin = originOf(h.get("x-forwarded-host") ?? h.get("host"), h.get("x-forwarded-proto"));
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/dealer", "/capture", "/order", "/api/"] }],
    ...(origin ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
