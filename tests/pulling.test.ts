import assert from "node:assert/strict";
import { test } from "node:test";
import type { LookupIndex } from "../lib/lookup.ts";
import { pullOrder, pullProgress, scanForPull, scanSay, type PullLine } from "../lib/pulling.ts";

const line = (product_id: string, name: string, part_number: string, qty: number, picked: number, bin: string | null): PullLine => ({ product_id, name, part_number, qty, picked, location_id: "L", bin: bin ? { code: bin, line: bin } : null });
const lines = [line("tee", "JIC tee", "2603-08", 2, 0, "M-10"), line("cap", "JIC cap", "CAP-4", 1, 1, "M-2"), line("kit", "Seal kit", "IK-2", 1, 0, null)];
const index: LookupIndex = {
  codes: [
    { norm: "012345678905", product_id: "tee", label: "UPC 012345678905" },
    { norm: "5550001", product_id: "plug", label: "UPC 5550001" },
  ],
  bins: [{ code: "M-2", line: "", product_ids: ["cap"] }, { code: "M-10", line: "", product_ids: ["tee"] }, { code: "M-7", line: "", product_ids: ["plug"] }],
  pairs: {},
};
const catalog = [{ id: "plug", name: "Drain plug", part_number: "DP-1" }, { id: "tee", name: "JIC tee", part_number: "2603-08" }];

test("progress counts parts, not lines, and never more than was asked for", () => {
  assert.deepEqual(pullProgress(lines), { need: 4, have: 1, done: false });
  assert.deepEqual(pullProgress([{ qty: 2, picked: 5 }, { qty: 1, picked: 1 }]), { need: 3, have: 3, done: true });
  assert.deepEqual(pullProgress([]), { need: 0, have: 0, done: false }, "nothing to pull is not 'done'");
});

test("the walk goes bin by bin in shelf order, parts with no bin last", () => {
  assert.deepEqual(pullOrder(lines).map((l) => l.product_id), ["cap", "tee", "kit"], "M-2 comes before M-10");
});

test("a scan while pulling: the part, a full line, a bin, the wrong part, nothing", () => {
  assert.deepEqual(scanForPull("2603 08", lines, index), { kind: "picked", product_id: "tee", name: "JIC tee", picked: 1, qty: 2 });
  assert.deepEqual(scanForPull("0012345678905", lines, index), { kind: "picked", product_id: "tee", name: "JIC tee", picked: 1, qty: 2 }, "by its UPC, with an extra leading zero");
  assert.deepEqual(scanForPull("cap-4", lines, index), { kind: "full", name: "JIC cap", qty: 1 });
  const bin = scanForPull("m-10", lines, index);
  assert.ok(bin.kind === "bin" && bin.code === "M-10" && bin.lines.map((l) => l.product_id).join() === "tee");
  const empty = scanForPull("M-7", lines, index);
  assert.ok(empty.kind === "bin" && empty.lines.length === 0, "a real bin with nothing for this order");
  assert.deepEqual(scanForPull("DP-1", lines, index, catalog), { kind: "wrong", name: "Drain plug", part_number: "DP-1" });
  assert.deepEqual(scanForPull("5550001", lines, index, catalog), { kind: "wrong", name: "Drain plug", part_number: "DP-1" }, "a wrong part by its UPC is named too");
  assert.deepEqual(scanForPull("5550001", lines, index), { kind: "wrong", name: "", part_number: "" }, "without the catalog it is still flagged");
  assert.deepEqual(scanForPull("NOPE-9", lines, index, catalog), { kind: "unknown" });
  assert.deepEqual(scanForPull("x", lines, index), { kind: "unknown" });
});

test("what the page says after a scan", () => {
  assert.deepEqual(scanSay(scanForPull("2603-08", lines, index), 5002), { text: "JIC tee: 1 of 2.", bad: false });
  const second = lines.map((l) => (l.product_id === "tee" ? { ...l, picked: 1 } : l));
  assert.deepEqual(scanSay(scanForPull("2603-08", second, index), 5002), { text: "JIC tee: got all 2.", bad: false });
  assert.deepEqual(scanSay(scanForPull("IK-2", lines, index), 5002), { text: "Seal kit: got it.", bad: false });
  assert.deepEqual(scanSay(scanForPull("CAP-4", lines, index), 5002), { text: "JIC cap: you already have it. Put the extra back.", bad: true });
  assert.deepEqual(scanSay(scanForPull("DP-1", lines, index, catalog), 5002), { text: "Wrong part. That is DP-1 Drain plug. It isn't on order #5002. Put it back.", bad: true });
  assert.deepEqual(scanSay(scanForPull("5550001", lines, index), 5002), { text: "Wrong part. That part isn't on order #5002. Put it back.", bad: true });
  assert.deepEqual(scanSay(scanForPull("M-10", lines, index), 5002), { text: "Bin M-10. Take: 2 × JIC tee.", bad: false });
  assert.deepEqual(scanSay(scanForPull("M-2", lines, index), 5002), { text: "Bin M-2. Take: 1 × JIC cap (already pulled).", bad: false });
  assert.deepEqual(scanSay(scanForPull("M-7", lines, index), 5002), { text: "Bin M-7: nothing on order #5002 is kept there.", bad: true });
  assert.equal(scanSay(scanForPull("NOPE", lines, index), 5002).bad, true);
});
