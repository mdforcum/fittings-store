// Supplier photo import: reading a distributor's own catalog pages to find the
// product photo for a part number we stock. No network calls in this file, so
// every rule here can be tested.
//
// Ground rules the importer keeps:
//  - It only ever reads pages the supplier's robots.txt allows, and waits the
//    crawl delay the supplier asks for between requests.
//  - It reads category listing pages and product pages. It never uses site search.
//  - Imported photos stay held (not shown to shoppers) until the owner records
//    that the supplier has given permission.
import { normPart } from "./match.ts";

export type SupplierSource = {
  id: string;
  name: string;
  host: string;
  /** Category pages that list the parts we stock. More can be added in the back office. */
  listings: string[];
};

export const SOURCES: SupplierSource[] = [
  {
    id: "burns-ag",
    name: "Burns Ag Supply",
    host: "www.burnsagsupply.com",
    listings: [
      "https://www.burnsagsupply.com/steel-adapters/jic-bulkhead-caps-plugs.html",
      "https://www.burnsagsupply.com/steel-adapters/o-ring-boss-o-ring-plugs.html",
    ],
  },
];

export const sourceById = (id: string) => SOURCES.find((s) => s.id === id) ?? null;

export type ListingItem = { part_number: string; name: string; page_url: string; image_url: string };

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const text = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** Same-site https URL, or null. Keeps the importer from being pointed anywhere else. */
export function sameSite(url: string, host: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === host ? u : null;
  } catch {
    return null;
  }
}

/**
 * Reads one category page: each product's part number, name, page and photo.
 * Written against the product-grid markup Magento stores use.
 */
export function parseListing(html: string, pageUrl: string, host: string): { items: ListingItem[]; next: string | null } {
  const items: ListingItem[] = [];
  for (const chunk of html.split(/<li\s+class="[^"]*\bproduct\b[^"]*"/i).slice(1)) {
    const block = chunk.slice(0, Math.max(0, chunk.indexOf("</li>")) || chunk.length);
    const link = /class="product-item-link"[^>]*?href="([^"]+)"|href="([^"]+)"[^>]*?class="product-item-link"/i.exec(block);
    const name = /class="product-item-link"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const img = /<img\b[^>]*?\bsrc="([^"]*\/media\/catalog\/product\/[^"]+)"/i.exec(block);
    // The part number sits in a bare <span> right after the product name.
    const pn = /<\/strong>\s*<span>([^<]{2,40})<\/span>/i.exec(block);
    const href = sameSite(decode(link?.[1] ?? link?.[2] ?? ""), host);
    const image = sameSite(decode(img?.[1] ?? ""), host);
    const partNumber = text(pn?.[1] ?? "");
    if (!href || !image || !normPart(partNumber)) continue;
    items.push({
      part_number: partNumber,
      name: text(name?.[1] ?? "").slice(0, 160),
      page_url: href.toString(),
      image_url: image.toString(),
    });
  }
  const nextLink = /<a\b[^>]*class="[^"]*\bnext\b[^"]*"[^>]*href="([^"]+)"|<a\b[^>]*href="([^"]+)"[^>]*class="[^"]*\bnext\b[^"]*"/i.exec(html);
  const next = sameSite(decode(nextLink?.[1] ?? nextLink?.[2] ?? ""), host);
  return { items, next: next && next.toString() !== pageUrl ? next.toString() : null };
}

/** Reads one product page: its name, the supplier's own SKU and its main photo. */
export function parseProductPage(html: string, host: string): { name: string; sku: string; image_url: string | null } {
  const og = /<meta\s+property="og:image"\s+content="([^"]+)"/i.exec(html);
  const gallery = /"img":"([^"]+)"/.exec(html);
  const raw = gallery ? gallery[1].replace(/\\\//g, "/") : decode(og?.[1] ?? "");
  const image = sameSite(raw, host);
  const title = /<meta\s+property="og:title"\s+content="([^"]*)"/i.exec(html);
  const sku = /itemprop="sku"[^>]*>([^<]{1,60})</i.exec(html);
  return {
    name: text(title?.[1] ?? "").slice(0, 160),
    sku: text(sku?.[1] ?? ""),
    image_url: image && image.pathname.includes("/media/catalog/product/") ? image.toString() : null,
  };
}

/** The supplier's image at a size worth showing: same file, same resizing service their own pages use. */
export function largeImage(url: string, size = 700): string {
  const u = new URL(url);
  u.search = `?optimize=medium&bg-color=255,255,255&fit=bounds&height=${size}&width=${size}&canvas=${size}:${size}`;
  return u.toString();
}

export type Robots = { disallow: string[]; crawl_delay: number };

/** Rules for every crawler ("User-agent: *"). */
export function parseRobots(body: string): Robots {
  const disallow: string[] = [];
  let delay = 0;
  let applies = false;
  let lastWasAgent = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      // Consecutive User-agent lines share one group.
      applies = lastWasAgent ? applies || value === "*" : value === "*";
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!applies) continue;
    if (field === "disallow" && value) disallow.push(value);
    if (field === "crawl-delay" && Number.isFinite(Number(value))) delay = Math.max(delay, Number(value));
  }
  return { disallow, crawl_delay: delay };
}

function ruleToRegex(rule: string): RegExp {
  const anchored = rule.endsWith("$");
  const body = (anchored ? rule.slice(0, -1) : rule)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function allowedByRobots(url: string, robots: Robots): boolean {
  const u = new URL(url);
  const target = u.pathname + u.search;
  return !robots.disallow.some((rule) => ruleToRegex(rule).test(target));
}

export type IndexRow = { part_norm: string; part_number: string; name: string; page_url: string; image_url: string };

/** Which of our parts the supplier's index has a photo for. */
export function matchParts<P extends { id: string; part_number: string }>(
  products: P[],
  index: IndexRow[],
): Map<string, IndexRow> {
  const byNorm = new Map(index.map((row) => [row.part_norm, row]));
  const found = new Map<string, IndexRow>();
  for (const p of products) {
    const row = byNorm.get(normPart(p.part_number));
    if (row) found.set(p.id, row);
  }
  return found;
}
