// Starts a Stripe Checkout session. Prices, stock and shipping are all
// re-checked here on the server; nothing the browser sends is trusted but
// the item ids and quantities.
import { money, normalizeProduct, normalizeSettings, sellable, shippingFor } from "@/lib/catalog";
import { getStripe } from "@/lib/payments";
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
  const [found, settingsRow, taxMode] = await Promise.all([
    db.from(T.products).select("*").in("id", [...wanted.keys()]),
    db.from(T.settings).select("*").eq("id", 1).maybeSingle(),
    getConfig<string>(db, "tax_mode"),
  ]);
  if (found.error) return json({ error: "server", message: "The catalog could not be loaded." }, 500);
  const settings = normalizeSettings(settingsRow.data);
  const byId = new Map((found.data ?? []).map((r) => [r.id as string, normalizeProduct(r)]));

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
  const subtotal = lines.reduce((sum, l) => sum + l.qty * (l.p.price_cents ?? 0), 0);
  if (subtotal < settings.order_min_cents) {
    return json(
      { error: "minimum", message: `The minimum order is ${money(settings.order_min_cents)} before shipping.` },
      400,
    );
  }
  const shipping = shippingFor(subtotal, settings);

  const order = await db
    .from(T.orders)
    .insert({ status: "pending", subtotal_cents: subtotal, shipping_cents: shipping, total_cents: subtotal + shipping })
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
  if (items.error) {
    await db.from(T.orders).delete().eq("id", orderId);
    return json({ error: "server", message: "The order could not be started." }, 500);
  }

  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: orderId,
      metadata: { order_id: orderId },
      line_items: lines.map((l) => ({
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
      shipping_address_collection: { allowed_countries: ["US"] },
      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            display_name: shipping === 0 ? "Free shipping" : "Standard shipping",
            fixed_amount: { amount: shipping, currency: "usd" },
          },
        },
      ],
      phone_number_collection: { enabled: true },
      ...(taxMode === "stripe" ? { automatic_tax: { enabled: true } } : {}),
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      success_url: `${origin}/order/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?cart=open`,
    });
    await db.from(T.orders).update({ stripe_session_id: session.id }).eq("id", orderId);
    return json({ url: session.url });
  } catch (e) {
    await db.from(T.orders).update({ status: "cancelled", notes: "Checkout could not be created." }).eq("id", orderId);
    console.error("checkout session failed", e);
    return json({ error: "stripe", message: "Checkout could not be started. Please try again in a moment." }, 502);
  }
}
