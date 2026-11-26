// Pick tickets: what to pull from the shelves for one order or several, in
// the order a picker walks the shop, with a check-off per item.
//
// The walk follows the shelf map (lib/shelf.ts): locations, buildings and
// areas in their set order, then aisles one after another, going up one
// aisle and back down the next (a snake), so the picker never walks an aisle
// twice. Items with no shelf spot come last, by name.
//
// A kit or package that has no shelf spot of its own but does have parts on
// file is pulled as its parts; one that sits on a shelf is pulled whole.

import { spotPath, spotName, treeRows, type Spot } from "./shelf.ts";

export type PickOrderItem = {
  id: number; // order item id
  order_id: string;
  order_number: number;
  product_id: string;
  name: string;
  part_number: string;
  qty: number;
};

export type PickProduct = { id: string; name: string; part_number: string; spot_id: string | null };
export type PickKitItem = { kit_id: string; product_id: string; qty: number };
export type PickMark = { order_item_id: number; product_id: string; picked_qty: number };

/** One thing to pull for one order line: the item itself, or one part of a kit. */
export type PickPart = {
  key: string; // `${order_item_id}:${product_id}`
  order_item_id: number;
  order_id: string;
  order_number: number;
  product_id: string;
  name: string;
  part_number: string;
  qty: number;
  /** The kit this part is pulled for, or null when the item is pulled whole. */
  for_kit: string | null;
  picked_qty: number;
};

/** One stop on the walk: a product at a spot, with every order part that needs it. */
export type PickStop = {
  product_id: string;
  name: string;
  part_number: string;
  qty: number;
  picked_qty: number;
  done: boolean;
  spot_id: string | null;
  /** "Aisle 07, Section 3, Bin 12" below the group, or "" when not placed. */
  where: string;
  /** "EFF-1-105-07-3-12" or "". */
  code: string;
  parts: PickPart[];
};

/** A run of stops that share an aisle (or the same parent spot), with its heading. */
export type PickGroup = { heading: string; stops: PickStop[] };

export type PickRoute = { groups: PickGroup[]; total: number; picked: number; lines: number; done: number };

const NOT_PLACED = "Not on the shelf map";
const isAisle = (s: Spot) => /^(aisle|row)\b/i.test(s.level.trim());

/** The order lines as parts to pull: kits with no spot of their own become their parts. */
export function expandParts(
  items: PickOrderItem[],
  products: PickProduct[],
  kitItems: PickKitItem[],
  marks: PickMark[],
): PickPart[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const markOf = new Map(marks.map((m) => [`${m.order_item_id}:${m.product_id}`, m.picked_qty]));
  const out: PickPart[] = [];
  const add = (it: PickOrderItem, productId: string, name: string, partNumber: string, qty: number, forKit: string | null) => {
    const key = `${it.id}:${productId}`;
    const existing = out.find((p) => p.key === key);
    if (existing) {
      existing.qty += qty; // the same part listed twice in one kit
      existing.picked_qty = Math.min(existing.picked_qty, existing.qty);
      return;
    }
    out.push({
      key,
      order_item_id: it.id,
      order_id: it.order_id,
      order_number: it.order_number,
      product_id: productId,
      name,
      part_number: partNumber,
      qty,
      for_kit: forKit,
      picked_qty: Math.min(Math.max(0, markOf.get(key) ?? 0), qty),
    });
  };
  for (const it of items) {
    const product = byId.get(it.product_id);
    const parts = kitItems.filter((k) => k.kit_id === it.product_id && k.qty > 0 && k.product_id !== it.product_id);
    if (!product?.spot_id && parts.length) {
      for (const k of parts) {
        const p = byId.get(k.product_id);
        add(it, k.product_id, p?.name ?? k.product_id, p?.part_number ?? "", k.qty * it.qty, it.name);
      }
    } else {
      add(it, it.product_id, it.name, it.part_number, it.qty, null);
    }
  }
  return out;
}

/**
 * The walk. Parts of the same product at the same spot become one stop (one
 * trip to the bin for every order in the batch); stops are grouped by aisle
 * and ordered by the shelf map, snaking through the aisles.
 */
export function routeParts(parts: PickPart[], products: PickProduct[], spots: Spot[]): PickRoute {
  const rows = treeRows(spots);
  const rank = new Map(rows.map((r, i) => [r.spot.id, i]));
  const spotOf = new Map(products.map((p) => [p.id, p.spot_id && rank.has(p.spot_id) ? p.spot_id : null]));

  // One stop per product.
  const stops = new Map<string, PickStop>();
  for (const part of parts) {
    const spotId = spotOf.get(part.product_id) ?? null;
    let stop = stops.get(part.product_id);
    if (!stop) {
      const path = spotPath(spots, spotId);
      stop = {
        product_id: part.product_id,
        name: part.name,
        part_number: part.part_number,
        qty: 0,
        picked_qty: 0,
        done: false,
        spot_id: spotId,
        where: "",
        code: path.map((s) => s.code).join("-"),
        parts: [],
      };
      stops.set(part.product_id, stop);
    }
    stop.qty += part.qty;
    stop.picked_qty += part.picked_qty;
    stop.parts.push(part);
  }

  // Group heading: the path down to the aisle (or to the spot's parent when no aisle is named).
  const grouped = new Map<string, { heading: string; aisleRank: number; stops: PickStop[] }>();
  for (const stop of stops.values()) {
    stop.done = stop.picked_qty >= stop.qty;
    stop.parts.sort((a, b) => a.order_number - b.order_number || a.order_item_id - b.order_item_id);
    const path = spotPath(spots, stop.spot_id);
    let key = "~none";
    let heading = NOT_PLACED;
    let aisleRank = Number.MAX_SAFE_INTEGER;
    if (path.length) {
      const ai = path.findIndex(isAisle);
      const cut = ai >= 0 ? ai + 1 : Math.max(1, path.length - 1);
      const head = path.slice(0, cut);
      const below = path.slice(cut);
      key = head[head.length - 1].id;
      heading = head.map(spotName).join(", ");
      aisleRank = rank.get(key) ?? aisleRank;
      stop.where = below.map(spotName).join(", ");
    }
    const g = grouped.get(key) ?? grouped.set(key, { heading, aisleRank, stops: [] }).get(key)!;
    g.stops.push(stop);
  }

  // Groups in map order; within a group, bins in map order, every other aisle reversed.
  const groups = [...grouped.values()].sort((a, b) => a.aisleRank - b.aisleRank);
  let aisleTurn = 0;
  for (const g of groups) {
    if (g.heading === NOT_PLACED) {
      g.stops.sort((a, b) => a.name.localeCompare(b.name) || a.part_number.localeCompare(b.part_number));
      continue;
    }
    const byRank = (s: PickStop) => rank.get(s.spot_id!) ?? 0;
    g.stops.sort((a, b) => byRank(a) - byRank(b) || a.name.localeCompare(b.name));
    if (spotPath(spots, g.stops[0]?.spot_id).some(isAisle)) {
      if (aisleTurn % 2 === 1) g.stops.reverse();
      aisleTurn++;
    }
  }

  const all = groups.flatMap((g) => g.stops);
  return {
    groups: groups.map((g) => ({ heading: g.heading, stops: g.stops })),
    total: all.reduce((n, s) => n + s.qty, 0),
    picked: all.reduce((n, s) => n + Math.min(s.picked_qty, s.qty), 0),
    lines: all.length,
    done: all.filter((s) => s.done).length,
  };
}
