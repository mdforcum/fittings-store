"use client";
// The buy button on a part's own page, and the cart link in its header. Both
// use the same browser cart as the shop. The button follows the same rule as
// the cart and checkout: a part with no stock or no price can't be added, and
// checkout checks again on the server whatever the browser says.
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

export function PartBuy({ id, name, qty, canBuy, label, cartHref }: { id: string; name: string; qty: number; canBuy: boolean; label: string; cartHref: string }) {
  const cart = useCart();
  const have = cart[id] ?? 0;
  const allIn = canBuy && have >= qty;
  return (
    <div className="part-buy">
      <button
        type="button"
        className="btn"
        disabled={!canBuy || allIn}
        onClick={() => {
          if (!canBuy || have >= qty) return;
          writeCart({ ...cart, [id]: Math.min(qty, have + 1) });
        }}
      >
        {!canBuy ? label : have > 0 ? "Add one more" : label}
      </button>
      <p className="hint" role="status" aria-live="polite">
        {!canBuy && have > 0
          ? `${name} is in your cart from before, but it can't be ordered now. It will be left out at checkout.`
          : have > 0
            ? `${have} of ${name} in your cart${allIn ? `. That's all ${qty} on hand.` : "."}`
            : ""}
      </p>
      {have > 0 && (
        <Link className="btn ghost" href={cartHref}>
          Go to cart
        </Link>
      )}
    </div>
  );
}
