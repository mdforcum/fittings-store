// Stripe calls this when a checkout is paid or expires. This is the reliable
// path for marking orders paid and counting stock down.
import type Stripe from "stripe";
import { expireOrder, fulfillSession, getStripe } from "@/lib/payments";
import { adminDb, env, getConfig } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const stripe = getStripe();
  if (!stripe || !env.secret) return new Response("not configured", { status: 503 });

  const signature = req.headers.get("stripe-signature");
  const payload = await req.text();
  const stored = await getConfig<{ secret?: string }>(adminDb(), "stripe_webhook");
  const secret = process.env.STRIPE_WEBHOOK_SECRET || stored?.secret;
  if (!signature || !secret) return new Response("webhook secret missing", { status: 400 });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, secret);
  } catch {
    return new Response("bad signature", { status: 400 });
  }

  try {
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      await fulfillSession(event.data.object);
    } else if (event.type === "checkout.session.expired") {
      await expireOrder(event.data.object);
    }
  } catch (e) {
    console.error("webhook handling failed", e);
    return new Response("handler error", { status: 500 }); // Stripe will retry
  }
  return Response.json({ received: true });
}
