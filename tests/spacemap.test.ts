import assert from "node:assert/strict";
import { test } from "node:test";
import type { Spot } from "../lib/shelf.ts";
import {
  countSpots,
  expandRange,
  mapFromSpots,
  nameAt,
  nodeAt,
  outlineRows,
  parseSpaceMap,
  planApply,
  printSpaceMap,
  walkPlan,
} from "../lib/spacemap.ts";

const FILE = `spacemap 1
name: McCormick Diesel Service
# Mapped from six photos and the parts manager's notes

Location MCD "McCormick Diesel"
  Building 1 "Main shop"
    Area 100 "Parts room"
      Aisle 01..04
        Section A..C
          Bin 01..12
      Aisle 05 (dead end)
        Bin 01..08
    Area 105 "Upstairs backstock"
      Shelf A..D

start: MCD-1-100 "Parts counter"
link: MCD-1-100-04 <> MCD-1-105 far "Stairs at the end of aisle 4"
`;

test("a layout file reads into spots, a start and links", () => {
  const { map, problems, count } = parseSpaceMap(FILE);
  assert.deepEqual(problems, []);
  assert.equal(map.name, "McCormick Diesel Service");
  assert.deepEqual(map.notes, ["Mapped from six photos and the parts manager's notes"]);
  // 1 location + 1 building + 2 areas + 4 aisles x (1 + 3 sections x (1 + 12 bins)) + aisle 05 (1 + 8) + 4 shelves
  assert.equal(count, 4 + 4 * (1 + 3 * 13) + 9 + 4);
  assert.equal(countSpots(map), count);
  assert.equal(nodeAt(map, "MCD-1-100-03-B-12")?.level, "Bin");
  assert.equal(nodeAt(map, "mcd-1-100-05")?.deadEnd, true);
  assert.equal(nodeAt(map, "MCD-1-100-01")?.deadEnd, false);
  assert.equal(nodeAt(map, "MCD-1-100-06"), null);
  assert.deepEqual(map.starts, [{ at: "MCD-1-100", label: "Parts counter" }]);
  assert.deepEqual(map.links, [{ a: "MCD-1-100-04", b: "MCD-1-105", effort: "far", via: "Stairs at the end of aisle 4" }]);
  assert.equal(nameAt(map, "MCD-1-105"), "Upstairs backstock");
  assert.equal(nameAt(map, "MCD-1-100-04"), "Aisle 04");
});

test("writing the file back gives the same file, ranges and all", () => {
  const { map } = parseSpaceMap(FILE);
  assert.equal(printSpaceMap(map), FILE);
  // Tabs, Windows line ends, code fences, lower case and trailing notes all read the same.
  const messy = "```\r\n" + FILE.replace(/\n/g, "\r\n").replace(/ {2}/g, "\t").replace("Aisle 05 (dead end)", "Aisle 05 (Dead-End)   # past the bench").replace("MCD-1-100-04 <> MCD-1-105", "mcd-1-100-04 <-> mcd-1-105") + "```\r\n";
  const again = parseSpaceMap(messy);
  assert.deepEqual(again.problems, []);
  assert.equal(printSpaceMap(again.map), FILE);
});

test("ranges: padded numbers, plain numbers and letters", () => {
  assert.deepEqual(expandRange("08", "11"), ["08", "09", "10", "11"]);
  assert.deepEqual(expandRange("8", "11"), ["8", "9", "10", "11"]);
  assert.deepEqual(expandRange("b", "d"), ["B", "C", "D"]);
  assert.match(expandRange("12", "3") as string, /backwards/);
  assert.match(expandRange("01", "120") as string, /same number of digits/);
  assert.match(expandRange("A", "12") as string, /one per line/);
  assert.match(expandRange("1", "900") as string, /at most 500/);
});

test("only regular runs print as a range", () => {
  const { map, problems } = parseSpaceMap(`spacemap 1
Location S
  Bin 1
  Bin 2
  Bin 3 "Bolt bin"
  Bin 4
  Bin 5
  Bin 6
  Bin 8
  Bin 9
  Aisle 9A
  Aisle 9B
`);
  assert.deepEqual(problems, []);
  assert.equal(
    printSpaceMap(map),
    `spacemap 1

Location S
  Bin 1
  Bin 2
  Bin 3 "Bolt bin"
  Bin 4..6
  Bin 8
  Bin 9
  Aisle 9A
  Aisle 9B
`,
  );
  assert.deepEqual(
    outlineRows(map).map((r) => [r.depth, r.level, r.from, r.to, r.count, r.code]),
    [
      [0, "Location", "S", "S", 1, "S"],
      [1, "Bin", "1", "1", 1, "S-1"],
      [1, "Bin", "2", "2", 1, "S-2"],
      [1, "Bin", "3", "3", 1, "S-3"],
      [1, "Bin", "4", "6", 3, "S-4"],
      [1, "Bin", "8", "8", 1, "S-8"],
      [1, "Bin", "9", "9", 1, "S-9"],
      [1, "Aisle", "9A", "9A", 1, "S-9A"],
      [1, "Aisle", "9B", "9B", 1, "S-9B"],
    ],
  );
});

