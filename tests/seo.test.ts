import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonForScript, listable, originOf, partDescription, partJsonLd, partPath, partTitle, replaces } from "../lib/seo.ts";
import { normalizeProduct } from "../lib/catalog.ts";

const tee = normalizeProduct({ id: "jic-tee-8", name: "JIC tee", part_number: "2603-08", thread: "3/4-16", dash: "8", price_cents: 1250, qty: 4, brand: "Brennan", condition: "new" });
const xrefs = [
  { kind: "oem", brand: "CNH", number: "86572263" },
  { kind: "supplier", brand: "Burns", number: "B-99" },
  { kind: "aftermarket", brand: "", number: "T8-JIC" },
];

test("a part's address and the store's origin", () => {
  assert.equal(partPath("jic-tee-8"), "/part/jic-tee-8");
  assert.equal(partPath("a b/c"), "/part/a%20b%2Fc");
  assert.equal(originOf("shop.backroadiron.com", "https"), "https://shop.backroadiron.com");
  assert.equal(originOf("Parts.McCormickDiesel.com, proxy.internal"), "https://parts.mccormickdiesel.com");
  assert.equal(originOf("localhost:3100"), "http://localhost:3100");
  assert.equal(originOf("bad host/<x>"), "");
  assert.equal(originOf(null), "");
});

test("the title and description come from the part's own details", () => {
  assert.equal(partTitle(tee, "Backroad Iron"), "JIC tee 2603-08 | Backroad Iron");
  assert.equal(partTitle({ name: "Tee 2603-08", part_number: "2603-08" }, "Backroad Iron"), "Tee 2603-08 | Backroad Iron");
  assert.deepEqual(replaces(xrefs), ["CNH 86572263", "T8-JIC"], "supplier numbers stay private");
  assert.equal(partDescription(tee, xrefs, "Backroad Iron"), "JIC tee, part # 2603-08. 3/4-16 thread, dash 8. Replaces CNH 86572263, T8-JIC. In stock at Backroad Iron.");
  assert.equal(partDescription({ ...tee, qty: 0 }, [], "Backroad Iron"), "JIC tee, part # 2603-08. 3/4-16 thread, dash 8. From Backroad Iron.", "never says in stock when it isn't");
  assert.match(partDescription({ ...tee, price_mode: "quote" }, [], "Backroad Iron"), /Priced by quote from Backroad Iron\.$/);
  assert.ok(partDescription({ ...tee, name: "Very long name ".repeat(20) }, xrefs, "Backroad Iron").length <= 160);
});

test("product data for search engines: price and stock only when they're real", () => {
  const opts = { url: "https://shop.example/part/jic-tee-8", storeName: "Backroad Iron", images: ["https://img/x.jpg"], xrefs, description: "d" };
  const d = partJsonLd(tee, opts) as Record<string, unknown> & { offers: Record<string, unknown> };
  assert.equal(d["@type"], "Product");
  assert.equal(d.sku, "2603-08");
  assert.deepEqual(d.brand, { "@type": "Brand", name: "Brennan" });
  assert.deepEqual(d.offers, {
    "@type": "Offer",
    url: opts.url,
    priceCurrency: "USD",
    price: "12.50",
    availability: "https://schema.org/InStock",
    itemCondition: "https://schema.org/NewCondition",
    seller: { "@type": "Organization", name: "Backroad Iron" },
  });
  assert.equal((partJsonLd({ ...tee, qty: 0 }, opts).offers as Record<string, unknown>).availability, "https://schema.org/OutOfStock");
  assert.equal(partJsonLd({ ...tee, price_cents: null }, opts).offers, undefined, "no price, no offer");
  assert.equal(partJsonLd({ ...tee, price_mode: "quote" }, opts).offers, undefined, "quote items carry no price");
  const bare = partJsonLd({ ...tee, brand: "", part_number: "" }, { ...opts, images: [], xrefs: [] });
  assert.ok(!("brand" in bare) && !("sku" in bare) && !("image" in bare) && !("isSimilarTo" in bare), "nothing is filled in that the part doesn't have");
});

test("part text can't break out of the data script, and only priced parts are listed", () => {
  assert.equal(jsonForScript({ name: "</script><b>" }), '{"name":"\\u003c/script>\\u003cb>"}');
  assert.equal(listable({ price_cents: 100, price_mode: "cart" }), true);
  assert.equal(listable({ price_cents: null, price_mode: "cart" }), false);
  assert.equal(listable({ price_cents: null, price_mode: "quote" }), true);
});
