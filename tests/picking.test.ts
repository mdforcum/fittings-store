import assert from "node:assert/strict";
import { test } from "node:test";
import { expandParts, routeParts, type PickOrderItem, type PickProduct } from "../lib/picking.ts";
import type { Spot } from "../lib/shelf.ts";

const s = (id: string, parent_id: string | null, level: string, code: string, label = "", sort = 0): Spot => ({ id, parent_id, level, code, label, sort });

// Effingham store, Main building, Aisles 1 and 2 with bins; a back room with no aisles.
const SPOTS: Spot[] = [
  s("loc", null, "Location", "EFF", "Effingham store"),
  s("b1", "loc", "Building", "1", "Main building"),
  s("a1", "b1", "Aisle", "01"),
  s("a1s1", "a1", "Section", "1"),
  s("a1s2", "a1", "Section", "2"),
  s("a1s3", "a1", "Section", "3"),
  s("a2", "b1", "Aisle", "02"),
  s("a2s1", "a2", "Section", "1"),
  s("a2s2", "a2", "Section", "2"),
  s("a2s3", "a2", "Section", "3"),
  s("back", "loc", "Area", "200", "Back room", 5),
  s("shelfA", "back", "Shelf", "A"),
];

const P = (id: string, spot_id: string | null, name = id, part_number = ""): PickProduct => ({ id, name, part_number, spot_id });
const PRODUCTS = [
  P("cap", "a1s3", "JIC cap", "830-08"),
  P("tee", "a1s1", "JIC tee"),
  P("filter", "a2s1", "Hydraulic filter", "PT-9"),
  P("hose", "a2s3", "Hose end"),
  P("seal", "shelfA", "Seal kit 580"),
  P("loose", null, "Loose bolt"),
  P("pkg", null, "580 cylinder package"),
];
const item = (id: number, order_number: number, product_id: string, qty: number): PickOrderItem => ({
  id,
  order_id: `o${order_number}`,
  order_number,
  product_id,
  name: PRODUCTS.find((p) => p.id === product_id)!.name,
  part_number: "",
  qty,
});

test("the walk goes aisle by aisle, up one and back down the next, then the back room, then unplaced items", () => {
  const items = [item(1, 1001, "loose", 1), item(2, 1001, "hose", 1), item(3, 1001, "cap", 2), item(4, 1001, "seal", 1), item(5, 1001, "tee", 1), item(6, 1001, "filter", 1)];
  const route = routeParts(expandParts(items, PRODUCTS, [], []), PRODUCTS, SPOTS);
  assert.deepEqual(
    route.groups.map((g) => [g.heading, g.stops.map((x) => x.product_id)]),
    [
      ["Effingham store, Main building, Aisle 01", ["tee", "cap"]], // up aisle 1: section 1 then 3
      ["Effingham store, Main building, Aisle 02", ["hose", "filter"]], // back down aisle 2: section 3 then 1
      ["Effingham store, Back room", ["seal"]],
      ["Not on the shelf map", ["loose"]],
    ],
  );
  const cap = route.groups[0].stops[1];
  assert.equal(cap.where, "Section 3");
  assert.equal(cap.code, "EFF-1-01-3");
  assert.equal(route.groups[2].stops[0].where, "Shelf A");
  assert.deepEqual([route.lines, route.total, route.done, route.picked], [6, 7, 0, 0]);
});

test("a batch pulls each product once, with every order's share listed", () => {
  const items = [item(1, 1002, "cap", 3), item(2, 1001, "cap", 2), item(3, 1002, "filter", 1)];
  const route = routeParts(expandParts(items, PRODUCTS, [], []), PRODUCTS, SPOTS);
  const cap = route.groups[0].stops[0];
  assert.equal(cap.qty, 5);
  assert.deepEqual(
    cap.parts.map((p) => [p.order_number, p.qty]),
    [
      [1001, 2],
      [1002, 3],
    ],
  );
});

test("checked-off parts count toward the stop and the ticket", () => {
  const items = [item(1, 1001, "cap", 2), item(2, 1002, "cap", 1), item(3, 1001, "tee", 1)];
  const marks = [
    { order_item_id: 1, product_id: "cap", picked_qty: 2 },
    { order_item_id: 3, product_id: "tee", picked_qty: 1 },
  ];
  const route = routeParts(expandParts(items, PRODUCTS, [], marks), PRODUCTS, SPOTS);
  const [tee, cap] = route.groups[0].stops;
  assert.equal(tee.done, true);
  assert.equal(cap.done, false);
  assert.equal(cap.picked_qty, 2);
  assert.deepEqual([route.lines, route.done, route.total, route.picked], [2, 1, 4, 3]);
});

test("a mark never counts for more than the line needs", () => {
  const parts = expandParts([item(1, 1001, "cap", 1)], PRODUCTS, [], [{ order_item_id: 1, product_id: "cap", picked_qty: 9 }]);
  assert.equal(parts[0].picked_qty, 1);
});

