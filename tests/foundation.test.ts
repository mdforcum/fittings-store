import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  addBusinessDays,
  cartShipping,
  categoryLabel,
  categoryPath,
  cleanMachine,
  cleanSpecs,
  deliveryPromise,
  fitsSerial,
  machineLabel,
  parseMachineLines,
  serialKey,
  findByNumber,
  flatTree,
  inherited,
  kitAvailable,
  kitLoops,
  parseXrefLine,
  serialInRange,
  shippingGaps,
  sources,
  specFieldsFor,
  surchargeLines,
  type Category,
  type KitItem,
  type Location,
  type SpecField,
  madeInUSA,
} from "../lib/foundation.ts";

const field = (key: string, over: Partial<SpecField> = {}): SpecField => ({
  key,
  label: key,
  type: "text",
  filter: "list",
  ...over,
});
const cat = (id: string, parent_id: string | null, over: Partial<Category> = {}): Category => ({
  id,
  parent_id,
  name: id,
  sort: 0,
  spec_fields: [],
  fitment: null,
  default_ship: null,
  live: false,
  note: "",
  ...over,
});

const CATS: Category[] = [
  cat("filters", null, {
    name: "Filters",
    fitment: "part_number",
    default_ship: "parcel",
    spec_fields: [field("style"), field("micron", { type: "number" })],
  }),
  cat("filters-fuel", "filters", {
    name: "Fuel",
    sort: 20,
    spec_fields: [field("micron", { type: "number", label: "Micron (fuel)" }), field("water_sep", { type: "bool" })],
  }),
  cat("filters-air", "filters", { name: "Air", sort: 10 }),
  cat("tires", null, { name: "Tires", default_ship: "freight", sort: 5 }),
  cat("tires-tubes", "tires", { default_ship: "parcel" }),
];

test("a category's path runs from the root down", () => {
  assert.deepEqual(
    categoryPath("filters-fuel", CATS).map((c) => c.id),
    ["filters", "filters-fuel"],
  );
  assert.equal(categoryLabel("filters-fuel", CATS), "Filters › Fuel");
  assert.deepEqual(categoryPath("nope", CATS), []);
  assert.deepEqual(categoryPath(null, CATS), []);
});

test("a loop in the tree does not hang", () => {
  const loop = [cat("a", "b"), cat("b", "a")];
  assert.equal(categoryPath("a", loop).length, 2);
  assert.equal(flatTree(loop).length, 0); // neither is reachable from a root
});

test("spec fields are inherited, and the nearer definition wins in place", () => {
  const f = specFieldsFor("filters-fuel", CATS);
  assert.deepEqual(
    f.map((x) => x.key),
    ["style", "micron", "water_sep"],
  );
  assert.equal(f[1].label, "Micron (fuel)");
});

test("settings come from the nearest category that has one", () => {
  assert.equal(inherited("filters-fuel", CATS, "fitment"), "part_number");
  assert.equal(inherited("tires-tubes", CATS, "default_ship"), "parcel");
  assert.equal(inherited("tires", CATS, "default_ship"), "freight");
  assert.equal(inherited(null, CATS, "fitment"), null);
});

test("the flat tree is in order with depths and leaves marked", () => {
  const t = flatTree(CATS);
  assert.deepEqual(
    t.map((c) => `${c.depth}:${c.id}:${c.leaf ? "leaf" : "branch"}`),
    ["0:filters:branch", "1:filters-air:leaf", "1:filters-fuel:leaf", "0:tires:branch", "1:tires-tubes:leaf"],
  );
});

test("spec values are cleaned against the template", () => {
  const fields: SpecField[] = [
    field("style", { type: "choice", choices: ["Spin-on", "Element"] }),
    field("micron", { type: "number" }),
    field("adv", { type: "bool" }),
    field("specs_met", { type: "multi" }),
    field("size", { column: "size" }),
    field("note"),
  ];
  const { specs, problems } = cleanSpecs(
    {
      style: "Spin-on",
      micron: "1,000",
      adv: "yes",
      specs_met: "API CK-4, JDM J20C, API CK-4",
      size: "1/2",
      note: "   ",
      stray: "dropped",
    },
    fields,
  );
  assert.deepEqual(specs, { style: "Spin-on", micron: 1000, adv: true, specs_met: ["API CK-4", "JDM J20C"] });
  assert.deepEqual(problems, []);

  const bad = cleanSpecs({ style: "Canister", micron: "fine" }, fields);
  assert.deepEqual(bad.specs, {});
  assert.equal(bad.problems.length, 2);
});

