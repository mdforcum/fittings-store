import assert from "node:assert/strict";
import { test } from "node:test";
import {
  codeTaken,
  findIt,
  moveProblem,
  nextLevel,
  normCode,
  normLevel,
  spotPath,
  treeRows,
  type Spot,
  MAX_DEPTH,
} from "../lib/shelf.ts";

const s = (id: string, parent_id: string | null, level: string, code: string, label = "", sort = 0): Spot => ({
  id,
  parent_id,
  level,
  code,
  label,
  sort,
});

const SPOTS: Spot[] = [
  s("loc", null, "Location", "EFF", "Effingham store"),
  s("b1", "loc", "Building", "1", "Main building"),
  s("a105", "b1", "Area", "105", "Upstairs backstock"),
  s("ai07", "a105", "Aisle", "07"),
  s("se3", "ai07", "Section", "3"),
  s("bin12", "se3", "Bin", "12"),
  s("subB", "bin12", "Divider", "B"),
];

test("a part's spot prints one line and one joined code", () => {
  assert.deepEqual(findIt(SPOTS, "subB"), {
    line: "Effingham store, Main building, Upstairs backstock, Aisle 07, Section 3, Bin 12, Divider B",
    code: "EFF-1-105-07-3-12-B",
  });
  assert.deepEqual(findIt(SPOTS, "ai07"), {
    line: "Effingham store, Main building, Upstairs backstock, Aisle 07",
    code: "EFF-1-105-07",
  });
});

test("no spot, an unknown spot or a broken chain prints nothing", () => {
  assert.equal(findIt(SPOTS, null), null);
  assert.equal(findIt(SPOTS, "nope"), null);
  assert.equal(findIt([s("x", "gone", "Bin", "1")], "x"), null);
  const loop = [s("p", "q", "Aisle", "1"), s("q", "p", "Bin", "2")];
  assert.deepEqual(spotPath(loop, "p"), []);
});

test("codes are letters and digits, upper-cased, 1 to 6 long", () => {
  assert.equal(normCode(" eff "), "EFF");
  assert.equal(normCode("1 05"), "105");
  assert.equal(normCode(""), null);
  assert.equal(normCode("A-1"), null);
  assert.equal(normCode("ABCDEFG"), null);
  assert.equal(normLevel("  Paint   room "), "Paint room");
  assert.equal(normLevel(""), null);
  assert.equal(normLevel("x".repeat(25)), null);
});

test("a new child is offered the next level word", () => {
  assert.equal(nextLevel(null), "Location");
  assert.equal(nextLevel(SPOTS[0]), "Building");
  assert.equal(nextLevel(SPOTS[5]), "Sub-bin");
  assert.equal(nextLevel(SPOTS[6]), "Sub-bin"); // a dealer's own word: more sub-bins
});

test("a spot can't move inside itself, under a missing parent, or past the depth limit", () => {
  assert.equal(moveProblem(SPOTS, "ai07", null), null);
  assert.equal(moveProblem(SPOTS, "ai07", "b1"), null);
  assert.match(moveProblem(SPOTS, "ai07", "ai07")!, /inside itself/);
  assert.match(moveProblem(SPOTS, "ai07", "bin12")!, /inside itself/);
  assert.match(moveProblem(SPOTS, null, "gone")!, /no longer exists/);
  // A chain of MAX_DEPTH spots: nothing more fits under its last one.
  const chain: Spot[] = Array.from({ length: MAX_DEPTH }, (_, i) => s(`c${i}`, i ? `c${i - 1}` : null, "Bin", String(i)));
  assert.match(moveProblem(chain, null, `c${MAX_DEPTH - 1}`)!, /levels deep/);
  assert.equal(moveProblem(chain, null, `c${MAX_DEPTH - 2}`), null);
});

test("codes are unique among siblings only", () => {
  assert.equal(codeTaken(SPOTS, "b1", "105"), true);
  assert.equal(codeTaken(SPOTS, "b1", "105", "a105"), false);
  assert.equal(codeTaken(SPOTS, "a105", "105"), false);
});

test("the tree lists parents before children, siblings by sort then number", () => {
  const spots = [...SPOTS, s("ai2", "a105", "Aisle", "2"), s("ai10", "a105", "Aisle", "10"), s("dock", "b1", "Area", "200", "Loading dock", -1)];
  const rows = treeRows(spots);
  assert.deepEqual(
    rows.map((r) => `${"  ".repeat(r.depth)}${r.code}`),
    [
      "EFF",
      "  EFF-1",
      "    EFF-1-200",
      "    EFF-1-105",
      "      EFF-1-105-2",
      "      EFF-1-105-07",
      "        EFF-1-105-07-3",
      "          EFF-1-105-07-3-12",
      "            EFF-1-105-07-3-12-B",
      "      EFF-1-105-10",
    ],
  );
  // A spot whose parent is gone shows at the top, not lost.
  assert.equal(treeRows([s("orphan", "gone", "Bin", "9")])[0].code, "9");
});
