import type { Metadata } from "next";
import Link from "next/link";
import ClearCart from "@/components/ClearCart";
import { money } from "@/lib/catalog";
import { fulfillSession, getStripe } from "@/lib/payments";
import { T, adminDb, env } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Order received", robots: { index: false } };

type Found = { number: number; total: number; email: string | null } | null;

// Backs up the webhook: if the shopper lands here first, the order is marked
// paid now. The database function only acts once, so the two never double up.
async function confirm(sessionId: string): Promise<Found> {
  const stripe = getStripe();
  if (!stripe || !env.secret || !sessionId.startsWith("cs_")) return null;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const { orderId, paid } = await fulfillSession(session);
    if (!orderId || !paid) return null;
    const { data } = await adminDb().from(T.orders).select("number, total_cents, email").eq("id", orderId).maybeSingle();
    return data ? { number: data.number as number, total: data.total_cents as number, email: data.email as string | null } : null;
  } catch (e) {
    console.error("order confirmation failed", e);
    return null;
  }
}

export default async function Success({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const id = (await searchParams).session_id;
  const order = await confirm(typeof id === "string" ? id : "");
  return (
    <main className="center">
      <p className="eyebrow">{order ? `Order #${order.number}` : "Checkout"}</p>
      {order ? (
        <>
          <h1>Thanks. Your order is in.</h1>
          <p>
            We charged {money(order.total)}. Your fittings ship as soon as they are packed
            {order.email ? `, and we will use ${order.email} if we need to reach you` : ""}.
          </p>
          <ClearCart />
        </>
      ) : (
        <>
          <h1>We could not confirm that payment</h1>
          <p>
            If you completed checkout, your card receipt is your confirmation and the order will appear on
            our side shortly. If not, your cart is still saved.
          </p>
        </>
      )}
      <p>
        <Link className="btn" href="/">
          Back to the shop
        </Link>
      </p>
    </main>
  );
}
