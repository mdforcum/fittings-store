import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { identifySerial, inRun, matchSentence, type SerialRun } from "../lib/serials.ts";

const run = (machine_id: string, prefix: string, serial_from: string, serial_to: string, year: number | null = null, confidence: SerialRun["confidence"] = "reference"): SerialRun => ({
  machine_id,
  prefix,
  serial_from,
  serial_to,
  year,
  note: "",
  confidence,
});

test("Cat: the prefix decides, the 17-character PIN reads the same", () => {
  const r = run("320d", "PHX", "PHX00001", "", null, "oem");
  assert.equal(inRun("PHX01234", r), true);
  assert.equal(inRun("phx-01234", r), true);
  assert.equal(inRun("CAT0320DCPHX01234", r), true);
  assert.equal(inRun("SPN01234", r), false);
  const broken = run("416", "5PC", "5PC00001", "5PC06191");
  assert.equal(inRun("5PC06191", broken), true);
  assert.equal(inRun("5PC06192", broken), false);
});

test("Case numbered runs, including a run that changes numbering partway", () => {
  assert.equal(inRun("8960000", run("580c", "", "8957501", "8969419", 1977)), true);
  assert.equal(inRun("8970000", run("580c", "", "8957501", "8969419", 1977)), false);
  const k1987 = run("580k", "", "17417850", "JJG0006900", 1987);
  assert.equal(inRun("17418000", k1987), true);
  assert.equal(inRun("JJG0003000", k1987), true);
  assert.equal(inRun("JJG0007000", k1987), false);
  // An open start ("up to JJG0164348") still needs the same letters.
  const superK = run("580sk", "JJG", "", "JJG0164348", 1992);
  assert.equal(inRun("JJG0100000", superK), true);
  assert.equal(inRun("N5C415308", superK), false);
  // Letters on one side, digits only on the other: no match across numberings.
  assert.equal(inRun("JJG0003000", run("x", "", "8279001", "8307000")), false);
});

test("the build year is the latest run that starts at or below the serial", () => {
  const runs = [run("1066", "", "7101", "12676", 1971), run("1066", "", "12677", "24204", 1972), run("1066", "", "56672", "", 1976)];
  assert.deepEqual(
    identifySerial("13000", runs).map((m) => m.year),
    [1972],
  );
  assert.deepEqual(
    identifySerial("60000", runs).map((m) => m.year),
    [1976],
  );
  assert.deepEqual(identifySerial("5000", runs), []);
  // An open last year takes only serials written the same width: a 7-digit Case number is not a 1066.
  assert.equal(inRun("8970281", runs[2]), false);
  // N-series PINs keep their whole lead.
  assert.equal(inRun("N5C415308", run("580m2", "N5C", "N5C415308", "N5C420059", 2004)), true);
  assert.equal(inRun("N4C415308", run("580m2", "N5C", "N5C415308", "N5C420059", 2004)), false);
});

test("several machines can share one sequence; the best evidence comes first", () => {
  const runs = [run("7110", "JJA", "JJA0001501", "JJA0010000", 1988), run("7140", "JJA", "JJA0001501", "JJA0010000", 1988, "oem"), run("d6t", "JNM", "JNM00001", "")];
  const m = identifySerial("JJA0002000", runs);
  assert.deepEqual(
    m.map((x) => x.machine_id),
    ["7140", "7110"],
  );
  assert.equal(matchSentence(m[0], "Case IH 7140"), "Case IH 7140, built in 1988");
  assert.equal(matchSentence(m[1], "Case IH 7110"), "Case IH 7110, built in 1988 (check the plate to confirm)");
});

test("the starter lineup file is well formed", () => {
  const doc = JSON.parse(readFileSync(new URL("../data/machine-lineup.json", import.meta.url), "utf8")) as {
    machines: Array<{ make: string; model: string; kind: string; runs: Array<{ prefix: string; from: string; to: string; confidence: string }> }>;
  };
  assert.ok(doc.machines.length > 300);
  const keys = new Set<string>();
  for (const m of doc.machines) {
    const k = `${m.make}|${m.model}`.toLowerCase();
    assert.ok(!keys.has(k), `duplicate ${k}`);
    keys.add(k);
    assert.ok(m.model.length <= 40 && m.make.length <= 40);
    for (const r of m.runs) {
      assert.match(r.prefix, /^[A-Z0-9]{0,6}$/);
      assert.ok(["oem", "reference", "seller", "single"].includes(r.confidence));
    }
  }
  // Cat's own guide puts PHX on the 320D, not the 320D L.
  const d320 = doc.machines.find((m) => m.make === "Cat" && m.model === "320D");
  assert.ok(d320?.runs.some((r) => r.prefix === "PHX" && r.confidence === "oem"));
});

test("a plant letter after the number is part of the numbering", () => {
  const t = { prefix: "", serial_from: "134700T", serial_to: "157108T" };
  assert.equal(inRun("150000T", t), true);
  assert.equal(inRun("150000L", t), false);
  assert.equal(inRun("150000", t), false);
  assert.equal(inRun("157109T", t), false);
  assert.equal(inRun("140001L", { prefix: "", serial_from: "140000L", serial_to: "" }), true);
});
