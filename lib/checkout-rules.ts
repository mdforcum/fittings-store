// Checkout rules decided for the store, kept pure so the cart, the checkout,
// the back office and the tests all apply the same ones.
//
//   Cores       full credit returned within 30 days of the sale, 85% from day
//               31 to day 60, nothing after day 60.
//   Same day    in-stock orders placed before the cutoff (2 pm Central) on a
//               weekday ship that day; later ones ship the next business day.
//   Ship method one freight item puts the order on a truck (quoted); a pickup
//               item makes it a pickup; otherwise parcel.
import { shippingFor, type Settings } from "./catalog.ts";
import { cartShipping, surchargeLines, type ShipClass, type Surcharge, type SurchargeLine } from "./foundation.ts";

export const CORE_FULL_DAYS = 30;
export const CORE_PARTIAL_DAYS = 60;
export const CORE_PARTIAL_SHARE = 0.85;

const DAY = 86_400_000;

/** The calendar day a moment falls on at the store, as "2026-11-25". */
export function storeDate(d: Date, tz = "America/Chicago"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const dayNumber = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / DAY);

/**
 * The credit for a returned core. Days count from the day of the sale to the
 * day the core arrives back, by calendar day at the store: arriving on day 30
 * still earns full credit, day 31 to 60 earns 85% (rounded down to the cent).
 * The return day may be given as the "2026-11-25" a date box gives.
 */
export function coreCredit(
  amountCents: number,
  soldAt: Date,
  returned: Date | string,
  tz = "America/Chicago",
): { cents: number; days: number; share: number; text: string } {
  const back = typeof returned === "string" ? returned : storeDate(returned, tz);
  const days = Math.max(0, dayNumber(back) - dayNumber(storeDate(soldAt, tz)));
  if (days <= CORE_FULL_DAYS) return { cents: amountCents, days, share: 1, text: `Returned in ${days} days: full credit.` };
  if (days <= CORE_PARTIAL_DAYS) {
    return { cents: Math.floor(amountCents * CORE_PARTIAL_SHARE), days, share: CORE_PARTIAL_SHARE, text: `Returned in ${days} days: 85% credit.` };
  }
  return { cents: 0, days, share: 0, text: `Returned after ${days} days: past the 60-day limit, no credit.` };
}

/** "14:00" → "2 pm", "9:30" → "9:30 am". */
export function clockLabel(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = m[2];
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === "00" ? `${h12} ${suffix}` : `${h12}:${min} ${suffix}`;
}

const ZONE_NAMES: Record<string, string> = {
  "America/Chicago": "Central",
  "America/New_York": "Eastern",
  "America/Denver": "Mountain",
  "America/Los_Angeles": "Pacific",
};

/** The local clock in a time zone: weekday 0-6 (Sunday 0), minutes after midnight. */
function local(now: Date, tz: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * When an in-stock order placed now leaves the shelf. Within three hours of
 * the cutoff it counts down, so a buyer can see how long they have.
 */
export function shipDay(now: Date, cutoff = "14:00", tz = "America/Chicago"): { today: boolean; text: string } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(cutoff.trim());
  const cut = m ? Number(m[1]) * 60 + Number(m[2]) : 14 * 60;
  const { weekday, minutes } = local(now, tz);
  const zone = ZONE_NAMES[tz] ?? tz;
  const at = `${clockLabel(cutoff)} ${zone}`;
  const weekend = weekday === 0 || weekday === 6;
  if (!weekend && minutes < cut) {
    const left = cut - minutes;
    if (left <= 180) {
      const h = Math.floor(left / 60);
      const mins = left % 60;
      const span = h ? `${h} h ${mins} min` : `${mins} min`;
      return { today: true, text: `Order in the next ${span} and in-stock parts ship today.` };
    }
    return { today: true, text: `Order by ${at} and in-stock parts ship today.` };
  }
  // Next business day.
  let next = (weekday + 1) % 7;
  while (next === 0 || next === 6) next = (next + 1) % 7;
  const when = !weekend && next === (weekday + 1) % 7 ? "tomorrow" : WEEKDAYS[next];
  return { today: false, text: `In-stock parts ordered now ship ${when}.` };
}

export type CheckoutLine = { id: string; qty: number; ship_class: ShipClass; price_mode: "cart" | "quote" };

/**
 * How a cart can be paid for online. Freight is quoted (a truck rate depends on
 * the address and the dock); quote-only items cannot be bought at a listed price.
 */
export function checkoutPlan(lines: CheckoutLine[]): {
  method: "parcel" | "freight" | "pickup";
  online: boolean;
  reason: string;
} {
  if (lines.some((l) => l.price_mode === "quote")) {
    return { method: "parcel", online: false, reason: "An item in the cart is priced by quote. Ask for a price on it, or take it out to check out." };
  }
  const plan = cartShipping(lines.map((l) => l.ship_class));
  if (plan.method === "freight") {
    return { method: "freight", online: false, reason: "This order ships by truck. Send it for a freight quote and we'll come back with the delivered price." };
  }
  return { method: plan.method, online: true, reason: "" };
}

/**
 * The cart's money, the same way checkout works it out: the order minimum and
 * free shipping go by the parts alone; cores and other charges are added on
 * their own lines; a pickup order has no shipping.
 */
export function cartTotals(
  lines: Array<CheckoutLine & { price_cents: number }>,
  charges: Record<string, Surcharge[]>,
  settings: Settings,
): {
  subtotal: number;
  charges: SurchargeLine[];
  chargesTotal: number;
  shipping: number;
  short: number;
  plan: ReturnType<typeof checkoutPlan>;
  total: number;
} {
  const subtotal = lines.reduce((sum, l) => sum + l.qty * l.price_cents, 0);
  const extra = surchargeLines(
    lines.map((l) => ({ product_id: l.id, qty: l.qty })),
    lines.flatMap((l) => (charges[l.id] ?? []).map((c) => ({ ...c, product_id: l.id }))),
  );
  const chargesTotal = extra.reduce((sum, c) => sum + c.total_cents, 0);
  const plan = checkoutPlan(lines);
  const shipping = plan.method === "pickup" || !lines.length ? 0 : shippingFor(subtotal, settings);
  const short = Math.max(0, settings.order_min_cents - subtotal);
  return { subtotal, charges: extra, chargesTotal, shipping, short, plan, total: subtotal + chargesTotal + shipping };
}

/** "Add $41.20 for free shipping", or "" once the cart is there (or there is no free shipping). */
export function freeShipNudge(subtotal: number, settings: Settings): string {
  if (settings.free_ship_over_cents == null) return "";
  const left = settings.free_ship_over_cents - subtotal;
  if (left <= 0) return "";
  return `Add ${(left / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} more for free shipping.`;
}
