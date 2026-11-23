"use client";
import { useEffect } from "react";
import { writeCart } from "@/lib/cart";

/** Empties the browser cart once an order is confirmed. */
export default function ClearCart() {
  useEffect(() => {
    writeCart({});
  }, []);
  return null;
}
