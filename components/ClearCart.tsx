"use client";
import { useEffect } from "react";
import { writeCart } from "@/lib/cart";
import { HELD_KEY } from "@/lib/holds";

/** Empties the browser cart and forgets the held checkout once an order is confirmed. */
export default function ClearCart() {
  useEffect(() => {
    writeCart({});
    try {
      window.localStorage.removeItem(HELD_KEY);
    } catch {
      /* nothing saved */
    }
  }, []);
  return null;
}
