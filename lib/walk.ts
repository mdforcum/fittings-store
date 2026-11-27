// The order a picker visits aisles, worked out from what is next to what.
//
// The shelf map (lib/shelf.ts) says what is inside what and the order spots
// are walked past. On its own that gives a straight walk: first aisle to last.
// A layout file on the shelf map (lib/spacemap.ts) adds the rest: where a pick
// begins and ends, and links between spots that are closer or farther than
// their place in the list suggests (stairs, a door between two rooms).
//
// There are no measurements. Distance is counted in effort: near (a few
// steps), walk (across the room or through a door), far (stairs, another
// building). Unless a link says otherwise:
//   - spots listed one after another are next to each other: near, or walk
//     when either is a room or area, or far when either is a building;
//   - you come into a space at the first spot listed inside it.
// A link replaces the guess for its pair of spots. And once links reach two
// rooms, areas or buildings, the guessed step between those two is dropped:
// the links are the ways in and out.

import { treeRows, type Spot } from "./shelf.ts";
import type { Effort, WalkPlan } from "./spacemap.ts";

export const EFFORT_COST: Record<Effort, number> = { near: 1, walk: 3, far: 8 };
/** One spot to the next along an aisle. */
const STEP = 0.25;
/** Two locations: never one walk, but the sum still has to add up. */
const OTHER_SITE = 50;
const NO_WAY = 1000;

const isAisle = (s: Spot) => /^(aisle|row)\b/i.test(s.level.trim());
const isBuilding = (s: Spot) => /^(building|bldg|site|yard|lot|barn|shed)\b/i.test(s.level.trim());
const isArea = (s: Spot) => /^(area|room|floor|level|zone|dept|department|addition|loft|mezzanine|upstairs|downstairs|basement|dock|office)\b/i.test(s.level.trim());

type Graph = Map<string, Map<string, number>>;

function join(g: Graph, a: string, b: string, cost: number) {
  (g.get(a) ?? g.set(a, new Map()).get(a)!).set(b, cost);
  (g.get(b) ?? g.set(b, new Map()).get(b)!).set(a, cost);
}

