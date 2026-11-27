# Fittings store

Standalone store for hydraulic caps, plugs and adapters: a public shop, a
password-protected back office, Stripe Checkout for payment and Shippo for
shipping labels. Built on Next.js and Supabase so it can fold into Backroad Iron
later.

## How it fits together

- **Shop (`/`)** reads the catalog fresh on every visit. An item with zero
  quantity or no price is shown as temporarily out of stock and cannot be added
  to a cart. The same rule is enforced again on the server at checkout.
- **Checkout** (`/api/checkout`) re-prices the cart from the database, checks
  stock and the order minimum, adds the flat shipping fee, and sends the shopper
  to Stripe's hosted payment page. The customer types their address once, there.
- **Paid orders** arrive two ways, both safe to repeat: Stripe's webhook
  (`/api/stripe/webhook`) and the thank-you page. Either one marks the order paid
  and takes the items out of stock in a single database function.
- **Back office (`/admin`)** has three tabs:
  - *Inventory*: quantity, cost, margin, sell price, photos, add and delete items.
  - *Orders*: paid orders with the customer's address. "Get rates" sends that
    address to Shippo; "Buy label" saves the label and tracking number on the order.
  - *Settings*: store details, shipping fee, order minimum, ship-from address,
    package sizes, and the Stripe and Shippo connection status.

Products are entered once, in Inventory. Nothing is maintained inside Stripe or
Shippo.

## Inventory survey (`/capture` and the Survey tab)

For walking a parts room with a phone: photograph inventory cards and parts bins,
scan codes, or type entries in, in any order, over any number of days.

- **`/capture`** is the phone page. Every capture is saved on the phone first and
  uploaded when there is signal, so it works with none. Open it once with signal
  and wait for "Ready for offline use"; after that the page itself opens offline
  too. Barcodes and QR codes are read on the phone. Sign-in is the back-office
  password.
- **Reading.** Each uploaded photo is read by Claude's vision API: part number,
  description, aisle and bin, the on-hand quantity from a card, or a count of the
  parts in a bin with a stated confidence. A deep pile cannot be counted from a
  photo, and the reading says so instead of guessing. Needs `ANTHROPIC_API_KEY`.
- **Matching.** Captures are the only facts stored. Parts are worked out fresh
  from the whole pile every time (`lib/match.ts`): captures that share a part
  number or a scanned code are one part; captures that share only an aisle and
  bin are joined but flagged for a one-tap confirmation. Because nothing is
  matched at capture time, the order photos arrive in cannot change the result.
- **Survey tab** in the back office shows the parts, card-versus-bin mismatches,
  look-alike part numbers (0/O, 1/I), and captures still waiting for a match.
  From there a part can be added to the shop catalog, a count can be applied to
  an existing item, and a capture photo can be used as a shop photo.

Survey photos live in a private storage bucket and are only ever shown to the
signed-in owner.

## Supplier photos tab

Finds the distributor's own product photo for each stocked part, by part number.

- It reads the supplier's category listing pages and product pages only. It obeys
  the site's `robots.txt`, including the crawl delay, and never uses site search.
  One request is made at a time; the tab shows the wait.
- An item the listings do not cover can be pointed at its product page by hand.
- **Imported photos are held, out of the shop, until permission is recorded** on
  that tab. Recording it publishes them; withdrawing it takes them back out.
  Product photos belong to whoever took them, so get the supplier's answer in
  writing first.

Sources are defined in `lib/supplier.ts`.

## Catalog details (the foundation)

Every item can carry the ten shared structures from the category plan: its
place on the category tree, specs from that category's template, sizes sold as
one family, every number it goes by (OEM, aftermarket, supplier, superseded,
UPC), machine fitment, kit parts, stock at other places, its shipping profile,
extra charges such as a core charge, and documents. Open an item in Inventory
and press **Catalog details**.

- Nothing here changes the shop on its own. The storefront starts reading it
  category by category. Only the hydraulic fittings' categories are switched on.
- The rules (kit stock, delivery promise, how a cart ships, surcharge lines,
  part-number search) live in `lib/foundation.ts` and are tested in
  `tests/foundation.test.ts`.
- Survey cards now match an item through any of its cross-reference numbers, not
  only its listed part number.
- If the details screen says a setup step is needed, run the "Catalog
  foundation" section of `supabase/schema.sql` in the Supabase SQL editor.

## Hose builder (`/hose` and the Hoses tab)

Replacing a hydraulic hose assembly, three ways in and one build sheet out:

- **Snap the old hose.** Photos of the printing along the hose and of each end
  are read (needs `ANTHROPIC_API_KEY`); the printed layline text is also parsed
  directly, and where it says something plainly it wins. The customer checks
  every field before ordering. Reads are limited per visitor per hour.
