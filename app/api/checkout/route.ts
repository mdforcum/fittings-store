// Starts a Stripe Checkout session. Prices, stock and shipping are all
// re-checked here on the server; nothing the browser sends is trusted but
// the item ids and quantities.
//
// Starting checkout holds the parts for the shopper (lib/holds.ts): other
// shoppers can't buy them until the payment page closes. If the shopper is
// starting over with a changed cart, their earlier hold is let go first.
import { money, normalizeProduct, normalizeSettings, sellable, shippingFor } from "@/lib/catalog";
import { checkoutPlan } from "@/lib/checkout-rules";
import { surchargeLines, type Surcharge } from "@/lib/foundation";
import { availableQty, heldMap, holdMessage, holdWindow, isOrderId } from "@/lib/holds";
import { getStripe } from "@/lib/payments";
import { storeShipping } from "@/lib/storefront";
import { storeForRequest } from "@/lib/storefront-server";
import { T, adminDb, env, getConfig, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const stripe = getStripe();
  if (!stripe || !env.secret) {
    return json({ error: "not_configured", message: "Online checkout is not switched on yet." }, 503);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request", message: "The cart could not be read." }, 400);
  }
  const wanted = new Map<string, number>();
  const rawItems = (body as { items?: unknown })?.items;
  for (const it of Array.isArray(rawItems) ? rawItems.slice(0, 60) : []) {
    const id = (it as { id?: unknown })?.id;
    const qty = (it as { qty?: unknown })?.qty;
    if (typeof id === "string" && typeof qty === "number" && Number.isInteger(qty) && qty > 0 && qty < 1000) {
      wanted.set(id, qty);
    }
  }
  if (wanted.size === 0) return json({ error: "empty", message: "Your cart is empty." }, 400);

  const db = adminDb();
  // A dealer's storefront: the order is theirs and is filled from their shelves only.
  const { storefront } = await storeForRequest(null);
  const release = (body as { release?: unknown })?.release;
  if (isOrderId(release)) await letGo(db, stripe, release);

  const [found, settingsRow, taxMode, extras, heldRows] = await Promise.all([
    db.from(T.products).select("*").in("id", [...wanted.keys()]),
    db.from(T.settings).select("*").eq("id", 1).maybeSingle(),
    getConfig<string>(db, "tax_mode"),
    db.from("fittings_surcharges").select("product_id, kind, amount_cents, refundable, label").in("product_id", [...wanted.keys()]),
    db.rpc("fittings_held"),
  ]);
  if (found.error) return json({ error: "server", message: "The catalog could not be loaded." }, 500);
  // A dealer's store charges its own shipping and minimum when it sets them.
  const settings = storeShipping(normalizeSettings(settingsRow.data), storefront);
  const held = heldMap(heldRows.error ? [] : (heldRows.data as Array<{ product_id: unknown; held: unknown }>));
  const byId = new Map(
    (found.data ?? []).map((r) => {
      const p = normalizeProduct(r);
      return [p.id, { ...p, qty: availableQty(p.qty, held[p.id]) }];
    }),
  );

  // THE RULE, enforced where it counts: zero stock or no price cannot be bought.
  const problems: Array<{ id: string; available: number }> = [];
  for (const [id, qty] of wanted) {
    const p = byId.get(id);
    if (!sellable(p)) problems.push({ id, available: 0 });
    else if (qty > p!.qty) problems.push({ id, available: p!.qty });
  }
  if (problems.length) {
    return json(
      {
        error: "stock",
        message: "Stock changed while you were shopping. Your cart has been updated; please review it.",
        problems,
      },
      409,
    );
  }

  const lines = [...wanted].map(([id, qty]) => ({ p: byId.get(id)!, qty }));

  // Quote-only items and truck freight are not paid for online.
  const plan = checkoutPlan(lines.map((l) => ({ id: l.p.id, qty: l.qty, ship_class: l.p.ship_class, price_mode: l.p.price_mode })));
  if (!plan.online) {
    return json({ error: plan.method === "freight" ? "freight" : "quote", message: plan.reason }, 409);
  }
  const pickup = plan.method === "pickup";

  // Cores and other charges ride along as their own lines. They are not part
  // of the parts subtotal, so the order minimum and free shipping ignore them.
  if (extras.error) return json({ error: "server", message: "The catalog could not be loaded." }, 500);
  const charges = surchargeLines(
    lines.map((l) => ({ product_id: l.p.id, qty: l.qty })),
    (extras.data ?? []) as Array<Surcharge & { product_id: string }>,
  );
  const chargesTotal = charges.reduce((sum, c) => sum + c.total_cents, 0);

  const subtotal = lines.reduce((sum, l) => sum + l.qty * (l.p.price_cents ?? 0), 0);
  if (subtotal < settings.order_min_cents) {
    return json(
      { error: "minimum", message: `The minimum order is ${money(settings.order_min_cents)} before shipping.` },
      400,
    );
  }
  const shipping = pickup ? 0 : shippingFor(subtotal, settings);

  const order = await db
    .from(T.orders)
    .insert({
      ...(storefront
        ? {
            storefront_id: storefront.id,
            dealer_id: storefront.dealer_id,
            // A store showing only its own stock is filled only from its own shelves.
            ...(storefront.has_options ? { own_stock_only: storefront.stock_scope === "own" } : {}),
          }
        : {}),
      status: "pending",
      ship_method: pickup ? "pickup" : "parcel",
      subtotal_cents: subtotal,
      shipping_cents: shipping,
      charges_cents: chargesTotal,
      total_cents: subtotal + chargesTotal + shipping,
    })
    .select("id")
    .single();
  if (order.error || !order.data) return json({ error: "server", message: "The order could not be started." }, 500);
  const orderId = order.data.id as string;

  const items = await db.from(T.items).insert(
    lines.map((l) => ({
      order_id: orderId,
      product_id: l.p.id,
      name: l.p.name,
      part_number: l.p.part_number,
      unit_price_cents: l.p.price_cents,
      qty: l.qty,
    })),
  );
  const chargeRows = charges.length
    ? await db.from("fittings_order_charges").insert(
        charges.map((c) => ({
          order_id: orderId,
          product_id: c.product_id,
          kind: c.kind,
          label: c.label,
          unit_cents: c.unit_cents,
          qty: c.qty,
          total_cents: c.total_cents,
          refundable: c.refundable,
        })),
      )
    : { error: null };
  if (items.error || chargeRows.error) {
    await db.from(T.orders).delete().eq("id", orderId);
    return json({ error: "server", message: "The order could not be started." }, 500);
  }
  const nameOf = (id: string) => byId.get(id)?.name ?? "item";

  // Hold the parts. The database checks again with the products locked, so two
  // shoppers racing for the last one can't both get it.
  const holdWin = holdWindow(settings.hold_minutes, settings.hold_grace_minutes, Date.now());
  const hold = await db.rpc("fittings_hold_order", { p_order_id: orderId, p_minutes: holdWin.dbMinutes });
  if (hold.error) {
    // Before the holds are set up the function is missing: sell as before.
    if (!/fittings_hold_order|PGRST202|42883/.test(`${hold.error.code} ${hold.error.message}`)) {
      await db.from(T.orders).delete().eq("id", orderId);
      return json({ error: "server", message: "The order could not be started." }, 500);
    }
  } else if (!(hold.data as { ok?: boolean })?.ok) {
    await db.from(T.orders).delete().eq("id", orderId);
    return json(
      {
        error: "stock",
        message: "Someone else just checked out with some of these parts. Your cart has been updated; please review it.",
        problems: ((hold.data as { problems?: Array<{ id: string; available: number }> })?.problems ?? []),
      },
      409,
    );
  }
  const holding = !hold.error;

  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: orderId,
      metadata: { order_id: orderId },
      line_items: [
        ...lines.map((l) => ({
          quantity: l.qty,
          price_data: {
            currency: "usd",
            unit_amount: l.p.price_cents ?? 0,
            product_data: {
              name: l.p.name,
              ...(l.p.part_number ? { description: `Part # ${l.p.part_number}` } : {}),
            },
          },
        })),
        ...charges.map((c) => ({
          quantity: c.qty,
          price_data: {
            currency: "usd",
            unit_amount: c.unit_cents,
            product_data: {
              name: `${c.label}: ${nameOf(c.product_id)}`,
              description:
                c.kind === "core"
                  ? "Refunded when your old part comes back: full within 30 days, 85% from day 31 to 60."
                  : c.refundable
                    ? "Refundable."
                    : "Not refundable.",
            },
          },
        })),
      ],
      ...(holding
        ? { custom_text: { submit: { message: holdMessage(holdWin.endsAt, settings.ship_tz, pickup) } } }
        : pickup
          ? { custom_text: { submit: { message: "Pickup order: we'll call when it's ready at the counter." } } }
          : {}),
      ...(pickup
        ? {}
        : {
            shipping_address_collection: { allowed_countries: ["US" as const] },
            shipping_options: [
              {
                shipping_rate_data: {
                  type: "fixed_amount" as const,
                  display_name: shipping === 0 ? "Free shipping" : "Standard shipping",
                  fixed_amount: { amount: shipping, currency: "usd" },
                },
              },
            ],
          }),
      phone_number_collection: { enabled: true },
      ...(taxMode === "stripe" ? { automatic_tax: { enabled: true } } : {}),
      expires_at: holdWin.stripeExpiresAt,
      success_url: `${origin}/order/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?cart=open`,
    });
    await db.from(T.orders).update({ stripe_session_id: session.id }).eq("id", orderId);
    return json({ url: session.url, order_id: orderId, ...(holding ? { held_until: holdWin.endsAt, now: new Date().toISOString() } : {}) });
  } catch (e) {
    await db.from(T.orders).update({ status: "cancelled", notes: "Checkout could not be created." }).eq("id", orderId);
    if (holding) await db.rpc("fittings_release_holds", { p_order_id: orderId, p_reason: "cancelled" });
    console.error("checkout session failed", e);
    return json({ error: "stripe", message: "Checkout could not be started. Please try again in a moment." }, 502);
  }
}

/**
 * The shopper changed their cart and is starting over: close their earlier
 * payment page so it can't be paid as well, and give its parts back.
 * Only an unpaid checkout is touched; knowing its id is the shopper's proof.
 */
async function letGo(db: ReturnType<typeof adminDb>, stripe: NonNullable<ReturnType<typeof getStripe>>, orderId: string) {
  const { data } = await db.from(T.orders).select("id, status, stripe_session_id").eq("id", orderId).maybeSingle();
  if (!data || data.status !== "pending") return;
  if (data.stripe_session_id) {
    try {
      await stripe.checkout.sessions.expire(data.stripe_session_id as string);
    } catch {
      // Stripe refuses if the page already closed or was paid. Only a closed,
      // unpaid page lets the parts go; a paid one is settled by the webhook.
      const s = await stripe.checkout.sessions.retrieve(data.stripe_session_id as string).catch(() => null);
      if (s?.status !== "expired") return;
    }
  }
  await db.from(T.orders).update({ status: "expired" }).eq("id", orderId).eq("status", "pending");
  await db.rpc("fittings_release_holds", { p_order_id: orderId, p_reason: "released" });
}
