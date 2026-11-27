import assert from "node:assert/strict";
import { test } from "node:test";
import {
  counterLines,
  counterTotal,
  counterWarnings,
  importColumns,
  importPlan,
  importSummary,
  locationShipFrom,
  lowStockText,
  mainLocationId,
  zipRows,
  orderAlert,
  parseCsv,
  priceCents,
  refundFor,
  runningLow,
  stillOut,
  toE164,
} from "../lib/operations.ts";
import { hashPassword, lockMinutes, makeToken, passwordProblem, passwordTag, tokenSigned, tokenUser, verifyPassword } from "../lib/passwords.ts";

const SHOP = { name: "Matt", company: "Backroad Iron", street1: "1 Main", street2: "", city: "Shelbyville", state: "IL", zip: "62565", phone: "217-555-0100", email: "m@x.com" };

test("a location with a full street address is the ship-from; otherwise the shop's", () => {
  const loc = { name: "McCormick shop", city: "Sullivan", state: "IL", zip: "61951", street1: "9 Elm", street2: "Bay 2", phone: "" };
  const own = locationShipFrom(loc, "McCormick Diesel", SHOP);
  assert.equal(own.own, true);
  assert.deepEqual(own.from, { name: "McCormick shop", company: "McCormick Diesel", street1: "9 Elm", street2: "Bay 2", city: "Sullivan", state: "IL", zip: "61951", phone: "217-555-0100", email: "m@x.com" });
  assert.deepEqual(locationShipFrom({ ...loc, street1: "" }, "McCormick Diesel", SHOP), { from: SHOP, own: false });
  assert.deepEqual(locationShipFrom(null, "", SHOP), { from: SHOP, own: false });
});

test("the label ships from the location that pulled the most parts", () => {
  assert.equal(mainLocationId([]), null);
  assert.equal(
    mainLocationId([
      { order_id: "o", product_id: "a", location_id: "L1", qty: 1 },
      { order_id: "o", product_id: "b", location_id: "L2", qty: 1 },
      { order_id: "o", product_id: "c", location_id: "L2", qty: 1 },
    ]),
    "L2",
  );
});

test("what can still come back, after earlier returns", () => {
  assert.deepEqual(stillOut([{ product_id: "a", qty: 3 }, { product_id: "b", qty: 1 }], [{ product_id: "a", qty: 2 }, { product_id: "b", qty: 5 }]), { a: 1, b: 0 });
});

test("a refund is the parts at what was paid, their tax, and shipping if asked, capped at what's left", () => {
  const o = {
    items: [{ product_id: "a", unit_price_cents: 1000, qty: 2 }],
    subtotal_cents: 2000,
    shipping_cents: 900,
    tax_cents: 150,
    total_cents: 3050,
    refunded_cents: 0,
    core_refunded_cents: 0,
  };
  assert.deepEqual(refundFor(o, [{ product_id: "a", qty: 1 }], false), { parts: 1000, tax: 75, shipping: 0, total: 1075, left: 3050 });
  assert.equal(refundFor(o, [{ product_id: "a", qty: 2 }], true).total, 3050);
  assert.equal(refundFor({ ...o, refunded_cents: 3000 }, [{ product_id: "a", qty: 2 }], true).total, 50, "never more than is left");
  assert.equal(refundFor({ ...o, core_refunded_cents: 50, refunded_cents: 3000 }, [], true).total, 0, "core credits count against it");
});

test("counter lines merge the same part and drop empty ones", () => {
  const lines = counterLines([
    { product_id: "a", qty: 1, price_cents: 500 },
    { product_id: "a", qty: 2, price_cents: 500 },
    { product_id: "b", qty: 0, price_cents: 100 },
    { product_id: "", qty: 1, price_cents: 100 },
  ]);
  assert.deepEqual(lines, [{ product_id: "a", qty: 3, price_cents: 500 }]);
  assert.equal(counterTotal(lines), 1500);
});

test("a counter sale warns when it's short or cuts into checkout holds", () => {
  const lines = [
    { product_id: "a", qty: 2, price_cents: 0 },
    { product_id: "b", qty: 1, price_cents: 0 },
  ];
  assert.deepEqual(counterWarnings(lines, { a: 1, b: 3 }, { b: 3 }, { a: 1, b: 3 }), ["a: only 1 on this shelf.", "b: this cuts into parts held in an online checkout."]);
  assert.deepEqual(counterWarnings(lines, { a: 2, b: 3 }, {}, { a: 2, b: 3 }), []);
});

