// Public: a shopper asks for a price. Either one item sold by quote, or a cart
// that ships by truck (freight is priced by the destination, so it is quoted
// rather than charged a flat rate). Saved for the back office's Quotes tab.
import { adminDb, env, json } from "@/lib/server";

export const dynamic = "force-dynamic";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function POST(req: Request) {
  if (!env.secret) return json({ ok: false, message: "Quotes are not switched on yet. Call or email us instead." }, 503);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, message: "The request could not be read." }, 400);
  }

  const source = body.source === "freight" ? "freight" : "product";
  const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 200).flatMap((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const number = str(r.number, 60);
    const qty = typeof r.qty === "number" && Number.isInteger(r.qty) && r.qty > 0 && r.qty < 10000 ? r.qty : 1;
    const product_id = str(r.product_id, 80);
    if (!number && !product_id) return [];
    return [{ number, qty, ...(product_id ? { product_id } : {}), ...(str(r.note, 200) ? { note: str(r.note, 200) } : {}) }];
  });
  if (!lines.length) return json({ ok: false, message: "There is nothing in the request to price." }, 400);

  const phone = str(body.phone, 30);
  const email = str(body.email, 120);
  const zip = str(body.zip, 10);
  if (!phone && !email) return json({ ok: false, message: "Leave a phone number or an email so we can send the price." }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, message: "That email doesn't look right." }, 400);
  if (source === "freight" && !/^\d{5}$/.test(zip)) {
    return json({ ok: false, message: "Enter the 5-digit ZIP code it ships to. Freight is priced by the destination." }, 400);
  }

  const { data, error } = await adminDb()
    .from("fittings_quote_requests")
    .insert({
      source,
      lines,
      name: str(body.name, 80),
      company: str(body.company, 80),
      phone,
      email,
      zip,
      machine: str(body.machine, 120),
      notes: str(body.notes, 1000),
    })
    .select("number")
    .single();
  if (error || !data) {
    console.error("quote insert failed", error?.message);
    return json({ ok: false, message: "The request could not be saved. Try again, or call us." }, 500);
  }
  return json({ ok: true, number: data.number });
}
