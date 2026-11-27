// Search-friendly part pages: each part's address, its page title and
// description, and the product data search engines and AI assistants read.
// Everything here comes from the part's own record; nothing is made up.
import type { Product } from "./catalog.ts";

export type SeoXref = { kind: string; brand: string; number: string };

/** A part's own page. */
export const partPath = (id: string) => `/part/${encodeURIComponent(id)}`;

/** "https://shop.example.com" from the request's host; "" when there is none. */
export function originOf(host: string | null | undefined, proto?: string | null): string {
  const h = (host ?? "").split(",")[0].trim().toLowerCase();
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(h)) return "";
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h);
  const p = (proto ?? "").split(",")[0].trim() === "http" || local ? "http" : "https";
  return `${p}://${h}`;
}

/** The numbers this part replaces, as shoppers search for them (supplier numbers left out). */
export function replaces(xrefs: SeoXref[] | undefined): string[] {
  return (xrefs ?? []).filter((x) => x.kind !== "supplier" && x.number).map((x) => `${x.brand ? `${x.brand} ` : ""}${x.number}`);
}

export function partTitle(p: Pick<Product, "name" | "part_number">, storeName: string): string {
  const head = p.part_number && !p.name.includes(p.part_number) ? `${p.name} ${p.part_number}` : p.name;
  return `${head} | ${storeName}`;
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);

/** One or two plain sentences from the part's own details, for search results. */
export function partDescription(p: Product, xrefs: SeoXref[] | undefined, storeName: string): string {
  const bits: string[] = [];
  bits.push(`${p.name}${p.part_number ? `, part # ${p.part_number}` : ""}.`);
  const spec = [p.thread && `${p.thread} thread`, p.dash && `dash ${p.dash}`, p.size].filter(Boolean).join(", ");
  if (spec) bits.push(`${spec[0].toUpperCase()}${spec.slice(1)}.`);
  const rep = replaces(xrefs);
  if (rep.length) bits.push(`Replaces ${rep.slice(0, 3).join(", ")}.`);
  if (p.price_mode === "quote") bits.push(`Priced by quote from ${storeName}.`);
  else if (p.qty > 0 && (p.price_cents ?? 0) > 0) bits.push(`In stock at ${storeName}.`);
  else bits.push(`From ${storeName}.`);
  return clip(bits.join(" "), 160);
}

const CONDITION: Record<string, string> = {
  new: "https://schema.org/NewCondition",
  used: "https://schema.org/UsedCondition",
  reman: "https://schema.org/RefurbishedCondition",
  remanufactured: "https://schema.org/RefurbishedCondition",
  rebuilt: "https://schema.org/RefurbishedCondition",
};

/**
 * schema.org Product data for a part. The offer (price, in stock or not) is
 * only included when the part has a price and sells from the cart.
 */
export function partJsonLd(
  p: Product,
  opts: { url: string; storeName: string; images: string[]; xrefs?: SeoXref[]; description: string },
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    description: p.description || opts.description,
    url: opts.url,
  };
  if (p.part_number) {
    data.sku = p.part_number;
    data.mpn = p.part_number;
  }
  if (p.brand) data.brand = { "@type": "Brand", name: p.brand };
  if (opts.images.length) data.image = opts.images;
  const rep = replaces(opts.xrefs);
  if (rep.length) data.isSimilarTo = rep.map((name) => ({ "@type": "Product", name }));
  if (p.price_mode !== "quote" && (p.price_cents ?? 0) > 0) {
    data.offers = {
      "@type": "Offer",
      url: opts.url,
      priceCurrency: "USD",
      price: ((p.price_cents as number) / 100).toFixed(2),
      availability: p.qty > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      ...(CONDITION[p.condition] ? { itemCondition: CONDITION[p.condition] } : {}),
      seller: { "@type": "Organization", name: opts.storeName },
    };
  }
  return data;
}

/** JSON for a script tag: "<" is escaped so part text can't close the tag. */
export const jsonForScript = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");

/** Parts worth listing for search engines: those with a price, or sold by quote. */
export function listable(p: Pick<Product, "price_cents" | "price_mode">): boolean {
  return p.price_mode === "quote" || (p.price_cents ?? 0) > 0;
}
