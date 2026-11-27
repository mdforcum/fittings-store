import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_LABELS, labelCharge, parcelFrom, quoteKey, readLabels, readQuote, signQuote, type Quote } from "../lib/labels.ts";

test("dealer labels start off, with no markup", () => {
  assert.deepEqual(readLabels(null), NO_LABELS);
  assert.deepEqual(readLabels({ on: true }), { on: true, markup_bps: 0, flat_cents: 0 });
  assert.deepEqual(readLabels({ on: "yes", markup_bps: 9999, flat_cents: -5 }), NO_LABELS, "bad values read as off and zero");
  assert.deepEqual(readLabels({ on: true, markup_bps: 250, flat_cents: 50 }), { on: true, markup_bps: 250, flat_cents: 50 });
});

test("a label is charged at cost until a markup is set", () => {
  assert.equal(labelCharge(1240, NO_LABELS), 1240);
  assert.equal(labelCharge(1240, { markup_bps: 500, flat_cents: 0 }), 1302);
  assert.equal(labelCharge(1240, { markup_bps: 0, flat_cents: 50 }), 1290);
  assert.equal(labelCharge(1233, { markup_bps: 250, flat_cents: 25 }), 1233 + 31 + 25);
  assert.equal(labelCharge(0, { markup_bps: 5000, flat_cents: 0 }), 0);
});

test("the package a dealer types becomes a parcel, or plain words", () => {
  assert.deepEqual(parcelFrom({ weight_lb: "2.5", length: "12", width: "9", height: "4" }), { length: 12, width: 9, height: 4, weight_oz: 40 });
  assert.deepEqual(parcelFrom({ weight_lb: 1, length: 6, width: 6, height: 6 }), { length: 6, width: 6, height: 6, weight_oz: 16 });
  assert.equal(parcelFrom({ weight_lb: "", length: "12", width: "9", height: "4" }), "Enter the weight in pounds.");
  assert.equal(parcelFrom({ weight_lb: "2", length: "12", width: "", height: "4" }), "Enter the box length, width and height in inches.");
  assert.equal(parcelFrom({ weight_lb: "2", length: "12", width: "-3", height: "4" }), "Enter the box length, width and height in inches.");
  assert.match(String(parcelFrom({ weight_lb: "151", length: "12", width: "9", height: "4" })), /over 150 lb need freight/);
  assert.match(String(parcelFrom({ weight_lb: "20", length: "120", width: "9", height: "4" })), /over 108 inches needs freight/);
});

test("a quote token buys only the price that was offered, for that order and location, for a while", () => {
  const key = quoteKey("secret-one");
  const q: Quote = { order_id: "o1", location_id: "l1", rate_id: "rate_1", carrier: "UPS", service: "Ground", cost_cents: 1240, charge_cents: 1240, expires: 2_000 };
  const token = signQuote(q, key);
  assert.deepEqual(readQuote(token, key, "o1", "l1", 1_000), q);
  assert.equal(readQuote(token, key, "o2", "l1", 1_000), null, "another order");
  assert.equal(readQuote(token, key, "o1", "l2", 1_000), null, "another location");
  assert.equal(readQuote(token, key, "o1", "l1", 2_000), null, "ran out");
  assert.equal(readQuote(token, quoteKey("secret-two"), "o1", "l1", 1_000), null, "signed with another key");
  const cheaper = Buffer.from(JSON.stringify({ ...q, cost_cents: 1, charge_cents: 1 })).toString("base64url");
  assert.equal(readQuote(`${cheaper}.${token.split(".")[1]}`, key, "o1", "l1", 1_000), null, "a changed price breaks the signature");
  assert.equal(readQuote(signQuote({ ...q, charge_cents: 1000 }, key), key, "o1", "l1", 1_000), null, "never under cost");
  assert.equal(readQuote("junk", key, "o1", "l1", 1_000), null);
  assert.equal(readQuote(`${token}.x`, key, "o1", "l1", 1_000), null);
});

test("the package is guessed only from what the parts' records say", async () => {
  const { packageGuess } = await import("../lib/labels.ts");
  const none = { weight_oz: null, length_in: null, width_in: null, height_in: null };
  assert.deepEqual(packageGuess([]), { weight_lb: "", length: "", width: "", height: "" });
  assert.deepEqual(packageGuess([{ qty: 1, weight_oz: 20, length_in: 8, width_in: 6, height_in: 4 }]), { weight_lb: "1.3", length: "8", width: "6", height: "4" }, "one part: its own weight and box, weight rounded up");
  assert.deepEqual(packageGuess([{ qty: 2, weight_oz: 20, length_in: 8, width_in: 6, height_in: 4 }]), { weight_lb: "2.5", length: "", width: "", height: "" }, "two of a part: weight adds up, box is left blank");
  assert.deepEqual(packageGuess([{ qty: 1, ...none, weight_oz: 16, length_in: 5 }, { qty: 3, ...none, weight_oz: 8 }]).weight_lb, "2.5");
  assert.deepEqual(packageGuess([{ qty: 1, ...none, weight_oz: 16 }, { qty: 1, ...none }]), { weight_lb: "", length: "", width: "", height: "" }, "a part with no weight: no guess at all");
  assert.equal(packageGuess([{ qty: 1, ...none, weight_oz: 16 * 200 }]).weight_lb, "", "too heavy for parcel: left blank");
});
