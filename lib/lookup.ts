// Finding a part fast at the counter or the shelf: by a scanned or typed
// number (our part number, a UPC, a number it replaces), by a bin code, by a
// few words, or from what a photo says. Also what tends to go with a part:
// the other parts in its bin and the parts sold with it before. No database
// or network here, so the rules can be tested.

import { prepareWords, termTier, type Words } from "./words.ts";

export type LookupPart = { id: string; name: string; part_number: string };
/** Another number a part answers to: a UPC, an OEM number, a number it replaces. */
export type LookupCode = { norm: string; product_id: string; label: string };
/** A bin (or any shelf spot) and every part kept in it. One bin can hold several parts. */
export type LookupBin = { code: string; line: string; product_ids: string[] };
export type LookupIndex = { codes: LookupCode[]; bins: LookupBin[]; pairs: Record<string, string[]> };
export const EMPTY_INDEX: LookupIndex = { codes: [], bins: [], pairs: {} };

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * A number as it is compared: letters and digits only, and for all-digit
 * codes no leading zeros, so a 12-digit UPC and the same code scanned as 13
 * digits are one number.
 */
export const codeKey = (s: string) => {
  const n = norm(s);
  return /^\d+$/.test(n) ? n.replace(/^0+(?=\d)/, "") : n;
};

export type Exact = { kind: "part"; ids: string[]; because: string } | { kind: "bin"; bin: LookupBin } | null;

/**
 * What a scan (or a typed number and Enter) means, exactly: our own part
 * number first, then any other number the part answers to, then a bin code.
 * Null when nothing matches the whole code.
 */
export function exactLookup(query: string, parts: LookupPart[], index: LookupIndex): Exact {
  const key = codeKey(query);
  if (key.length < 2) return null;
  const own = parts.filter((p) => p.part_number && codeKey(p.part_number) === key).map((p) => p.id);
  if (own.length) return { kind: "part", ids: own, because: "" };
  const known = new Set(parts.map((p) => p.id));
  const hits = index.codes.filter((c) => codeKey(c.norm) === key && known.has(c.product_id));
  if (hits.length) return { kind: "part", ids: [...new Set(hits.map((c) => c.product_id))], because: hits[0].label };
  const bin = index.bins.find((b) => codeKey(b.code) === key);
  return bin ? { kind: "bin", bin } : null;
}

/** True when two words are the same or one typing slip apart (one letter wrong, missing, extra or swapped). */
export function nearWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const [ra, rb] = [a.slice(i), b.slice(i)];
  if (ra.length === rb.length) return ra.slice(1) === rb.slice(1) || (ra.length > 1 && ra[0] === rb[1] && ra[1] === rb[0] && ra.slice(2) === rb.slice(2));
  return ra.length > rb.length ? ra.slice(1) === rb : rb.slice(1) === ra;
}

export type Found = { id: string; score: number; because: string };

const preparedParts = new WeakMap<LookupPart, { key: string; w: Words }>();
function wordsFor(p: LookupPart): Words {
  const key = `${p.name} ${p.part_number}`;
  const had = preparedParts.get(p);
  if (had && had.key === key) return had.w;
  const w = prepareWords(key);
  preparedParts.set(p, { key, w });
  return w;
}

const wordsOf = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Ranked matches as someone types. Numbers are compared with punctuation
 * taken out and can match anywhere in a part number; words must all be in
 * the name (a typing slip in a longer word is forgiven). Ties go to the part
 * that is on this shelf.
 */
