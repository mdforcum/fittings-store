import assert from "node:assert/strict";
import { test } from "node:test";
import type { Spot } from "../lib/shelf.ts";
import { NO_WALK_PLAN, parseSpaceMap, walkPlan } from "../lib/spacemap.ts";
import { effortFrom, shortestRound, tour, walkGraph } from "../lib/walk.ts";

const s = (id: string, parent_id: string | null, level: string, code: string, sort = 0): Spot => ({ id, parent_id, level, code, label: "", sort });

// A parts room with five aisles, an upstairs reached by stairs at the end of
// aisle 4, and a paint room through a door beside aisle 1.
const SPOTS: Spot[] = [
  s("loc", null, "Location", "MCD"),
  s("b1", "loc", "Building", "1"),
  s("room", "b1", "Area", "100", 10),
  s("a1", "room", "Aisle", "01", 10),
  s("a2", "room", "Aisle", "02", 20),
  s("a3", "room", "Aisle", "03", 30),
  s("a4", "room", "Aisle", "04", 40),
  s("a5", "room", "Aisle", "05", 50),
  s("up", "b1", "Area", "105", 20),
  s("upA", "up", "Shelf", "A", 10),
  s("paint", "b1", "Area", "110", 30),
  s("paintA", "paint", "Shelf", "A", 10),
];
const FILE = `spacemap 1
Location MCD
  Building 1
    Area 100
      Aisle 01..05
    Area 105
      Shelf A
    Area 110
      Shelf A
start: MCD-1-100 "Parts counter"
link: MCD-1-100-04 <> MCD-1-105 far "Stairs at the end of aisle 4"
link: MCD-1-100-01 <> MCD-1-110 walk "Door beside aisle 1"
`;
const plan = () => walkPlan([parseSpaceMap(FILE).map], SPOTS);

test("with no layout file the stops stay in shelf-map order", () => {
  assert.deepEqual(tour(SPOTS, ["a1", "a3", "up", "paint"], NO_WALK_PLAN), [{ order: ["a1", "a3", "up", "paint"], start: null }]);
  assert.deepEqual(tour(SPOTS, [], plan()), []);
});

test("effort adds up along the way, and a link replaces the guess between two rooms", () => {
  const guess = effortFrom(walkGraph(SPOTS, NO_WALK_PLAN), "room");
  assert.equal(guess.get("a1"), 0, "you come into a room at its first aisle");
  assert.equal(guess.get("a4"), 3, "three aisles over");
  assert.equal(guess.get("up"), 3, "rooms listed one after another are a walk apart");
  assert.equal(guess.get("paint"), 6);
  const said = effortFrom(walkGraph(SPOTS, plan()), "room");
  assert.equal(said.get("up"), 11, "upstairs is now only by the stairs at aisle 4: three aisles, then far");
  assert.equal(said.get("upA"), 11);
  assert.equal(said.get("paint"), 3, "the paint room is through the door beside aisle 1");
});

test("the walk leaves from the start, takes the near things together and comes back", () => {
  const [t] = tour(SPOTS, ["a2", "a5", "up", "paint"], plan());
  assert.deepEqual(t.start, { spot_id: "room", label: "Parts counter" });
  // Paint room off aisle 1 first, then down the aisles, upstairs from aisle 4 last... or the mirror image.
  // Counter > paint (3) > a2 (4) > a5 (3) > up (9) > counter (11) = 30 either way round; the shelf-map order wins the tie.
  assert.deepEqual(t.order, ["a2", "a5", "up", "paint"]);
  // Now put the stairs beside the counter (aisle 1) and the paint room door at aisle 5. In shelf-map
  // order the picker would climb the stairs from aisle 5 and come back down for the paint room.
  const moved = walkPlan(
    [parseSpaceMap(FILE.replace("MCD-1-100-04 <> MCD-1-105", "MCD-1-100-01 <> MCD-1-105").replace("MCD-1-100-01 <> MCD-1-110", "MCD-1-100-05 <> MCD-1-110")).map],
    SPOTS,
  );
  const [m] = tour(SPOTS, ["a2", "a5", "up", "paint"], moved);
  assert.deepEqual(m.order, ["a2", "a5", "paint", "up"], "the paint room while at aisle 5, the stairs on the way back to the counter");
});

test("each location is walked on its own", () => {
  const two = [...SPOTS, s("eff", null, "Location", "EFF"), s("e1", "eff", "Aisle", "01", 10), s("e2", "eff", "Aisle", "02", 20)];
  const tours = tour(two, ["a1", "up", "e1", "e2"], plan());
  assert.deepEqual(tours.map((t) => [t.order, t.start?.label ?? null]), [
    [["a1", "up"], "Parts counter"],
    [["e1", "e2"], null],
  ]);
});

test("the shortest round: exact for a few stops, untangled for many", () => {
  // Points on a line at 0, 5, 1, 4, 2, 3: the best walk out and back visits them in line order.
  const at = [0, 5, 1, 4, 2, 3];
  const d = at.map((a) => at.map((b) => Math.abs(a - b)));
  assert.deepEqual(shortestRound(d, false), [0, 2, 4, 5, 3, 1]);
  const len = (t: number[], dd: number[][]) => t.reduce((sum, p, i) => sum + dd[p][t[(i + 1) % t.length]], 0);
  assert.equal(len(shortestRound(d, true), d), 10);
  // Twelve stops round a ring, given in a shuffled order: the walk finds the ring.
  const ring = [0, 7, 3, 10, 1, 8, 5, 11, 2, 9, 4, 6];
  const rd = ring.map((a) => ring.map((b) => Math.min(Math.abs(a - b), 12 - Math.abs(a - b))));
  const got = shortestRound(rd, true);
  assert.equal(got[0], 0);
  assert.equal(new Set(got).size, 12);
  assert.equal(len(got, rd), 12);
  assert.deepEqual(shortestRound([[0]], true), [0]);
});
