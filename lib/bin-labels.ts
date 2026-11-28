// Bin labels: which spots get a printed label, and how the sheets are laid
// out. A label carries the spot's code as text and as a bar code, and the
// spot's plain-words line. Pure, so the rules can be tested.
import { canEncode } from "./code128.ts";
import { treeRows, type Spot } from "./shelf.ts";

export type BinLabel = {
  id: string;
  /** "MCD-A-03-2": printed big, and what the bar code says. */
  code: string;
  /** "McCormick shop, Aisle A, Section 03, Bin 2" */
  line: string;
  /** The top spot this one sits under (a location's shelf map). */
  top: string;
  /** True when nothing sits under it: the bins themselves, not the aisles above them. */
  leaf: boolean;
};

/**
 * Every spot that can carry a label, in shelf order. `tops`, when given,
 * keeps only spots under those top spots (a dealer's own locations).
 */
export function binLabels(spots: Spot[], tops?: Set<string>): BinLabel[] {
  const parents = new Set(spots.map((s) => s.parent_id).filter((p): p is string => !!p));
  const out: BinLabel[] = [];
  let top = "";
  for (const row of treeRows(spots)) {
    if (row.depth === 0) top = row.spot.id;
    if (tops && !tops.has(top)) continue;
    if (!canEncode(row.code)) continue;
    out.push({ id: row.spot.id, code: row.code, line: row.line, top, leaf: !parents.has(row.spot.id) });
  }
  return out;
}

/** A sheet layout, in inches, for US letter paper. */
export type Sheet = { id: string; name: string; note: string; cols: number; rows: number; width: number; height: number; gapX: number; gapY: number; marginTop: number; marginSide: number };

export const SHEETS: Sheet[] = [
  { id: "address", name: "Address labels, 30 to a sheet", note: "1 by 2⅝ inch labels, three across and ten down (the common 5160 layout).", cols: 3, rows: 10, width: 2.625, height: 1, gapX: 0.125, gapY: 0, marginTop: 0.5, marginSide: 0.1875 },
  { id: "shipping", name: "Large labels, 10 to a sheet", note: "2 by 4 inch labels, two across and five down (the common 5163 layout).", cols: 2, rows: 5, width: 4, height: 2, gapX: 0.1875, gapY: 0, marginTop: 0.5, marginSide: 0.15625 },
  { id: "plain", name: "Plain paper, cut apart", note: "Two across and seven down on plain paper or a full-sheet label, with lines to cut along.", cols: 2, rows: 7, width: 3.75, height: 1.4, gapX: 0, gapY: 0, marginTop: 0.5, marginSide: 0.5 },
];

export function sheetById(id: string | null | undefined): Sheet {
  return SHEETS.find((s) => s.id === id) ?? SHEETS[0];
}

/** Labels split into sheets, with `skip` blank places first so a part-used sheet can go back in the printer. */
export function pagesOf<T>(labels: T[], sheet: Sheet, skip = 0): Array<Array<T | null>> {
  const per = sheet.cols * sheet.rows;
  const blanks = Math.min(Math.max(0, Math.floor(skip) || 0), per - 1);
  const all: Array<T | null> = [...Array.from({ length: blanks }, () => null), ...labels];
  const pages: Array<Array<T | null>> = [];
  for (let i = 0; i < all.length; i += per) pages.push(all.slice(i, i + per));
  return labels.length ? pages : [];
}

/** True when a sheet fits on US letter paper (8.5 by 11 inches) with its margins. */
export function fitsLetter(s: Sheet): boolean {
  const w = s.marginSide * 2 + s.cols * s.width + (s.cols - 1) * s.gapX;
  const h = s.marginTop + s.rows * s.height + (s.rows - 1) * s.gapY;
  return w <= 8.5 + 1e-9 && h <= 11 + 1e-9;
}