test("any number an item goes by finds it, exact matches first", () => {
  const products = [
    { id: "b7299", part_number: "B7299" },
    { id: "b72", part_number: "B72" },
    { id: "jic", part_number: "839-FS-12" },
  ];
  const xrefs = [
    { product_id: "b7299", kind: "oem" as const, number: "RE-50483", number_norm: "RE50483" },
    { product_id: "jic", kind: "supplier" as const, number: "2408-12", number_norm: "240812" },
    { product_id: "b7299", kind: "upc" as const, number: "0 12345 67890 5", number_norm: "012345678905" },
  ];
  assert.deepEqual(findByNumber("re50483", products, xrefs), [
    { product_id: "b7299", matched: "RE-50483", via: "oem" },
  ]);
  assert.deepEqual(findByNumber("2408 12", products, xrefs)[0], {
    product_id: "jic",
    matched: "2408-12",
    via: "supplier",
  });
  assert.deepEqual(
    findByNumber("b72", products, xrefs).map((h) => h.product_id),
    ["b72", "b7299"],
  );
  assert.deepEqual(findByNumber("8", products, xrefs), []);
});

test("cross-reference lines split into brand and number", () => {
  assert.deepEqual(parseXrefLine("  Baldwin   B7299 ", "aftermarket"), {
    kind: "aftermarket",
    brand: "Baldwin",
    number: "B7299",
    number_norm: "B7299",
  });
  assert.deepEqual(parseXrefLine("Case IH 1930982C1", "oem"), {
    kind: "oem",
    brand: "Case IH",
    number: "1930982C1",
    number_norm: "1930982C1",
  });
  assert.equal(parseXrefLine("---", "oem"), null);
  assert.equal(parseXrefLine("ABC123", "upc"), null);
  assert.equal(parseXrefLine("012345678905", "upc")?.number_norm, "012345678905");
});

test("a kit is in stock only as far as its scarcest part goes", () => {
  const qty: Record<string, number> = { oil: 9, fuel: 3, air: 10 };
  const items: KitItem[] = [
    { product_id: "oil", qty: 2 },
    { product_id: "fuel", qty: 1 },
    { product_id: "air", qty: 1 },
  ];
  assert.equal(kitAvailable(items, (id) => qty[id] ?? 0), 3);
  assert.equal(kitAvailable([{ product_id: "oil", qty: 10 }], (id) => qty[id] ?? 0), 0);
  assert.equal(kitAvailable([], () => 5), 0);
});

test("a kit cannot contain itself, even through another kit", () => {
  const kits: Record<string, KitItem[]> = { inner: [{ product_id: "outer", qty: 1 }] };
  assert.equal(kitLoops("outer", [{ product_id: "inner", qty: 1 }], (id) => kits[id] ?? []), true);
  assert.equal(kitLoops("outer", [{ product_id: "oil", qty: 1 }], (id) => kits[id] ?? []), false);
});

const WED = new Date("2026-11-25T15:00:00Z"); // a Wednesday
const LOCS: Location[] = [
  { id: "mcc", name: "McCormick Diesel", kind: "dealer", lead_days: null, phone: "" },
  { id: "burns", name: "Burns Ag", kind: "supplier", lead_days: 4, phone: "" },
];

test("business days skip the weekend", () => {
  assert.equal(addBusinessDays(WED, 1).getUTCDay(), 4); // Thu
  assert.equal(addBusinessDays(WED, 3).getUTCDay(), 1); // Mon
  assert.equal(addBusinessDays(WED, 0).getTime(), WED.getTime());
});

test("the promise comes from the fastest place that has enough", () => {
  const stock = [
    { location_id: "burns", qty: 50, counted_at: "2026-11-24T00:00:00Z", lead_days: null },
    { location_id: "mcc", qty: 4, counted_at: "2026-11-20T00:00:00Z", lead_days: null },
  ];
  const s = sources(2, 1, stock, LOCS, WED);
  assert.deepEqual(
    s.map((x) => `${x.name}:${x.ready_days}`),
    ["McCormick Diesel:2", "Burns Ag:4"],
  ); // our shelf has 1, not enough for 2
  const p = deliveryPromise(s, { min: 1, max: 3 }, WED);
  assert.equal(p.kind, "date");
  if (p.kind === "date") {
    assert.equal(p.source.name, "McCormick Diesel");
    assert.equal(p.ships_by.getUTCDay(), 5); // Fri
    assert.equal(p.arrives_from.getUTCDay(), 1); // Mon
    assert.equal(p.arrives_to.getUTCDay(), 3); // Wed
  }
  assert.equal(sources(1, 1, stock, LOCS, WED)[0].from, "own");
});

