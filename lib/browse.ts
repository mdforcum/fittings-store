// Browse and search rules for the shop, pure so the page and the tests agree.
//
// Three doors into the catalog (see the Parts Catalog Plan):
//   by number    our part number, or any number an item replaces ("86-572263")
//   by category  departments down to the shelf an item sits on
//   by machine   the customer's machine, and its serial where a part changed partway
import { typeOf, type Product } from "./catalog.ts";
import { prepareWords, squash, termTier, type Words } from "./words.ts";
import { CONDITIONS, fitsSerial, numberNorm, type Category, type FitRow } from "./foundation.ts";

/** A number an item goes by, as the shop needs it. */
export type ShopXref = { kind: string; brand: string; number: string; number_norm: string };
/** One "fits this machine" row, as the shop needs it. */
/** A core or other charge an item carries, as the shop shows it. */
export type ShopCharge = { kind: "core" | "tire_fee" | "hazmat" | "deposit"; amount_cents: number; refundable: boolean; label: string };

export type ShopFit = Pick<FitRow, "machine_id" | "serial_prefix" | "serial_from" | "serial_to" | "position">;

export type Hit = {
  product: Product;
  /** Higher first. 100 exact part number, 90 exact replaced number, 60 starts with, 20 words. */
  score: number;
  /** Shown under the item when the search matched a number other than our own: "Replaces 86572263". */
  because: string;
  /** Set when the match is a best guess: "spelling" a word was a typing slip away; "some" only some of the words matched. */
  loose?: "spelling" | "some";
};

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9./-]+/).filter((t) => squash(t) !== "");

/** Each shelf's own name and the names of the departments above it, for search. */
export function shelfWords(categories: Pick<Category, "id" | "parent_id" | "name" | "live">[]): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out = new Map<string, string>();
  for (const c of categories) {
    const names: string[] = [];
    for (let at: (typeof categories)[number] | undefined = c, hops = 0; at && hops < 8; at = at.parent_id ? byId.get(at.parent_id) : undefined, hops++) {
      if (at.live) names.push(at.name);
    }
    out.set(c.id, names.join(" "));
  }
  return out;
}

// An item's searchable words, worked out once and reused while the shopper types.
const prepared = new WeakMap<Product, { x: ShopXref[] | undefined; shelf: string; w: Words }>();
function wordsFor(product: Product, x: ShopXref[] | undefined, shelf: string): Words {
  const had = prepared.get(product);
  if (had && had.x === x && had.shelf === shelf) return had.w;
  const main = [product.name, product.part_number, product.thread, product.size, product.dash, product.brand, ...(x ?? []).flatMap((r) => [r.brand, r.number])].join(" ");
  const extra = [product.type !== "other" ? typeOf(product.type).label : "", shelf, product.description].join(" ");
  const w = prepareWords(main, extra);
  prepared.set(product, { x, shelf, w });
  return w;
}

/**
 * Finds items by number first, then by words. A number is compared with its
 * punctuation and spaces taken out, so 86-572263, 86572263 and "86 572263"
 * are one number. Every word must match the item's name, specs, numbers,
 * shelf or description, and a word is forgiven its form: no hyphen ("oring"),
 * a plural, or shop shorthand ("orb"). A size or number is never guessed at.
 * Only when nothing matches for certain are guesses offered, and they are
 * marked: first items a typing slip away, then items that match at least
 * half of the words.
 */
export function searchProducts(products: Product[], xrefs: Map<string, ShopXref[]>, query: string, shelves?: Map<string, string>): Hit[] {
  const q = query.trim();
  if (!q) return products.map((product) => ({ product, score: 0, because: "" }));
  const norm = numberNorm(q);
  const terms = words(q);
  const hits: Hit[] = [];
  const partial: Hit[] = [];
  for (const product of products) {
    let score = 0;
    let because = "";
    let loose: Hit["loose"];
    const own = numberNorm(product.part_number);
    if (norm.length >= 3) {
      if (own && own === norm) score = 100;
      else if (own && own.startsWith(norm)) score = 60;
      for (const x of xrefs.get(product.id) ?? []) {
        if (x.number_norm === norm && score < 90) {
          score = 90;
          because = `Replaces ${x.brand ? `${x.brand} ` : ""}${x.number}`;
        } else if (x.number_norm.startsWith(norm) && score < 55) {
          score = 55;
          because = `Replaces ${x.brand ? `${x.brand} ` : ""}${x.number}`;
        }
      }
    }
    if (!score && terms.length) {
      const w = wordsFor(product, xrefs.get(product.id), shelves?.get(product.category_id ?? "") ?? "");
      const tiers = terms.map((t) => termTier(w, t));
      const worst = Math.min(...tiers);
      if (worst === 3) score = 20;
      else if (worst === 2) score = 16;
      else if (worst === 1) {
        score = 10;
        loose = "spelling";
      } else {
        const matched = tiers.filter((t) => t > 0).length;
        if (terms.length >= 2 && matched >= Math.ceil(terms.length / 2)) partial.push({ product, score: matched, because: "", loose: "some" });
      }
    }
    if (score) hits.push(loose ? { product, score, because, loose } : { product, score, because });
  }
  // A guess is only offered when nothing matched for certain: "seal" should not also bring up "seat".
  const firm = hits.filter((h) => !h.loose);
  return (firm.length ? firm : hits.length ? hits : partial).sort((a, b) => b.score - a.score || a.product.sort - b.product.sort || a.product.name.localeCompare(b.product.name));
}

