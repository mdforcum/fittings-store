"use client";
// The cart lives in the shopper's browser. A tiny external store keeps every
// component in step and survives a page reload.
import { useSyncExternalStore } from "react";

export type Cart = Record<string, number>;

const KEY = "fittings-cart-v1";
const EMPTY: Cart = Object.freeze({}) as Cart;
const listeners = new Set<() => void>();
let raw = "";
let cache: Cart = EMPTY;

function clean(value: unknown): Cart {
  const out: Cart = {};
  if (value && typeof value === "object") {
    for (const [id, qty] of Object.entries(value as Record<string, unknown>)) {
      if (typeof qty === "number" && Number.isInteger(qty) && qty > 0) out[id] = qty;
    }
  }
  return out;
}

function read(): Cart {
  try {
    const stored = localStorage.getItem(KEY) ?? "";
    if (stored !== raw) {
      raw = stored;
      cache = stored ? clean(JSON.parse(stored)) : EMPTY;
    }
  } catch {
    /* storage unavailable: keep the in-memory cart */
  }
  return cache;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

export function writeCart(next: Cart): void {
  cache = clean(next);
  raw = JSON.stringify(cache);
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

export function useCart(): Cart {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}
