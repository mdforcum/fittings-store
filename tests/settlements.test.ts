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
  cut_bps: 600,
  cut_cents: 60,
  referral_cents: 0,
  network_bps: 0,
  network_cents: 0,
  card_fee_cents: 59,
  net_cents: 2081,
  created_at: "2026-11-20T18:00:00.000Z",
  paid_at: null,
  paid_note: "",
  ...o,
});

test("routing settings read safely, and know when they're set up", () => {
  assert.equal(readRouting(null).ready, false);
  assert.equal(readRouting({ hold_minutes: 30 }).ready, false);
  const r = readRouting({ route_orders: true, route_cut_bps: 750, storefront_fee_bps: 9999, house_dealer_id: "d0" });
  assert.deepEqual(r, { ready: true, house_dealer_id: "d0", route_orders: true, route_cut_bps: 750, network_fee_bps: 200, storefront_fee_bps: 0 });
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
  assert.equal(t.cut, 180);
  assert.equal(t.fee, 118);
  assert.equal(t.net, 4162);
  assert.equal(t.waiting, 1);
  assert.equal(t.unpaid, 2);
  assert.equal(t.unpaidNet, 2081, "an unpaid line still waiting on its fee isn't counted as owed yet");
});

test("the statement downloads as a spreadsheet", () => {
  const csv = statementCsv("McCormick Diesel", "2026-11", [row({ paid_note: "Check 1041, \"Nov\"" })]);
  const [head, line] = csv.trim().split("\n");
  assert.match(head, /^Dealer,Month,Date,Order,Kind,Parts shipped,Shipping,Share paid %,Share paid,Network fee,Share earned,Card fee,Owed to dealer,Paid,Paid note$/);
  assert.equal(line, 'McCormick Diesel,2026-11,2026-11-20,#1001,Backroad Iron sale,10.00,12.00,6,0.60,0.00,0.00,0.59,20.81,,"Check 1041, ""Nov"""');
});

test("both ways: shares earned and network fees add up into one owed total", async () => {
  const { totals, readSettlement } = await import("../lib/settlements.ts");
  const rows = [
    readSettlement({ order_id: "o1", dealer_id: "d", kind: "routed", parts_cents: 90000, shipping_cents: 0, cut_bps: 600, cut_cents: 5400, card_fee_cents: 0, net_cents: 84600, created_at: "2026-11-20T18:00:00Z" }, 1),
    readSettlement({ order_id: "o2", dealer_id: "d", kind: "referral", parts_cents: 0, shipping_cents: 0, referral_cents: 4000, card_fee_cents: 0, net_cents: 4000, created_at: "2026-11-21T18:00:00Z" }, 2),
    readSettlement({ order_id: "o3", dealer_id: "d", kind: "network", parts_cents: 10000, shipping_cents: 0, cut_bps: 600, cut_cents: 600, network_bps: 200, network_cents: 200, card_fee_cents: 0, net_cents: 9200, created_at: "2026-11-22T18:00:00Z" }, 3),
  ];
  const t = totals(rows);
  assert.equal(t.parts, 100000);
  assert.equal(t.cut, 6000);
  assert.equal(t.network, 200);
  assert.equal(t.earned, 4000);
  assert.equal(t.net, 97800, "$1,000 shipped + $40 earned − $60 shares − $2 network");
  assert.equal(readSettlement({ kind: "old", order_id: "x", dealer_id: "d", created_at: "x" }, null).referral_cents, 0, "older rows read as zero earned");
});
