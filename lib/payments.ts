// Stripe: client, and the one function that turns a paid checkout into a paid order.
import Stripe from "stripe";
import { T, adminDb, env } from "./server";

export function getStripe(): Stripe | null {
  return env.stripe ? new Stripe(env.stripe) : null;
}

type StripeAddress = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
};
type ShippingDetails = { name?: string | null; address?: StripeAddress | null };
// Where Stripe puts the shipping address depends on the API version in use.
type SessionShipping = {
  collected_information?: { shipping_details?: ShippingDetails | null } | null;
  shipping_details?: ShippingDetails | null;
};

/**
 * Marks the order for this checkout session paid and takes its items out of
 * stock. Called from both the webhook and the thank-you page; the database
 * function only acts once, so the second caller is a no-op.
 */
export async function fulfillSession(
  session: Stripe.Checkout.Session,
): Promise<{ orderId: string | null; paid: boolean }> {
  const orderId = session.client_reference_id ?? session.metadata?.order_id ?? null;
  if (!orderId || session.payment_status !== "paid") return { orderId, paid: false };

  const loose = session as unknown as SessionShipping;
  const ship = loose.collected_information?.shipping_details ?? loose.shipping_details ?? null;
  const customer = session.customer_details;
  const address = ship?.address ?? customer?.address ?? null;

  const details = {
    stripe_session_id: session.id,
    stripe_payment_intent:
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : (session.payment_intent?.id ?? null),
    email: customer?.email ?? null,
    customer_name: ship?.name ?? customer?.name ?? null,
    phone: customer?.phone ?? null,
    ship_to: address
      ? {
          name: ship?.name ?? customer?.name ?? "",
          street1: address.line1 ?? "",
          street2: address.line2 ?? "",
          city: address.city ?? "",
          state: address.state ?? "",
          zip: address.postal_code ?? "",
          country: address.country ?? "US",
        }
      : null,
    // The parts subtotal stays as checkout worked it out: Stripe's subtotal
    // also counts core and other charges, which are kept on their own lines.
    subtotal_cents: null,
    shipping_cents: session.total_details?.amount_shipping ?? 0,
    tax_cents: session.total_details?.amount_tax ?? 0,
    total_cents: session.amount_total,
  };

  const { error } = await adminDb().rpc("fittings_fulfill_order", {
    p_order_id: orderId,
    p_details: { ...details, card_fee_cents: await cardFee(details.stripe_payment_intent) },
  });
  if (error) throw new Error(`fulfill failed: ${error.message}`);
  return { orderId, paid: true };
}

export async function expireOrder(session: Stripe.Checkout.Session): Promise<void> {
  const orderId = session.client_reference_id ?? session.metadata?.order_id;
  if (!orderId) return;
  const db = adminDb();
  await db.from(T.orders).update({ status: "expired" }).eq("id", orderId).eq("status", "pending");
  // The payment page closed unpaid: its parts go back on sale. (Before the
  // holds are set up this call fails harmlessly.)
  await db.rpc("fittings_release_holds", { p_order_id: orderId, p_reason: "expired" });
}

/**
 * What Stripe charged to process a payment, in cents, read from the payment's
 * balance transaction. Null when Stripe hasn't settled it yet or can't be
 * reached; the dealer statements can fill it in later.
 */
export async function cardFee(paymentIntentId: string | null): Promise<number | null> {
  const stripe = getStripe();
  if (!stripe || !paymentIntentId) return null;
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
    const charge = pi.latest_charge;
    const bt = charge && typeof charge === "object" ? charge.balance_transaction : null;
    return bt && typeof bt === "object" && typeof bt.fee === "number" ? bt.fee : null;
  } catch {
    return null;
  }
}
