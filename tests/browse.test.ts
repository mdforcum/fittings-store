import assert from "node:assert/strict";
import { test } from "node:test";
import { addToGarage, fitState, readGarage, removeFromGarage, searchProducts, shopNav, underCategory, warrantyText, type ShopXref } from "../lib/browse.ts";
import type { Product } from "../lib/catalog.ts";
import type { Category } from "../lib/foundation.ts";

const p = (id: string, over: Partial<Product> = {}): Product => ({
  id,
  name: over.name ?? id,
  type: "other",
  size: "",
  dash: "",
  thread: "",
  part_number: "",
  description: "",
  price_cents: 100,
  qty: 1,
  photos: [],
  sort: 0,
  category_id: null,
  brand: "",
  condition: "new",
  universal: false,
  price_mode: "cart",
  warranty_months: null,
  ...over,
});

const cat = (id: string, parent_id: string | null, live = true, sort = 0): Category => ({
  id,
  parent_id,
  name: id,
  sort,
  spec_fields: [],
  fitment: null,
  default_ship: null,
  live,
  note: "",
});

test("search: our number, then numbers an item replaces, then words", () => {
  const items = [p("cap", { name: "37° JIC Cap 1/2 FJ", part_number: "830-FS-08", thread: "3/4-16" }), p("filter", { name: "Oil filter", part_number: "BT339" })];
  const xrefs = new Map<string, ShopXref[]>([["filter", [{ kind: "oem", brand: "Case IH", number: "86-572263", number_norm: "86572263" }]]]);
  assert.deepEqual(
    searchProducts(items, xrefs, "830fs08").map((h) => [h.product.id, h.score]),
    [["cap", 100]],
  );
  const byOem = searchProducts(items, xrefs, "86572263");
  assert.equal(byOem[0].product.id, "filter");
  assert.equal(byOem[0].because, "Replaces Case IH 86-572263");
  assert.equal(searchProducts(items, xrefs, "86 572")[0]?.because, "Replaces Case IH 86-572263");
  assert.deepEqual(
    searchProducts(items, xrefs, "jic 3/4-16").map((h) => h.product.id),
    ["cap"],
  );
  assert.deepEqual(searchProducts(items, xrefs, "hose"), []);
  assert.equal(searchProducts(items, xrefs, " ").length, 2);
});

test("fit: say nothing without a machine list, ask for the serial where it matters", () => {
  const rows = [
    { machine_id: "m1", serial_prefix: "", serial_from: "", serial_to: "", position: "Engine" },
    { machine_id: "m2", serial_prefix: "ABC", serial_from: "1", serial_to: "4999", position: "" },
  ];
  assert.deepEqual(fitState(p("x"), [], "m1"), { kind: "unknown" });
  assert.deepEqual(fitState(p("x", { universal: true }), rows, "m1"), { kind: "universal" });
  assert.deepEqual(fitState(p("x"), rows, "m1"), { kind: "fits", note: "Engine" });
  assert.equal(fitState(p("x"), rows, "m2").kind, "checkSerial");
  assert.equal(fitState(p("x"), rows, "m2", "ABC01234").kind, "fits");
  assert.equal(fitState(p("x"), rows, "m2", "ABC05000").kind, "notListed");
  assert.deepEqual(fitState(p("x"), rows, "m3"), { kind: "notListed" });
  assert.deepEqual(fitState(p("x"), rows, null), { kind: "unknown" });
});

test("nav shows only live shelves that hold items, with counts rolled up", () => {
  const cats = [cat("hyd", null), cat("fit", "hyd"), cat("caps", "fit", true, 20), cat("plugs", "fit", true, 10), cat("empty", "fit"), cat("filters", null, false)];
  const items = [p("a", { category_id: "caps" }), p("b", { category_id: "plugs" }), p("c", { category_id: "plugs" }), p("d", { category_id: "filters" })];
  const nav = shopNav(cats, items);
  assert.equal(nav.length, 1);
  assert.equal(nav[0].count, 3);
  assert.deepEqual(
    nav[0].children[0].children.map((n) => [n.id, n.count]),
    [
      ["plugs", 2],
      ["caps", 1],
    ],
  );
  assert.deepEqual([...underCategory("fit", cats)].sort(), ["caps", "empty", "fit", "plugs"]);
});

test("the garage keeps six machines, the newest active, and survives bad storage", () => {
  assert.deepEqual(readGarage("not json"), { active: null, machines: [] });
  let g = readGarage(null);
  for (let i = 1; i <= 7; i++) g = addToGarage(g, { id: `m${i}`, label: `Machine ${i}`, serial: "" });
  assert.equal(g.machines.length, 6);
  assert.equal(g.active, "m7");
  assert.ok(!g.machines.some((m) => m.id === "m1"));
  g = removeFromGarage(g, "m7");
  assert.equal(g.active, "m6");
  assert.deepEqual(readGarage(JSON.stringify({ active: "gone", machines: [{ id: "m2", label: "x" }] })).active, "m2");
  assert.equal(warrantyText(24), "2-year warranty");
  assert.equal(warrantyText(6), "6-month warranty");
});