/** Every spot, joined to its neighbours by how much effort the step between them takes. */
export function walkGraph(spots: Spot[], plan: WalkPlan): Graph {
  const g: Graph = new Map();
  const rows = treeRows(spots);
  const kids = new Map<string | null, Spot[]>();
  const inAisle = new Set<string>(); // spots somewhere inside an aisle
  const byId = new Map(spots.map((s) => [s.id, s]));
  for (const r of rows) {
    g.set(r.spot.id, new Map());
    const parentId = r.depth > 0 ? r.spot.parent_id : null;
    (kids.get(parentId) ?? kids.set(parentId, []).get(parentId)!).push(r.spot);
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent && (isAisle(parent) || inAisle.has(parent.id))) inAisle.add(r.spot.id);
  }
  for (const [parentId, list] of kids) {
    if (parentId && list.length) join(g, parentId, list[0].id, 0);
    for (let i = 0; i + 1 < list.length; i++) {
      const [a, b] = [list[i], list[i + 1]];
      const cost = !parentId
        ? OTHER_SITE
        : inAisle.has(a.id)
          ? STEP
          : isBuilding(a) || isBuilding(b)
            ? EFFORT_COST.far
            : isArea(a) || isArea(b)
              ? EFFORT_COST.walk
              : EFFORT_COST.near;
      join(g, a.id, b.id, cost);
    }
  }
  // What the layout file says replaces the guess. A room, area or building
  // that a link reaches from outside (stairs at the end of aisle 4 up to the
  // loft) is reached by its links: the guessed step between two such spaces
  // goes. A space no link mentions keeps its guess, so nothing is cut off.
  const chain = (id: string): string[] => {
    const out: string[] = [];
    for (let cur = byId.get(id), guard = 0; cur && g.has(cur.id) && guard < 20; guard++) {
      out.unshift(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return out;
  };
  const linked = plan.links.filter((l) => g.has(l.a) && g.has(l.b) && l.a !== l.b);
  const reached = new Set<string>();
  for (const l of linked) {
    const [ca, cb] = [chain(l.a), chain(l.b)];
    for (const [mine, other] of [[ca, cb], [cb, ca]]) {
      for (const id of mine) {
        const spot = byId.get(id)!;
        if (!other.includes(id) && (isArea(spot) || isBuilding(spot))) reached.add(id);
      }
    }
  }
  for (const [parentId, list] of kids) {
    if (!parentId) continue;
    for (let i = 0; i + 1 < list.length; i++) {
      const [a, b] = [list[i].id, list[i + 1].id];
      if (reached.has(a) && reached.has(b)) {
        g.get(a)!.delete(b);
        g.get(b)!.delete(a);
      }
    }
  }
  for (const l of linked) join(g, l.a, l.b, EFFORT_COST[l.effort]);
  return g;
}

/** Least effort from one spot to every other. */
export function effortFrom(g: Graph, from: string): Map<string, number> {
  const best = new Map<string, number>([[from, 0]]);
  const heap: Array<[number, string]> = [[0, from]];
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  const push = (item: [number, string]) => {
    heap.push(item);
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  while (heap.length) {
    const [d, id] = pop();
    if (d > (best.get(id) ?? Infinity)) continue;
    for (const [next, cost] of g.get(id) ?? []) {
      const nd = d + cost;
      if (nd < (best.get(next) ?? Infinity) - 1e-9) {
        best.set(next, nd);
        push([nd, next]);
      }
    }
  }
  return best;
}

/**
 * The shortest way round: point 0 first, then every other point once. With
 * `loop` the walk also comes back to point 0. Exact for up to 8 stops; beyond
 * that, nearest stop first and then untangled. Ties keep the given order.
 */
export function shortestRound(d: number[][], loop: boolean): number[] {
  const n = d.length;
  if (n <= 2) return d.map((_, i) => i);
  const length = (t: number[]) => {
    let sum = loop ? d[t[t.length - 1]][t[0]] : 0;
    for (let i = 0; i + 1 < t.length; i++) sum += d[t[i]][t[i + 1]];
    return sum;
  };
  if (n <= 9) {
    let best: number[] = [];
    let bestLen = Infinity;
    const used = new Array<boolean>(n).fill(false);
    const cur = [0];
    used[0] = true;
    const go = (len: number) => {
      if (len >= bestLen - 1e-9) return;
      if (cur.length === n) {
        const total = len + (loop ? d[cur[n - 1]][0] : 0);
        if (total < bestLen - 1e-9) {
          bestLen = total;
          best = [...cur];
        }
        return;
      }
      for (let i = 1; i < n; i++) {
        if (used[i]) continue;
        used[i] = true;
        cur.push(i);
        go(len + d[cur[cur.length - 2]][i]);
        cur.pop();
        used[i] = false;
      }
    };
    go(0);
    return best;
  }
  // Nearest stop first.
  const tour = [0];
  const left = new Set(d.map((_, i) => i).slice(1));
  while (left.size) {
    const here = tour[tour.length - 1];
    let pick = -1;
    for (const i of left) if (pick < 0 || d[here][i] < d[here][pick] - 1e-9) pick = i;
    tour.push(pick);
    left.delete(pick);
  }
  // Untangle: turn a stretch round whenever that makes the walk shorter.
  for (let improved = true, guard = 0; improved && guard < 50; guard++) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const trial = [...tour.slice(0, i), ...tour.slice(i, j + 1).reverse(), ...tour.slice(j + 1)];
        if (length(trial) < length(tour) - 1e-9) {
          tour.splice(0, n, ...trial);
          improved = true;
        }
      }
    }
  }
  return tour;
}

export type Tour = { order: string[]; start: { spot_id: string; label: string } | null };

/**
 * The stops (aisles, or whatever spot holds the bins) in the order to visit
 * them. `stops` come in shelf-map order. With nothing from a layout file the
 * order is unchanged. Each location is walked on its own, from its start point
 * and back when it has one, otherwise from its first stop.
 */
export function tour(spots: Spot[], stops: string[], plan: WalkPlan): Tour[] {
  if (!stops.length) return [];
  if (!plan.links.length && !plan.starts.size) return [{ order: stops, start: null }];
  const byId = new Map(spots.map((s) => [s.id, s]));
  const rootOf = (id: string): string => {
    let cur = byId.get(id);
    for (let guard = 0; cur?.parent_id && byId.has(cur.parent_id) && guard < 20; guard++) cur = byId.get(cur.parent_id);
    return cur?.id ?? id;
  };
  const byRoot = new Map<string, string[]>();
  for (const id of stops) {
    const root = rootOf(id);
    (byRoot.get(root) ?? byRoot.set(root, []).get(root)!).push(id);
  }
  const g = walkGraph(spots, plan);
  const out: Tour[] = [];
  for (const [root, list] of byRoot) {
    const start = plan.starts.get(root) ?? null;
    const usable = start && g.has(start.spot_id) ? start : null;
    const points = usable ? [usable.spot_id, ...list] : list;
    const from = points.map((p) => effortFrom(g, p));
    const d = points.map((_, i) => points.map((q) => from[i].get(q) ?? NO_WAY));
    const round = shortestRound(d, !!usable).map((i) => points[i]);
    out.push({ order: usable ? round.slice(1) : round, start: usable });
  }
  return out;
}
