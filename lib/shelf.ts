// Shelf spots: where a part sits, as a chain of levels each dealer names and
// codes for itself (location, building, area, aisle, section, bin, and any
// sub-bins). One spot prints as one line the customer, the counter and the
// picker all read, plus a joined code for bin tags and pick lists:
//
//   Effingham store, Main building, Upstairs backstock, Aisle 07, Section 3, Bin 12
//   EFF-1-105-07-3-12
//
// The levels are a tree (fittings_shelf_spots). A part points at the deepest
// spot it sits in; the line is that spot's path from the root.

export type Spot = {
  id: string;
  parent_id: string | null;
  level: string;
  code: string;
  label: string;
  sort: number;
};

/** The levels offered when adding a spot, in order. Dealers may type their own word. */
export const LEVELS = ["Location", "Building", "Area", "Aisle", "Section", "Bin", "Sub-bin"] as const;

/** Deepest chain allowed: the seven levels above plus three more sub-bins. */
export const MAX_DEPTH = 10;

/** A code is 1 to 6 letters and digits, kept as typed apart from case and spaces. */
export function normCode(raw: string): string | null {
  const c = raw.replace(/\s+/g, "").toUpperCase();
  return /^[A-Z0-9]{1,6}$/.test(c) ? c : null;
}

/** A level word: 1 to 24 characters of plain text. */
export function normLevel(raw: string): string | null {
  const l = raw.replace(/\s+/g, " ").trim();
  return l.length >= 1 && l.length <= 24 && !/[<>]/.test(l) ? l : null;
}

/** The plain-words name of one spot: its label, or its level and code ("Aisle 07"). */
export function spotName(s: Spot): string {
  return s.label.trim() || `${s.level} ${s.code}`;
}

/** The chain from the root down to `id`, or [] when the id is unknown or the chain loops. */
export function spotPath(spots: Spot[], id: string | null | undefined): Spot[] {
  if (!id) return [];
  const byId = new Map(spots.map((s) => [s.id, s]));
  const out: Spot[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur) {
    if (seen.has(cur.id) || out.length >= MAX_DEPTH) return [];
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    if (cur === undefined && out[0].parent_id) return []; // parent missing: the chain is broken
  }
  return out;
}

/** "Effingham store, Main building, Aisle 07, Bin 12" */
export function spotLine(path: Spot[]): string {
  return path.map(spotName).join(", ");
}

/** "EFF-1-07-12" */
export function spotCode(path: Spot[]): string {
  return path.map((s) => s.code).join("-");
}

export type FindIt = { line: string; code: string };

/** What the part page prints, or null when the part has no spot or its chain is broken. */
export function findIt(spots: Spot[], spotId: string | null | undefined): FindIt | null {
  const path = spotPath(spots, spotId);
  return path.length ? { line: spotLine(path), code: spotCode(path) } : null;
}

/** The level a new child of `parent` is offered: the next word in LEVELS after the parent's. */
export function nextLevel(parent: Spot | null): string {
  if (!parent) return LEVELS[0];
  const i = LEVELS.findIndex((l) => l.toLowerCase() === parent.level.toLowerCase());
  return i >= 0 && i < LEVELS.length - 1 ? LEVELS[i + 1] : LEVELS[LEVELS.length - 1];
}

/** Every spot under `id`, at any depth. */
export function descendants(spots: Spot[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (pid: string) => {
    for (const s of spots) {
      if (s.parent_id === pid && !out.has(s.id)) {
        out.add(s.id);
        walk(s.id);
      }
    }
  };
  walk(id);
  return out;
}

/** Height of the subtree rooted at `id` (1 for a spot with no children). */
function height(spots: Spot[], id: string, guard = 0): number {
  if (guard > MAX_DEPTH) return MAX_DEPTH + 1;
  const kids = spots.filter((s) => s.parent_id === id);
  return 1 + (kids.length ? Math.max(...kids.map((k) => height(spots, k.id, guard + 1))) : 0);
}

/**
 * Why a spot can't sit under `parentId`, or null when it can: not under
 * itself or its own children, and not so deep that its chain passes MAX_DEPTH.
 */
export function moveProblem(spots: Spot[], id: string | null, parentId: string | null): string | null {
  if (!parentId) return null;
  if (id && (parentId === id || descendants(spots, id).has(parentId))) {
    return "A spot can't go inside itself.";
  }
  const parentDepth = spotPath(spots, parentId).length;
  if (!parentDepth) return "That parent spot no longer exists.";
  const own = id ? height(spots, id) : 1;
  return parentDepth + own > MAX_DEPTH ? `Spots go at most ${MAX_DEPTH} levels deep.` : null;
}

/** Codes are unique among brothers and sisters, so a joined code names one spot. */
export function codeTaken(spots: Spot[], parentId: string | null, code: string, exceptId: string | null = null): boolean {
  return spots.some((s) => s.parent_id === parentId && s.code === code && s.id !== exceptId);
}

export type TreeRow = { spot: Spot; depth: number; line: string; code: string };

/** The whole tree, flattened in reading order (parents before children, by sort then code). */
export function treeRows(spots: Spot[]): TreeRow[] {
  const kids = new Map<string | null, Spot[]>();
  const ids = new Set(spots.map((s) => s.id));
  for (const s of spots) {
    const key = s.parent_id && ids.has(s.parent_id) ? s.parent_id : null;
    (kids.get(key) ?? kids.set(key, []).get(key)!).push(s);
  }
  for (const list of kids.values()) list.sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code, "en", { numeric: true }));
  const out: TreeRow[] = [];
  const walk = (pid: string | null, depth: number, trail: Spot[]) => {
    if (depth >= MAX_DEPTH) return;
    for (const s of kids.get(pid) ?? []) {
      const path = [...trail, s];
      out.push({ spot: s, depth, line: spotLine(path), code: spotCode(path) });
      walk(s.id, depth + 1, path);
    }
  };
  walk(null, 0, []);
  return out;
}
