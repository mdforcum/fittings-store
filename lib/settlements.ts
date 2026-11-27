// Dealer statements: what each outside dealer is owed, both ways. Whoever
// makes a sale earns the selling share; whoever ships keeps the rest; a sale
// one dealer makes and another ships also pays Backroad Iron's network fee
// (supabase/add-routing.sql, add-selling-shares.sql: one ledger row per
// dealer per paid order).

export type SettlementRow = {
  order_id: string;
  order_number: number | null;
  dealer_id: string;
  kind: SettlementKind;
  parts_cents: number;
  shipping_cents: number;
  /** The selling share it pays (or its own-store fee on its own sale). */
  cut_bps: number;
  cut_cents: number;
  /** Selling share it earns on its sale that others shipped. */
  referral_cents: number;
  /** Backroad Iron's network fee, when another dealer's store made the sale. */
  network_bps: number;
  network_cents: number;
  /** Null until Stripe's fee for the payment is known. */
  card_fee_cents: number | null;
  net_cents: number | null;
  created_at: string;
  paid_at: string | null;
  paid_note: string;
};

export type SettlementKind = "routed" | "storefront" | "referral" | "network" | "mixed" | "reversal";

export const KIND_LABEL: Record<SettlementKind, string> = {
  routed: "Backroad Iron sale",
  storefront: "Own store",
  referral: "Own store, shipped by others",
  network: "Another dealer's sale",
  mixed: "Own store, partly shipped by others",
  reversal: "Return or refund",
};

/** A ledger row as stored, with fields added later read as zero. */
export function readSettlement(r: Record<string, unknown>, orderNumber: number | null): SettlementRow {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const nn = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const kind = (["routed", "storefront", "referral", "network", "mixed", "reversal"] as const).find((k) => k === r.kind) ?? "routed";
  return {
    order_id: String(r.order_id),
    order_number: orderNumber,
    dealer_id: String(r.dealer_id),
    kind,
    parts_cents: n(r.parts_cents),
    shipping_cents: n(r.shipping_cents),
    cut_bps: n(r.cut_bps),
    cut_cents: n(r.cut_cents),
    referral_cents: n(r.referral_cents),
    network_bps: n(r.network_bps),
    network_cents: n(r.network_cents),
    card_fee_cents: nn(r.card_fee_cents),
    net_cents: nn(r.net_cents),
    created_at: String(r.created_at),
    paid_at: typeof r.paid_at === "string" ? r.paid_at : null,
    paid_note: typeof r.paid_note === "string" ? r.paid_note : "",
  };
}

export type RoutingSettings = {
  /** False until supabase/add-routing.sql has run. */
  ready: boolean;
  house_dealer_id: string | null;
  route_orders: boolean;
  /** The selling share, both ways. */
  route_cut_bps: number;
  /** Backroad Iron's fee when one dealer's store sells and another ships. */
  network_fee_bps: number;
  storefront_fee_bps: number;
};

export const NO_ROUTING: RoutingSettings = {
  ready: false,
  house_dealer_id: null,
  route_orders: false,
  route_cut_bps: 600,
  network_fee_bps: 200,
  storefront_fee_bps: 0,
};

export function readRouting(row: Record<string, unknown> | null | undefined): RoutingSettings {
  if (!row || !("route_orders" in row)) return NO_ROUTING;
  const bps = (v: unknown, d: number) => (typeof v === "number" && v >= 0 && v <= 5000 ? Math.floor(v) : d);
  return {
    ready: true,
    house_dealer_id: typeof row.house_dealer_id === "string" ? row.house_dealer_id : null,
    route_orders: row.route_orders === true,
    route_cut_bps: bps(row.route_cut_bps, 600),
    network_fee_bps: bps(row.network_fee_bps, 200),
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
  /** Selling shares paid (and own-store fees). */
  cut: number;
  /** Network fees paid to Backroad Iron. */
  network: number;
  /** Selling shares earned. */
  earned: number;
  fee: number;
  net: number;
  /** Rows whose card fee isn't known yet: their net is left out of `net`. */
  waiting: number;
  unpaid: number;
  unpaidNet: number;
};

export function totals(rows: SettlementRow[]): StatementTotals {
  const t: StatementTotals = { parts: 0, shipping: 0, cut: 0, network: 0, earned: 0, fee: 0, net: 0, waiting: 0, unpaid: 0, unpaidNet: 0 };
  for (const r of rows) {
    t.parts += r.parts_cents;
    t.shipping += r.shipping_cents;
    t.cut += r.cut_cents;
    t.network += r.network_cents;
    t.earned += r.referral_cents;
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
    [
      "Dealer",
      "Month",
      "Date",
      "Order",
      "Kind",
      "Parts shipped",
      "Shipping",
      "Share paid %",
      "Share paid",
      "Network fee",
      "Share earned",
      "Card fee",
      "Owed to dealer",
      "Paid",
      "Paid note",
    ].join(","),
    ...rows.map((r) =>
      [
        dealer,
        month,
        r.created_at.slice(0, 10),
        r.order_number == null ? "" : `#${r.order_number}`,
        KIND_LABEL[r.kind],
        d2(r.parts_cents),
        d2(r.shipping_cents),
        bpsToPercent(r.cut_bps),
        d2(r.cut_cents),
        d2(r.network_cents),
        d2(r.referral_cents),
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