- **Tag or part number.** Every request gets our own tag (`BH-XXXX-XXXX`). The
  tag brings the build back for an identical replacement. Builds can also be
  stored against OEM part numbers.
- **By hand.** Hose size, type and printed working pressure, both ends
  (connection, gender, shape, thread size), length and the angle between
  elbows. A caliper measurement identifies the thread.

The engine is `lib/hose.ts` (tested in `tests/hose.test.ts`). A build sheet is
refused until the hose's rated pressure is given and covers the system pressure;
pressures are never invented. The sheet states where length is measured, the
length and angle tolerances, and the rule that hose and fittings come from one
maker's system crimped to that maker's spec.

**Measuring guide.** Under length and angle, a step-by-step walkthrough for
each way a customer measures: the hose off the machine (lay it straight; the
last step reads two photos of the tape, one at each end), the hose still on the
machine (safety first, then a string along the route), and the angle between
two elbows (tap a clock position). Steps are written from the ends picked
(`lib/measure.ts`). "I build hoses: skip the guides" hides all of it and is
remembered on that device.

Machine-down requests are shown the places marked in the Hoses tab as
promising a one-hour build; with none, the customer is told to call the store.
Shop requests are confirmed and priced by hand for now.

## Space mapper (the Space mapper tab)

Maps a shop's physical layout from photos, so pick tickets pull parts for
several orders in one short walk. It is about what is there, what is next to
what and how you walk it. Nothing is measured and nothing is drawn.

1. **Photos and notes.** Snap or upload photos of the aisles, shelf tags, doors
   and stairs (or a hand sketch), with a few words on each if needed.
2. **Questions.** The reader drafts the layout and asks what it could not tell:
   where picks start, whether an aisle is a dead end, how many bins a shelf has.
   Answer or skip, and it reads again.
3. **The layout.** One plain-text layout file, shown as an outline. It can be
   edited by hand, downloaded and loaded back.
4. **Shelf map.** One button adds the spots to the Shelf map tab. Nothing is ever
   removed and no part moves. Pick tickets then start and finish at the file's
   start point, take aisles in the shortest order, and walk a dead-end aisle in
   and back out.

The layout file (`lib/spacemap.ts` has the full rules):

```
spacemap 1
name: McCormick Diesel Service

Location MCD "McCormick Diesel"
  Building 1 "Main shop"
    Area 100 "Parts room"
      Aisle 01..04
        Section A..C
          Bin 01..12
      Aisle 05 (dead end)
        Bin 01..08
    Area 105 "Upstairs backstock"
      Shelf A..D

start: MCD-1-100 "Parts counter"
link: MCD-1-100-04 <> MCD-1-105 far "Stairs at the end of aisle 4"
```

One spot per line, two spaces of indent to go inside, in walking order. A range
(`01..12`) is that many spots, and what is indented under it is inside each one.
Spots listed one after another are taken to be next to each other; a `link:`
line says otherwise (`near`, `walk` or `far`). `start:` is where picks begin and
end. The walk itself is `lib/walk.ts`; the reader's instructions are
`lib/spacemap-read.ts`. Setup: `supabase/add-space-maps.sql` (after
`add-shelf-spots.sql`), and `ANTHROPIC_API_KEY` for the photo reading. Without
the key the file can still be written by hand.

## Environment variables

The two public values are committed in `.env.production`. The secret values
are set in Vercel under Project, Settings, Environment Variables, followed by a
redeploy. See `.env.example`.

