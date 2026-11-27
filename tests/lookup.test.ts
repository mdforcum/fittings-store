import assert from "node:assert/strict";
import { test } from "node:test";
import { codeKey, exactLookup, goesWith, nearWord, photoMatches, smartSearch, soldTogether, type LookupIndex } from "../lib/lookup.ts";

const parts = [
  { id: "tee", name: "JIC tee", part_number: "2603-08" },
  { id: "elbow", name: "JIC elbow 90", part_number: "2500-08-08" },
  { id: "cap", name: "JIC cap", part_number: "CAP-4" },
  { id: "kit", name: "Injector seal kit", part_number: "IK-2" },
];
const index: LookupIndex = {
  codes: [
    { norm: "012345678905", product_id: "tee", label: "UPC 012345678905" },
    { norm: "86572263", product_id: "tee", label: "Replaces CNH 86572263" },
    { norm: "AB123", product_id: "elbow", label: "Replaces AB-123" },
    { norm: "GONE1", product_id: "not-in-this-store", label: "Replaces GONE-1" },
  ],
  bins: [{ code: "A-03-2", line: "Aisle A, Section 03, Bin 2", product_ids: ["tee", "elbow", "cap"] }],
  pairs: { tee: ["cap", "kit"] },
};

test("a scanned or typed code means one thing: our number, then other numbers, then a bin", () => {
  assert.equal(codeKey("00123-45"), "12345");
  assert.equal(codeKey("ab 12/3"), "AB123");
  assert.deepEqual(exactLookup("2603 08", parts, index), { kind: "part", ids: ["tee"], because: "" });
  assert.deepEqual(exactLookup("0012345678905", parts, index), { kind: "part", ids: ["tee"], because: "UPC 012345678905" }, "a UPC scanned with an extra leading zero is the same code");
  assert.deepEqual(exactLookup("ab-123", parts, index), { kind: "part", ids: ["elbow"], because: "Replaces AB-123" });
  assert.equal(exactLookup("a032", parts, index)?.kind, "bin");
  assert.equal(exactLookup("GONE-1", parts, index), null, "a number for a part this store doesn't carry finds nothing");
  assert.equal(exactLookup("2603", parts, index), null, "part of a number is not an exact match");
  assert.equal(exactLookup("x", parts, index), null);
});

test("search as you type: numbers anywhere, all words, a typing slip forgiven, on-shelf first", () => {
  const ids = (q: string, shelf?: (id: string) => number) => smartSearch(q, parts, index, shelf).map((f) => f.id);
  assert.deepEqual(ids("2603"), ["tee"]);
  assert.deepEqual(ids("0808"), ["elbow"], "matches inside a part number");
  assert.deepEqual(ids("8657"), ["tee"], "a number it replaces");
  assert.equal(smartSearch("8657", parts, index)[0].because, "Replaces CNH 86572263");
  assert.deepEqual(ids("jic"), ["cap", "elbow", "tee"], "ties sort by name");
  assert.deepEqual(ids("jic", (id) => (id === "tee" ? 4 : 0)), ["tee", "cap", "elbow"], "what's on this shelf comes first");
  assert.deepEqual(ids("elbow jic"), ["elbow"], "every word must match, in any order");
  assert.deepEqual(ids("injecter"), ["kit"]);
  assert.equal(smartSearch("injecter", parts, index)[0].because, "Close spelling");
  assert.deepEqual(ids("pump"), []);
  assert.deepEqual(ids("  "), []);
  assert.ok(nearWord("elbow", "elbwo") && nearWord("seal", "seel") && nearWord("tee", "te") && !nearWord("cap", "tee") && !nearWord("elbow", "el"));
});

test("what goes with a part: its bin mates and what sold with it before", () => {
  const g = goesWith("tee", index);
  assert.equal(g.bin?.code, "A-03-2");
  assert.deepEqual(g.sameBin, ["elbow", "cap"]);
  assert.deepEqual(g.soldWith, ["kit"], "a part already listed as a bin mate isn't repeated");
  assert.deepEqual(goesWith("tee", index, new Set(["elbow", "kit"])), { bin: index.bins[0], sameBin: ["cap"], soldWith: [] });
  assert.deepEqual(goesWith("kit", index), { bin: null, sameBin: [], soldWith: [] });
});

test("sold-together pairs need to happen more than once", () => {
  const pairs = soldTogether([["tee", "cap"], ["tee", "cap", "kit"], ["tee", "kit"], ["elbow", "kit"], ["tee", "tee"]]);
  assert.deepEqual(pairs.tee, ["cap", "kit"]);
  assert.deepEqual(pairs.cap, ["tee"]);
  assert.equal(pairs.elbow, undefined, "one sale together isn't a pattern");
});

test("a photo's reading points to parts by number first, then by name, and never invents one", () => {
  const read = { part_number: "2603-08", other_numbers: [], upc: "", description: "" };
  assert.deepEqual(photoMatches(read, parts, index), [{ id: "tee", why: "number", because: "The part number 2603-08 matches" }]);
  assert.deepEqual(photoMatches({ ...read, part_number: "", upc: "012345678905" }, parts, index)[0], { id: "tee", why: "number", because: "The barcode number 012345678905 matches" });
  assert.deepEqual(photoMatches({ part_number: "ZZZ-9", other_numbers: ["AB123"], upc: "", description: "tee" }, parts, index).map((m) => [m.id, m.why]), [["elbow", "number"]], "a number match beats a name guess");
  assert.deepEqual(photoMatches({ part_number: "ZZZ-9", other_numbers: [], upc: "", description: "seal kit" }, parts, index), [{ id: "kit", why: "words", because: "The name looks alike" }]);
  assert.deepEqual(photoMatches({ part_number: "ZZZ-9", other_numbers: [], upc: "", description: "hydraulic pump" }, parts, index), []);
});
