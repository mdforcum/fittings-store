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
| `ANTHROPIC_API_KEY` | Optional. Anthropic API key; switches on reading of survey photos. |
| `ANTHROPIC_MODEL` | Optional. Model used to read photos. Defaults to `claude-sonnet-5-5`. |

After Stripe's key is in place, open `/admin`, Settings, and press **Connect**
next to "Stripe order reporting". That registers the webhook with Stripe and
stores its signing secret in the database.

## Database

Tables live in the shared `fieldline-staging` Supabase project with a
`fittings_` prefix. `supabase/schema.sql` is the full definition and
`supabase/seed.sql` loads the 20 items from the ADK600 cap and plug kit. They are
applied by hand, outside that project's migration history, so they never collide
with Backroad Iron migrations. Shoppers can read `fittings_products` and
`fittings_settings`; every other table is reachable only with the secret key.

## Working on it

```bash
npm install
npm run dev      # local site
npm test         # unit tests: matching, photo reading rules, supplier pages, barcodes
npm run check    # lint, type check, tests and production build: run before every push
```

Money is stored in cents. Margin means profit as a share of the sell price:
`price = cost / (1 - margin)`.
