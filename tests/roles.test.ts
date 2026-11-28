import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_RULES, checkProblem, checkStep, eventText, readRole, readRules, splitCounts, type ShipCheck } from "../lib/roles.ts";

test("roles and rules read safely, before and after the database change", () => {
  assert.equal(readRole("worker"), "worker");
  assert.equal(readRole("manager"), "manager");
  assert.equal(readRole(undefined), "manager", "before roles existed, every login could do everything");
  assert.deepEqual(readRules({ id: "d", name: "McCormick" }, true), NO_RULES, "no rule columns yet");
  assert.deepEqual(readRules({ ship_check: "any", count_hold_over: 5 }, false), NO_RULES, "tables not there yet");
  assert.deepEqual(readRules({ ship_check: "any", count_hold_over: 5 }, true), { ready: true, ship_check: "any", count_hold_over: 5 });
  assert.deepEqual(readRules({ ship_check: "weird", count_hold_over: -3 }, true), { ready: true, ship_check: "off", count_hold_over: 0 });
  assert.deepEqual(readRules(null, true), NO_RULES);
});

test("the second check: who can do what, and why not", () => {
  const packed: ShipCheck = { packed_by: "kim", packed_name: "Kim", packed_at: "2026-11-27T10:00:00Z", checked_name: "", checked_at: null, override_reason: "" };
  const kim = { id: "kim", role: "worker" as const };
  const lee = { id: "lee", role: "worker" as const };
  const doc = { id: "doc", role: "manager" as const };
  assert.deepEqual(checkStep("off", null, kim), { state: "none" });
  assert.deepEqual(checkStep("off", packed, kim), { state: "none" }, "turned off, an old packed mark gets in nobody's way");
  assert.deepEqual(checkStep("any", null, kim), { state: "pack" });
  assert.deepEqual(checkStep("any", packed, kim), { state: "wait", canCheck: false, canOverride: false, why: "You packed this, so someone else has to check it." });
  assert.deepEqual(checkStep("any", packed, lee), { state: "wait", canCheck: true, canOverride: false, why: "" });
  assert.deepEqual(checkStep("any", packed, doc), { state: "wait", canCheck: true, canOverride: true, why: "" });
  assert.deepEqual(checkStep("manager", packed, lee), { state: "wait", canCheck: false, canOverride: false, why: "A manager has to check this." });
  assert.deepEqual(checkStep("manager", packed, doc), { state: "wait", canCheck: true, canOverride: true, why: "" });
  const byDoc = { ...packed, packed_by: "doc", packed_name: "Doc" };
  assert.deepEqual(checkStep("manager", byDoc, doc), { state: "wait", canCheck: false, canOverride: true, why: "You packed this, so someone else has to check it." }, "a manager alone can only override");
  assert.deepEqual(checkStep("any", { ...packed, checked_at: "2026-11-27T10:05:00Z", checked_name: "Lee" }, kim), { state: "done" });
});

test("a worker's big count waits for a manager; small ones and a manager's go through", () => {
  const rules = { ready: true, ship_check: "off" as const, count_hold_over: 5 };
  const have: Record<string, number> = { a: 10, b: 10, c: 10, d: 0 };
  const now = (id: string) => have[id] ?? 0;
  const lines = [{ product_id: "a", qty: 12 }, { product_id: "b", qty: 15 }, { product_id: "c", qty: 16 }, { product_id: "d", qty: 40 }, { product_id: "new", qty: 5 }];
  assert.deepEqual(splitCounts(lines, now, "worker", rules), {
    apply: [{ product_id: "a", qty: 12 }, { product_id: "b", qty: 15 }, { product_id: "new", qty: 5 }],
    hold: [{ product_id: "c", from: 10, to: 16 }, { product_id: "d", from: 0, to: 40 }],
  });
  assert.deepEqual(splitCounts([{ product_id: "a", qty: 3 }], now, "worker", rules).hold, [{ product_id: "a", from: 10, to: 3 }], "a big drop waits too");
  assert.deepEqual(splitCounts(lines, now, "manager", rules), { apply: lines, hold: [] });
  assert.deepEqual(splitCounts(lines, now, "worker", NO_RULES), { apply: lines, hold: [] }, "before the database change nothing waits");
  assert.deepEqual(splitCounts([{ product_id: "a", qty: 11 }], now, "worker", { ...rules, count_hold_over: 0 }).hold.length, 1, "set to 0, every change waits");
});

test("refusals and the activity log read in plain words", () => {
  assert.equal(checkProblem("ship check needed"), "This order needs a second check before it ships.");
  assert.equal(checkProblem("same person"), "You packed this, so someone else has to check it. A manager can override with a reason.");
  assert.equal(checkProblem("manager needed"), "A manager has to do this.");
  assert.equal(checkProblem("something odd from the database"), "That didn't save. Try again.");
  assert.equal(eventText({ action: "packed", user_name: "Kim", order_number: 5002 }), "Kim packed order #5002");
  assert.equal(eventText({ action: "checked", user_name: "Lee", order_number: 5002, detail: { packed_by: "Kim" } }), "Lee checked order #5002, packed by Kim");
  assert.equal(eventText({ action: "override", user_name: "Doc", order_number: 7, detail: { reason: "Alone today" } }), "Doc overrode the second check on order #7: Alone today");
  assert.equal(eventText({ action: "count_held", user_name: "Kim", detail: { name: "JIC cap", from: 10, to: 40 } }), "Kim counted JIC cap: 10 to 40, waiting for a manager");
  assert.equal(eventText({ action: "count_approved", user_name: "Doc", detail: { product_id: "cap", from: 10, to: 40, asked_by: "Kim" } }), "Doc approved Kim's count of cap: 10 to 40");
  assert.equal(eventText({ action: "shipped", user_name: "Lee", order_number: 9, detail: { carrier: "UPS", tracking: "1Z9" } }), "Lee shipped order #9 (UPS 1Z9)");
  assert.equal(eventText({ action: "mystery", user_name: "" }), "Someone: mystery");
});
