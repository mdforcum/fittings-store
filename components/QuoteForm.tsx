"use client";
// Asks for a price: one item priced by quote, or a whole cart that ships by
// truck. Sends to /api/quote; the back office answers from the Quotes tab.
import { useState } from "react";

export type QuoteLine = { number: string; qty: number; product_id?: string; note?: string };

type Props = {
  source: "product" | "freight";
  lines: QuoteLine[];
  machine?: string;
  /** Shown above the fields. */
  intro: string;
  onSent?: (number: number) => void;
};

export default function QuoteForm({ source, lines, machine = "", intro, onSent }: Props) {
  const [f, setF] = useState({ name: "", company: "", phone: "", email: "", zip: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<number | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));
  const id = (k: string) => `qf-${source}-${k}`;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!f.phone.trim() && !f.email.trim()) return setError("Leave a phone number or an email so we can send the price.");
    if (source === "freight" && !/^\d{5}$/.test(f.zip.trim())) return setError("Enter the 5-digit ZIP code it ships to. Freight is priced by the destination.");
    setBusy(true);
    try {
      const r = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, lines, machine, ...f }),
      });
      const body = (await r.json()) as { ok?: boolean; number?: number; message?: string };
      if (r.ok && body.number) {
        setSent(body.number);
        onSent?.(body.number);
      } else setError(body.message ?? "The request could not be sent. Try again.");
    } catch {
      setError("The request could not be sent. Check your connection and try again.");
    }
    setBusy(false);
  }

  if (sent) {
    return (
      <div className="panel" role="status">
        <p>
          <b>Request #{sent} is in.</b>{" "}
          {source === "freight"
            ? "We'll price the truck to your ZIP code and send the delivered total, usually the same business day."
            : "We'll come back with a price and a ship date, usually the same business day."}
        </p>
      </div>
    );
  }

  return (
    <form className="panel form quote-form" onSubmit={send} noValidate>
      <p>{intro}</p>
      <div className="two">
        <label htmlFor={id("name")}>
          Name
          <input id={id("name")} autoComplete="name" value={f.name} onChange={set("name")} />
        </label>
        <label htmlFor={id("company")}>
          Farm or company (optional)
          <input id={id("company")} autoComplete="organization" value={f.company} onChange={set("company")} />
        </label>
        <label htmlFor={id("phone")}>
          Phone
          <input id={id("phone")} type="tel" autoComplete="tel" value={f.phone} onChange={set("phone")} />
        </label>
        <label htmlFor={id("email")}>
          Email
          <input id={id("email")} type="email" autoComplete="email" value={f.email} onChange={set("email")} />
        </label>
        <label htmlFor={id("zip")}>
          {source === "freight" ? "Ship-to ZIP code" : "ZIP code (optional)"}
          <input id={id("zip")} inputMode="numeric" autoComplete="postal-code" maxLength={5} value={f.zip} onChange={set("zip")} />
        </label>
      </div>
      <label htmlFor={id("notes")}>
        {source === "freight" ? "Anything about the delivery? (dock, liftgate, farm lane)" : "Machine, serial or anything else we should know"}
        <textarea id={id("notes")} rows={2} value={f.notes} onChange={set("notes")} />
      </label>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn" disabled={busy}>
        {busy ? "Sending…" : source === "freight" ? "Send for a freight quote" : "Ask for a price"}
      </button>
    </form>
  );
}
