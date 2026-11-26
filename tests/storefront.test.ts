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
