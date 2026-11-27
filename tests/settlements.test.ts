import assert from "node:assert/strict";
import { test } from "node:test";
import { bpsToPercent, monthName, monthOf, monthRange, percentToBps, readRouting, statementCsv, totals, type SettlementRow } from "../lib/settlements.ts";

const row = (o: Partial<SettlementRow>): SettlementRow => ({
  order_id: "o1",
  order_number: 1001,
  dealer_id: "d1",
  kind: "routed",
  parts_cents: 1000,
  shipping_cents: 1200,
  cut_bps: 1000,
  cut_cents: 100,
  card_fee_cents: 59,
  net_cents: 2041,
  created_at: "2026-11-20T18:00:00.000Z",
  paid_at: null,
  paid_note: "",
  ...o,
});

test("routing settings read safely, and know when they're set up", () => {
  assert.equal(readRouting(null).ready, false);
  assert.equal(readRouting({ hold_minutes: 30 }).ready, false);
  const r = readRouting({ route_orders: true, route_cut_bps: 750, storefront_fee_bps: 9999, house_dealer_id: "d0" });
  assert.deepEqual(r, { ready: true, house_dealer_id: "d0", route_orders: true, route_cut_bps: 750, storefront_fee_bps: 0 });
});

test("percents and basis points", () => {
  assert.equal(percentToBps("10"), 1000);
  assert.equal(percentToBps("7.5%"), 750);
  assert.equal(percentToBps("0"), 0);
  assert.ok(Number.isNaN(percentToBps("51")), "up to 50%");
  assert.ok(Number.isNaN(percentToBps("-1")));
  assert.ok(Number.isNaN(percentToBps("ten")));
  assert.equal(bpsToPercent(750), "7.5");
  assert.equal(bpsToPercent(1000), "10");
});

test("months are the shop's months", () => {
  assert.equal(monthOf("2026-12-01T03:00:00.000Z"), "2026-11", "9 PM Nov 30 in Illinois");
  assert.equal(monthOf("2026-12-01T07:00:00.000Z"), "2026-12");
  assert.equal(monthName("2026-11"), "November 2026");
  assert.deepEqual(monthRange("2026-12"), { from: "2026-12-01T05:00:00.000Z", to: "2027-01-01T07:00:00.000Z" });
});

test("statement totals leave out lines still waiting on a card fee", () => {
  const t = totals([row({}), row({ order_id: "o2", card_fee_cents: null, net_cents: null }), row({ order_id: "o3", paid_at: "2026-12-02T00:00:00Z" })]);
  assert.equal(t.parts, 3000);
  assert.equal(t.cut, 300);
  assert.equal(t.fee, 118);
  assert.equal(t.net, 4082);
  assert.equal(t.waiting, 1);
  assert.equal(t.unpaid, 2);
  assert.equal(t.unpaidNet, 2041, "an unpaid line still waiting on its fee isn't counted as owed yet");
});

test("the statement downloads as a spreadsheet", () => {
  const csv = statementCsv("McCormick Diesel", "2026-11", [row({ paid_note: "Check 1041, \"Nov\"" })]);
  const [head, line] = csv.trim().split("\n");
  assert.match(head, /^Dealer,Month,Date,Order,Kind,Parts,Shipping,Cut %,Backroad Iron cut,Card fee,Owed to dealer,Paid,Paid note$/);
  assert.equal(line, 'McCormick Diesel,2026-11,2026-11-20,#1001,Backroad Iron order,10.00,12.00,10,1.00,0.59,20.41,,"Check 1041, ""Nov"""');
});
