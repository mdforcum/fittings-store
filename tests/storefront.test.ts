import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanHost, cleanLogo, contrast, hostOf, lookStyle, normalizeStorefront, pickStorefront, storefrontProblem } from "../lib/storefront.ts";

const mcd = normalizeStorefront({
  id: "s1",
  dealer_id: "d1",
  slug: "mccormick-diesel",
  host: "parts.mccormickdiesel.com",
  name: "McCormick Diesel",
  phone: "217-682-3339",
  logo_url: "/brands/mccormick-diesel.png",
  color_header: "#1A1A1A",
  live: true,
});

test("a storefront row reads with safe colors", () => {
  assert.equal(mcd.color_header, "#1a1a1a");
  assert.equal(normalizeStorefront({ color_button: "red" }).color_button, "#b3121a");
  assert.equal(normalizeStorefront({}).live, false);
  assert.equal(normalizeStorefront({ dealer_id: "" }).dealer_id, null);
});

test("web addresses are read and cleaned the same way", () => {
  assert.equal(hostOf("Parts.McCormickDiesel.com:443"), "parts.mccormickdiesel.com");
  assert.equal(hostOf("shop.backroadiron.com."), "shop.backroadiron.com");
  assert.equal(hostOf(null), "");
  assert.equal(cleanHost("https://Parts.McCormickDiesel.com/shop?x=1"), "parts.mccormickdiesel.com");
});

test("the address picks the live storefront; staff can preview one that isn't live", () => {
  const draft = { ...mcd, live: false };
  assert.equal(pickStorefront([mcd], "parts.mccormickdiesel.com", null, false)?.name, "McCormick Diesel");
  assert.equal(pickStorefront([mcd], "shop.backroadiron.com", null, false), null, "Backroad Iron's own store");
  assert.equal(pickStorefront([draft], "parts.mccormickdiesel.com", null, false), null, "not live: nobody sees it at its address");
  assert.equal(pickStorefront([draft], "shop.backroadiron.com", "mccormick-diesel", false), null, "shoppers can't preview");
  const p = pickStorefront([draft], "shop.backroadiron.com", "mccormick-diesel", true);
  assert.equal(p?.name, "McCormick Diesel");
  assert.equal(p?.preview, true);
  assert.equal(pickStorefront([mcd], "x", "mccormick-diesel", true)?.preview, false, "a live store previewed is not marked preview");
});

