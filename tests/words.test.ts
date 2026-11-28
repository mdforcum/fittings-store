import assert from "node:assert/strict";
import { test } from "node:test";
import { editDistance, prepareWords, stem, termTier } from "../lib/words.ts";

test("plurals come back to one, short words and numbers are left alone", () => {
  assert.equal(stem("plugs"), "plug");
  assert.equal(stem("hoses"), "hose");
  assert.equal(stem("boxes"), "box");
  assert.equal(stem("bushes"), "bush");
  assert.equal(stem("glass"), "glass");
  assert.equal(stem("gas"), "gas");
  assert.equal(stem("16s"), "16s");
});

test("typing slips are counted, and counting stops early", () => {
  assert.equal(editDistance("hydraulic", "hydraulic", 2), 0);
  assert.equal(editDistance("adaptor", "adapter", 1), 1);
  assert.equal(editDistance("guage", "gauge", 1), 1, "two letters swapped is one slip");
  assert.equal(editDistance("hydrolic", "hydraulic", 2), 2);
  assert.equal(editDistance("plug", "hose", 1), 2, "past the limit it just says too far");
  assert.equal(editDistance("cap", "adapter", 2), 3);
});

test("a word matches in whatever form it is typed", () => {
  const w = prepareWords("O-Ring Boss Plug 3/4-16 Hydraulic");
  assert.equal(termTier(w, "o-ring"), 3, "as written");
  assert.equal(termTier(w, "oring"), 2, "no hyphen");
  assert.equal(termTier(w, "ORing"), 2);
  assert.equal(termTier(w, "orings"), 2, "plural, no hyphen");
  assert.equal(termTier(w, "plugs"), 2, "plural");
  assert.equal(termTier(w, "hyd"), 3, "the start of a word");
  assert.equal(termTier(w, "orb"), 2, "shop shorthand for O-ring boss");
  assert.equal(termTier(w, "hydrolic"), 1, "a misspelling");
  assert.equal(termTier(w, "hidraulic"), 1);
  assert.equal(termTier(w, "bos"), 3);
  assert.equal(termTier(w, "cap"), 0);
  assert.equal(termTier(w, "elbow"), 0);
  // The other way round: the catalog says "Oring", the shopper types "o-ring" or "o ring".
  const flat = prepareWords("Oring kit, ORB plug");
  assert.equal(termTier(flat, "o-ring"), 2);
  assert.equal(termTier(flat, "boss"), 2, "ORB brings O-ring boss with it");
  assert.equal(termTier(prepareWords("Greese zerks"), "zerk"), 3);
  assert.equal(termTier(prepareWords("90° zerk"), "grease"), 2);
  assert.equal(termTier(prepareWords("1/4 NPT plug"), "pipe"), 2, "NPT is a pipe thread");
  assert.equal(termTier(prepareWords("1/4 pipe plug"), "npt"), 0, "but not every pipe thread is NPT");
});

test("sizes and numbers are never guessed at", () => {
  const w = prepareWords("JIC Cap 3/4-16 -08 part 830-FS-08");
  assert.equal(termTier(w, "3/4-16"), 3);
  assert.equal(termTier(w, "3/4"), 3);
  assert.equal(termTier(w, "3416"), 2, "the same size typed without marks");
  assert.equal(termTier(w, "3/4-14"), 0, "a different thread is a different part");
  assert.equal(termTier(w, "7/8-16"), 0);
  assert.equal(termTier(w, "830fs08"), 2);
  assert.equal(termTier(w, "830fs06"), 0);
  assert.equal(termTier(w, "-06"), 0);
});

test("short words are not fuzzed, and extra text can match but is not the main text", () => {
  const w = prepareWords("JIC cap", "Hydraulic fittings. Seals a male flare end.");
  assert.equal(termTier(w, "cup"), 0, "three letters are too few to guess from");
  assert.equal(termTier(w, "caps"), 2);
  assert.equal(termTier(w, "fitting"), 2, "found in the extra text");
  assert.equal(termTier(w, "flare"), 2);
  assert.equal(termTier(w, "seal"), 2);
  assert.equal(termTier(w, ""), 3);
  assert.equal(termTier(w, "-"), 0);
});