export function smartSearch(query: string, parts: LookupPart[], index: LookupIndex, shelf?: (id: string) => number | undefined, limit = 8): Found[] {
  const q = query.trim();
  if (!q) return [];
  const key = codeKey(q);
  const terms = wordsOf(q);
  const byPart = new Map<string, LookupCode[]>();
  for (const c of index.codes) byPart.set(c.product_id, [...(byPart.get(c.product_id) ?? []), c]);
  const out: Found[] = [];
  for (const p of parts) {
    let score = 0;
    let because = "";
    const own = codeKey(p.part_number);
    if (key.length >= 2) {
      if (own && own === key) score = 100;
      else if (own && own.startsWith(key)) score = 70;
      else if (own && key.length >= 3 && own.includes(key)) score = 45;
      for (const c of byPart.get(p.id) ?? []) {
        const k = codeKey(c.norm);
        const s = k === key ? 90 : k.startsWith(key) && key.length >= 3 ? 60 : 0;
        if (s > score) [score, because] = [s, c.label];
      }
    }
    if (terms.length) {
      // The same forgiving word match as the shop's search box: "oring" finds "O-ring", "plugs" finds "plug".
      const w = wordsFor(p);
      const worst = Math.min(...terms.map((t) => termTier(w, t)));
      const whole = worst >= 2;
      const close = worst === 1;
      const s = whole ? ([...w.tokens].some((h) => h.startsWith(terms[0])) || w.joins.has(terms[0]) ? 35 : 30) : close ? 15 : 0;
      if (s > score) [score, because] = [s, close ? "Close spelling" : ""];
    }
    if (score) out.push({ id: p.id, score, because });
  }
  const have = (id: string) => shelf?.(id) ?? 0;
  const name = new Map(parts.map((p) => [p.id, p.name]));
  return out.sort((a, b) => b.score - a.score || have(b.id) - have(a.id) || (name.get(a.id) ?? "").localeCompare(name.get(b.id) ?? "")).slice(0, limit);
}

/**
 * Parts that were sold together: for each part, the parts most often on the
 * same sale. A pair counts only once it has happened `min` times, so one
 * odd sale doesn't become a suggestion.
 */
export function soldTogether(baskets: string[][], min = 2, top = 3): Record<string, string[]> {
  const counts = new Map<string, Map<string, number>>();
  for (const basket of baskets) {
    const ids = [...new Set(basket)].slice(0, 40);
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        const row = counts.get(a) ?? new Map<string, number>();
        row.set(b, (row.get(b) ?? 0) + 1);
        counts.set(a, row);
      }
    }
  }
  const out: Record<string, string[]> = {};
  for (const [a, row] of counts) {
    const best = [...row].filter(([, n]) => n >= min).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, top).map(([id]) => id);
    if (best.length) out[a] = best;
  }
  return out;
}

/** What goes with a part: its bin and the other parts in it, and what sold with it before. */
export function goesWith(id: string, index: LookupIndex, skip: Set<string> = new Set()): { bin: LookupBin | null; sameBin: string[]; soldWith: string[] } {
  const bin = index.bins.find((b) => b.product_ids.includes(id)) ?? null;
  const sameBin = (bin?.product_ids ?? []).filter((x) => x !== id && !skip.has(x));
  const soldWith = (index.pairs[id] ?? []).filter((x) => x !== id && !skip.has(x) && !sameBin.includes(x));
  return { bin, sameBin, soldWith };
}

/** What a photo was read to say. A computer's reading: always shown as a guess to check. */
export type PhotoRead = { part_number: string; other_numbers: string[]; upc: string; description: string };
export type PhotoMatch = { id: string; why: "number" | "words"; because: string };

/** Parts a photo's reading points to: an exact number first; otherwise the closest names. */
export function photoMatches(read: PhotoRead, parts: LookupPart[], index: LookupIndex): PhotoMatch[] {
  const out: PhotoMatch[] = [];
  const seen = new Set<string>();
  for (const [n, label] of [[read.part_number, "part number"], [read.upc, "barcode number"], ...read.other_numbers.map((x) => [x, "number"] as const)] as Array<readonly [string, string]>) {
    const hit = n ? exactLookup(n, parts, index) : null;
    if (hit?.kind !== "part") continue;
    for (const id of hit.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, why: "number", because: `The ${label} ${n} matches` });
    }
  }
  if (out.length) return out.slice(0, 5);
  return smartSearch(read.description, parts, index, undefined, 3)
    .filter((f) => f.score >= 30)
    .map((f) => ({ id: f.id, why: "words" as const, because: "The name looks alike" }));
}
