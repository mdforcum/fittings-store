// Space maps: a shop's layout written as one plain-text file. The Space mapper
// (lib/spacemap-read.ts) drafts the file from photos and notes; people can
// read it, fix it by hand, and keep it. Putting it on the shelf map makes the
// spots (lib/shelf.ts), and the pick walk (lib/walk.ts) uses its start point,
// links and dead ends to pull parts in the shortest order.
//
// The file says what is there, what is next to what, and how you walk it.
// It holds no measurements and no drawing.
//
//   spacemap 1
//   name: McCormick Diesel Service
//
//   Location MCD "McCormick Diesel"
//     Building 1 "Main shop"
//       Area 100 "Parts room"
//         Aisle 01..04
//           Section A..C
//             Bin 01..12
//         Aisle 05 (dead end)
//           Bin 01..08
//       Area 105 "Upstairs backstock"
//         Shelf A..D
//
//   start: MCD-1-100 "Parts counter"
//   link: MCD-1-100-04 <> MCD-1-105 far "Stairs at the end of aisle 4"
//
// One spot per line: level word, code, an optional name in quotes, and
// "(dead end)" for an aisle you walk into and back out of. Two spaces of
// indent put a spot inside the one above. A range (01..12, A..D) is that many
// spots, and anything indented under a range is inside every one of them.
// Spots are listed in the order you walk past them.
//
// Spots beside each other in the file are taken to be next to each other.
// A "link:" line says otherwise: near (a few steps), walk (across the room or
// through a door) or far (stairs, another building, outside). "start:" is
// where a pick begins and ends, one per location.

import { MAX_DEPTH, normCode, normLevel, treeRows, type Spot } from "./shelf.ts";

export type Effort = "near" | "walk" | "far";
export const EFFORTS: Effort[] = ["near", "walk", "far"];

export type SpaceNode = { level: string; code: string; label: string; deadEnd: boolean; children: SpaceNode[] };
export type SpaceLink = { a: string; b: string; effort: Effort; via: string };
export type SpaceStart = { at: string; label: string };
export type SpaceMap = { name: string; notes: string[]; roots: SpaceNode[]; starts: SpaceStart[]; links: SpaceLink[] };
export type Problem = { line: number; text: string };
export type Parsed = { map: SpaceMap; problems: Problem[]; count: number };

/** Most spots one file may hold, and most spots one range may make. */
export const MAX_SPOTS = 5000;
export const MAX_RANGE = 500;
const MAX_TEXT = 200_000;

const clean = (v: string, max: number) => v.replace(/["<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

/** The line without a trailing "# note" (a # inside a quoted name stays). */
function uncomment(line: string): string {
  for (let i = 1, quotes = 0; i < line.length; i++) {
    if (line[i] === '"') quotes++;
    else if (line[i] === "#" && quotes % 2 === 0 && /\s/.test(line[i - 1]) && line.slice(0, i).trim()) return line.slice(0, i);
  }
  return line;
}

/** "01..12" or "A..D" as its codes, or a plain-words reason it is not a range we can read. */
export function expandRange(from: string, to: string): string[] | string {
  const a = normCode(from);
  const b = normCode(to);
  if (!a || !b) return "A range runs between two codes, like 01..12 or A..D.";
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const lo = Number(a);
    const hi = Number(b);
    if (hi < lo) return `The range ${a}..${b} runs backwards.`;
    if (hi - lo + 1 > MAX_RANGE) return `A range makes at most ${MAX_RANGE} spots.`;
    const padded = a.length === b.length;
    if (!padded && a.length > 1 && a.startsWith("0")) return `Write both ends of ${a}..${b} with the same number of digits.`;
    const out: string[] = [];
    for (let n = lo; n <= hi; n++) out.push(padded ? String(n).padStart(a.length, "0") : String(n));
    return out;
  }
  if (/^[A-Z]$/.test(a) && /^[A-Z]$/.test(b)) {
    if (b < a) return `The range ${a}..${b} runs backwards.`;
    const out: string[] = [];
    for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) out.push(String.fromCharCode(c));
    return out;
  }
  return `The range ${a}..${b} is not all numbers or single letters. List those spots one per line.`;
}

