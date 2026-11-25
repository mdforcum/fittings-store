import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_BUILD,
  END_FAMILIES,
  TAG_RE,
  buildSheet,
  canBuild,
  checkBuild,
  cleanBuild,
  fmtInches,
  identifyThread,
  lengthTolerance,
  makeTag,
  measurePoint,
  parseLayline,
  type Build,
} from "../lib/hose.ts";

const good: Build = {
  ...EMPTY_BUILD,
  hose_type: "100R2AT",
  hose_dash: 8,
  rated_psi: 4000,
  system_psi: 2500,
  end_a: { family: "jic", gender: "female_swivel", shape: "straight", dash: 8 },
  end_b: { family: "orfs", gender: "female_swivel", shape: "90", dash: 8 },
  length_in: 36.5,
};

test("a complete build passes", () => {
  assert.deepEqual(checkBuild(good), []);
  assert.equal(canBuild(good), true);
});

test("a hose weaker than the system is refused", () => {
  const p = checkBuild({ ...good, system_psi: 5000 });
  assert.equal(p.length, 1);
  assert.match(p[0].text, /rated 4,000 psi, below the system's 5,000 psi/);
  assert.equal(canBuild({ ...good, system_psi: 5000 }), false);
});

test("no pressure, no build sheet", () => {
  assert.equal(canBuild({ ...good, rated_psi: null }), false);
});

test("two elbows need the angle between them", () => {
  const twoElbows = { ...good, end_a: { ...good.end_a, shape: "90" as const } };
  assert.equal(canBuild(twoElbows), false);
  assert.equal(canBuild({ ...twoElbows, angle: 0 }), true);
  assert.equal(canBuild({ ...twoElbows, angle: 360 }), false);
});

test("an end must come in that size and gender", () => {
  assert.equal(canBuild({ ...good, end_b: { family: "orfs", gender: "female_swivel", shape: "straight", dash: 5 } }), false);
  assert.equal(canBuild({ ...good, end_b: { family: "orb", gender: "female_swivel", shape: "straight", dash: 8 } }), false);
});

test("short assemblies warn but do not block", () => {
  const p = checkBuild({ ...good, length_in: 3 });
  assert.equal(p.length, 1);
  assert.equal(p[0].blocking, false);
});

test("length is measured to the right point on each end", () => {
  assert.equal(measurePoint(good.end_a), "end of the fitting");
  assert.equal(measurePoint({ ...good.end_a, family: "orfs" }), "sealing face");
  assert.equal(measurePoint(good.end_b), "centerline of the sealing surface");
});

test("length tolerance grows with length", () => {
  assert.equal(lengthTolerance(12), 0.125);
  assert.equal(lengthTolerance(30), 0.25);
  assert.equal(lengthTolerance(48), 0.5);
  assert.equal(lengthTolerance(120), 1.2);
});

test("inches print in eighths", () => {
  assert.equal(fmtInches(36.5), "36-1/2 in");
  assert.equal(fmtInches(12.125), "12-1/8 in");
  assert.equal(fmtInches(0.75), "3/4 in");
  assert.equal(fmtInches(9.99), "10 in");
});

test("the build sheet says how to measure and how to build", () => {
  const sheet = buildSheet({ ...good, end_a: { ...good.end_a, shape: "90" }, angle: 90 }, "BH-ABCD-EFGH");
  assert.equal(sheet.title, "-08 hose assembly, 36-1/2 in");
  assert.match(sheet.text, /End A: Female swivel JIC 37° flare, 90° elbow, -08 \(3\/4-16\)/);
  assert.match(sheet.text, /End B: Female swivel O-ring face seal \(ORFS\), 90° elbow, -08 \(13\/16-16\)/);
  assert.match(sheet.text, /Offset angle: 90° ±5°, clockwise from A/);
  assert.match(sheet.text, /one maker's system/);
});

test("laylines are read for maker, type, size and pressure", () => {
  assert.deepEqual(parseLayline("PARKER 451TC-8 1/2 IN (12.7MM) SAE 100R16 WP 350 BAR / 5075 PSI MADE IN USA"), {
    brand: "Parker",
    hose_type: "100R16",
    dash: 8,
    psi: 5075,
    line: "451TC",
  });
  const g = parseLayline("GATES 8M3K MEGA3000 1/2\" 3000 PSI EN 857 1SC");
  assert.equal(g.brand, "Gates");
  assert.equal(g.psi, 3000);
  assert.equal(g.dash, 8);
  assert.equal(g.hose_type, "100R17");
  const metric = parseLayline("SAE 100R2AT -06 WP 33 MPa");
  assert.equal(metric.hose_type, "100R2AT");
  assert.equal(metric.dash, 6);
  assert.equal(metric.psi, 4786);
  assert.equal(parseLayline("").psi, null);
});

test("a caliper reading finds the thread", () => {
  const jic8 = identifyThread(0.745, 16).map((m) => `${m.family.id}:${m.size.thread}`);
  assert.deepEqual(jic8, ["jic:3/4-16", "orb:3/4-16"]);
  const orfs = identifyThread(0.81).map((m) => `${m.family.id}:${m.size.thread}`);
  assert.ok(orfs.includes("orfs:13/16-16"));
  assert.ok(orfs.includes("bspp:1/2-14"));
  assert.deepEqual(identifyThread(0.81, 14).map((m) => m.family.id), ["bspp", "npt"]); // NPT tapers, so the end reads small
  assert.deepEqual(identifyThread(0.708, null, 1.5).map((m) => m.size.thread), ["M18x1.5", "M18x1.5"]);
  assert.deepEqual(identifyThread(0), []);
});

test("every end family lists sizes in order without repeats", () => {
  for (const f of END_FAMILIES) {
    const d = f.sizes.map((s) => s.dash);
    assert.deepEqual(d, [...d].sort((a, b) => a - b), f.id);
    assert.equal(new Set(d).size, d.length, f.id);
  }
});

test("tags are readable and unique enough", () => {
  const tags = new Set(Array.from({ length: 2000 }, () => makeTag()));
  assert.equal(tags.size, 2000);
  for (const t of tags) assert.match(t, TAG_RE);
});

test("builds from a browser are cleaned", () => {
  const b = cleanBuild({ hose_type: "nope", hose_dash: "8", length_in: "24.256", end_a: { family: "x", gender: "f", shape: "z", dash: 6 }, sleeve: "gold", qty: "2", rated_psi: "3000" });
  assert.equal(b.hose_type, "other");
  assert.equal(b.hose_dash, 8);
  assert.equal(b.length_in, 24.26);
  assert.deepEqual(b.end_a, { family: "jic", gender: "female_swivel", shape: "straight", dash: 6 });
  assert.equal(b.sleeve, "none");
  assert.equal(b.qty, 2);
  assert.equal(b.rated_psi, 3000);
});
