import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanReading, mergeTyped } from "../lib/reading.ts";

test("keeps well-formed values and trims the rest", () => {
  const r = cleanReading({
    part_number: "  830-FS-08 ",
    other_numbers: ["BR218-755", "N/A", 7, ""],
    upc: "0 12345 67890 5",
    description: "JIC  cap\n1/2",
    part_type: "JIC cap",
    aisle: "3",
    bin: "12",
    qty_on_card: 14.2,
    count_seen: 9,
    count_confidence: "medium",
    count_note: "two overlap",
    notes: "",
  });
  assert.equal(r.part_number, "830-FS-08");
  assert.deepEqual(r.other_numbers, ["BR218-755"]);
  assert.equal(r.upc, "012345678905");
  assert.equal(r.description, "JIC cap 1/2");
  assert.equal(r.qty_on_card, 14);
  assert.equal(r.count_confidence, "medium");
});

test("placeholder words are not part numbers", () => {
  for (const word of ["N/A", "unknown", "not visible", "illegible", "---", "?"]) {
    assert.equal(cleanReading({ part_number: word }).part_number, "", word);
  }
});

test("junk input yields an empty reading, never a crash", () => {
  for (const junk of [null, undefined, "text", 5, [], { count_seen: -3, qty_on_card: "12", count_confidence: "certain" }]) {
    const r = cleanReading(junk);
    assert.equal(r.part_number, "");
    assert.equal(r.qty_on_card, null);
    assert.equal(r.count_seen, null);
    assert.equal(r.count_confidence, null);
  }
});

test("a count with no stated confidence is treated as rough", () => {
  assert.equal(cleanReading({ count_seen: 30 }).count_confidence, "low");
});

test("what was typed on the phone wins over what the camera read", () => {
  const read = cleanReading({ part_number: "830-FS-O8", aisle: "3", bin: "12", count_seen: 11, count_confidence: "medium", other_numbers: ["BR218-755"] });
  const merged = mergeTyped({ part_number: "830-FS-08", count_seen: 14 }, read);
  assert.equal(merged.part_number, "830-FS-08");
  assert.equal(merged.bin, "12");
  assert.equal(merged.count_seen, 14);
  assert.equal(merged.count_confidence, "high");
  assert.match(merged.notes, /BR218-755/);
  assert.equal(mergeTyped({}, null).part_number, "");
});