test("lines it can't use are named by line number, and the rest still reads", () => {
  const { map, problems } = parseSpaceMap(`spacemap 1
Location MCD "McCormick"
   Aisle 01
      Aisle 02
  Aisle
  Aisle 03 (one way)
  Aisle TOOLONG7
  Aisle 04
  Aisle 04
  Aisle 05..07 "Fasteners"
  Aisle 08
start: MCD-99
start: MCD-08
start: MCD-04
link: MCD-04 <> MCD-08
link: MCD-04 <> MCD-04 near
link: MCD-04 <> MCD-77 near
link: MCD-04 <> MCD-08 walk
link: MCD-08 <> MCD-04 far
`);
  assert.deepEqual(
    problems.map((p) => [p.line, p.text.slice(0, 34)]),
    [
      [3, "Indent with two spaces for each le"],
      [4, "This line is indented too far: a s"],
      [5, "A spot line is a level word, then "],
      [6, '"(one way)" is not something a spo'],
      [7, '"TOOLONG7" is not a code. A code i'],
      [10, "A range of spots can't share one n"],
      [9, "Code 04 is used twice at this leve"],
      [12, "The start is at MCD-99, which is n"],
      [14, "MCD already has a start. A locatio"],
      [15, "Say how far the link is: near (a f"],
      [16, "A link joins two different spots."],
      [17, "The link names MCD-77, which is no"],
      [19, "MCD-08 and MCD-04 are already link"],
    ],
  );
  assert.deepEqual(map.roots[0].children.map((c) => c.code), ["04", "08"]);
  assert.deepEqual(map.starts, [{ at: "MCD-08", label: "" }]);
  assert.deepEqual(map.links, [{ a: "MCD-04", b: "MCD-08", effort: "walk", via: "" }]);
});

test("a file needs its first line, and has a size limit", () => {
  assert.match(parseSpaceMap("Location A\n").problems[0].text, /first line should be "spacemap 1"/);
  assert.match(parseSpaceMap("spacemap 2\nLocation A\n").problems[0].text, /version 1/);
  assert.deepEqual(parseSpaceMap("").problems, []);
  const big = parseSpaceMap(`spacemap 1\nLocation A\n  Aisle 01..20\n    Section 01..20\n      Bin 01..20\n`);
  assert.equal(big.count, 5000);
  assert.match(big.problems[0].text, /at most 5000 spots/);
  assert.equal(big.problems.length, 1);
});

const s = (id: string, parent_id: string | null, level: string, code: string, label = "", sort = 0): Spot => ({ id, parent_id, level, code, label, sort });

test("putting a file on the shelf map adds what is missing and never removes", () => {
  const spots: Spot[] = [
    s("loc", null, "Location", "MCD", "McCormick Diesel", 10),
    s("b1", "loc", "Building", "1", "Shop", 10),
    s("a100", "b1", "Room", "100", "Parts room", 10),
    s("ai2", "a100", "Aisle", "02", "", 10),
    s("old", "a100", "Aisle", "77", "Old rack", 5),
    s("other", null, "Location", "EFF", "Effingham"),
    s("otherA", "other", "Aisle", "01"),
  ];
  const { map } = parseSpaceMap(`spacemap 1
Location MCD "McCormick Diesel"
  Building 1
    Area 100 "Parts room"
      Aisle 01
      Aisle 02
        Bin 1..3
`);
  let n = 0;
  const plan = planApply(map, spots, () => `new${++n}`);
  assert.deepEqual([plan.adds, plan.changes, plan.same, plan.extra], [4, 2, 2, 1]);
  assert.deepEqual(plan.rows, [
    // The room becomes an area; the building keeps the name it had.
    s("a100", "b1", "Area", "100", "Parts room", 10),
    s("new1", "a100", "Aisle", "01", "", 10),
    s("ai2", "a100", "Aisle", "02", "", 20),
    s("new2", "ai2", "Bin", "1", "", 10),
    s("new3", "ai2", "Bin", "2", "", 20),
    s("new4", "ai2", "Bin", "3", "", 30),
  ]);
  // Applying the result again changes nothing.
  const after = [...spots.filter((x) => !plan.rows.some((r) => r.id === x.id)), ...plan.rows];
  const twice = planApply(map, after, () => "never");
  assert.deepEqual([twice.adds, twice.changes, twice.rows.length], [0, 0, 0]);
});

test("the shelf map prints as a file, and the walk plan finds its spots by code", () => {
  const spots: Spot[] = [
    s("loc", null, "Location", "MCD", "McCormick Diesel"),
    s("a1", "loc", "Aisle", "01", "", 10),
    s("a2", "loc", "Aisle", "02", "", 20),
    s("up", "loc", "Area", "UP", "Upstairs", 30),
    s("eff", null, "Location", "EFF"),
  ];
  assert.equal(
    printSpaceMap(mapFromSpots(spots, "Shop", "loc")),
    `spacemap 1\nname: Shop\n\nLocation MCD "McCormick Diesel"\n  Aisle 01\n  Aisle 02\n  Area UP "Upstairs"\n`,
  );
  assert.equal(mapFromSpots(spots).roots.length, 2);
  const { map, problems } = parseSpaceMap(`spacemap 1
Location MCD
  Aisle 01
  Aisle 02 (dead end)
  Aisle 03
  Area UP
start: MCD-01 "Counter"
link: MCD-02 <> MCD-UP far "Stairs"
link: MCD-03 <> MCD-UP near
`);
  assert.deepEqual(problems, []);
  const plan = walkPlan([map], spots);
  assert.deepEqual([...plan.deadEnds], ["a2"]);
  assert.deepEqual([...plan.starts], [["loc", { spot_id: "a1", label: "Counter" }]]);
  assert.deepEqual(plan.links, [{ a: "a2", b: "up", effort: "far", via: "Stairs" }]);
  assert.equal(plan.lost, 1, "aisle 03 is not on the shelf map, so its link is skipped");
});
