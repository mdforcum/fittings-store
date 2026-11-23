// Shapes shared by the back-end API and the back-end screens.
import type { Product, Settings } from "./catalog";

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
  integrations: { stripe: Mode; webhook: boolean; shippo: Mode };
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
