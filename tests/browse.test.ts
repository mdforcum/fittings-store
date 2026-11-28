import assert from "node:assert/strict";
import { test } from "node:test";
import { addToGarage, fitState, readGarage, removeFromGarage, searchProducts, shelfWords, shopNav, underCategory, warrantyText, type ShopXref } from "../lib/browse.ts";
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
  ship_class: "parcel",
  origin: "",
  spot_id: null,
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

test("search forgives how people type: no hyphen, plurals, shorthand, misspellings", () => {
  const items = [
    p("orb", { name: "O-Ring Boss Plug -08", type: "orb-plug", part_number: "6408-08", thread: "3/4-16", sort: 1 }),
    p("kit", { name: "O-ring kit, 382 pieces", part_number: "ORK-382", sort: 2 }),
    p("cap", { name: "37° JIC Cap 1/2 FJ", type: "jic-cap", part_number: "830-FS-08", thread: "3/4-16", sort: 3 }),
    p("cap14", { name: "37° JIC Cap 9/16", type: "jic-cap", part_number: "830-FS-06", thread: "9/16-18", sort: 4 }),
    p("hose", { name: "Hydraulic hose 3/8 x 10 ft", part_number: "HH-38-10", description: "Two-wire hose with JIC swivel ends.", category_id: "hoses", sort: 5 }),
  ];
  const none = new Map<string, ShopXref[]>();
  const find = (q: string, shelves?: Map<string, string>) => searchProducts(items, none, q, shelves);
  const ids = (q: string, shelves?: Map<string, string>) => find(q, shelves).map((h) => h.product.id);

  assert.deepEqual(ids("o-ring"), ["orb", "kit"]);
  assert.deepEqual(ids("oring"), ["orb", "kit"], "no hyphen finds the same parts");
  assert.deepEqual(ids("o ring"), ["orb", "kit"]);
  assert.deepEqual(ids("O-Rings"), ["orb", "kit"]);
  assert.deepEqual(ids("orings kit"), ["kit"]);
  assert.deepEqual(ids("orb"), ["orb"], "ORB means O-ring boss");
  assert.deepEqual(ids("caps"), ["cap", "cap14"], "a plural");
  assert.deepEqual(ids("jic caps 3/4-16"), ["cap"]);
  assert.ok(find("o-ring").every((h) => !h.loose), "a match in another form is not marked as a guess");
  assert.ok(find("o-ring")[0].score > find("oring")[0].score, "as written ranks above another form");

  const slip = find("hydrolic hose");
  assert.deepEqual(slip.map((h) => [h.product.id, h.loose]), [["hose", "spelling"]], "a misspelling still finds it, marked as a guess");
  assert.deepEqual(ids("hidraulic"), ["hose"]);
  assert.deepEqual(ids("swivel"), ["hose"], "words in the description count");

  // A guess is offered only when nothing matches for certain.
  const seats = [p("seal", { name: "Seal kit" }), p("seat", { name: "Valve seat" })];
  assert.deepEqual(searchProducts(seats, none, "seal").map((h) => h.product.id), ["seal"], "a sure match keeps the near-miss out");
  assert.deepEqual(searchProducts(seats, none, "seel").map((h) => [h.product.id, h.loose]), [["seal", "spelling"]]);

  // Sizes are never guessed at.
  assert.deepEqual(ids("3/4-14"), []);
  assert.deepEqual(ids("830-FS-07"), []);
  assert.deepEqual(ids("cap 9/16-18"), ["cap14"]);

  // Nothing matches every word: offer what matches at least half, marked as a looser match.
  const some = find("jic cap 7/8-14 stainless");
  assert.deepEqual(some.map((h) => [h.product.id, h.loose]), [["cap", "some"], ["cap14", "some"]]);
  assert.deepEqual(ids("stainless pump"), [], "no words match, so nothing is offered");
  assert.deepEqual(ids("pump"), []);

  // A shelf's name, and the departments above it, can be searched.
  const shelves = shelfWords([cat("hyd", null), cat("hoses", "hyd"), cat("hidden", null, false)].map((c, i) => ({ ...c, name: ["Hydraulics", "Hoses and couplers", "Secret"][i] })));
  assert.equal(shelves.get("hoses"), "Hoses and couplers Hydraulics");
  assert.equal(shelves.get("hidden"), "");
  assert.deepEqual(ids("couplers", shelves), ["hose"]);
  assert.deepEqual(ids("coupler", shelves), ["hose"]);
  assert.deepEqual(ids("couplers"), []);
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
