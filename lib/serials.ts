// Serial runs: which machine, and which part of its production, a serial number
// belongs to. Pure, so the store, the back office and the tests share one rule.
//
// Two shapes of run come from the makers' records:
//   Cat           prefix plus a sequence: "ABC" from ABC00001, open-ended or to a break.
//   Case / IH     a numbered run, often one per build year: 8950152 to 8957500 = 1976.
//                 Some carry letters (JJG0164349, N5C415308); letters must match.
import { numberNorm, serialKey } from "./foundation.ts";

export const CONFIDENCES = [
  { id: "oem", label: "Maker's document" },
  { id: "reference", label: "Reference guide" },
  { id: "seller", label: "Seller list" },
  { id: "single", label: "Single source" },
  { id: "observed", label: "Seen on a machine" },
] as const;
export type Confidence = (typeof CONFIDENCES)[number]["id"];
const RANK: Record<Confidence, number> = { oem: 0, observed: 1, reference: 2, single: 3, seller: 4 };

export type SerialRun = {
  machine_id: string;
  prefix: string;
  serial_from: string;
  serial_to: string;
  year: number | null;
  note: string;
  confidence: Confidence;
};

/**
 * Splits a serial into its lead (everything up to its last letter) and its
 * trailing number: JJG0164349 → JJG + 164349, N5C415308 → N5C + 415308.
 * `width` is how many digits the number is written with, zeros included.
 */
function parts(s: string, prefix: string): { lead: string; n: number; width: number } | null {
  if (prefix) {
    if (!s.startsWith(prefix)) return null;
    const rest = s.slice(prefix.length);
    return /^\d+$/.test(rest) ? { lead: prefix, n: Number(rest), width: rest.length } : null;
  }
  const m = /^(?:(.*[A-Z]))?(\d+)$/.exec(s);
  if (m) return { lead: m[1] ?? "", n: Number(m[2]), width: m[2].length };
  // A plant letter after the number (Ford 021649B, John Deere 134700T) is part of the numbering.
  const t = /^(?:(.*?[A-Z]))?(\d+)([A-Z])$/.exec(s);
  return t ? { lead: `${t[1] ?? ""}*${t[3]}`, n: Number(t[2]), width: t[2].length } : null;
}

/** The digit widths a run's ends are written in, for ends in the serial's own numbering. */
function widths(run: Pick<SerialRun, "serial_from" | "serial_to">, prefix: string, lead: string): number[] {
  return [run.serial_from, run.serial_to].flatMap((end) => {
    const e = numberNorm(end);
    const p = e ? parts(e, prefix) : null;
    return p && p.lead === lead ? [p.width] : [];
  });
}

/** One end of a run, as a number on the serial's own scale, or null when that end is open or unreadable. */
function bound(end: string, prefix: string, lead: string): number | null {
  const e = numberNorm(end);
  if (!e) return null;
  const p = parts(e, prefix);
  if (!p || p.lead !== lead) return null;
  return p.n;
}

/** Whether a serial falls in a run. An open end (blank, or written in another numbering) does not limit it. */
export function inRun(serial: string, run: Pick<SerialRun, "prefix" | "serial_from" | "serial_to">): boolean {
  const s = serialKey(serial);
  if (!s) return false;
  const prefix = numberNorm(run.prefix);
  const p = parts(s, prefix);
  if (!p) return false;
  const fromLead = numberNorm(run.serial_from) ? (parts(numberNorm(run.serial_from), prefix)?.lead ?? null) : null;
  const toLead = numberNorm(run.serial_to) ? (parts(numberNorm(run.serial_to), prefix)?.lead ?? null) : null;
  // Without a prefix, the letters of the run's own ends say which numbering it is in.
  // A run can change numbering partway (17417850 to JJG0006900): either end's letters will do.
  if (!prefix && p.lead !== fromLead && p.lead !== toLead) return false;
  // Serials inside one run keep their width: a 7-digit Case number is not in a 5-digit IH run.
  const w = widths(run, prefix, p.lead);
  if (w.length && !w.includes(p.width)) return false;
  const from = bound(run.serial_from, prefix, p.lead);
  const to = bound(run.serial_to, prefix, p.lead);
  if (from === null && to === null && !prefix) return false;
  if (from !== null && p.n < from) return false;
  if (to !== null && p.n > to) return false;
  return true;
}

export type SerialMatch = {
  machine_id: string;
  year: number | null;
  note: string;
  confidence: Confidence;
};

/**
 * Every machine whose runs take this serial, best evidence first. Where a
 * machine's year runs overlap (an open-ended last year), the run that starts
 * latest at or below the serial wins, which is the year it was built.
 */
export function identifySerial(serial: string, runs: SerialRun[]): SerialMatch[] {
  const s = serialKey(serial);
  const best = new Map<string, { run: SerialRun; start: number }>();
  for (const run of runs) {
    if (!inRun(s, run)) continue;
    const prefix = numberNorm(run.prefix);
    const lead = parts(s, prefix)?.lead ?? "";
    const start = bound(run.serial_from, prefix, lead) ?? -1;
    const had = best.get(run.machine_id);
    if (!had || start > had.start || (start === had.start && RANK[run.confidence] < RANK[had.run.confidence])) {
      best.set(run.machine_id, { run, start });
    }
  }
  return [...best.values()]
    .sort((a, b) => RANK[a.run.confidence] - RANK[b.run.confidence] || b.start - a.start)
    .map(({ run }) => ({ machine_id: run.machine_id, year: run.year, note: run.note, confidence: run.confidence }));
}

/** Plain words for a match, for the counter and the customer. */
export function matchSentence(m: Pick<SerialMatch, "year" | "confidence">, machine: string): string {
  const year = m.year ? `, built in ${m.year}` : "";
  const how = m.confidence === "oem" || m.confidence === "observed" ? "" : " (check the plate to confirm)";
  return `${machine}${year}${how}`;
}