test("CSV: quotes, doubled quotes, commas and line breaks inside quotes", () => {
  assert.deepEqual(parseCsv('﻿Part number,Name,Qty\r\n"6400-08-08","Elbow, 90°",4\n"X ""big""","two\nlines",1\n\n'), [
    ["Part number", "Name", "Qty"],
    ["6400-08-08", "Elbow, 90°", "4"],
    ['X "big"', "two\nlines", "1"],
  ]);
});

test("import columns are found by their headings", () => {
  assert.deepEqual(importColumns(["SKU", "Description", "On hand", "List price"]), { part: 0, name: 1, qty: 2, price: 3 });
  assert.deepEqual(importColumns(["Part #", "Qty"]), { part: 0, name: -1, qty: 1, price: -1 });
  assert.equal(priceCents("$1,200.50"), 120050);
  assert.equal(priceCents(""), null);
  assert.ok(Number.isNaN(priceCents("call")));
});

test("an import preview matches part numbers and flags problem rows", () => {
  const products = [{ id: "elbow", name: "Elbow", part_number: "6400-08-08" }];
  const onhand = { elbow: { L1: 3 } };
  const rows = parseCsv(
    "Part number,Name,Qty,Price\n6400 08 08,,5,\n6400-08-08,,1,\nNEW-1,New cap,2,4.50\nNEW-2,,1,\n,Nothing,1,\nNEW-3,Cap,two,\nNEW-4,Cap,1,call\n",
  );
  const { lines, problem } = importPlan(rows, products, onhand, "L1");
  assert.equal(problem, "");
  assert.deepEqual(
    lines.map((l) => [l.row, l.product_id, l.now, l.qty, l.price_cents, l.problem]),
    [
      [2, "elbow", 3, 5, null, ""],
      [3, "elbow", 3, 1, null, "This part is on an earlier row too."],
      [4, null, 0, 2, 450, ""],
      [5, null, 0, 1, null, "New part: give it a name."],
      [6, null, 0, 1, null, "No part number."],
      [7, null, 0, null, null, "The count isn't a whole number."],
      [8, null, 0, 1, null, "The price isn't a dollar amount."],
    ],
  );
  assert.deepEqual(importSummary(lines), { update: 1, add: 1, same: 0, skip: 5 });
  assert.equal(importPlan([["Part number", "Name"], ["a", "b"]], products, onhand, "L1").problem, "Add a column headed Qty.");
  assert.equal(importPlan([["Qty"]], products, onhand, "L1").problem, "The file needs a heading row and at least one part.");
});

test("running low: under the low-stock number, or under a month at the 30-day pace", () => {
  const products = [
    { id: "a", name: "A", part_number: "PA" },
    { id: "b", name: "B", part_number: "PB" },
    { id: "c", name: "C", part_number: "PC" },
    { id: "d", name: "D", part_number: "PD" },
  ];
  const onhand = { a: { L1: 1 }, b: { L1: 10 }, c: { L1: 40 }, d: { L2: 0 } };
  const sold = { b: { L1: 15 }, c: { L1: 10 } };
  const low = runningLow(products, onhand, sold, [{ id: "L1", active: true }, { id: "L2", active: false }], 2);
  assert.deepEqual(
    low.map((l) => [l.product_id, l.qty, l.sold30, l.days_left]),
    [
      ["b", 10, 15, 20],
      ["a", 1, 0, null],
    ],
  );
  const text = lowStockText("McCormick", low, () => "Shop");
  assert.match(text, /^Running low at McCormick: 2 parts\./);
  assert.match(text, /- PB B: 10 left at Shop, 15 sold in 30 days/);
});

test("an order alert says what to pull, in plain words", () => {
  const m = orderAlert(1042, [{ name: "Elbow", part_number: "6400", qty: 2, location: "Sullivan" }], false, "https://shop.example/dealer");
  assert.equal(m.subject, "Order #1042: pull 2 parts");
  assert.match(m.body, /- 2 x 6400 Elbow \(Sullivan\)/);
  assert.match(m.body, /Pack it to ship\./);
  assert.ok(m.sms.length < 160);
  assert.equal(toE164("(217) 555-0100"), "+12175550100");
  assert.equal(toE164("1-217-555-0100"), "+12175550100");
  assert.equal(toE164("555-0100"), "");
});

