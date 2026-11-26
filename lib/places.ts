// Dealers and their store locations: who keeps which parts where.
// The database keeps the counts (supabase/add-locations.sql); this file has
// the rules the screens share: checking a location, reading counts by
// location, and saying where an order ships from.

export type Dealer = { id: string; name: string; slug: string };

export type StoreLocation = {
  id: string;
  dealer_id: string;
  name: string;
  /** Short code, up to 6 letters or digits (EFF, MAIN). */
  code: string;
  city: string;
  state: string;
  zip: string;
  ships: boolean;
  pickup: boolean;
  active: boolean;
  sort: number;
};

/** Item id → location id → count. */
export type Onhand = Record<string, Record<string, number>>;

export type Allocation = { order_id: string; product_id: string; location_id: string; qty: number };

export type Places = {
  dealers: Dealer[];
  locations: StoreLocation[];
  default_location_id: string | null;
  onhand: Onhand;
  /** False until supabase/add-locations.sql has run. */
  ready: boolean;
};

export const NO_PLACES: Places = { dealers: [], locations: [], default_location_id: null, onhand: {}, ready: false };

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function normalizeLocation(row: Record<string, unknown>): StoreLocation {
  return {
    id: str(row.id),
    dealer_id: str(row.dealer_id),
    name: str(row.name),
    code: str(row.code),
    city: str(row.city),
    state: str(row.state),
    zip: str(row.zip),
    ships: row.ships !== false,
    pickup: row.pickup !== false,
    active: row.active !== false,
    sort: typeof row.sort === "number" ? row.sort : 0,
  };
}

export function byLocationOrder(a: StoreLocation, b: StoreLocation): number {
  return a.sort - b.sort || a.name.localeCompare(b.name);
}

export function onhandMap(rows: Array<{ product_id: unknown; location_id: unknown; qty: unknown }> | null | undefined): Onhand {
  const out: Onhand = {};
  for (const r of rows ?? []) {
    const n = Number(r.qty);
    if (typeof r.product_id !== "string" || typeof r.location_id !== "string" || !Number.isFinite(n)) continue;
    (out[r.product_id] ??= {})[r.location_id] = Math.max(0, Math.floor(n));
  }
  return out;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export function normCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

/** What is wrong with a location before it is saved, in words for staff; null when it is fine. */
export function locationProblem(
  loc: Pick<StoreLocation, "id" | "dealer_id" | "name" | "code" | "state" | "zip">,
  others: StoreLocation[],
): string | null {
  if (!loc.dealer_id) return "Pick the dealer this location belongs to.";
  const name = loc.name.trim();
  if (name.length < 1 || name.length > 60) return "Give the location a name, up to 60 letters.";
  if (!/^[A-Z0-9]{0,6}$/.test(loc.code)) return "The short code is up to 6 letters or numbers, like EFF.";
  if (loc.code && others.some((o) => o.id !== loc.id && o.dealer_id === loc.dealer_id && o.code === loc.code)) {
    return `Another location already uses the code ${loc.code}.`;
  }
  if (loc.state && !/^[A-Z]{2}$/.test(loc.state)) return "State is two letters, like IL.";
  if (loc.zip && !/^\d{5}$/.test(loc.zip)) return "ZIP is 5 digits.";
  if (others.some((o) => o.id !== loc.id && o.dealer_id === loc.dealer_id && o.name.trim().toLowerCase() === name.toLowerCase())) {
    return "This dealer already has a location with that name.";
  }
  return null;
}

/** "Main shop 3 · EFF 2": counts at each location holding any, in location order. */
export function countsLine(counts: Record<string, number> | undefined, locations: StoreLocation[]): string {
  return [...locations]
    .sort(byLocationOrder)
    .filter((l) => (counts?.[l.id] ?? 0) > 0)
    .map((l) => `${l.code || l.name} ${counts![l.id]}`)
    .join(" · ");
}

/** Where a paid order ships from: one name, or each location with how many parts. */
export function shipsFrom(allocs: Allocation[], locations: StoreLocation[]): string {
  const per = new Map<string, number>();
  for (const a of allocs) per.set(a.location_id, (per.get(a.location_id) ?? 0) + a.qty);
  const name = (id: string) => locations.find((l) => l.id === id)?.name ?? "a location no longer listed";
  const ids = [...per.keys()].sort((x, y) => {
    const a = locations.find((l) => l.id === x);
    const b = locations.find((l) => l.id === y);
    return a && b ? byLocationOrder(a, b) : 0;
  });
  if (ids.length === 0) return "";
  if (ids.length === 1) return name(ids[0]);
  return ids.map((id) => `${name(id)} ×${per.get(id)}`).join(" · ");
}

/**
 * The location an order's item is picked at: where most of it was taken from.
 * (An item split across locations is rare; staff see each location's share on
 * the order.)
 */
export function pickLocation(allocs: Allocation[], orderId: string, productId: string): string | null {
  let best: Allocation | null = null;
  for (const a of allocs) {
    if (a.order_id !== orderId || a.product_id !== productId) continue;
    if (!best || a.qty > best.qty) best = a;
  }
  return best?.location_id ?? null;
}
