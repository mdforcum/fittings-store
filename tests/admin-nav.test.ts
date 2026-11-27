import assert from "node:assert/strict";
import { test } from "node:test";
import { HOME_TAB, NAV_GROUPS, TAB_NAMES, groupOf, groupTarget, isTab, tabFromHash, type Tab } from "../lib/admin-nav.ts";

test("every back-office page is in exactly one group", () => {
  const placed = NAV_GROUPS.flatMap((g) => g.tabs);
  assert.deepEqual([...placed].sort(), (Object.keys(TAB_NAMES) as Tab[]).sort());
  assert.equal(new Set(placed).size, placed.length, "no page is listed twice");
  assert.ok(NAV_GROUPS.length <= 5, "the header stays short");
  assert.ok(NAV_GROUPS.every((g) => g.tabs.length >= 1 && g.tabs.length <= 5));
  assert.equal(new Set(NAV_GROUPS.map((g) => g.name)).size, NAV_GROUPS.length);
});

test("pages are grouped by the job they belong to", () => {
  assert.equal(groupOf("orders").name, "Sell");
  assert.equal(groupOf("counter").name, "Sell");
  assert.equal(groupOf(HOME_TAB).name, "Stock");
  assert.equal(groupOf("spacemap").name, "Stock");
  assert.equal(groupOf("machines").name, "Catalog");
  assert.equal(groupOf("dealers").name, "Dealers");
  assert.equal(groupOf("statements").name, "Dealers");
  assert.equal(groupOf("settings").name, "Settings");
});

test("the address picks the page, and junk is ignored", () => {
  assert.equal(tabFromHash("#orders"), "orders");
  assert.equal(tabFromHash("#Dealers"), "dealers");
  assert.equal(tabFromHash("statements"), "statements");
  assert.equal(tabFromHash(""), null);
  assert.equal(tabFromHash("#nope"), null);
  assert.equal(tabFromHash("#constructor"), null);
  assert.equal(isTab("toString"), false);
});

test("a group opens on the page last used there, else its first page", () => {
  const stock = groupOf("inventory");
  assert.equal(groupTarget(stock, {}), "inventory");
  assert.equal(groupTarget(stock, { stock: "spots" }), "spots");
  assert.equal(groupTarget(stock, { stock: "orders" }), "inventory", "a page from another group is not used");
  assert.equal(groupTarget(groupOf("orders"), { stock: "spots" }), "orders");
});