/** "MCD-1-100" as its codes, or null when a piece is not a code. */
function pathCodes(raw: string): string[] | null {
  const parts = raw.trim().split("-").map((p) => normCode(p));
  return parts.length && parts.length <= MAX_DEPTH && parts.every((p): p is string => !!p) ? parts : null;
}

/** The spot a joined code names, or null. */
export function nodeAt(map: SpaceMap, path: string): SpaceNode | null {
  const codes = pathCodes(path);
  if (!codes) return null;
  let list = map.roots;
  let node: SpaceNode | null = null;
  for (const code of codes) {
    node = list.find((n) => n.code === code) ?? null;
    if (!node) return null;
    list = node.children;
  }
  return node;
}

export function countSpots(map: SpaceMap): number {
  const walk = (n: SpaceNode): number => 1 + n.children.reduce((sum, c) => sum + walk(c), 0);
  return map.roots.reduce((sum, r) => sum + walk(r), 0);
}

type Template = { line: number; level: string; codes: string[]; label: string; deadEnd: boolean; children: Template[] };

/** Reads a layout file. Lines it cannot use are listed as problems and left out. */
export function parseSpaceMap(text: string): Parsed {
  const map: SpaceMap = { name: "", notes: [], roots: [], starts: [], links: [] };
  const problems: Problem[] = [];
  const say = (line: number, t: string) => {
    if (problems.length < 60) problems.push({ line, text: t });
  };
  if (text.length > MAX_TEXT) {
    say(0, "This file is too long to read.");
    return { map, problems, count: 0 };
  }

  const top: Template[] = [];
  const open: Template[] = []; // the spot at each depth that later lines may sit inside
  const later: Array<{ line: number; kind: "start" | "link"; rest: string }> = [];
  let sawHeader = false;
  let lastDepth = -1;

  const lines = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = uncomment(raw.replace(/\t/g, "  ")).replace(/\s+$/, "");
    const body = line.trim();
    if (!body || body.startsWith("```")) return;
    if (body.startsWith("#")) {
      const note = clean(body.replace(/^#+\s*/, ""), 200);
      if (note && map.notes.length < 40) map.notes.push(note);
      return;
    }
    if (/^spacemap\b/i.test(body)) {
      if (!/^spacemap\s+1$/i.test(body)) say(n, "This reads version 1 files: the first line is \"spacemap 1\".");
      sawHeader = true;
      return;
    }
    const keyed = /^(name|start|link)\s*:\s*(.*)$/i.exec(body);
    if (keyed) {
      if (line.startsWith(" ")) say(n, `"${keyed[1].toLowerCase()}:" lines start at the left edge.`);
      const kind = keyed[1].toLowerCase() as "name" | "start" | "link";
      if (kind === "name") map.name = clean(keyed[2], 80);
      else later.push({ line: n, kind, rest: keyed[2] });
      return;
    }

    // A spot line.
    const indent = line.length - line.trimStart().length;
    if (indent % 2) return say(n, "Indent with two spaces for each level.");
    const depth = indent / 2;
    if (depth > lastDepth + 1) return say(n, "This line is indented too far: a spot sits one level inside the spot above it.");
    if (depth >= MAX_DEPTH) return say(n, `Spots go at most ${MAX_DEPTH} levels deep.`);
    let rest = body;
    let deadEnd = false;
    const flag = /\(([^)]*)\)\s*$/.exec(rest);
    if (flag) {
      if (!/^dead[\s-]?end$/i.test(flag[1].trim())) return say(n, `"(${flag[1]})" is not something a spot line can say. Only "(dead end)" goes in brackets.`);
      deadEnd = true;
      rest = rest.slice(0, flag.index).trim();
    }
    let label = "";
    const quoted = /"([^"]*)"\s*$/.exec(rest);
    if (quoted) {
      label = clean(quoted[1], 60);
      rest = rest.slice(0, quoted.index).trim();
    }
    if (rest.includes('"')) return say(n, "A spot has one name in quotes, at the end of the line.");
    const words = rest.split(/\s+/).filter(Boolean);
    if (words.length < 2) return say(n, "A spot line is a level word, then a code: Aisle 07.");
    const level = normLevel(words.slice(0, -1).join(" "));
    if (!level) return say(n, "Name the level in 1 to 24 characters, like Aisle or Bin.");
    const codeWord = words[words.length - 1];
    let codes: string[];
    const range = /^([^.]+)\.\.+([^.]+)$/.exec(codeWord);
    if (range) {
      const got = expandRange(range[1], range[2]);
      if (typeof got === "string") return say(n, got);
      if (label && got.length > 1) return say(n, "A range of spots can't share one name. Give the name on a line of its own.");
      codes = got;
    } else {
      const code = normCode(codeWord);
      if (!code) return say(n, `"${codeWord.slice(0, 20)}" is not a code. A code is 1 to 6 letters or digits, like 07 or B.`);
      codes = [code];
    }
    const t: Template = { line: n, level, codes, label, deadEnd, children: [] };
    (depth === 0 ? top : open[depth - 1].children).push(t);
    open[depth] = t;
    open.length = depth + 1;
    lastDepth = depth;
  });
  if (!sawHeader && (top.length || later.length)) say(1, "The first line should be \"spacemap 1\".");

  // Ranges become their spots; a code used twice under one parent keeps the first.
  let count = 0;
  const build = (templates: Template[]): SpaceNode[] => {
    const out: SpaceNode[] = [];
    const seen = new Set<string>();
    for (const t of templates) {
      for (const code of t.codes) {
        if (seen.has(code)) {
          say(t.line, `Code ${code} is used twice at this level. Each spot needs its own code.`);
          continue;
        }
        if (count >= MAX_SPOTS) {
          if (count === MAX_SPOTS) say(t.line, `One file holds at most ${MAX_SPOTS} spots. Split the shop into more than one file.`);
          count++;
          return out;
        }
        seen.add(code);
        count++;
        out.push({ level: t.level, code, label: t.label, deadEnd: t.deadEnd, children: build(t.children) });
      }
    }
    return out;
  };
  map.roots = build(top);
  count = Math.min(count, MAX_SPOTS);

  for (const item of later) {
    if (item.kind === "start") {
      const m = /^(\S+)\s*(?:"([^"]*)")?\s*$/.exec(item.rest.trim());
      const codes = m ? pathCodes(m[1]) : null;
      if (!m || !codes) {
        say(item.line, "A start line names one spot by its joined code: start: MCD-1-100 \"Parts counter\".");
        continue;
      }
      const at = codes.join("-");
      if (!nodeAt(map, at)) {
        say(item.line, `The start is at ${at}, which is not a spot in this file.`);
        continue;
      }
      if (map.starts.some((s) => s.at.split("-")[0] === codes[0])) {
        say(item.line, `${codes[0]} already has a start. A location has one place where picks begin and end.`);
        continue;
      }
      map.starts.push({ at, label: clean(m[2] ?? "", 60) });
    } else {
      const m = /^(\S+)\s*(?:<-?>|--)\s*(\S+)(?:\s+([A-Za-z]+))?\s*(?:"([^"]*)")?\s*$/.exec(item.rest.trim());
      const a = m ? pathCodes(m[1]) : null;
      const b = m ? pathCodes(m[2]) : null;
      if (!m || !a || !b) {
        say(item.line, "A link line joins two spots: link: MCD-1-100 <> MCD-1-105 far \"Stairs\".");
        continue;
      }
      const effort = (m[3] ?? "").toLowerCase() as Effort;
      if (!EFFORTS.includes(effort)) {
        say(item.line, "Say how far the link is: near (a few steps), walk (across the room or through a door) or far (stairs, another building).");
        continue;
      }
      const [pa, pb] = [a.join("-"), b.join("-")];
      const missing = [pa, pb].filter((p) => !nodeAt(map, p));
      if (missing.length) {
        say(item.line, `The link names ${missing.join(" and ")}, which ${missing.length === 1 ? "is not a spot" : "are not spots"} in this file.`);
        continue;
      }
      if (pa === pb) {
        say(item.line, "A link joins two different spots.");
        continue;
      }
      if (map.links.some((l) => (l.a === pa && l.b === pb) || (l.a === pb && l.b === pa))) {
        say(item.line, `${pa} and ${pb} are already linked.`);
        continue;
      }
      if (map.links.length >= 500) {
        say(item.line, "One file holds at most 500 links.");
        continue;
      }
      map.links.push({ a: pa, b: pb, effort, via: clean(m[4] ?? "", 60) });
    }
  }
  return { map, problems, count };
}

