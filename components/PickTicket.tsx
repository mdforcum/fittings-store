"use client";
// A pick ticket: the walk through the shop for one order or a batch, with a
// big check-off per stop. Works on a phone at the shelf and on paper.
import { useCallback, useEffect, useState } from "react";
import type { PickPart, PickRoute, PickStop } from "@/lib/picking";

type TicketOrder = { id: string; number: number; status: string; customer_name: string | null; ship_method: string; notes: string };
type Ticket = { orders: TicketOrder[]; route: PickRoute & { places?: string[] }; marks_ready: boolean; mapped: boolean };

const REFRESH_MS = 30_000;

export default function PickTicket({ orders }: { orders: string }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [hidePicked, setHidePicked] = useState(false);
  const [busy, setBusy] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/pick?orders=${encodeURIComponent(orders)}`, { cache: "no-store" });
      const body = (await r.json()) as { ok: boolean; message?: string } & Partial<Ticket>;
      if (!body.ok) return setError(body.message ?? "The pick ticket could not be loaded.");
      setError("");
      setTicket({ orders: body.orders ?? [], route: body.route!, marks_ready: !!body.marks_ready, mapped: !!body.mapped });
    } catch {
      setError("No connection. Try again.");
    }
  }, [orders]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    // Another picker may be on the same ticket: pick up their check-offs.
    const every = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [load]);

  async function mark(stop: PickStop, picked: boolean, parts: PickPart[] = stop.parts) {
    setBusy(stop.product_id);
    setNote("");
    try {
      const r = await fetch("/api/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pick.mark", picked, parts: parts.map((p) => ({ order_item_id: p.order_item_id, product_id: p.product_id })) }),
      });
      const body = (await r.json()) as { ok: boolean; message?: string };
      if (!body.ok) setNote(body.message ?? "That did not save. Try again.");
    } catch {
      setNote("No connection. That check-off did not save.");
    }
    await load();
    setBusy("");
  }

  if (error) {
    return (
      <main className="pick">
        <p className="err">{error}</p>
        <a className="btn ghost" href="/admin">
          Back to orders
        </a>
      </main>
    );
  }
  if (!ticket) return <main className="pick"><p className="hint">Loading the pick ticket…</p></main>;

  const { route } = ticket;
  const batch = ticket.orders.length > 1;
  const allDone = route.lines > 0 && route.done === route.lines;

  return (
    <main className="pick">
      <header className="pick-head">
        <div>
          <p className="eyebrow">Pick ticket</p>
          <h1>{batch ? `${ticket.orders.length} orders` : `Order #${ticket.orders[0].number}`}</h1>
          <ul className="pick-orders">
            {ticket.orders.map((o) => (
              <li key={o.id}>
                <b>#{o.number}</b> {o.customer_name || "No name"}
                {o.ship_method === "pickup" ? " · Pickup at the counter" : " · Ship"}
                {o.status === "shipped" ? " · already shipped" : ""}
                {o.notes ? <span className="hint"> · Note: {o.notes}</span> : null}
              </li>
            ))}
          </ul>
          {(route.places?.length ?? 0) > 1 && (
            <p className="pick-from">
              Pull from {route.places!.length} locations: {route.places!.join(", ")}. Each has its own walk below.
            </p>
          )}
        </div>
        <div className="pick-actions">
          <p className="pick-count" aria-live="polite">
            {route.done} of {route.lines} {route.lines === 1 ? "stop" : "stops"} picked
            <span className="hint"> · {route.picked} of {route.total} items</span>
          </p>
          <div className="inline">
            <button type="button" className="btn ghost sm" onClick={() => window.print()}>
              Print
            </button>
            <button type="button" className="btn ghost sm" aria-pressed={hidePicked} onClick={() => setHidePicked(!hidePicked)}>
              {hidePicked ? "Show picked" : "Hide picked"}
            </button>
            <a className="btn ghost sm" href="/admin">
              Back to orders
            </a>
          </div>
        </div>
      </header>

      {!ticket.marks_ready && <p className="err">Check-offs are not set up yet, so they won&apos;t save. The list below is still in walking order.</p>}
      {!ticket.mapped && <p className="hint">No shelf map yet, so items are listed by name. Build the map in the Shelf map tab to get a walking order.</p>}
      {note && <p className="err">{note}</p>}
      {allDone && <p className="pick-done">Everything is picked. Pack and ship it from Orders.</p>}

      {route.groups.map((g) => {
        const stops = hidePicked ? g.stops.filter((s) => !s.done) : g.stops;
        if (!stops.length) return null;
        return (
          <section key={g.heading} className="pick-group">
            <h2>{g.heading}</h2>
            <ol className="pick-list">
              {stops.map((s) => (
                <li key={s.product_id} className={s.done ? "pick-stop done" : "pick-stop"}>
                  <label className="pick-check">
                    <input
                      type="checkbox"
                      checked={s.done}
                      disabled={busy === s.product_id || !ticket.marks_ready}
                      onChange={(e) => void mark(s, e.target.checked)}
                      aria-label={`${s.done ? "Picked" : "Pick"} ${s.qty} × ${s.name}`}
                    />
                    <span className="pick-qty">×{s.qty}</span>
                    <span className="pick-what">
                      <b>{s.name}</b>
                      {s.part_number && <span className="mono"> {s.part_number}</span>}
                      {(s.where || s.code) && (
                        <span className="pick-where">
                          {s.where}
                          {s.code && <span className="mono"> · {s.code}</span>}
                        </span>
                      )}
                      {(batch || s.parts.some((p) => p.for_kit)) && (
                        <span className="pick-split">
                          {s.parts
                            .map((p) => `${batch ? `#${p.order_number} ` : ""}×${p.qty}${p.for_kit ? ` for ${p.for_kit}` : ""}${p.picked_qty >= p.qty ? " ✓" : ""}`)
                            .join(" · ")}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
      {route.lines === 0 && <p className="empty">These orders have no items to pick.</p>}
    </main>
  );
}
