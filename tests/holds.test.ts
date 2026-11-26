import assert from "node:assert/strict";
import { test } from "node:test";
import {
  availableQty,
  cartSignature,
  countdown,
  heldFromReply,
  heldMap,
  heldStillGood,
  holdMessage,
  holdWindow,
  readHeld,
  STRIPE_MIN_MINUTES,
  type HeldCheckout,
} from "../lib/holds.ts";

const NOW = Date.parse("2026-11-26T21:00:00Z"); // 3:00 PM Central

test("the hold window follows the setting, never shorter than Stripe allows", () => {
  const w = holdWindow(45, 5, NOW);
  assert.equal(w.stripeExpiresAt, NOW / 1000 + 45 * 60);
  assert.equal(w.dbMinutes, 50, "the database keeps the parts a little past the page closing");
  assert.equal(w.endsAt, "2026-11-26T21:45:00.000Z");
  assert.equal(holdWindow(30, 5, NOW).stripeExpiresAt, NOW / 1000 + STRIPE_MIN_MINUTES * 60);
  assert.equal(holdWindow(5000, 999, NOW).dbMinutes, 1440 + 60);
  assert.equal(holdWindow(Number.NaN, -3, NOW).dbMinutes, STRIPE_MIN_MINUTES);
});

test("shoppers can buy what is on the shelf less what is held", () => {
  assert.equal(availableQty(5, 2), 3);
  assert.equal(availableQty(5, undefined), 5);
  assert.equal(availableQty(1, 4), 0, "never below zero");
  assert.deepEqual(heldMap([{ product_id: "a", held: 2 }, { product_id: "a", held: "1" }, { product_id: "b", held: 0 }, { product_id: 7, held: 1 }]), { a: 3 });
  assert.deepEqual(heldMap(null), {});
});

test("the countdown reads minutes and seconds and stops at zero", () => {
  assert.equal(countdown(NOW + 27 * 60_000 + 5_000, NOW), "27:05");
  assert.equal(countdown(NOW + 400, NOW), "0:01", "the last part of a second still shows");
  assert.equal(countdown(NOW, NOW), null);
  assert.equal(countdown(NOW - 1, NOW), null);
});

test("Stripe is told when the hold ends, in the shop's time zone", () => {
  assert.equal(holdMessage("2026-11-26T21:31:00Z", "America/Chicago", false), "We're holding these parts for you until 3:31 PM CST.");
  assert.match(holdMessage("2026-11-26T21:31:00Z", "America/Chicago", true), /until 3:31 PM CST\. Pickup order: we'll call/);
  assert.match(holdMessage("2026-11-26T21:31:00Z", "Not/AZone", false), /3:31 PM CST/);
});

test("a saved checkout is only reused for the same cart with time left", () => {
  const sig = cartSignature([{ id: "tee", qty: 2 }, { id: "cap", qty: 1 }, { id: "gone", qty: 0 }]);
  assert.equal(sig, "cap*1,tee*2");
  const saved = JSON.stringify({ order_id: "00000000-0000-4000-8000-000000000001", url: "https://checkout.stripe.com/c/pay/cs_test_1", ends_at: new Date(NOW + 10 * 60_000).toISOString(), skew: 0, sig });
  const h = readHeld(saved);
  assert.ok(h);
  const kept: HeldCheckout = h;
  assert.ok(heldStillGood(h, sig, NOW));
  assert.ok(!heldStillGood(h, "cap*1,tee*3", NOW), "a changed cart starts over");
  assert.ok(!heldStillGood(h, sig, NOW + 11 * 60_000), "an ended hold is not reused");
  assert.ok(heldStillGood({ ...kept, skew: -2 * 60_000 }, sig, NOW + 11 * 60_000), "a browser clock that runs fast is corrected");
});

test("a saved checkout that is malformed or points off Stripe is ignored", () => {
  const ok = { order_id: "00000000-0000-4000-8000-000000000001", url: "https://checkout.stripe.com/c/pay/x", ends_at: "2026-11-26T21:30:00Z", skew: 0, sig: "a*1" };
  assert.ok(readHeld(JSON.stringify(ok)));
  assert.equal(readHeld(JSON.stringify({ ...ok, url: "https://evil.example/pay" })), null);
  assert.equal(readHeld(JSON.stringify({ ...ok, order_id: "1; drop" })), null);
  assert.equal(readHeld(JSON.stringify({ ...ok, ends_at: "soon" })), null);
  assert.equal(readHeld("{not json"), null);
  assert.equal(readHeld(null), null);
});

test("a started checkout is saved with what it holds and the clock difference", () => {
  const h = heldFromReply(
    { order_id: "00000000-0000-4000-8000-000000000001", url: "https://checkout.stripe.com/c/pay/cs_1", held_until: "2026-11-26T21:31:00Z", now: "2026-11-26T21:00:02Z" },
    [{ id: "tee", qty: 1 }, { id: "cap", qty: 2 }],
    NOW,
  );
  assert.deepEqual(h.items, { tee: 1, cap: 2 });
  assert.equal(h.sig, "cap*2,tee*1");
  assert.equal(h.skew, 2000, "the server clock is two seconds ahead");
  const back = readHeld(JSON.stringify(h));
  assert.deepEqual(back?.items, { tee: 1, cap: 2 });
  assert.deepEqual(readHeld(JSON.stringify({ ...h, items: { tee: -1, cap: "2", ok: 3 } }))?.items, { ok: 3 }, "bad counts are dropped");
});
