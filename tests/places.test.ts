import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countsLine,
  locationProblem,
  normCode,
  normalizeLocation,
  onhandMap,
  pickLocation,
  shipsFrom,
  slugify,
  type StoreLocation,
} from "../lib/places.ts";

const D = "d-1";
const loc = (id: string, name: string, code: string, sort: number): StoreLocation =>
  normalizeLocation({ id, dealer_id: D, name, code, sort });
const MAIN = loc("l-main", "Main shop", "MAIN", 0);
const EFF = loc("l-eff", "Effingham", "EFF", 1);

test("a location row reads with safe defaults", () => {
  const l = normalizeLocation({ id: "x", dealer_id: D, name: "Barn", ships: false });
  assert.deepEqual(
    { ships: l.ships, pickup: l.pickup, active: l.active, sort: l.sort, code: l.code },
    { ships: false, pickup: true, active: true, sort: 0, code: "" },
  );
});

test("locations are checked before saving", () => {
  const base = { id: "", dealer_id: D, name: "Sullivan", code: "SUL", state: "IL", zip: "61951" };
  assert.equal(locationProblem(base, [MAIN, EFF]), null);
  assert.match(locationProblem({ ...base, dealer_id: "" }, [])!, /dealer/);
  assert.match(locationProblem({ ...base, name: " " }, [])!, /name/);
  assert.match(locationProblem({ ...base, code: "EFF" }, [MAIN, EFF])!, /already uses the code EFF/);
  assert.equal(locationProblem({ ...base, id: "l-eff", code: "EFF" }, [MAIN, EFF]), null, "a location keeps its own code");
  assert.match(locationProblem({ ...base, name: "effingham" }, [MAIN, EFF])!, /already has a location with that name/);
  assert.match(locationProblem({ ...base, state: "Ill" }, [])!, /two letters/);
  assert.match(locationProblem({ ...base, zip: "6195" }, [])!, /5 digits/);
  assert.match(locationProblem({ ...base, code: "too-long" }, [])!, /6 letters/);
});

test("codes and slugs are cleaned", () => {
  assert.equal(normCode(" eff-1 x "), "EFF1X");
  assert.equal(normCode("abcdefgh"), "ABCDEF");
  assert.equal(slugify("McCormick Diesel, Inc."), "mccormick-diesel-inc");
  assert.equal(slugify("  Backroad   Iron "), "backroad-iron");
});

test("counts by location read cleanly and print in location order", () => {
  const on = onhandMap([
    { product_id: "tee", location_id: "l-eff", qty: 2 },
    { product_id: "tee", location_id: "l-main", qty: 3 },
    { product_id: "cap", location_id: "l-main", qty: 0 },
    { product_id: 7, location_id: "l-main", qty: 1 },
  ]);
  assert.deepEqual(on, { tee: { "l-eff": 2, "l-main": 3 }, cap: { "l-main": 0 } });
  assert.equal(countsLine(on.tee, [EFF, MAIN]), "MAIN 3 · EFF 2");
  assert.equal(countsLine(on.cap, [EFF, MAIN]), "", "empty locations are left out");
  assert.equal(countsLine(undefined, [MAIN]), "");
});

test("an order says where it ships from", () => {
  const a = (location_id: string, qty: number, product_id = "tee") => ({ order_id: "o1", product_id, location_id, qty });
  assert.equal(shipsFrom([a("l-eff", 2), a("l-eff", 1, "cap")], [MAIN, EFF]), "Effingham");
  assert.equal(shipsFrom([a("l-eff", 1), a("l-main", 2, "cap")], [MAIN, EFF]), "Main shop ×2 · Effingham ×1");
  assert.equal(shipsFrom([], [MAIN]), "");
  assert.equal(shipsFrom([a("gone", 1)], [MAIN]), "a location no longer listed");
});

test("a split item is picked where most of it came from", () => {
  const allocs = [
    { order_id: "o1", product_id: "tee", location_id: "l-main", qty: 1 },
    { order_id: "o1", product_id: "tee", location_id: "l-eff", qty: 3 },
    { order_id: "o2", product_id: "tee", location_id: "l-main", qty: 5 },
  ];
  assert.equal(pickLocation(allocs, "o1", "tee"), "l-eff");
  assert.equal(pickLocation(allocs, "o2", "tee"), "l-main");
  assert.equal(pickLocation(allocs, "o3", "tee"), null);
});
