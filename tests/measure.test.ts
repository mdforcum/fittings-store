import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOCK, cleanTapeReading, lengthFromTape, measureHow, steps } from "../lib/measure.ts";
import type { HoseEnd } from "../lib/hose.ts";

const jic: HoseEnd = { family: "jic", gender: "female_swivel", shape: "straight", dash: 8 };
const orfs: HoseEnd = { family: "orfs", gender: "female_swivel", shape: "straight", dash: 8 };
const elbow: HoseEnd = { family: "jic", gender: "female_swivel", shape: "90", dash: 8 };
const npt: HoseEnd = { family: "npt", gender: "male", shape: "straight", dash: 8 };

test("each end gets its own measuring instruction", () => {
  assert.match(measureHow(jic, "A"), /outer edge of the swivel nut/);
  assert.match(measureHow(npt, "B"), /tip of the threads/);
  assert.match(measureHow(orfs, "A"), /flat sealing face/);
  assert.match(measureHow(elbow, "B"), /elbow\. Measure to the middle of its sealing end/);
});

test("the on-machine path starts with safety", () => {
  const s = steps("on", jic, elbow);
  assert.equal(s[0].title, "Make it safe first");
  assert.ok(s[0].warn);
  assert.match(s[0].body, /Never feel along a hose for a leak/);
  assert.match(s[3].body, /elbow/);
});

test("the off-machine path ends with the tape photo option", () => {
  const s = steps("off", orfs, jic);
  assert.match(s[1].body, /sealing face/);
  assert.equal(s.at(-1)?.title, "Or let us read the tape");
});

test("the angle clock goes clockwise in 45° steps", () => {
  assert.deepEqual(CLOCK.map((c) => c.deg), [0, 45, 90, 135, 180, 225, 270, 315]);
  assert.equal(steps("angle", elbow, elbow).length, 3);
});

test("length comes from the difference between two tape readings", () => {
  assert.equal(lengthFromTape(1, 37.5), 36.5);
  assert.equal(lengthFromTape(37.5, 1), 36.5);
  assert.equal(lengthFromTape(0, 24.06), 24);
  assert.equal(lengthFromTape(5, 5.5), null);
  assert.equal(lengthFromTape(null, 30), null);
});

test("tape readings are cleaned and never guessed", () => {
  assert.deepEqual(cleanTapeReading({ a_inches: 2.03, b_inches: 38.51, note: "" }), { a: 2, b: 38.5, length: 36.5, note: "" });
  const blurred = cleanTapeReading({ a_inches: null, b_inches: 40, note: "First photo is blurred." });
  assert.equal(blurred.length, null);
  assert.equal(blurred.note, "First photo is blurred.");
  assert.equal(cleanTapeReading({ a_inches: -3, b_inches: "x" }).a, null);
});
