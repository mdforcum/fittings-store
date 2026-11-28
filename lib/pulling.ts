// Pulling an order at a dealer: which parts are checked off, what a scan
// means while pulling, and the order to walk the bins in. Pure, so the page
// and the tests agree.
import { codeKey, type LookupIndex, type LookupPart } from "./lookup.ts";

export type Bin = { code: string; line: string };

/** One part to pull for an order at one location. */
export type PullLine = {
  product_id: string;
  name: string;
  part_number: string;
  qty: number;
  /** How many are checked off so far. */
  picked: number;
  /** Who checked off the last one. */
  picked_name?: string;
  location_id: string;
  /** Where it sits on the shelf map, when it has a spot. */
  bin: Bin | null;
};

export const pulled = (l: Pick<PullLine, "qty" | "picked">) => l.picked >= l.qty;

/** How far along a set of lines is. */
export function pullProgress(lines: Array<Pick<PullLine, "qty" | "picked">>): { need: number; have: number; done: boolean } {
  const need = lines.reduce((n, l) => n + l.qty, 0);
  const have = lines.reduce((n, l) => n + Math.min(l.picked, l.qty), 0);
  return { need, have, done: need > 0 && have >= need };
}

/** The walk: bins in shelf order (A-2 before A-10), parts with no bin last, then by name. */
export function pullOrder<T extends Pick<PullLine, "bin" | "name">>(lines: T[]): T[] {
  return [...lines].sort((a, b) => {
    if (!a.bin !== !b.bin) return a.bin ? -1 : 1;
    return (a.bin?.code ?? "").localeCompare(b.bin?.code ?? "", "en", { numeric: true }) || a.name.localeCompare(b.name);
  });
}

export type ScanResult =
  /** A part on this order: check one more off. `picked` is the new count. */
  | { kind: "picked"; product_id: string; name: string; picked: number; qty: number }
  /** A part on this order that is already fully checked off. */
  | { kind: "full"; name: string; qty: number }
  /** A real part, but not one this order needs from here. */
  | { kind: "wrong"; name: string; part_number: string }
  /** A bin label: what this order needs from that bin. */
  | { kind: "bin"; code: string; lines: PullLine[] }
  | { kind: "unknown" };

/**
 * What a scanned or typed code means while pulling these lines. A part's own
 * number, any other number it answers to (a UPC, a number it replaces) or a
 * bin label. `catalog`, when given, lets a wrong part be named.
 */
export function scanForPull(code: string, lines: PullLine[], index: LookupIndex, catalog: LookupPart[] = []): ScanResult {
  const key = codeKey(code);
  if (key.length < 2) return { kind: "unknown" };
  const ids = new Set(lines.map((l) => l.product_id));
  const byCode = new Set(index.codes.filter((c) => codeKey(c.norm) === key).map((c) => c.product_id));
  const hits = lines.filter((l) => (l.part_number && codeKey(l.part_number) === key) || byCode.has(l.product_id));
  if (hits.length) {
    const next = hits.find((l) => !pulled(l));
    if (!next) return { kind: "full", name: hits[0].name, qty: hits[0].qty };
    return { kind: "picked", product_id: next.product_id, name: next.name, picked: next.picked + 1, qty: next.qty };
  }
  const binCode = lines.find((l) => l.bin && codeKey(l.bin.code) === key)?.bin?.code ?? index.bins.find((b) => codeKey(b.code) === key)?.code;
  if (binCode) return { kind: "bin", code: binCode, lines: lines.filter((l) => l.bin && codeKey(l.bin.code) === key) };
  const other = catalog.find((p) => !ids.has(p.id) && ((p.part_number && codeKey(p.part_number) === key) || byCode.has(p.id)));
  if (other) return { kind: "wrong", name: other.name, part_number: other.part_number };
  if ([...byCode].some((id) => !ids.has(id))) return { kind: "wrong", name: "", part_number: "" };
  return { kind: "unknown" };
}

/** What to say after a scan, and whether it is a warning. */
export function scanSay(r: ScanResult, orderNumber: number): { text: string; bad: boolean } {
  switch (r.kind) {
    case "picked":
      return { text: r.picked >= r.qty ? `${r.name}: got ${r.qty === 1 ? "it" : `all ${r.qty}`}.` : `${r.name}: ${r.picked} of ${r.qty}.`, bad: false };
    case "full":
      return { text: `${r.name}: you already have ${r.qty === 1 ? "it" : `all ${r.qty}`}. Put the extra back.`, bad: true };
    case "wrong":
      return { text: `Wrong part. ${r.name ? `That is ${r.part_number ? `${r.part_number} ` : ""}${r.name}. It` : "That part"} isn't on order #${orderNumber}. Put it back.`, bad: true };
    case "bin":
      return r.lines.length
        ? { text: `Bin ${r.code}. Take: ${r.lines.map((l) => `${l.qty - Math.min(l.picked, l.qty) || l.qty} × ${l.name}${pulled(l) ? " (already pulled)" : ""}`).join(", ")}.`, bad: false }
        : { text: `Bin ${r.code}: nothing on order #${orderNumber} is kept there.`, bad: true };
    default:
      return { text: "That code isn't a part or a bin here. Check the label, or tick the part by hand.", bad: true };
  }
}