const shape = (n: SpaceNode): string => JSON.stringify([n.level, n.label, n.deadEnd, n.children.map((c) => [c.code, shape(c)])]);

/**
 * Brothers and sisters as runs: three or more plain spots in a row with codes
 * that count up and the same things inside print as one range.
 */
export function runs(nodes: SpaceNode[]): SpaceNode[][] {
  const out: SpaceNode[][] = [];
  let i = 0;
  while (i < nodes.length) {
    let j = i;
    const first = nodes[i];
    if (!first.label) {
      const same = shape(first);
      while (j + 1 < nodes.length && shape(nodes[j + 1]) === same) {
        const got = expandRange(first.code, nodes[j + 1].code);
        if (typeof got === "string" || got.length !== j + 2 - i || !got.every((code, k) => code === nodes[i + k].code)) break;
        j++;
      }
    }
    if (j - i < 2) j = i;
    out.push(nodes.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

/** Writes the file, the same way every time, with ranges where the shop is regular. */
export function printSpaceMap(map: SpaceMap): string {
  const out: string[] = ["spacemap 1"];
  if (map.name) out.push(`name: ${clean(map.name, 80)}`);
  for (const note of map.notes) out.push(`# ${note}`);
  if (map.roots.length) out.push("");
  const walk = (nodes: SpaceNode[], depth: number) => {
    for (const run of runs(nodes)) {
      const n = run[0];
      const code = run.length > 1 ? `${n.code}..${run[run.length - 1].code}` : n.code;
      const label = n.label ? ` "${clean(n.label, 60)}"` : "";
      out.push(`${"  ".repeat(depth)}${n.level} ${code}${label}${n.deadEnd ? " (dead end)" : ""}`);
      walk(n.children, depth + 1);
    }
  };
  walk(map.roots, 0);
  if (map.starts.length || map.links.length) out.push("");
  for (const s of map.starts) out.push(`start: ${s.at}${s.label ? ` "${clean(s.label, 60)}"` : ""}`);
  for (const l of map.links) out.push(`link: ${l.a} <> ${l.b} ${l.effort}${l.via ? ` "${clean(l.via, 60)}"` : ""}`);
  return out.join("\n") + "\n";
}

export type OutlineRow = { depth: number; level: string; from: string; to: string; count: number; label: string; deadEnd: boolean; code: string };

/** The layout for the screen: one row per spot or range, parents before children. */
export function outlineRows(map: SpaceMap): OutlineRow[] {
  const out: OutlineRow[] = [];
  const walk = (nodes: SpaceNode[], depth: number, trail: string[]) => {
    for (const run of runs(nodes)) {
      const n = run[0];
      const last = run[run.length - 1];
      out.push({
        depth,
        level: n.level,
        from: n.code,
        to: last.code,
        count: run.length,
        label: n.label,
        deadEnd: n.deadEnd,
        code: [...trail, n.code].join("-"),
      });
      walk(n.children, depth + 1, [...trail, n.code]);
    }
  };
  walk(map.roots, 0, []);
  return out;
}

/** The plain-words name of the spot a joined code names: "Parts room" or "Aisle 04". */
export function nameAt(map: SpaceMap, path: string): string {
  const n = nodeAt(map, path);
  return n ? n.label || `${n.level} ${n.code}` : path;
}

/** The shelf map as a layout file: every spot, or only the tree under `rootId`. */
export function mapFromSpots(spots: Spot[], name = "", rootId: string | null = null): SpaceMap {
  const rows = treeRows(spots);
  const made = new Map<string, SpaceNode>();
  const roots: SpaceNode[] = [];
  for (const r of rows) {
    const node: SpaceNode = { level: r.spot.level, code: r.spot.code, label: r.spot.label.trim(), deadEnd: false, children: [] };
    made.set(r.spot.id, node);
    const parent = r.depth > 0 && r.spot.parent_id ? made.get(r.spot.parent_id) : null;
    if (parent) parent.children.push(node);
    else if (!rootId || r.spot.id === rootId) roots.push(node);
  }
  return { name, notes: [], roots, starts: [], links: [] };
}

/** Each spot of the file beside the shelf-map spot with the same joined code, if there is one. */
function pair(map: SpaceMap, spots: Spot[]): Array<{ node: SpaceNode; path: string; parentPath: string | null; index: number; spot: Spot | null }> {
  const byParent = new Map<string, Spot>();
  for (const s of spots) byParent.set(`${s.parent_id ?? ""}/${s.code}`, s);
  const out: Array<{ node: SpaceNode; path: string; parentPath: string | null; index: number; spot: Spot | null }> = [];
  const walk = (nodes: SpaceNode[], parentPath: string | null, parent: Spot | null, parentIsNew: boolean) => {
    nodes.forEach((node, index) => {
      const spot = parentIsNew ? null : (byParent.get(`${parent?.id ?? ""}/${node.code}`) ?? null);
      const path = parentPath ? `${parentPath}-${node.code}` : node.code;
      out.push({ node, path, parentPath, index, spot });
      walk(node.children, path, spot, !spot);
    });
  };
  walk(map.roots, null, null, false);
  return out;
}

export type ApplyPlan = {
  /** Rows to write to the shelf map: new spots and spots whose level, name or order changed. */
  rows: Spot[];
  adds: number;
  changes: number;
  same: number;
  /** Spots already on the shelf map under this file's locations that the file does not name. They are left alone. */
  extra: number;
};

/**
 * What putting the file on the shelf map would do. Spots are matched by their
 * joined code. Nothing is ever removed: a spot the file leaves out stays as it
 * is, and so does every part's place.
 */
export function planApply(map: SpaceMap, spots: Spot[], newId: () => string): ApplyPlan {
  const pairs = pair(map, spots);
  const idAt = new Map<string, string>();
  const plan: ApplyPlan = { rows: [], adds: 0, changes: 0, same: 0, extra: 0 };
  const named = new Set<string>();
  for (const p of pairs) {
    const sort = (p.index + 1) * 10;
    const parentId = p.parentPath ? idAt.get(p.parentPath)! : null;
    if (!p.spot) {
      const id = newId();
      idAt.set(p.path, id);
      plan.rows.push({ id, parent_id: parentId, level: p.node.level, code: p.node.code, label: p.node.label, sort });
      plan.adds++;
      continue;
    }
    idAt.set(p.path, p.spot.id);
    named.add(p.spot.id);
    const label = p.node.label || p.spot.label; // a file with no name for a spot keeps the name it has
    if (p.spot.level !== p.node.level || p.spot.label !== label || p.spot.sort !== sort) {
      plan.rows.push({ ...p.spot, level: p.node.level, label, sort });
      plan.changes++;
    } else {
      plan.same++;
    }
  }
  const rootIds = new Set(pairs.filter((p) => !p.parentPath && p.spot).map((p) => p.spot!.id));
  const byId = new Map(spots.map((s) => [s.id, s]));
  for (const r of treeRows(spots)) {
    let top: Spot | undefined = r.spot;
    for (let guard = 0; top?.parent_id && guard < MAX_DEPTH; guard++) top = byId.get(top.parent_id);
    if (top && rootIds.has(top.id) && !named.has(r.spot.id)) plan.extra++;
  }
  return plan;
}

/** What the pick walk needs from the files on the shelf map, in shelf-map spot ids. */
export type WalkPlan = {
  links: Array<{ a: string; b: string; effort: Effort; via: string }>;
  deadEnds: Set<string>;
  /** Where picks begin and end, by the id of the location (top spot) it belongs to. */
  starts: Map<string, { spot_id: string; label: string }>;
};

export const NO_WALK_PLAN: WalkPlan = { links: [], deadEnds: new Set(), starts: new Map() };

/**
 * The start points, links and dead ends of the files, matched to today's shelf
 * map by joined code. Anything naming a spot that has since been removed or
 * recoded is skipped (and counted in `lost`).
 */
export function walkPlan(maps: SpaceMap[], spots: Spot[]): WalkPlan & { lost: number } {
  const plan: WalkPlan & { lost: number } = { links: [], deadEnds: new Set(), starts: new Map(), lost: 0 };
  for (const map of maps) {
    const idAt = new Map<string, string>();
    for (const p of pair(map, spots)) {
      if (!p.spot) continue;
      idAt.set(p.path, p.spot.id);
      if (p.node.deadEnd) plan.deadEnds.add(p.spot.id);
    }
    for (const s of map.starts) {
      const id = idAt.get(s.at);
      const root = idAt.get(s.at.split("-")[0]);
      if (!id || !root) plan.lost++;
      else if (!plan.starts.has(root)) plan.starts.set(root, { spot_id: id, label: s.label || nameAt(map, s.at) });
    }
    for (const l of map.links) {
      const a = idAt.get(l.a);
      const b = idAt.get(l.b);
      if (!a || !b) plan.lost++;
      else plan.links.push({ a, b, effort: l.effort, via: l.via });
    }
  }
  return plan;
}

// --- One file per location ----------------------------------------------------
// A layout file belongs to one store location. On the shelf map it may read
// and write only that location's own top spot and what is inside it, so one
// dealer's file can never touch another dealer's shelves.

/** A shelf-map spot with the store location it is the top spot of (top spots only). */
export type BoundSpot = Spot & { location_id: string | null };

export type Scope =
  | { ok: true; spots: BoundSpot[]; rootId: string | null; /** The top spot exists with no location yet, and gets this one. */ adopt: boolean }
  | { ok: false; message: string };

/** What is wrong with a file as the file of the location with this code, or null. */
export function fileProblem(map: SpaceMap, code: string): string | null {
  if (!code) return "This location has no short code yet. It needs one before it can be mapped.";
  if (map.roots.length !== 1 || map.roots[0].code !== code) {
    return `This file maps one location, so it has one top line, with this location's code: Location ${code}.`;
  }
  return null;
}

/**
 * The part of the shelf map the file of one location may use: the top spot
 * tied to the location and everything inside it. A top spot with the same code
 * and no location yet may be taken over only when `mayAdopt` (the back office).
 */
export function locationScope(spots: BoundSpot[], location: { id: string; code: string }, mayAdopt: boolean): Scope {
  const inside = (rootId: string): BoundSpot[] => {
    const kids = new Map<string, BoundSpot[]>();
    for (const s of spots) if (s.parent_id) (kids.get(s.parent_id) ?? kids.set(s.parent_id, []).get(s.parent_id)!).push(s);
    const out: BoundSpot[] = [];
    const todo = spots.filter((s) => s.id === rootId);
    for (let guard = 0; todo.length && guard < 100_000; guard++) {
      const s = todo.pop()!;
      out.push(s);
      todo.push(...(kids.get(s.id) ?? []));
    }
    return out;
  };
  const bound = spots.find((s) => !s.parent_id && s.location_id === location.id);
  if (bound) {
    if (bound.code !== location.code) {
      return { ok: false, message: `This location's shelf map uses the code ${bound.code}, but the location's code is now ${location.code || "blank"}. Set them the same first.` };
    }
    return { ok: true, spots: inside(bound.id), rootId: bound.id, adopt: false };
  }
  const sameCode = spots.find((s) => !s.parent_id && s.code === location.code);
  if (!sameCode) return { ok: true, spots: [], rootId: null, adopt: false };
  if (sameCode.location_id || !mayAdopt) {
    return { ok: false, message: `The code ${location.code} is already in use on the shelf map. This location needs a different short code before it can go on.` };
  }
  return { ok: true, spots: inside(sameCode.id), rootId: sameCode.id, adopt: true };
}