test("an old shelf count asks the customer to confirm instead of promising", () => {
  const stock = [{ location_id: "mcc", qty: 4, counted_at: "2026-09-01T00:00:00Z", lead_days: null }];
  const p = deliveryPromise(sources(1, 0, stock, LOCS, WED), { min: 1, max: 3 }, WED);
  assert.equal(p.kind, "confirm");
  assert.equal(deliveryPromise([], { min: 1, max: 3 }, WED).kind, "none");
});

test("a fresh count beats a stale one even when the stale one is faster", () => {
  const stock = [
    { location_id: "mcc", qty: 4, counted_at: "2026-09-01T00:00:00Z", lead_days: 1 },
    { location_id: "burns", qty: 4, counted_at: "2026-11-24T00:00:00Z", lead_days: null },
  ];
  assert.equal(sources(1, 0, stock, LOCS, WED)[0].name, "Burns Ag");
});

test("one freight or pickup item decides how the whole cart ships", () => {
  assert.deepEqual(cartShipping(["parcel", "parcel"]), { method: "parcel", groundOnly: false, quote: false });
  assert.deepEqual(cartShipping(["parcel", "restricted"]), { method: "parcel", groundOnly: true, quote: false });
  assert.deepEqual(cartShipping(["parcel", "freight"]).method, "freight");
  assert.deepEqual(cartShipping(["freight", "oversize"]).quote, true);
  assert.deepEqual(cartShipping(["freight", "pickup"]).method, "pickup");
});

test("shipping gaps name what is missing", () => {
  const base = { ship_class: "parcel" as const, weight_oz: null, length_in: null, width_in: null, height_in: null, freight_class: "" };
  assert.deepEqual(shippingGaps(base), ["weight", "box size"]);
  assert.deepEqual(shippingGaps({ ...base, ship_class: "freight", weight_oz: 900, length_in: 40, width_in: 48, height_in: 30 }), [
    "freight class",
  ]);
  assert.deepEqual(shippingGaps({ ...base, ship_class: "pickup" }), []);
});

test("surcharges become their own lines, multiplied by quantity", () => {
  const lines = surchargeLines(
    [
      { product_id: "starter", qty: 2 },
      { product_id: "tire", qty: 4 },
      { product_id: "plug", qty: 1 },
    ],
    [
      { product_id: "starter", kind: "core", amount_cents: 4500, refundable: true, label: "" },
      { product_id: "tire", kind: "tire_fee", amount_cents: 250, refundable: false, label: "" },
      { product_id: "plug", kind: "hazmat", amount_cents: 0, refundable: false, label: "" },
    ],
  );
  assert.deepEqual(
    lines.map((l) => `${l.label}:${l.total_cents}:${l.refundable}`),
    ["Core charge:9000:true", "Illinois tire user fee:1000:false"],
  );
});

test("serial ranges compare as numbers and allow open ends", () => {
  assert.equal(serialInRange("JJA0012345", "JJA0010000", "JJA0019999"), true);
  assert.equal(serialInRange("JJA0020001", "JJA0010000", "JJA0019999"), false);
  assert.equal(serialInRange("JJA9", "JJA10", ""), false); // 9 comes before 10
  assert.equal(serialInRange("anything", "", ""), true);
});

test("the seeded category tree in schema.sql is well formed", () => {
  const sql = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  const start = sql.indexOf("insert into shop.fittings_categories");
  const end = sql.indexOf("on conflict (id) do update", start);
  assert.ok(start > 0 && end > start);
  const block = sql.slice(start, end);
  const rows = [...block.matchAll(/^\s+\('([a-z0-9-]+)', (null|'[a-z0-9-]+'), '((?:[^']|'')*)', (\d+), '((?:[^']|'')*)'::jsonb/gm)];
  assert.ok(rows.length >= 50, `found ${rows.length} rows`);
  const ids = new Set<string>();
  for (const [, id, parent, , , fields] of rows) {
    assert.ok(!ids.has(id), `duplicate ${id}`);
    if (parent !== "null") assert.ok(ids.has(parent.slice(1, -1)), `${id} comes before its parent`);
    ids.add(id);
    const parsed = JSON.parse(fields.replace(/''/g, "'")) as SpecField[];
    const keys = parsed.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length, `${id} repeats a spec key`);
    for (const f of parsed) {
      assert.ok(["text", "number", "choice", "multi", "bool"].includes(f.type), `${id}.${f.key} type`);
      if (f.type === "choice") assert.ok(f.choices?.length, `${id}.${f.key} has no choices`);
    }
  }
  for (const leaf of ["orb-plugs", "jic-caps", "jic-plugs", "breather-plugs", "adapters", "other-fittings"]) {
    assert.ok(ids.has(leaf), `missing ${leaf}`);
  }
});

