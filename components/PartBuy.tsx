"use client";
// The buy button on a part's own page, and the cart link in its header. Both
// use the same browser cart as the shop.
import Link from "next/link";
import { useCart, writeCart } from "@/lib/cart";

export function CartLink({ href }: { href: string }) {
  const cart = useCart();
  const count = Object.values(cart).reduce((s, n) => s + n, 0);
  return (
    <Link className="cartbtn" href={href}>
      Cart <span className="count">{count}</span>
    </Link>
  );
}

export function PartBuy({ id, name, qty, priced, cartHref }: { id: string; name: string; qty: number; priced: boolean; cartHref: string }) {
  const cart = useCart();
  const have = cart[id] ?? 0;
  const canSell = qty > 0 && priced;
  const allIn = have >= qty;
  return (
    <div className="part-buy">
      <button type="button" className="btn" disabled={!canSell || allIn} onClick={() => writeCart({ ...cart, [id]: Math.min(qty, have + 1) })}>
        {!canSell ? (qty <= 0 ? "Out of stock" : "Not available yet") : have > 0 ? "Add one more" : "Add to cart"}
      </button>
      <p className="hint" role="status" aria-live="polite">
        {have > 0 ? `${have} of ${name} in your cart${allIn && canSell ? `. That's all ${qty} on hand.` : "."}` : ""}
      </p>
      {have > 0 && (
        <Link className="btn ghost" href={cartHref}>
          Go to cart
        </Link>
      )}
    </div>
  );
}
