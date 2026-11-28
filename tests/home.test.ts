import assert from "node:assert/strict";
import { test } from "node:test";
import { alertsWaiting, dealerNeeds, networkOrders, orderNeeds, salesSummary, stockNeeds, waited } from "../lib/home.ts";

test("paid orders sort into to pull, to ship and ready for pickup", () => {
  const orders = [
    { id: "a", number: 1, status: "paid", paid_at: "2026-11-25T10:00:00Z", ship_method: "parcel" },
    { id: "b", number: 2, status: "paid", paid_at: "2026-11-26T10:00:00Z", ship_method: "parcel" },
    { id: "c", number: 3, status: "paid", paid_at: "2026-11-27T10:00:00Z", ship_method: "pickup", stock_short: true },
    { id: "d", number: 4, status: "paid", paid_at: "2026-11-27T11:00:00Z", ship_method: "parcel" },
    { id: "e", number: 5, status: "shipped", paid_at: "2026-11-01T10:00:00Z" },
    { id: "f", number: 6, status: "cancelled", paid_at: "2026-11-01T10:00:00Z" },
  ];
  const progress = { a: { need: 3, picked: 3 }, b: { need: 3, picked: 2 }, c: { need: 1, picked: 1 }, e: { need: 1, picked: 1 } };
  assert.deepEqual(orderNeeds(orders, progress), { toPull: 2, toShip: 1, toPickUp: 1, short: 1, oldestPaid: "2026-11-25T10:00:00Z" });
  // Before pull progress loads, every open order still shows as work to do: none is hidden.
  assert.deepEqual(orderNeeds(orders, {}), { toPull: 4, toShip: 0, toPickUp: 0, short: 1, oldestPaid: "2026-11-25T10:00:00Z" });
  assert.equal(orderNeeds([{ id: "z", number: 9, status: "paid" }], { z: { need: 0, picked: 0 } }).toPull, 1, "an order with nothing counted is not called pulled");
  assert.deepEqual(orderNeeds([], {}), { toPull: 0, toShip: 0, toPickUp: 0, short: 0, oldestPaid: null });
});

test("orders shared with dealers: going out and coming in", () => {
  const locations = [
    { id: "main", dealer_id: "bri" },
    { id: "mcd", dealer_id: "mc" },
    { id: "abc", dealer_id: "ab" },
  ];
  const dealers = [{ id: "bri", name: "Backroad Iron" }, { id: "mc", name: "McCormick Diesel" }, { id: "ab", name: "AB Parts" }];
  const storefronts = [{ id: "sf-mc", dealer_id: "mc" }, { id: "sf-house", dealer_id: "bri" }, { id: "sf-none", dealer_id: null }];
  const from = (...l: string[]) => l.map((location_id) => ({ location_id }));
  const orders = [
    { id: "1", number: 1, status: "paid", storefront_id: null, from: from("main") }, // ours, our shelf
    { id: "2", number: 2, status: "paid", storefront_id: null, from: from("main", "mcd") }, // ours, part from McCormick
    { id: "3", number: 3, status: "paid", storefront_id: "sf-house", from: from("mcd", "abc") }, // ours, two dealers
    { id: "4", number: 4, status: "paid", storefront_id: "sf-mc", from: from("mcd") }, // theirs, their shelf
    { id: "5", number: 5, status: "paid", storefront_id: "sf-mc", from: from("main") }, // theirs, our shelf
    { id: "6", number: 6, status: "shipped", storefront_id: null, from: from("mcd") }, // done
    { id: "7", number: 7, status: "paid", storefront_id: "sf-none", from: from("abc") }, // a store with no dealer is ours
    { id: "8", number: 8, status: "paid", storefront_id: null }, // from before locations
  ];
  const net = networkOrders(orders, locations, dealers, storefronts, "bri");
  assert.equal(net.outTotal, 3);
  assert.deepEqual(net.out, [
    { dealer_id: "ab", name: "AB Parts", orders: 2 },
    { dealer_id: "mc", name: "McCormick Diesel", orders: 2 },
  ]);
  assert.equal(net.inTotal, 1);
  assert.deepEqual(net.into, [{ dealer_id: "mc", name: "McCormick Diesel", orders: 1 }]);
  assert.deepEqual(networkOrders(orders, locations, dealers, storefronts, null), { out: [], outTotal: 0, into: [], inTotal: 0 }, "nothing is guessed before routing is set up");
});

