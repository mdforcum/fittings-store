// Dealer statements: what each outside dealer is owed for parts it shipped
// (supabase/add-routing.sql writes one ledger row per dealer per paid order).

export type SettlementRow = {
  order_id: string;
  order_number: number | null;
  dealer_id: string;
  kind: "routed" | "storefront";
  parts_cents: number;
  shipping_cents: number;
  cut_bps: number;
  cut_cents: number;
  /** Null until Stripe's fee for the payment is known. */
  card_fee_cents: number | null;
  net_cents: number | null;
  created_at: string;
  paid_at: string | null;
  paid_note: string;
};

export type RoutingSettings = {
  /** False until supabase/add-routing.sql has run. */
  ready: boolean;
  house_dealer_id: string | null;
  route_orders: boolean;
  route_cut_bps: number;
  storefront_fee_bps: number;
};

export const NO_ROUTING: RoutingSettings = { ready: false, house_dealer_id: null, route_orders: false, route_cut_bps: 1000, storefront_fee_bps: 0 };

export function readRouting(row: Record<string, unknown> | null | undefined): RoutingSettings {
  if (!row || !("route_orders" in row)) return NO_ROUTING;
  const bps = (v: unknown, d: number) => (typeof v === "number" && v >= 0 && v <= 5000 ? Math.floor(v) : d);
  return {
    ready: true,
    house_dealer_id: typeof row.house_dealer_id === "string" ? row.house_dealer_id : null,
    route_orders: row.route_orders === true,
    route_cut_bps: bps(row.route_cut_bps, 1000),
    storefront_fee_bps: bps(row.storefront_fee_bps, 0),
  };
}

/** "10" or "7.5" → basis points (1000, 750); NaN when it isn't a percent from 0 to 50. */
export function percentToBps(typed: string): number {
  const t = typed.replace(/[%\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN;
  const bps = Math.round(Number(t) * 100);
  return bps >= 0 && bps <= 5000 ? bps : Number.NaN;
}

export const bpsToPercent = (bps: number) => String(Number((bps / 100).toFixed(2)));

/** The month a row belongs to, in the shop's time zone: "2026-11". */
export function monthOf(iso: string, timeZone = "America/Chicago"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone }).formatToParts(new Date(iso));
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "00";
  return `${y}-${m}`;
}

export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Start and end of a month in the shop's time zone, as ISO times, for a database query. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  // Midnight Central: 06:00 UTC in winter, 05:00 in summer. Taking 05:00 UTC
  // on the 1st and comparing month names on each row keeps edges exact.
  return { from: `${month}-01T05:00:00.000Z`, to: `${next}-01T07:00:00.000Z` };
}

export type StatementTotals = {
  parts: number;
  shipping: number;
  cut: number;
  fee: number;
  net: number;
  /** Rows whose card fee isn't known yet: their net is left out of `net`. */
  waiting: number;
  unpaid: number;
  unpaidNet: number;
};

export function totals(rows: SettlementRow[]): StatementTotals {
  const t: StatementTotals = { parts: 0, shipping: 0, cut: 0, fee: 0, net: 0, waiting: 0, unpaid: 0, unpaidNet: 0 };
  for (const r of rows) {
    t.parts += r.parts_cents;
    t.shipping += r.shipping_cents;
    t.cut += r.cut_cents;
    if (r.net_cents == null || r.card_fee_cents == null) t.waiting++;
    else {
      t.fee += r.card_fee_cents;
      t.net += r.net_cents;
    }
    if (!r.paid_at) {
      t.unpaid++;
      if (r.net_cents != null) t.unpaidNet += r.net_cents;
    }
  }
  return t;
}

const d2 = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));

/** The statement as a spreadsheet-ready CSV. */
export function statementCsv(dealer: string, month: string, rows: SettlementRow[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [
    ["Dealer", "Month", "Date", "Order", "Kind", "Parts", "Shipping", "Cut %", "Backroad Iron cut", "Card fee", "Owed to dealer", "Paid", "Paid note"].join(","),
    ...rows.map((r) =>
      [
        dealer,
        month,
        r.created_at.slice(0, 10),
        r.order_number == null ? "" : `#${r.order_number}`,
        r.kind === "routed" ? "Backroad Iron order" : "Own store",
        d2(r.parts_cents),
        d2(r.shipping_cents),
        bpsToPercent(r.cut_bps),
        d2(r.cut_cents),
        d2(r.card_fee_cents),
        d2(r.net_cents),
        r.paid_at ? r.paid_at.slice(0, 10) : "",
        r.paid_note,
      ]
        .map((v) => esc(String(v)))
        .join(","),
    ),
  ];
  return lines.join("\n") + "\n";
}
