import assert from "node:assert/strict";
import { test } from "node:test";
import { fullMachine, packageCoverage, packageValue, positionsFor } from "../lib/seal-kits.ts";

test("a full-machine backhoe package covers the eleven standard cylinders", () => {
  const full = fullMachine("backhoe");
  assert.deepEqual(
    full.map((c) => `${c.count} ${c.position}`),
    ["1 Boom", "1 Dipper", "1 Bucket", "2 Stabilizer", "2 Swing", "2 Loader lift", "2 Loader bucket (tilt)"],
  );
  assert.equal(full.reduce((n, c) => n + c.count, 0), 11);
  assert.ok(positionsFor("backhoe").includes("Extendahoe"));
  assert.ok(positionsFor(null).includes("Stick"));
});

test("coverage names what a package is missing", () => {
  const lines = [
    { position: "Boom", qty: 1 },
    { position: "Dipper", qty: 1 },
    { position: "Bucket", qty: 1 },
    { position: "Stabilizer", qty: 2 },
    { position: "Swing", qty: 1 },
  ];
  const c = packageCoverage("backhoe", lines);
  assert.deepEqual(c.missing, [
    { position: "Swing", count: 1 },
    { position: "Loader lift", count: 2 },
    { position: "Loader bucket (tilt)", count: 2 },
  ]);
  assert.equal(c.covered.length, 4);
});

test("package savings only when every kit has a price", () => {
  const lines = [
    { product_id: "boom", qty: 1, price_cents: 6500 },
    { product_id: "stab", qty: 2, price_cents: 4200 },
  ];
  assert.deepEqual(packageValue(13000, lines), { separate: 14900, saves: 1900, kits: 3 });
  assert.deepEqual(packageValue(16000, lines), { separate: 14900, saves: null, kits: 3 });
  assert.deepEqual(packageValue(13000, [...lines, { product_id: "x", qty: 1, price_cents: null }]), { separate: null, saves: null, kits: 4 });
});

test("the seal kit shelf offers every cylinder name the fitment rows use", async () => {
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  assert.match(sql, /\('hyd-seal-kits', 'hydraulics', 'Seal kits',/);
  const row = /\('seal-kits-cylinder', 'hyd-seal-kits', 'Cylinder seal kits', \d+, '(.*?)'::jsonb/.exec(sql);
  assert.ok(row);
  const fields = JSON.parse(row[1].replace(/''/g, "'")) as Array<{ key: string; choices?: string[] }>;
  const choices = fields.find((f) => f.key === "cylinder")?.choices ?? [];
  for (const p of positionsFor(null)) assert.ok(choices.includes(p), `${p} missing from the shelf's cylinder choices`);
});