test("storefronts are checked before saving", () => {
  const ok = { id: "", slug: "acme-ag", host: "parts.acmeag.com", name: "Acme Ag", email: "", color_header: "#1a1a1a", color_button: "#b3121a", color_accent: "#e81820" };
  assert.equal(storefrontProblem(ok, [mcd]), null);
  assert.match(storefrontProblem({ ...ok, host: "parts.mccormickdiesel.com" }, [mcd])!, /already uses that web address/);
  assert.match(storefrontProblem({ ...ok, slug: "mccormick-diesel" }, [mcd])!, /short name/);
  assert.match(storefrontProblem({ ...ok, host: "not a host" }, [])!, /parts\.example\.com/);
  assert.match(storefrontProblem({ ...ok, host: "x.backroadiron.com" }, [])!, /Backroad Iron's own/);
  assert.match(storefrontProblem({ ...ok, color_header: "#eeeeee" }, [])!, /too light/);
  assert.match(storefrontProblem({ ...ok, color_button: "#ffcc00" }, [])!, /button color is too light/);
  assert.match(storefrontProblem({ ...ok, email: "nope" }, [])!, /email/);
  assert.match(storefrontProblem({ ...ok, color_accent: "#ffd400" }, [])!, /stripe color is too light/);
  assert.equal(storefrontProblem({ ...ok, host: null }, []), null, "an address can be added later");
});

test("logos are our own files or https images only", () => {
  assert.equal(cleanLogo("/brands/mccormick-diesel.png"), "/brands/mccormick-diesel.png");
  assert.equal(cleanLogo("https://cdn.example.com/logo.png"), "https://cdn.example.com/logo.png");
  assert.equal(cleanLogo("javascript:alert(1)"), "");
  assert.equal(cleanLogo("http://example.com/logo.png"), "");
  assert.equal(cleanLogo("/brands/../secret.png"), "");
});

test("colors keep white text readable", () => {
  assert.ok(contrast("#b3121a", "#ffffff") >= 4.5);
  assert.ok(contrast("#e81820", "#ffffff") < 5, "the logo red only just passes, so buttons use a darker red");
  const v = lookStyle({ ...mcd, preview: false });
  assert.equal(v["--lid"], "#1a1a1a");
  assert.equal(v["--primary"], "#b3121a");
  assert.equal(v["--on-zinc"], "#ffffff", "the cart button's text is white on the accent color");
});

test("store options read with safe defaults, and know whether they're set up", async () => {
  const { normalizeStorefront } = await import("../lib/storefront.ts");
  const before = normalizeStorefront({ slug: "x" });
  assert.equal(before.has_options, false);
  assert.equal(before.stock_scope, "own");
  assert.equal(before.ship_own, false);
  const after = normalizeStorefront({ slug: "x", stock_scope: "network", location_filter: true, ship_own: true, ship_flat_cents: 1250, free_ship_over_cents: null, order_min_cents: -5 });
  assert.equal(after.has_options, true);
  assert.equal(after.stock_scope, "network");
  assert.equal(after.location_filter, true);
  assert.equal(after.ship_flat_cents, 1250);
  assert.equal(after.free_ship_over_cents, null);
  assert.equal(after.order_min_cents, 0, "a bad minimum reads as none");
  assert.equal(normalizeStorefront({ stock_scope: "everything" }).stock_scope, "own");
});

test("a dealer's own shipping replaces Backroad Iron's only when it sets its own", async () => {
  const { storeShipping } = await import("../lib/storefront.ts");
  const base = { shipping_flat_cents: 800, free_ship_over_cents: 10000 as number | null, order_min_cents: 1500, store_name: "BI" };
  const theirs = { ship_own: true, ship_flat_cents: 1200, free_ship_over_cents: null, order_min_cents: 0 };
  assert.deepEqual(storeShipping(base, theirs), { ...base, shipping_flat_cents: 1200, free_ship_over_cents: null, order_min_cents: 0 });
  assert.equal(storeShipping(base, { ...theirs, ship_own: false }), base);
  assert.equal(storeShipping(base, null), base);
});

test("typed dollars become cents", async () => {
  const { dollarsToCents } = await import("../lib/storefront.ts");
  assert.equal(dollarsToCents("$12.50"), 1250);
  assert.equal(dollarsToCents("1,000"), 100000);
  assert.equal(dollarsToCents(" "), null);
  assert.ok(Number.isNaN(dollarsToCents("12.505")));
  assert.ok(Number.isNaN(dollarsToCents("-3")));
});

test("shelf counts by location group per location, empty ones left out", async () => {
  const { shelfPlaces } = await import("../lib/storefront.ts");
  const places = shelfPlaces([
    { location_id: "l1", location_name: "Main shop", city: "Shelbyville", state: "IL", dealer_name: "Backroad Iron", product_id: "a", qty: 5 },
    { location_id: "l1", location_name: "Main shop", city: "Shelbyville", state: "IL", dealer_name: "Backroad Iron", product_id: "b", qty: 0 },
    { location_id: "l2", location_name: "McCormick shop", city: "", state: "", dealer_name: "McCormick Diesel", product_id: "a", qty: 1 },
  ]);
  assert.deepEqual(places, [
    { id: "l1", name: "Main shop", town: "Shelbyville, IL", dealer: "Backroad Iron", stock: { a: 5 } },
    { id: "l2", name: "McCormick shop", town: "", dealer: "McCormick Diesel", stock: { a: 1 } },
  ]);
  assert.deepEqual(shelfPlaces(null), []);
});
