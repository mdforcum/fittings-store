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

## Environment variables

Set in Vercel under Project, Settings, Environment Variables. See `.env.example`.

| Name | What it is |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (public) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (public, read-only catalog) |
| `SUPABASE_SECRET_KEY` | Supabase secret key. Server only. |
| `ADMIN_PASSWORD` | Password for `/admin`. Use a long one. |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_...` or `sk_live_...`) |
| `SHIPPO_API_TOKEN` | Shippo API token (`shippo_test_...` or `shippo_live_...`) |

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
npm run check    # lint, type check and production build: run before every push
```

Money is stored in cents. Margin means profit as a share of the sell price:
`price = cost / (1 - margin)`.
