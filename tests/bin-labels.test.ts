import assert from "node:assert/strict";
import { test } from "node:test";
import { SHEETS, binLabels, fitsLetter, pagesOf, sheetById } from "../lib/bin-labels.ts";
import type { Spot } from "../lib/shelf.ts";

const s = (id: string, parent_id: string | null, level: string, code: string, sort = 0): Spot => ({ id, parent_id, level, code, label: "", sort });
const spots: Spot[] = [
  s("mcd", null, "Location", "MCD", 2),
  s("a", "mcd", "Aisle", "A", 1),
  s("a1", "a", "Bin", "1", 1),
  s("a2", "a", "Bin", "2", 2),
  s("b", "mcd", "Aisle", "B", 2),
  s("main", null, "Location", "MAIN", 1),
  s("m1", "main", "Bin", "7", 1),
];

test("every spot gets a label, in shelf order, and bins are marked as bins", () => {
  const all = binLabels(spots);
  assert.deepEqual(all.map((l) => [l.code, l.leaf, l.top]), [
    ["MAIN", false, "main"],
    ["MAIN-7", true, "main"],
    ["MCD", false, "mcd"],
    ["MCD-A", false, "mcd"],
    ["MCD-A-1", true, "mcd"],
    ["MCD-A-2", true, "mcd"],
    ["MCD-B", true, "mcd"],
  ]);
  assert.equal(all.find((l) => l.code === "MCD-A-2")?.line, "Location MCD, Aisle A, Bin 2");
});

test("a dealer gets only the spots under its own locations", () => {
  const mine = binLabels(spots, new Set(["mcd"]));
  assert.ok(mine.length === 5 && mine.every((l) => l.code.startsWith("MCD")));
  assert.deepEqual(binLabels(spots, new Set()), []);
});

test("sheets fit the paper, and labels fill them in order with room to skip used places", () => {
  assert.ok(SHEETS.every(fitsLetter), "every layout fits US letter paper");
  assert.equal(sheetById("shipping").cols, 2);
  assert.equal(sheetById("nope").id, "address");
  const address = sheetById("address");
  const labels = Array.from({ length: 65 }, (_, i) => i);
  const pages = pagesOf(labels, address);
  assert.deepEqual(pages.map((p) => p.length), [30, 30, 5]);
  const skipped = pagesOf(labels, address, 28);
  assert.deepEqual(skipped.map((p) => p.length), [30, 30, 30, 3]);
  assert.deepEqual(skipped[0].slice(26, 30), [null, null, 0, 1], "blank places first, then the labels");
  assert.deepEqual(pagesOf([], address, 5), [], "nothing to print makes no sheets");
  assert.equal(pagesOf(labels, address, 999)[0].filter((x) => x === null).length, 29, "a sheet is never skipped whole");
});
