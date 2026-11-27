// Shapes shared by the back-end API and the back-end screens.
import type { LabelSettings } from "./labels";
import type { Product, Settings } from "./catalog";
import type { Allocation, Places } from "./places";
import type { RoutingSettings } from "./settlements";
import type { Storefront } from "./storefront";

export type ShipFrom = {
  name: string;
  company: string;
  street1: string;
  street2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  email: string;
};

export type ParcelPreset = {
  name: string;
  length: number;
  width: number;
  height: number;
  weight_oz: number;
};

export const DEFAULT_PRESETS: ParcelPreset[] = [
  { name: "Padded mailer", length: 9, width: 6, height: 1, weight_oz: 8 },
  { name: "Small box", length: 6, width: 4, height: 4, weight_oz: 16 },
];

export const EMPTY_SHIP_FROM: ShipFrom = {
  name: "",
  company: "",
  street1: "",
  street2: "",
  city: "",
  state: "",
  zip: "",
  phone: "",
  email: "",
};

export type Cost = { cost_cents: number | null; margin: number | null };

export type OrderItem = {
  product_id: string;
  name: string;
  part_number: string;
  unit_price_cents: number;
  qty: number;
};

export type OrderAddress = {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
};

export type Order = {
  id: string;
  number: number;
  status: "pending" | "paid" | "shipped" | "cancelled" | "expired";
  email: string | null;
  customer_name: string | null;
  phone: string | null;
  ship_to: OrderAddress | null;
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  stock_short: boolean;
  carrier: string | null;
  service: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shippo_transaction_id: string | null;
  label_cost_cents: number | null;
  notes: string;
  created_at: string;
  paid_at: string | null;
  shipped_at: string | null;
  items: OrderItem[];
  charges_cents: number;
  ship_method: "parcel" | "pickup";
  /** Cores and other charges; empty on orders from before they existed. */
  charges: OrderCharge[];
  /** Which location each item was taken from when it was paid; empty before locations. */
  from: Allocation[];
  /** The storefront the order came through; null for the Backroad Iron store. */
  storefront_id?: string | null;
  /** Money refunded on returns and cancellations (not core credits). */
  refunded_cents?: number;
  /** Parts that came back, by item. */
  returned?: Array<{ product_id: string; qty: number }>;
  /** Each location's shipment, when locations ship on their own. */
  shipments?: Shipment[];
};

export type Shipment = {
  location_id: string;
  carrier: string;
  tracking_number: string;
  tracking_url: string;
  shipped_by: string;
  shipped_at: string;
  /** A label was bought here (not just tracking typed in). */
  has_label?: boolean;
  /** What the dealer was charged for that label. */
  label_charge_cents?: number | null;
};

export type CoreReturn = {
  id: number;
  qty: number;
  returned_on: string;
  days: number;
  credit_cents: number;
  stripe_refund_id: string | null;
  note: string;
  created_at: string;
};

export type OrderCharge = {
  id: number;
  product_id: string;
  kind: "core" | "tire_fee" | "hazmat" | "deposit";
  label: string;
  unit_cents: number;
  qty: number;
  total_cents: number;
  refundable: boolean;
  returned_qty: number;
  refunded_cents: number;
  returns: CoreReturn[];
};

export type QuoteRequest = {
  id: string;
  number: number;
  source: "product" | "list" | "phone" | "freight";
  status: "new" | "quoted" | "won" | "lost" | "cancelled";
  lines: Array<{ number: string; qty: number; product_id?: string; note?: string }>;
  name: string;
  company: string;
  phone: string;
  email: string;
  zip: string;
  machine: string;
  notes: string;
  answer: string;
  created_at: string;
};

export type AdminConfig = {
  ship_from: ShipFrom;
  presets: ParcelPreset[];
  tax_mode: "off" | "stripe";
  label_format: "PDF" | "PDF_4x6";
};

export type Mode = "test" | "live" | null;

export type AdminData = {
  products: Product[];
  costs: Record<string, Cost>;
  settings: Settings;
  config: AdminConfig;
  orders: Order[];
  quotes: QuoteRequest[];
  integrations: { stripe: Mode; webhook: boolean; shippo: Mode };
  /** Parts sitting in shoppers' checkouts right now, by item. */
  held: Record<string, number>;
  /** Dealers, their store locations and each item's count at each. */
  places: Places;
  /** Branded stores at dealers' own web addresses; empty before they're set up. */
  storefronts: Storefront[];
  /** Whether Backroad Iron orders go to dealers, and the cut. */
  routing: RoutingSettings;
  /** Returns, counter sales, dealer logins and alerts (supabase/add-operations.sql). */
  ops: { ready: boolean; email: boolean; text: boolean; labels: LabelSettings & { ready: boolean; shippo: boolean }; zips: { ready: boolean; count: number } };
};

/** One line of an item's stock history. */
export type StockMove = {
  id: number;
  delta: number;
  qty_after: number;
  kind: "start" | "receive" | "count" | "adjust" | "edit" | "sale" | "return" | "transfer";
  order_id: string | null;
  /** Null on lines from before locations. */
  location_id: string | null;
  note: string;
  created_at: string;
};

export type RateQuote = {
  id: string;
  amount_cents: number;
  carrier: string;
  service: string;
  days: number | null;
};

export type ActionReply =
  | { ok: true; data: AdminData; result?: Record<string, unknown> }
  | { ok: false; message: string };
