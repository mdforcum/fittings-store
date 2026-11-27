// Builds what the part finder needs from the database: every other number a
// part answers to, which parts share a bin, and which parts sell together.
// Also reads a part photo with the same reader the capture page uses.
import type { SupabaseClient } from "@supabase/supabase-js";
import { soldTogether, type LookupBin, type LookupCode, type LookupIndex, type PhotoRead } from "./lookup";
import { spotCode, spotLine, spotPath, type Spot } from "./shelf";
import { readPhoto, visionReady } from "./vision";

type Row = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" ? v : "");

function codeLabel(kind: string, brand: string, number: string): string {
  if (kind === "upc") return `UPC ${number}`;
  if (kind === "supplier") return `Supplier number ${brand ? `${brand} ` : ""}${number}`;
  return `Replaces ${brand ? `${brand} ` : ""}${number}`;
}

/**
 * The finder's index. `supplier` adds supplier numbers (back office only).
 * `locations`, when given, keeps only bins on those locations' shelf maps and
 * sales made there (a dealer sees its own shop, nobody else's).
 */
export async function buildIndex(db: SupabaseClient, opts: { supplier: boolean; locations?: string[] }): Promise<LookupIndex> {
  const since = new Date(Date.now() - 365 * 86400_000).toISOString();
  const [x, sp, pr, al, cs] = await Promise.all([
    db.from("fittings_xrefs").select("product_id, kind, brand, number, number_norm").limit(50000),
    db.from("fittings_shelf_spots").select("*").limit(20000),
    db.from("fittings_products").select("id, spot_id").not("spot_id", "is", null).limit(20000),
    db.from("fittings_allocations").select("order_id, product_id, location_id").limit(20000),
    db.from("fittings_counter_sales").select("location_id, lines").gte("created_at", since).limit(5000),
  ]);

  const codes: LookupCode[] = [];
  for (const r of (x.error ? [] : (x.data ?? [])) as Row[]) {
    const kind = text(r.kind);
    if (kind === "supplier" && !opts.supplier) continue;
    if (!text(r.number_norm)) continue;
    codes.push({ norm: text(r.number_norm), product_id: text(r.product_id), label: codeLabel(kind, text(r.brand), text(r.number)) });
  }

  const bins: LookupBin[] = [];
  if (!sp.error && !pr.error) {
    const spots = (sp.data ?? []) as unknown as Spot[];
    const inSpot = new Map<string, string[]>();
    for (const p of (pr.data ?? []) as Row[]) inSpot.set(text(p.spot_id), [...(inSpot.get(text(p.spot_id)) ?? []), text(p.id)]);
    for (const [spotId, ids] of inSpot) {
      const path = spotPath(spots, spotId);
      if (!path.length) continue;
      const top = (path[0] as unknown as Row).location_id;
      if (opts.locations && !(typeof top === "string" && opts.locations.includes(top))) continue;
      bins.push({ code: spotCode(path), line: spotLine(path), product_ids: ids.sort() });
    }
  }

  // Parts on the same order (as filled) or the same counter sale.
  const mine = (loc: unknown) => !opts.locations || (typeof loc === "string" && opts.locations.includes(loc));
  const byOrder = new Map<string, string[]>();
  for (const a of (al.error ? [] : (al.data ?? [])) as Row[]) {
    if (!mine(a.location_id)) continue;
    byOrder.set(text(a.order_id), [...(byOrder.get(text(a.order_id)) ?? []), text(a.product_id)]);
  }
  const baskets = [...byOrder.values()];
  for (const s of (cs.error ? [] : (cs.data ?? [])) as Row[]) {
    if (!mine(s.location_id) || !Array.isArray(s.lines)) continue;
    baskets.push((s.lines as Row[]).map((l) => text(l.product_id)).filter(Boolean));
  }
  return { codes, bins, pairs: soldTogether(baskets) };
}

const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Reads a part photo (sent as base64). Returns plain words when it can't. */
export async function readPartPhoto(image: unknown, type: unknown): Promise<{ read: PhotoRead } | { problem: string }> {
  if (!visionReady()) return { problem: "Photo lookup isn't switched on yet. Type or scan the number instead." };
  if (typeof image !== "string" || image.length < 100 || image.length > 6_000_000) return { problem: "That photo is too big or didn't come through. Try again." };
  const mediaType = typeof type === "string" && TYPES.has(type) ? type : "image/jpeg";
  try {
    const r = await readPhoto("card", Buffer.from(image, "base64"), mediaType);
    return { read: { part_number: r.part_number, other_numbers: r.other_numbers.slice(0, 6), upc: r.upc, description: r.description } };
  } catch (e) {
    console.error("part photo read failed", (e as Error).message);
    return { problem: "The photo couldn't be read. Try again in better light, or type the number." };
  }
}

/** Remembers a barcode for a part, so the next scan finds it. */
export async function linkUpc(db: SupabaseClient, productId: string, code: string): Promise<string | null> {
  const digits = code.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 14 || digits !== code.trim()) return "A barcode number is 6 to 14 digits.";
  const p = await db.from("fittings_products").select("id").eq("id", productId).maybeSingle();
  if (p.error || !p.data) return "That part isn't in the catalog.";
  const taken = await db.from("fittings_xrefs").select("product_id").eq("kind", "upc").eq("number_norm", digits).limit(2);
  if ((taken.data ?? []).some((r) => r.product_id !== productId)) return "That barcode is already linked to another part.";
  const r = await db.from("fittings_xrefs").upsert({ product_id: productId, kind: "upc", brand: "", number: digits, number_norm: digits }, { onConflict: "product_id,kind,brand,number_norm", ignoreDuplicates: true });
  return r.error ? "The barcode didn't save. Try again." : null;
}
