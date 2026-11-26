import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../lib/catalog.ts";
import { cartTotals, checkoutPlan, clockLabel, coreCredit, freeShipNudge, shipDay } from "../lib/checkout-rules.ts";

test("core credit: full to day 30, 85% to day 60, nothing after", () => {
  const sold = new Date("2026-11-02T15:00:00Z");
  assert.deepEqual(coreCredit(10000, sold, new Date("2026-11-02T20:00:00Z")).cents, 10000);
  assert.equal(coreCredit(10000, sold, new Date("2026-12-02T23:00:00Z")).days, 30);
  assert.equal(coreCredit(10000, sold, new Date("2026-12-02T23:00:00Z")).cents, 10000);
  // 00:30 UTC on Dec 3 is still Dec 2 in Central time: day 30.
  assert.equal(coreCredit(10000, sold, new Date("2026-12-03T00:30:00Z")).days, 30);
  const d31 = coreCredit(10001, sold, "2026-12-03");
  assert.equal(d31.days, 31);
  assert.equal(d31.cents, 8500); // 85% of $100.01, rounded down to the cent
  assert.equal(coreCredit(10000, sold, new Date("2027-01-01T12:00:00Z")).cents, 8500); // day 60
  const late = coreCredit(10000, sold, new Date("2027-01-02T12:00:00Z"));
  assert.equal(late.cents, 0);
  assert.equal(late.days, 61);
  assert.match(late.text, /past the 60-day limit/);
});

test("same-day cutoff in Central time, weekends and Fridays roll to Monday", () => {
  // 2026-11-25 is a Wednesday. 9:00 Central = 15:00 UTC.
  assert.deepEqual(shipDay(new Date("2026-11-25T15:00:00Z")), { today: true, text: "Order by 2 pm Central and in-stock parts ship today." });
  // 12:45 Central: 75 minutes left.
  assert.equal(shipDay(new Date("2026-11-25T18:45:00Z")).text, "Order in the next 1 h 15 min and in-stock parts ship today.");
  // 13:50 Central.
  assert.equal(shipDay(new Date("2026-11-25T19:50:00Z")).text, "Order in the next 10 min and in-stock parts ship today.");
  // 14:00 Central on a Wednesday: tomorrow.
  assert.deepEqual(shipDay(new Date("2026-11-25T20:00:00Z")), { today: false, text: "In-stock parts ordered now ship tomorrow." });
  // Friday 15:00 Central, Saturday, Sunday: Monday.
  assert.equal(shipDay(new Date("2026-11-27T21:00:00Z")).text, "In-stock parts ordered now ship Monday.");
  assert.equal(shipDay(new Date("2026-11-28T16:00:00Z")).text, "In-stock parts ordered now ship Monday.");
  assert.equal(shipDay(new Date("2026-11-29T16:00:00Z")).text, "In-stock parts ordered now ship Monday.");
  assert.equal(clockLabel("9:30"), "9:30 am");
  assert.equal(clockLabel("12:00"), "12 pm");
});

test("checkout plan: freight is quoted, quote-only items stop online checkout, pickup has no freight", () => {
  const l = (ship_class: "parcel" | "freight" | "pickup" | "oversize" | "restricted", price_mode: "cart" | "quote" = "cart") => ({ id: "x", qty: 1, ship_class, price_mode });
  assert.deepEqual(checkoutPlan([l("parcel"), l("restricted")]), { method: "parcel", online: true, reason: "" });
  assert.equal(checkoutPlan([l("parcel"), l("freight")]).online, false);
  assert.equal(checkoutPlan([l("oversize")]).method, "freight");
  assert.deepEqual(checkoutPlan([l("pickup"), l("parcel")]), { method: "pickup", online: true, reason: "" });
  assert.match(checkoutPlan([l("parcel", "quote")]).reason, /priced by quote/);
});

test("cart totals: cores ride on their own line and don't count toward free shipping", () => {
  const settings = { ...DEFAULT_SETTINGS, free_ship_over_cents: 24900, shipping_flat_cents: 800, order_min_cents: 1500 };
  const line = (id: string, price_cents: number, qty = 1, ship_class: "parcel" | "pickup" = "parcel") => ({ id, qty, price_cents, ship_class, price_mode: "cart" as const });
  const charges = { pump: [{ kind: "core" as const, amount_cents: 15000, refundable: true, label: "Core charge" }] };
  const a = cartTotals([line("pump", 20000)], charges, settings);
  assert.equal(a.subtotal, 20000);
  assert.equal(a.chargesTotal, 15000);
  assert.equal(a.shipping, 800); // $200 of parts: under $249 even with the $150 core
  assert.equal(a.total, 35800);
  assert.equal(a.charges[0].label, "Core charge");
  const b = cartTotals([line("pump", 20000), line("filter", 4900, 1)], charges, settings);
  assert.equal(b.shipping, 0);
  const c = cartTotals([line("pump", 20000, 2, "pickup")], charges, settings);
  assert.equal(c.shipping, 0);
  assert.equal(c.chargesTotal, 30000);
  assert.equal(cartTotals([line("cap", 900)], {}, settings).short, 600);
  assert.equal(freeShipNudge(20000, settings), "Add $49.00 more for free shipping.");
  assert.equal(freeShipNudge(24900, settings), "");
  assert.equal(freeShipNudge(100, { ...settings, free_ship_over_cents: null }), "");
});
