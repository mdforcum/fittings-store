import assert from "node:assert/strict";
import { test } from "node:test";
import { groupCaptures, keysOf, normUpc, type Capture } from "../lib/match.ts";

let n = 0;
function cap(over: Partial<Capture>): Capture {
  n += 1;
  return {
    id: over.id ?? `id-${String(n).padStart(3, "0")}`,
    location_id: "shop",
    kind: "bin",
    captured_at: `2026-11-${String(10 + (n % 15)).padStart(2, "0")}T10:00:00Z`,
    status: "read",
    read_error: "",
    photo: null,
    part_number: "",
    upc: "",
    description: "",
    part_type: "",
    aisle: "",
    bin: "",
    qty_on_card: null,
    count_seen: null,
    count_confidence: null,
    count_note: "",
    codes: [],
    notes: "",
    use_location: true,
    confirmed: false,
    edited: false,
    ...over,
  };
}

function shuffled<T>(list: T[], seed: number): T[] {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Same ids and timestamps every call, so two piles can be compared.
const pile = (): Capture[] => ((n = 0), [
  // A card and its bin, tied by part number.
  cap({ id: "card-a", kind: "card", part_number: "830-FS-08", aisle: "3", bin: "12", qty_on_card: 14, description: "JIC cap 1/2" }),
  cap({ id: "bin-a", kind: "bin", part_number: "830 fs 08", count_seen: 14, count_confidence: "high" }),
  // A card and an unlabeled bin photo, tied only by where they sit.
  cap({ id: "card-b", kind: "card", part_number: "839-FS-06", aisle: "3", bin: "14", qty_on_card: 9 }),
  cap({ id: "bin-b", kind: "bin", aisle: "3", bin: "14", count_seen: 6, count_confidence: "medium" }),
  // A scanned code that turns out to be the same part as a card seen later.
  cap({ id: "code-c", kind: "code", codes: ["721-FSO-10"] }),
  cap({ id: "card-c", kind: "card", part_number: "721-FSO-10", aisle: "4", bin: "02", qty_on_card: 3 }),
  // A bin photo with nothing readable on it yet.
  cap({ id: "bin-x", kind: "bin", count_seen: 5, count_confidence: "low" }),
  // Uploaded, not read.
  cap({ id: "new-y", kind: "card", status: "pending" }),
]);

test("pairs cards with bins by part number, however it was written", () => {
  const { parts } = groupCaptures(pile());
  const a = parts.find((p) => p.part_number === "830-FS-08");
  assert.ok(a);
  assert.deepEqual([...a.captures].sort(), ["bin-a", "card-a"]);
  assert.equal(a.card_qty, 14);
  assert.equal(a.counted, 14);
  assert.deepEqual(a.flags, []);
  assert.equal(a.bin, "12");
});

test("a match that rests on bin location alone asks for confirmation", () => {
  const { parts } = groupCaptures(pile());
  const b = parts.find((p) => p.part_number === "839-FS-06");
  assert.ok(b);
  assert.deepEqual(b.by_location, ["bin-b"]);
  assert.ok(b.flags.includes("confirm"));
  assert.ok(b.flags.includes("mismatch"));

  const confirmed = pile().map((c) => (c.id === "bin-b" ? { ...c, confirmed: true } : c));
  const again = groupCaptures(confirmed).parts.find((p) => p.part_number === "839-FS-06");
  assert.deepEqual(again?.by_location, []);
  assert.ok(!again?.flags.includes("confirm"));
});

test("saying a bin is not that part splits it back out", () => {
  const split = pile().map((c) => (c.id === "bin-b" ? { ...c, use_location: false } : c));
  const survey = groupCaptures(split);
  const b = survey.parts.find((p) => p.part_number === "839-FS-06");
  assert.deepEqual(b?.captures, ["card-b"]);
  assert.ok(survey.waiting.some((c) => c.id === "bin-b"));
});

test("a scanned code joins the card that carries the same number", () => {
  const { parts } = groupCaptures(pile());
  const c = parts.find((p) => p.part_number === "721-FSO-10");
  assert.deepEqual([...(c?.captures ?? [])].sort(), ["card-c", "code-c"]);
});

test("captures with nothing to match on wait; unread ones are listed apart", () => {
  const survey = groupCaptures(pile());
  assert.deepEqual(survey.waiting.map((c) => c.id), ["bin-x"]);
  assert.deepEqual(survey.unread.map((c) => c.id), ["new-y"]);
});

test("the order photos arrive in never changes the result", () => {
  const want = JSON.stringify(groupCaptures(pile()));
  for (let seed = 1; seed <= 40; seed++) {
    assert.equal(JSON.stringify(groupCaptures(shuffled(pile(), seed))), want, `seed ${seed}`);
  }
});

test("a late capture can stitch two groups together", () => {
  // Day 1: an unlabeled bin photo at aisle 7 bin 3. Day 2: a code scanned with no location.
  const early = [
    cap({ id: "bin-1", kind: "bin", aisle: "7", bin: "3", count_seen: 20, count_confidence: "high" }),
    cap({ id: "code-1", kind: "code", codes: ["012345678905"] }),
  ];
  assert.equal(groupCaptures(early).parts.length, 2);
  // Day 5: the card names the part, its UPC and its location, and everything falls into one group.
  const late = cap({ id: "card-1", kind: "card", part_number: "BF7633", upc: "0012345678905", aisle: "7", bin: "3", qty_on_card: 20 });
  const { parts } = groupCaptures([...early, late]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].part_number, "BF7633");
  assert.equal(parts[0].upc, "012345678905");
  assert.equal(parts[0].counted, 20);
  assert.deepEqual(parts[0].by_location, ["bin-1"]);
});

