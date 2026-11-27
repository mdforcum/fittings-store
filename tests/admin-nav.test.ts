import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SHORTCUTS, HOME_TAB, NAV_GROUPS, SHORTCUT_LIMIT, TAB_NAMES, groupOf, groupTarget, isTab, readShortcuts, tabFromHash, toggleShortcut, type Tab } from "../lib/admin-nav.ts";

test("every back-office page is in exactly one group", () => {
  const placed = NAV_GROUPS.flatMap((g) => g.tabs);
  assert.deepEqual([...placed].sort(), (Object.keys(TAB_NAMES) as Tab[]).sort());
  assert.equal(new Set(placed).size, placed.length, "no page is listed twice");
  assert.ok(NAV_GROUPS.length <= 6, "the header stays short");
  assert.equal(NAV_GROUPS[0].name, "Home", "Home comes first");
  assert.ok(NAV_GROUPS.every((g) => g.tabs.length >= 1 && g.tabs.length <= 5));
  assert.equal(new Set(NAV_GROUPS.map((g) => g.name)).size, NAV_GROUPS.length);
});

test("pages are grouped by the job they belong to", () => {
  assert.equal(groupOf("orders").name, "Sell");
  assert.equal(groupOf("counter").name, "Sell");
  assert.equal(HOME_TAB, "home");
  assert.equal(groupOf(HOME_TAB).name, "Home");
  assert.equal(groupOf("inventory").name, "Stock");
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

test("shortcuts: saved picks are read back, and junk falls back to the starting set", () => {
  assert.deepEqual(readShortcuts(null), DEFAULT_SHORTCUTS);
  assert.deepEqual(readShortcuts("not json"), DEFAULT_SHORTCUTS);
  assert.deepEqual(readShortcuts('{"a":1}'), DEFAULT_SHORTCUTS);
  assert.deepEqual(readShortcuts('["quotes","orders","quotes","nope","home",7]'), ["quotes", "orders"], "unknown pages, repeats and Home are dropped");
  assert.deepEqual(readShortcuts("[]"), [], "an empty pick is kept: the person cleared them");
  const many = JSON.stringify(Object.keys(TAB_NAMES));
  assert.equal(readShortcuts(many).length, SHORTCUT_LIMIT);
  assert.ok(DEFAULT_SHORTCUTS.every((t) => isTab(t) && t !== "home"));
});

test("shortcuts: ticking adds at the end, unticking removes, and the limit holds", () => {
  assert.deepEqual(toggleShortcut(["orders"], "quotes"), ["orders", "quotes"]);
  assert.deepEqual(toggleShortcut(["orders", "quotes"], "orders"), ["quotes"]);
  assert.deepEqual(toggleShortcut(["orders"], "home"), ["orders"]);
  const full = (Object.keys(TAB_NAMES) as Tab[]).filter((t) => t !== "home").slice(0, SHORTCUT_LIMIT);
  const extra = (Object.keys(TAB_NAMES) as Tab[]).filter((t) => t !== "home")[SHORTCUT_LIMIT];
  assert.deepEqual(toggleShortcut(full, extra), full, "a ninth pick is not added");
});
