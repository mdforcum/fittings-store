"use client";
// The dealer portal: orders with parts on this dealer's shelves, a pick list
// to print or check off, "mark shipped" with tracking, and the month's
// statement. Everything a dealer needs without a back-office login.
import { useCallback, useEffect, useState } from "react";
import type { PortalData, PortalOrder } from "@/app/api/dealer/route";
import { money } from "@/lib/catalog";
import { KIND_LABEL, monthName, monthOf, totals, type SettlementRow } from "@/lib/settlements";

type Reply = { ok: boolean; message?: string; data?: PortalData; result?: Record<string, unknown> };

async function call(body: Record<string, unknown>): Promise<Reply> {
  try {
    const r = await fetch("/api/dealer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as Reply;
  } catch {
    return { ok: false, message: "No connection. Try again." };
  }
}

function SignIn({ onIn }: { onIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const r = await call({ action: "login", email, password });
    setBusy(false);
    if (r.ok) onIn();
    else setError(r.message ?? "Sign-in failed.");
  }
  return (
    <main className="center portal">
      <p className="eyebrow">Dealer orders</p>
      <h1>Sign in</h1>
      <form className="form" onSubmit={submit}>
        <label htmlFor="de">
          Email
          <input id="de" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label htmlFor="dp">
          Password
          <input id="dp" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        <div>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
      <p className="hint">No login yet, or forgot your password? Ask Backroad Iron to set one up for you.</p>
    </main>
  );
}

function address(o: PortalOrder): string {
  const a = o.ship_to;
  if (!a) return "";
  return [a.name, a.street1, a.street2, [a.city, a.state].filter(Boolean).join(", ") + (a.zip ? ` ${a.zip}` : "")].filter(Boolean).join("\n");
}

function OrderCard({ o, locations, onShip }: { o: PortalOrder; locations: PortalData["locations"]; onShip: (loc: string, carrier: string, tracking: string, pickup: boolean) => Promise<boolean> }) {
  const locs = [...new Set(o.lines.map((l) => l.location_id))];
  const [carrier, setCarrier] = useState("UPS");
  const [tracking, setTracking] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const name = (id: string) => locations.find((l) => l.id === id)?.name ?? "";
  const pickup = o.ship_method === "pickup";
  return (
    <li className="po-card">
      <div className="po-head">
        <h2>Order #{o.number}</h2>
        <span className={`pill ${o.status === "shipped" ? "ok" : "hold"}`}>{o.status === "shipped" ? "Done" : pickup ? "Customer picks up" : "To ship"}</span>
        <span className="hint">{new Date(o.created_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
      </div>
      {locs.map((loc) => {
        const done = o.shipped.find((s) => s.location_id === loc);
        const lines = o.lines.filter((l) => l.location_id === loc);
        return (
          <div className="po-stop" key={loc}>
            <h3>{locs.length > 1 || locations.length > 1 ? `From ${name(loc)}` : "Pull these parts"}</h3>
            <ul className="po-lines">
              {lines.map((l) => (
                <li key={l.product_id}>
                  <label className="po-check">
                    <input type="checkbox" checked={!!picked[`${loc}:${l.product_id}`]} onChange={(e) => setPicked({ ...picked, [`${loc}:${l.product_id}`]: e.target.checked })} />
                    <span className="po-qty">{l.qty}</span>
                    <span>
                      {l.part_number && <span className="mono">{l.part_number} </span>}
                      {l.name}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {done ? (
              <p className="pill ok">
                {done.carrier === "Picked up" ? "Picked up" : `Shipped ${done.carrier} ${done.tracking_number}`} on {new Date(done.shipped_at).toLocaleDateString("en-US")}
              </p>
            ) : (
              <div className="po-ship">
                {!pickup && (
                  <>
                    <label>
                      Carrier
                      <select value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                        {["UPS", "FedEx", "USPS", "Freight", "Other"].map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Tracking number
                      <input value={tracking[loc] ?? ""} onChange={(e) => setTracking({ ...tracking, [loc]: e.target.value })} autoComplete="off" inputMode="text" />
                    </label>
                  </>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={!!busy || (!pickup && !(tracking[loc] ?? "").trim())}
                  onClick={async () => {
                    setBusy(loc);
                    await onShip(loc, carrier, tracking[loc] ?? "", pickup);
                    setBusy("");
                  }}
                >
                  {busy === loc ? "Saving…" : pickup ? "Mark picked up" : "Mark shipped"}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {!pickup && o.ship_to && (
        <div className="po-to">
          <h3>Ship to</h3>
          <pre>{address(o)}</pre>
          {o.phone && <p className="hint">Phone for the carrier: {o.phone}</p>}
        </div>
      )}
      {pickup && o.customer_name && <p>For {o.customer_name}</p>}
      {o.notes && <p className="hint">Note: {o.notes}</p>}
    </li>
  );
}

function Statement() {
  const [month, setMonth] = useState(monthOf(new Date().toISOString()));
  const [rows, setRows] = useState<SettlementRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    call({ action: "statement", month }).then((r) => {
      if (!live) return;
      if (r.ok) {
        setRows((r.result?.rows as SettlementRow[]) ?? []);
        setError("");
      } else setError(r.message ?? "The statement could not be loaded.");
    });
    return () => {
      live = false;
    };
  }, [month]);
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setDate(15);
    d.setMonth(d.getMonth() - i);
    return monthOf(d.toISOString());
  });
  const t = rows ? totals(rows) : null;
  return (
    <section className="po-statement">
      <h2>Your statement</h2>
      <label className="po-month">
        Month
        <select value={month} onChange={(e) => setMonth(e.target.value)}>
          {months.map((m) => (
            <option key={m} value={m}>
              {monthName(m)}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="err">{error}</p>}
      {rows && !rows.length && <p className="empty">Nothing for {monthName(month)}.</p>}
      {rows && rows.length > 0 && t && (
        <>
          <p className="po-total">
            {t.net >= 0 ? "Backroad Iron owes you" : "You owe Backroad Iron"} <strong>{money(Math.abs(t.net))}</strong> for {monthName(month)}
            {t.waiting ? ` (${t.waiting} line${t.waiting === 1 ? "" : "s"} still waiting on the card fee)` : ""}.
          </p>
          <ul className="po-rows">
            {rows.map((r, i) => (
              <li key={`${r.order_id}-${i}`}>
                <span>{r.order_number ? `#${r.order_number}` : "Order"}</span>
                <span>{KIND_LABEL[r.kind]}</span>
                <span className="mono">{r.net_cents == null ? "waiting" : money(r.net_cents)}</span>
                <span className="hint">{r.paid_at ? `Paid ${r.paid_note}` : "Not paid yet"}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export default function DealerPortal() {
  const [data, setData] = useState<PortalData | null>(null);
  const [state, setState] = useState<"loading" | "out" | "in" | "error">("loading");
  const [message, setMessage] = useState("");
  const [view, setView] = useState<"open" | "done" | "statement">("open");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dealer", { cache: "no-store" });
      const body = (await r.json()) as Reply;
      if (r.status === 401) return setState("out");
      if (!body.ok || !body.data) {
        setMessage(body.message ?? "Your orders could not be loaded.");
        return setState("error");
      }
      setData(body.data);
      setState("in");
    } catch {
      setMessage("No connection. Try again.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    const every = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);
    return () => {
      clearTimeout(t);
      clearInterval(every);
    };
  }, [load]);

  if (state === "loading") return <main className="center portal"><p>Loading your orders…</p></main>;
  if (state === "out") return <SignIn onIn={() => void load()} />;
  if (state === "error" || !data)
    return (
      <main className="center portal">
        <p className="err">{message}</p>
        <button type="button" className="btn" onClick={() => void load()}>
          Try again
        </button>
      </main>
    );

  const open = data.orders.filter((o) => o.lines.some((l) => !o.shipped.some((s) => s.location_id === l.location_id)));
  const done = data.orders.filter((o) => !open.includes(o));
  const list = view === "open" ? open : done;

  return (
    <main className="wrap portal">
      <header className="po-top">
        <div>
          <p className="eyebrow">Dealer orders</p>
          <h1>{data.dealer.name}</h1>
        </div>
        <div className="po-top-actions">
          <button type="button" className="btn ghost" onClick={() => window.print()}>
            Print pick list
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={async () => {
              await call({ action: "logout" });
              setState("out");
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <nav className="po-tabs" aria-label="Views">
        {(
          [
            ["open", `To pull (${open.length})`],
            ["done", "Done"],
            ["statement", "Statement"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" className="tab" aria-current={view === k ? "page" : undefined} onClick={() => setView(k)}>
            {label}
          </button>
        ))}
      </nav>
      {message && (
        <p className="err" role="alert">
          {message}
        </p>
      )}
      {view === "statement" ? (
        <Statement />
      ) : list.length === 0 ? (
        <p className="empty">{view === "open" ? "Nothing to pull right now. New orders show up here, and you'll get an alert if one is set up." : "No finished orders in the last 90 days."}</p>
      ) : (
        <ul className="po-list">
          {list.map((o) => (
            <OrderCard
              key={o.id}
              o={o}
              locations={data.locations}
              onShip={async (loc, carrier, tracking, pickup) => {
                const r = await call({ action: "ship", order_id: o.id, location_id: loc, carrier, tracking_number: tracking, pickup });
                if (r.ok && r.data) {
                  setData(r.data);
                  setMessage("");
                  return true;
                }
                if (!r.ok && /sign in/i.test(r.message ?? "")) setState("out");
                setMessage(r.message ?? "That didn't save. Try again.");
                return false;
              }}
            />
          ))}
        </ul>
      )}
      <p className="hint po-help">
        Questions about an order or a payment?{" "}
        {data.support_email ? (
          <>
            Email <a href={`mailto:${data.support_email}`}>{data.support_email}</a>.
          </>
        ) : (
          "Email Backroad Iron."
        )}
      </p>
    </main>
  );
}