test("dealer passwords: scrypt hash, length rule, lockout", () => {
  assert.equal(passwordProblem("short"), "Use at least 10 characters.");
  assert.equal(passwordProblem("aaaaaaaaaaaa"), "Use more than one repeated character.");
  assert.equal(passwordProblem("tractor-hydraulics"), null);
  const h = hashPassword("tractor-hydraulics");
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.notEqual(h, hashPassword("tractor-hydraulics"), "a new salt each time");
  assert.ok(verifyPassword("tractor-hydraulics", h));
  assert.ok(!verifyPassword("tractor-hydraulicz", h));
  assert.ok(!verifyPassword("x", "plain"));
  assert.equal(lockMinutes(4), 0);
  assert.equal(lockMinutes(5), 15);
});

test("dealer session tokens: signed, expiring, and tied to the password", () => {
  const key = Buffer.alloc(32, 7);
  const id = "00000000-0000-4000-8000-000000000001";
  const tag = passwordTag("scrypt$aa$bb");
  const t = makeToken(id, 2_000_000_000_000, tag, key);
  assert.deepEqual(tokenUser(t, 1_900_000_000_000)?.userId, id);
  assert.equal(tokenUser(t, 2_100_000_000_000), null, "expired");
  assert.ok(tokenSigned(t, tag, key));
  assert.ok(!tokenSigned(t, passwordTag("scrypt$aa$cc"), key), "a new password signs it out");
  assert.ok(!tokenSigned(t, tag, Buffer.alloc(32, 8)), "another key");
  assert.ok(!tokenSigned(t.replace(/\.\d+\./, ".2100000000000."), tag, key), "a changed expiry breaks the signature");
  assert.equal(tokenUser("junk", 0), null);
});

test("a dealer's spreadsheet changes counts only, for parts already in the catalog", async () => {
  const { dealerCountLines } = await import("../lib/operations.ts");
  const products = [
    { id: "elbow", name: "Elbow", part_number: "6400-08-08" },
    { id: "tee", name: "Tee", part_number: "T-1" },
  ];
  const rows = parseCsv("Part number,Name,Qty,Price\n6400-08-08,,5,99.00\nT-1,,2,\nNEW-1,New cap,2,4.50\nNEW-2,,1,\n,Nothing,1,\nT-1,,7,\n6400-08-08,,x,\n");
  const { lines } = importPlan(rows, products, { elbow: { L1: 3 }, tee: { L1: 2 } }, "L1");
  const out = dealerCountLines(lines);
  assert.deepEqual(out.apply, [{ product_id: "elbow", qty: 5 }], "the price column is ignored: only the count goes through");
  assert.equal(out.same, 1);
  assert.deepEqual(out.unknown.map((l) => l.part_number), ["NEW-1", "NEW-2"], "new parts are reported, never added");
  assert.deepEqual(out.bad.map((l) => l.row), [6, 7, 8], "no part number, a repeat, and a bad count are left out");
});

test("zipRows keeps United States ZIP codes that have a real point, one row each", () => {
  const rows = zipRows({
    a: { zip: "62565", latitude: 39.41, longitude: -88.79, country: "US" },
    b: { zip: "62401", latitude: "39.12", longitude: "-88.54", country: "US" },
    canada: { zip: "T5A", latitude: 53.5, longitude: -113.4, country: "Canada" },
    short: { zip: "6256", latitude: 39, longitude: -88, country: "US" },
    nowhere: { zip: "00000", latitude: 0, longitude: 0, country: "US" },
    blank: { zip: "99999", latitude: null, longitude: undefined, country: "US" },
    off: { zip: "11111", latitude: 120, longitude: -88, country: "US" },
    again: { zip: "62565", latitude: 1, longitude: 1, country: "US" },
  });
  assert.deepEqual(rows, [
    { zip: "62565", lat: 39.41, lng: -88.79 },
    { zip: "62401", lat: 39.12, lng: -88.54 },
  ]);
  assert.deepEqual(zipRows({}), []);
});

test("the ZIP code package gives enough real points to route by miles", async () => {
  const { default: zipcodes } = await import("zipcodes");
  const rows = zipRows(zipcodes.codes);
  assert.ok(rows.length > 30000, `expected most United States ZIP codes, got ${rows.length}`);
  const shelbyville = rows.find((r) => r.zip === "62565");
  assert.ok(shelbyville && Math.abs(shelbyville.lat - 39.4) < 0.3 && Math.abs(shelbyville.lng + 88.8) < 0.3, "62565 sits in central Illinois");
});