export type FitState =
  | { kind: "fits"; note: string }
  | { kind: "checkSerial"; note: string }
  | { kind: "notListed" }
  | { kind: "universal" }
  | { kind: "unknown" };

/**
 * Whether an item fits the customer's machine. "unknown" means the item
 * carries no machine list at all, so the shop says nothing rather than "no".
 */
export function fitState(product: Pick<Product, "universal">, rows: ShopFit[], machineId: string | null, serial = ""): FitState {
  if (product.universal) return { kind: "universal" };
  if (!rows.length || !machineId) return { kind: "unknown" };
  const mine = rows.filter((r) => r.machine_id === machineId);
  if (!mine.length) return { kind: "notListed" };
  const open = mine.find((r) => !r.serial_prefix && !r.serial_from && !r.serial_to);
  if (open) return { kind: "fits", note: open.position };
  if (!numberNorm(serial)) return { kind: "checkSerial", note: "Fits some serial numbers of this machine. Add your serial to check." };
  const hit = mine.find((r) => fitsSerial(serial, r));
  return hit ? { kind: "fits", note: hit.position } : { kind: "notListed" };
}

export type NavNode = { id: string; name: string; count: number; children: NavNode[] };

/**
 * The departments a shopper can browse: live categories that hold items, each
 * with how many items sit in it or below it. Empty and switched-off branches
 * are left out, so nobody lands on an empty shelf.
 */
export function shopNav(categories: Category[], products: Pick<Product, "category_id">[]): NavNode[] {
  const live = categories.filter((c) => c.live);
  const ids = new Set(live.map((c) => c.id));
  const direct = new Map<string, number>();
  for (const p of products) if (p.category_id && ids.has(p.category_id)) direct.set(p.category_id, (direct.get(p.category_id) ?? 0) + 1);
  const build = (parent: string | null): NavNode[] =>
    live
      .filter((c) => (c.parent_id && ids.has(c.parent_id) ? c.parent_id : null) === parent)
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
      .map((c) => {
        const children = build(c.id);
        return { id: c.id, name: c.name, count: (direct.get(c.id) ?? 0) + children.reduce((n, k) => n + k.count, 0), children };
      })
      .filter((n) => n.count > 0);
  return build(null);
}

/** Every category id at or below one, for filtering by a department. */
export function underCategory(id: string, categories: Pick<Category, "id" | "parent_id">[]): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of categories) {
      if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

export const conditionLabel = (id: string) => CONDITIONS.find((c) => c.id === id)?.label ?? id;

/** Warranty in plain words: "6-month warranty", "2-year warranty". */
export function warrantyText(months: number | null | undefined): string {
  if (!months) return "";
  if (months % 12 === 0) return `${months / 12}-year warranty`;
  return `${months}-month warranty`;
}

// ---------------------------------------------------------------------------
// The customer's machines, kept in their browser.
// ---------------------------------------------------------------------------

export type MyMachine = { id: string; label: string; serial: string };
export type Garage = { active: string | null; machines: MyMachine[] };
export const EMPTY_GARAGE: Garage = { active: null, machines: [] };
const GARAGE_MAX = 6;

/** Reads a stored garage, dropping anything malformed. */
export function readGarage(raw: string | null): Garage {
  try {
    const v = JSON.parse(raw ?? "") as Partial<Garage>;
    const machines = (Array.isArray(v.machines) ? v.machines : [])
      .filter((m): m is MyMachine => !!m && typeof m.id === "string" && typeof m.label === "string")
      .map((m) => ({ id: m.id.slice(0, 40), label: m.label.slice(0, 80), serial: typeof m.serial === "string" ? m.serial.slice(0, 20) : "" }))
      .slice(0, GARAGE_MAX);
    const active = typeof v.active === "string" && machines.some((m) => m.id === v.active) ? v.active : (machines[0]?.id ?? null);
    return { active, machines };
  } catch {
    return EMPTY_GARAGE;
  }
}

/** Adds or updates a machine and makes it the active one; the oldest drops off past six. */
export function addToGarage(g: Garage, m: MyMachine): Garage {
  const rest = g.machines.filter((x) => x.id !== m.id);
  return { active: m.id, machines: [m, ...rest].slice(0, GARAGE_MAX) };
}

export function removeFromGarage(g: Garage, id: string): Garage {
  const machines = g.machines.filter((m) => m.id !== id);
  return { active: g.active === id ? (machines[0]?.id ?? null) : g.active, machines };
}