test("the tree has exactly six departments and every old category sits under one", () => {
  const sql = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  const start = sql.indexOf("insert into shop.fittings_categories");
  const block = sql.slice(start, sql.indexOf("on conflict (id) do update", start));
  const tops = [...block.matchAll(/^\s+\('([a-z0-9-]+)', null,/gm)].map((m) => m[1]);
  assert.deepEqual(tops, ["machine-systems", "implements", "construction", "hydraulics", "universal", "tires"]);
  for (const [id, parent] of [
    ["filters", "machine-systems"],
    ["cab-glass", "ms-cab"],
    ["lubricants", "universal"],
    ["belts", "universal"],
    ["shop-supplies", "universal"],
    ["hydraulic-fittings", "hydraulics"],
    ["tires-drive", "tire-types"],
  ]) {
    assert.match(block, new RegExp(`\\('${id}', '${parent}',`), `${id} under ${parent}`);
  }
});

test("Cat serials: prefix plus sequence, and the 17-character PIN reads the same", () => {
  const row = { serial_prefix: "ABC", serial_from: "1", serial_to: "4999" };
  assert.equal(fitsSerial("ABC01234", row), true);
  assert.equal(fitsSerial("abc-05000", row), false);
  assert.equal(fitsSerial("XYZ01234", row), false);
  assert.equal(serialKey("CAT0D6TCABC01234"), "CAT0D6TCABC01234"); // 16 characters: not a PIN
  assert.equal(serialKey("CAT00D6TCABC01234"), "ABC01234");
  assert.equal(fitsSerial("CAT00D6TCABC01234", row), true);
  assert.equal(fitsSerial("", row), false);
  assert.equal(fitsSerial("ABC77777", { serial_prefix: "ABC", serial_from: "", serial_to: "" }), true);
  // No prefix: the whole serial compares as before.
  assert.equal(fitsSerial("JJA0012345", { serial_prefix: "", serial_from: "JJA0010000", serial_to: "JJA0019999" }), true);
});

test("machines are checked and tidied before they are saved", () => {
  const m = cleanMachine({ make: " Case  IH ", kind: "tractor", series: "66 series", model: "1066", year_from: "1967", year_to: 1971, serial_prefixes: "abc, xyz abc" });
  assert.equal(m.make, "Case IH");
  assert.deepEqual(m.serial_prefixes, ["ABC", "XYZ"]);
  assert.equal(machineLabel(m), "Case IH 1066 \u00b7 66 series \u00b7 1967\u20131971");
  assert.throws(() => cleanMachine({ make: "Cat", kind: "dozer" }), /needs a model/);
  assert.throws(() => cleanMachine({ make: "Cat", model: "D6", kind: "boat" }), /what kind of machine/);
  assert.throws(() => cleanMachine({ make: "Cat", model: "D6", kind: "dozer", year_from: 1990, year_to: 1980 }), /first year comes after/);
  assert.throws(() => cleanMachine({ make: "Cat", model: "D6", kind: "dozer", serial_prefixes: "A" }), /not a serial prefix/);
});

test("a pasted lineup: kinds by name, blank and # lines skipped, problems by line", () => {
  const { machines, problems } = parseMachineLines(
    "# ag\nCase IH, Tractor, 66 series, 1066\n\nCase, backhoe loader, 580 series, 580 Super N\nCat\tdozer\tD series\tD6\t\t\tABC XYZ\nCat, boat, , 320\nCat, , , 320\n",
  );
  assert.deepEqual(
    machines.map((m) => [m.make, m.kind, m.model, m.serial_prefixes.join(" ")]),
    [
      ["Case IH", "tractor", "1066", ""],
      ["Case", "backhoe", "580 Super N", ""],
      ["Cat", "dozer", "D6", "ABC XYZ"],
    ],
  );
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^Line 6: /);
  assert.match(problems[1], /^Line 7: Pick what kind/);
});

test("made in USA reads the usual ways of writing it, and nothing else", () => {
  for (const s of ["USA", "usa", "U.S.A.", "US", "United States", "United States of America"]) assert.equal(madeInUSA(s), true, s);
  for (const s of ["", "Canada", "USA parts, assembled in Mexico", "Mexico", null]) assert.equal(madeInUSA(s), false, String(s));
});