test("sales add up by today, 7 days and 30 days", () => {
  const now = Date.parse("2026-11-27T23:00:00Z");
  const dayStart = Date.parse("2026-11-27T06:00:00Z"); // midnight in Chicago
  const rows = [
    { at: "2026-11-27T15:00:00Z", cents: 5000, kind: "web" as const, refunded: 1000 },
    { at: "2026-11-27T05:30:00Z", cents: 700, kind: "counter" as const }, // yesterday evening, local time
    { at: "2026-11-22T12:00:00Z", cents: 2000, kind: "counter" as const },
    { at: "2026-11-01T12:00:00Z", cents: 9000, kind: "web" as const },
    { at: "2026-10-01T12:00:00Z", cents: 99999, kind: "web" as const }, // older than 30 days
    { at: "2026-11-28T12:00:00Z", cents: 1, kind: "web" as const }, // a clock that's ahead
    { at: "junk", cents: 1, kind: "web" as const },
  ];
  const s = salesSummary(rows, now, dayStart);
  assert.deepEqual(s.today, { web: { n: 1, cents: 5000 }, counter: { n: 0, cents: 0 }, refunded: 1000 });
  assert.deepEqual(s.week, { web: { n: 1, cents: 5000 }, counter: { n: 2, cents: 2700 }, refunded: 1000 });
  assert.deepEqual(s.month, { web: { n: 2, cents: 14000 }, counter: { n: 2, cents: 2700 }, refunded: 1000 });
});

test("stock needs: out, no price, running low", () => {
  const low = Array.from({ length: 7 }, (_, i) => ({ product_id: `p${i}`, name: `Part ${i}`, part_number: "", location_id: "L", qty: i, sold30: 0, days_left: null }));
  const s = stockNeeds([{ qty: 0, price_cents: 100 }, { qty: -1, price_cents: null }, { qty: 4, price_cents: null }, { qty: 4, price_cents: 0 }, { qty: 2, price_cents: 500 }], low);
  assert.equal(s.out, 2);
  assert.equal(s.noPrice, 2);
  assert.equal(s.low, 7);
  assert.equal(s.top.length, 5);
});

test("how long an order has waited, in plain words", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  assert.equal(waited("2026-11-27T11:59:40Z", now), "1 minute");
  assert.equal(waited("2026-11-27T11:20:00Z", now), "40 minutes");
  assert.equal(waited("2026-11-27T10:00:00Z", now), "2 hours");
  assert.equal(waited("2026-11-26T11:00:00Z", now), "25 hours");
  assert.equal(waited("2026-11-24T12:00:00Z", now), "3 days");
  assert.equal(waited(null, now), "");
  assert.equal(waited("2026-11-28T12:00:00Z", now), "");
});

test("dealer alerts that haven't gone out: waiting, failed, and why", () => {
  assert.deepEqual(alertsWaiting({ queued: 0, failed: 0 }, false), { n: 0, failed: false, detail: "No email or text service is set up yet" });
  assert.deepEqual(alertsWaiting({ queued: 3, failed: 0 }, false), { n: 3, failed: false, detail: "No email or text service is set up yet" });
  assert.deepEqual(alertsWaiting({ queued: 3, failed: 0 }, true), { n: 3, failed: false, detail: "Waiting in the outbox. Open it to send" });
  assert.deepEqual(alertsWaiting({ queued: 1, failed: 2 }, true), { n: 3, failed: true, detail: "2 failed. Open the outbox to try again" });
});

test("a dealer's quick look: open orders, the longest wait, and what shipped this week", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  const line = (location_id: string) => ({ location_id });
  const sent = (location_id: string, shipped_at: string) => ({ location_id, shipped_at });
  const orders = [
    { status: "paid", created_at: "2026-11-26T09:00:00Z", lines: [line("a")], shipped: [] }, // open
    { status: "paid", created_at: "2026-11-25T09:00:00Z", lines: [line("a"), line("b")], shipped: [sent("a", "2026-11-26T10:00:00Z")] }, // one stop still open
    { status: "shipped", created_at: "2026-11-24T09:00:00Z", lines: [line("a")], shipped: [sent("a", "2026-11-25T10:00:00Z")] }, // done this week
    { status: "shipped", created_at: "2026-11-01T09:00:00Z", lines: [line("a")], shipped: [sent("a", "2026-11-02T10:00:00Z")] }, // done long ago
  ];
  assert.deepEqual(dealerNeeds(orders, now), { open: 2, oldest: "2026-11-25T09:00:00Z", shipped7: 1 });
  assert.deepEqual(dealerNeeds([], now), { open: 0, oldest: null, shipped7: 0 });
});
