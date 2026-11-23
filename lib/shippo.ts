// Shippo: rates and labels over its REST API. No SDK needed.
import type { ShipFrom } from "./admin-types";
import { env } from "./server";

export type ShipTo = {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
};

export type Parcel = { length: number; width: number; height: number; weight_oz: number };

export type Rate = {
  id: string;
  amount_cents: number;
  carrier: string;
  service: string;
  days: number | null;
};

type ShippoMessage = { text?: string; code?: string; source?: string };

async function shippo<R>(path: string, init?: { method?: string; body?: unknown }): Promise<R> {
  if (!env.shippo) throw new Error("Shippo is not connected yet. Add SHIPPO_API_TOKEN in Vercel.");
  const res = await fetch(`https://api.goshippo.com${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `ShippoToken ${env.shippo}`,
      "Content-Type": "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const detail = data && typeof data === "object" ? JSON.stringify(data).slice(0, 300) : text.slice(0, 300);
    throw new Error(`Shippo said no (${res.status}): ${detail}`);
  }
  return data as R;
}

function messagesText(messages: ShippoMessage[] | undefined): string {
  return (messages ?? [])
    .map((m) => m.text)
    .filter(Boolean)
    .join(" ");
}

export async function getRates(from: ShipFrom, to: ShipTo, parcel: Parcel, email?: string | null) {
  type ShipmentResponse = {
    object_id: string;
    rates?: Array<{
      object_id: string;
      amount: string;
      provider: string;
      servicelevel?: { name?: string };
      estimated_days?: number | null;
    }>;
    messages?: ShippoMessage[];
  };
  const shipment = await shippo<ShipmentResponse>("/shipments/", {
    method: "POST",
    body: {
      address_from: { ...from, country: "US" },
      address_to: { ...to, country: to.country || "US", email: email ?? undefined },
      parcels: [
        {
          length: String(parcel.length),
          width: String(parcel.width),
          height: String(parcel.height),
          distance_unit: "in",
          weight: String(parcel.weight_oz),
          mass_unit: "oz",
        },
      ],
      async: false,
    },
  });
  const rates: Rate[] = (shipment.rates ?? [])
    .map((r) => ({
      id: r.object_id,
      amount_cents: Math.round(Number(r.amount) * 100),
      carrier: r.provider,
      service: r.servicelevel?.name ?? "",
      days: r.estimated_days ?? null,
    }))
    .filter((r) => Number.isFinite(r.amount_cents))
    .sort((a, b) => a.amount_cents - b.amount_cents);
  return { rates, note: messagesText(shipment.messages) };
}

type Transaction = {
  object_id: string;
  status: string;
  label_url?: string;
  tracking_number?: string;
  tracking_url_provider?: string;
  messages?: ShippoMessage[];
};

export async function buyLabel(rateId: string, format: "PDF" | "PDF_4x6") {
  const tx = await shippo<Transaction>("/transactions/", {
    method: "POST",
    body: { rate: rateId, label_file_type: format, async: false },
  });
  if (tx.status !== "SUCCESS") {
    throw new Error(messagesText(tx.messages) || `Label was not created (status ${tx.status}).`);
  }
  return {
    transaction_id: tx.object_id,
    label_url: tx.label_url ?? "",
    tracking_number: tx.tracking_number ?? "",
    tracking_url: tx.tracking_url_provider ?? "",
  };
}

/** Label links expire, so fetch a fresh one each time the label is opened. */
export async function freshLabelUrl(transactionId: string): Promise<string> {
  const tx = await shippo<Transaction>(`/transactions/${encodeURIComponent(transactionId)}`);
  return tx.label_url ?? "";
}
