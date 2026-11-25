import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowedByRobots,
  largeImage,
  matchParts,
  parseListing,
  parseProductPage,
  parseRobots,
  sameSite,
} from "../lib/supplier.ts";

const HOST = "www.example-supply.com";
const PAGE = `https://${HOST}/adapters/caps.html`;

// A made-up page in the same product-grid shape Magento stores use.
const item = (pn: string, name: string, slug: string, file: string) => `
<li class="item product product-list-item"><div class="item-info">
  <a href="https://${HOST}/${slug}.html" class="product photo product-item-photo">
    <img class="product-image-photo"
         src="https://${HOST}/media/catalog/product/a/b/${file}?optimize=medium&amp;height=300&amp;width=240" alt="${name}"/></a>
  <strong class="product name product-item-name">
    <a class="product-item-link"
       href="https://${HOST}/${slug}.html">
       ${name} </a></strong>
  <span>${pn}</span>
</div></li>`;

const listing = `<ul>
${item("830-FS-08", "Cap Tube - 1/2&quot;", "cap-tube-12", "cap-830-fs-08.jpg")}
${item("839-FS-06", "Plug Tube &#x2D; 3/8&quot;", "plug-tube-38", "plug-839-fs-06.jpg")}
<li class="item product product-list-item"><a class="product-item-link" href="https://elsewhere.test/x.html">Off-site</a>
  <img src="https://elsewhere.test/media/catalog/product/x.jpg"/></strong><span>ZZ-1</span></li>
</ul>
<a class="action  next" href="${PAGE}?p=2" title="Next">Next</a>`;

test("reads part number, name, page and photo from a category page", () => {
  const { items, next } = parseListing(listing, PAGE, HOST);
  assert.equal(items.length, 2, "the off-site item is dropped");
  assert.deepEqual(items[0], {
    part_number: "830-FS-08",
    name: 'Cap Tube - 1/2"',
    page_url: `https://${HOST}/cap-tube-12.html`,
    image_url: `https://${HOST}/media/catalog/product/a/b/cap-830-fs-08.jpg?optimize=medium&height=300&width=240`,
  });
  assert.equal(items[1].name, 'Plug Tube - 3/8"');
  assert.equal(next, `${PAGE}?p=2`);
});

test("the last page has no next link", () => {
  assert.equal(parseListing(item("A-1", "A", "a", "a.jpg"), PAGE, HOST).next, null);
});

test("reads the main photo from a product page", () => {
  const html = `<meta property="og:title" content="Cap&#x20;Tube" />
<meta property="og:image"
      content="https://${HOST}/media/catalog/product/a/b/cap.jpg?height=265&amp;width=265" />
<div itemprop="sku">BR-1010389</div>
<script>{"thumb":"x","img":"https:\\/\\/${HOST}\\/media\\/catalog\\/product\\/a\\/b\\/cap.jpg?height=700&width=700"}</script>`;
  const page = parseProductPage(html, HOST);
  assert.equal(page.name, "Cap Tube");
  assert.equal(page.sku, "BR-1010389");
  assert.equal(page.image_url, `https://${HOST}/media/catalog/product/a/b/cap.jpg?height=700&width=700`);
  assert.equal(parseProductPage("<html></html>", HOST).image_url, null);
});

test("asks for the photo at a display size", () => {
  assert.equal(
    largeImage(`https://${HOST}/media/catalog/product/a/b/cap.jpg?height=300&width=240`),
    `https://${HOST}/media/catalog/product/a/b/cap.jpg?optimize=medium&bg-color=255,255,255&fit=bounds&height=700&width=700&canvas=700:700`,
  );
});

test("only https pages on the supplier's own site are accepted", () => {
  assert.ok(sameSite(`https://${HOST}/x.html`, HOST));
  assert.equal(sameSite(`http://${HOST}/x.html`, HOST), null);
  assert.equal(sameSite("https://evil.test/x.html", HOST), null);
  assert.equal(sameSite("not a url", HOST), null);
});

const ROBOTS = `# comment
User-agent: SomeBot
Disallow: /

User-agent: *
Crawl-delay: 60
Disallow: /catalogsearch/
Disallow: /checkout/
Disallow: /*?*product_list_order=
Disallow: /*.php$
Sitemap: https://${HOST}/sitemap.xml`;

test("robots.txt: honours the rules written for every crawler", () => {
  const robots = parseRobots(ROBOTS);
  assert.equal(robots.crawl_delay, 60);
  assert.deepEqual(robots.disallow, ["/catalogsearch/", "/checkout/", "/*?*product_list_order=", "/*.php$"]);
  assert.equal(allowedByRobots(`https://${HOST}/adapters/caps.html?p=2`, robots), true);
  assert.equal(allowedByRobots(`https://${HOST}/media/catalog/product/a/b/c.jpg?height=700`, robots), true);
  assert.equal(allowedByRobots(`https://${HOST}/catalogsearch/result/?q=830`, robots), false);
  assert.equal(allowedByRobots(`https://${HOST}/adapters/caps.html?p=2&product_list_order=name`, robots), false);
  assert.equal(allowedByRobots(`https://${HOST}/index.php`, robots), false);
  assert.equal(allowedByRobots(`https://${HOST}/index.php?x=1`, robots), true, "$ anchors the end");
});

test("matches our parts to the supplier's index however the number is punctuated", () => {
  const found = matchParts(
    [
      { id: "a", part_number: "830-FS-08" },
      { id: "b", part_number: "1C2216" },
    ],
    [{ part_norm: "830FS08", part_number: "830 FS 08", name: "Cap", page_url: "p", image_url: "i" }],
  );
  assert.deepEqual([...found.keys()], ["a"]);
});