| Name | What it is |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (public) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (public, read-only catalog) |
| `SUPABASE_SECRET_KEY` | Supabase secret key. Server only. |
| `ADMIN_PASSWORD` | Password for `/admin`. Use a long one. |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_...` or `sk_live_...`) |
| `SHIPPO_API_TOKEN` | Shippo API token (`shippo_test_...` or `shippo_live_...`) |
| `ANTHROPIC_API_KEY` | Optional. Anthropic API key; switches on reading of survey photos and the Space mapper. |
| `ANTHROPIC_MODEL` | Optional. Model used to read photos. Defaults to `claude-sonnet-5-5`. |
| `RESEND_API_KEY`, `ALERT_FROM_EMAIL` | Optional. Send dealer alerts by email (Resend). The from address must be on a domain verified in Resend, like `Backroad Iron <orders@backroadiron.com>`. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Optional. Send dealer alerts by text (Twilio). `TWILIO_FROM` is your Twilio number, like `+12175550100`. |
| `CRON_SECRET` | Optional. Any long random string. Lets the Monday running-low job run (`vercel.json`). |
| `SITE_URL` | Optional. The address used in alert links. Defaults to the production domain. |

After Stripe's key is in place, open `/admin`, Settings, and press **Connect**
next to "Stripe order reporting". That registers the webhook with Stripe and
stores its signing secret in the database.

## Database

Tables live in the shared `fieldline-staging` Supabase project with a
`fittings_` prefix. `supabase/schema.sql` is the full definition and
`supabase/seed.sql` loads the 20 items from the ADK600 cap and plug kit. They are
applied by hand, outside that project's migration history, so they never collide
with Backroad Iron migrations. Shoppers can read `fittings_products`,
`fittings_settings` and the catalog structures (categories, cross-references,
machines, fitment, kit parts, surcharges, documents). Stock counts at other places
and everything else are reachable only with the secret key.

## Running the network day to day (`supabase/add-operations.sql`)

- **Ship-from per location.** Each location can have a street address and phone (Settings, Dealers and locations). A label ships from the location that pulled the most parts for the order, when it has a full address; otherwise from the shop-wide ship-from.
- **Returns and refunds.** Orders, Return or refund (or Cancel and refund on an order still to ship). Parts go back on the shelf they came from, Stripe refunds the card, and each dealer's statement gets a reversing line at its original rates. Stripe keeps its card fee on a refund, so that is not reversed.
- **Dealer page (`/dealer`).** Staff add logins per dealer in Settings. Dealers see orders with parts on their shelves, check parts off, print the pick list, mark each location's part of an order shipped with tracking, and see their month's statement. The order shows shipped once every location has shipped.
- **Dealer alerts.** Each dealer has alert emails and a cell phone. A paid order that needs parts from a dealer's shelves queues a message; running-low lists go out Mondays. Messages always land in the outbox (Running low tab) and send when Resend or Twilio is set up.
- **Counter sale tab.** Rings up a walk-in or phone sale at one location; the parts come off that location's count.
- **Import spreadsheet** (Inventory). A CSV with Part number and Qty (plus Name for new parts and Price) sets counts at one location as a recount, after a preview.
- **Running low tab.** Parts at or under the low-stock number, or with under about 30 days left at the last 30 days' pace, by location.

- **Dealer shipping labels** (`supabase/add-dealer-labels.sql`). Off until turned on in Settings, Dealers and locations, Dealer shipping labels. A dealer types the package weight and size on an order, sees label prices from the Shippo account, and buys one. The label prints from that location's street address, the tracking fills in, and the charge goes on the dealer's statement as a "Shipping label" line. The markup (a percent, a flat amount per label, or both) lives in the private config under `dealer_labels` and starts at 0, so dealers pay what the label costs. A dealer can always type in tracking from its own carrier account instead. Linking a dealer's own carrier accounts needs a Shippo Platform Account and is not built yet.

- **Package prefill.** On the dealer page, the label's weight is filled in from the parts' saved packed weight (Edit item, Details) when every part has one. The box size is filled in only for a single part with a saved box size. The dealer can change both.
- **Void a label** (`supabase/add-label-voids.sql`). Staff only: Orders, the shipment line, Void label. Shippo is asked for the refund (it can take up to 14 days to confirm; a used label is turned down and nothing changes), the dealer's statement gets a line that gives the charge back, the shipment comes off the order and the order goes back to To ship. Each void is kept in `fittings_label_voids`.

Checks: `supabase/test-operations.sql`, `supabase/test-dealer-labels.sql` and `supabase/test-label-voids.sql` on a scratch database with every change loaded.

## Part pages for search (`/part/<id>`)

Every part has its own page at `/part/<id>`: name, part number, specs, the numbers it replaces, price, stock and an Add to cart button that uses the same cart as the shop. The page's title, description and product data (schema.org, for search engines and AI assistants) are built only from the part's own record: a price or "in stock" is shown only when it is real, quote-only parts carry no price, and supplier numbers stay private. `/sitemap.xml` lists the shop and each part with a price (or sold by quote) for whichever store's address is asked; `/robots.txt` keeps the back office, dealer page, order pages and API out of search. The shop's part window links to the part's page, and `/?item=<id>` opens the shop with that part's window open.

A part page can't be used to get around the shop. A part this store doesn't sell has no page (404). An out-of-stock or unpriced part shows a plain notice and a disabled button, and an unpriced part is kept out of search. Whatever a browser sends, `/api/checkout` checks every line again on the server (in stock after holds, priced, not quote-only) and the database hold checks the store's own stock with the rows locked, so no order is made for a part that can't be sold.

## Working on it

```bash
npm install
npm run dev      # local site
npm test         # unit tests: matching, photo reading rules, supplier pages, barcodes
npm run check    # lint, type check, tests and production build: run before every push
```

Money is stored in cents. Margin means profit as a share of the sell price:
`price = cost / (1 - margin)`.