test("two part numbers in one bin are flagged, not silently merged", () => {
  const { parts } = groupCaptures([
    cap({ id: "c1", kind: "card", part_number: "A-100", aisle: "1", bin: "1" }),
    cap({ id: "c2", kind: "card", part_number: "A-200", aisle: "1", bin: "1" }),
  ]);
  assert.equal(parts.length, 1);
  assert.ok(parts[0].flags.includes("conflict"));
  assert.equal(parts[0].other_numbers.length, 1);
});

test("look-alike part numbers are pointed out", () => {
  const { parts } = groupCaptures([
    cap({ id: "c1", kind: "card", part_number: "830-FS-08" }),
    cap({ id: "c2", kind: "bin", part_number: "830-FS-O8" }),
  ]);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.flags.includes("lookalike")));
});

test("the same part number in two shops stays two parts", () => {
  const { parts } = groupCaptures([
    cap({ id: "c1", kind: "card", part_number: "X1", location_id: "shop-a" }),
    cap({ id: "c2", kind: "card", part_number: "X1", location_id: "shop-b" }),
  ]);
  assert.equal(parts.length, 2);
});

test("a low-confidence count is marked rough rather than called a mismatch", () => {
  const { parts } = groupCaptures([
    cap({ id: "c1", kind: "card", part_number: "P9", qty_on_card: 40 }),
    cap({ id: "b1", kind: "bin", part_number: "P9", count_seen: 25, count_confidence: "low" }),
  ]);
  assert.deepEqual(parts[0].flags, ["rough_count"]);
});

test("the newest card and newest count win", () => {
  const { parts } = groupCaptures([
    cap({ id: "old", kind: "card", part_number: "P1", qty_on_card: 5, captured_at: "2026-11-01T10:00:00Z" }),
    cap({ id: "new", kind: "card", part_number: "P1", qty_on_card: 2, captured_at: "2026-11-20T10:00:00Z" }),
  ]);
  assert.equal(parts[0].card_qty, 2);
});

test("codes: 13 digits with a leading zero equals the 12-digit form", () => {
  assert.equal(normUpc("0012345678905"), "012345678905");
  assert.deepEqual(keysOf(cap({ codes: ["0012345678905"] })).strong, ["upc:012345678905"]);
  assert.deepEqual(keysOf(cap({ codes: ["2408-12"] })).strong, ["pn:240812"]);
});