test("a package with no shelf spot is pulled as its parts; a kit on a shelf is pulled whole", () => {
  const kits = [
    { kit_id: "pkg", product_id: "seal", qty: 2 },
    { kit_id: "pkg", product_id: "cap", qty: 1 },
    { kit_id: "seal", product_id: "cap", qty: 4 }, // seal sits on a shelf: not split
  ];
  const parts = expandParts([item(1, 1001, "pkg", 2), item(2, 1001, "seal", 1)], PRODUCTS, kits, []);
  assert.deepEqual(
    parts.map((p) => [p.key, p.qty, p.for_kit]),
    [
      ["1:seal", 4, "580 cylinder package"],
      ["1:cap", 2, "580 cylinder package"],
      ["2:seal", 1, null],
    ],
  );
  const route = routeParts(parts, PRODUCTS, SPOTS);
  const seal = route.groups.find((g) => g.heading.endsWith("Back room"))!.stops[0];
  assert.equal(seal.qty, 5); // one trip to the shelf for both lines
});

test("with no shelf map at all, everything is one list by name", () => {
  const items = [item(1, 1001, "tee", 1), item(2, 1001, "cap", 1)];
  const route = routeParts(expandParts(items, PRODUCTS, [], []), PRODUCTS, []);
  assert.equal(route.groups.length, 1);
  assert.equal(route.groups[0].heading, "Not on the shelf map");
  assert.deepEqual(
    route.groups[0].stops.map((x) => x.name),
    ["JIC cap", "JIC tee"],
  );
});

test("a batch from two locations is two walks, one per location", async () => {
  const { routeByPlace } = await import("../lib/picking.ts");
  const products = [
    { id: "tee", name: "Tee", part_number: "T", spot_id: null },
    { id: "cap", name: "Cap", part_number: "C", spot_id: null },
  ];
  const items = [
    { id: 1, order_id: "o1", order_number: 1001, product_id: "tee", name: "Tee", part_number: "T", qty: 1 },
    { id: 2, order_id: "o2", order_number: 1002, product_id: "tee", name: "Tee", part_number: "T", qty: 2 },
    { id: 3, order_id: "o2", order_number: 1002, product_id: "cap", name: "Cap", part_number: "C", qty: 1 },
  ];
  const parts = expandParts(items, products, [], []);
  const at: Record<string, string> = { o1: "eff", o2: "main" };
  const places = [{ id: "main", name: "Main shop" }, { id: "eff", name: "Effingham" }];
  const r = routeByPlace(parts, products, [], (p) => at[p.order_id], places);
  assert.deepEqual(r.places, ["Main shop", "Effingham"]);
  assert.deepEqual(
    r.groups.map((g) => [g.heading, g.stops.map((s) => `${s.name} ×${s.qty}`)]),
    [
      ["Main shop: Not on the shelf map", ["Cap ×1", "Tee ×2"]],
      ["Effingham: Not on the shelf map", ["Tee ×1"]],
    ],
  );
  assert.equal(r.total, 4);
  assert.equal(r.lines, 3, "the tee is a stop at each location");
  const one = routeByPlace(parts, products, [], () => "main", places);
  assert.deepEqual(one.places, ["Main shop"]);
  assert.equal(one.groups[0].heading, "Not on the shelf map", "one location: no prefix");
});

test("with a layout file on the shelf map, the walk starts at the counter and a dead-end aisle is walked in and out", async () => {
  const { parseSpaceMap, walkPlan } = await import("../lib/spacemap.ts");
  // The back room is listed first on the shelf map (sort 5) but is the far end of the building;
  // aisle 01 is a dead end against the wall.
  const { map, problems } = parseSpaceMap(`spacemap 1
Location EFF
  Area 200 "Back room"
    Shelf A
  Building 1
    Aisle 01 (dead end)
      Section 1..3
    Aisle 02
      Section 1..3
start: EFF-1 "Front counter"
link: EFF-1-02 <> EFF-200 far "Through the wash bay"
`);
  assert.deepEqual(problems, []);
  const plan = walkPlan([map], SPOTS);
  assert.equal(plan.lost, 0);
  const items = [item(1, 1001, "hose", 1), item(2, 1001, "cap", 2), item(3, 1002, "seal", 1), item(4, 1002, "tee", 1), item(5, 1002, "filter", 1), item(6, 1002, "cap", 1)];
  const route = routeParts(expandParts(items, PRODUCTS, [], []), PRODUCTS, SPOTS, plan);
  assert.equal(route.start, "Front counter");
  assert.deepEqual(
    route.groups.map((g) => [g.heading, g.stops.map((x) => `${x.product_id} x${x.qty}`)]),
    [
      ["Effingham store, Main building, Aisle 01", ["tee x1", "cap x3"]], // in and back out: map order, both orders' caps in one stop
      ["Effingham store, Main building, Aisle 02", ["filter x1", "hose x1"]], // the first through aisle, so still map order
      ["Effingham store, Back room", ["seal x1"]], // last: it is far, through the wash bay off aisle 2
    ],
  );
  // The same pick with no layout file: the back room first, as the shelf map lists it, and aisle 2 walked backwards.
  const plain = routeParts(expandParts(items, PRODUCTS, [], []), PRODUCTS, SPOTS);
  assert.equal(plain.start, "");
  assert.deepEqual(plain.groups.map((g) => g.stops.map((x) => x.product_id)), [["tee", "cap"], ["hose", "filter"], ["seal"]]);
});
