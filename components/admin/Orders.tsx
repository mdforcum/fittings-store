"use client";
import { useState } from "react";
import type { AdminData, Order, ParcelPreset, RateQuote } from "@/lib/admin-types";
import { money } from "@/lib/catalog";
import type { Act, Say } from "../Admin";

type Props = { data: AdminData; act: Act; say: Say };
type View = "open" | "shipped" | "all";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

export default function Orders({ data, act, say }: Props) {
  const [view, setView] = useState<View>("open");
  const counts = {
    open: data.orders.filter((o) => o.status === "paid").length,
    shipped: data.orders.filter((o) => o.status === "shipped").length,
    all: data.orders.length,
  };
  const shown = data.orders.filter((o) =>
    view === "all" ? true : view === "open" ? o.status === "paid" : o.status === "shipped",
  );
  const views: Array<[View, string]> = [
    ["open", "To ship"],
    ["shipped", "Shipped"],
    ["all", "All"],
  ];

  return (
    <>
      <div className="inv-head">
        <div>
          <p className="eyebrow">Back office</p>
          <h1>Orders</h1>
        </div>
      </div>
      <div className="chips" role="group" aria-label="Order status">
        {views.map(([id, label]) => (
          <button key={id} type="button" className="chip" aria-pressed={view === id} onClick={() => setView(id)}>
            {label}
            <span className="n">{counts[id]}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 && (
        <p className="empty">
          {view === "open" ? "Nothing waiting to ship." : "No orders here yet."} Paid orders appear on their own.
        </p>
      )}
      {shown.map((o) => (
        <OrderCard key={o.id} o={o} data={data} act={act} say={say} />
      ))}
    </>
  );
}

function OrderCard({ o, data, act, say }: { o: Order; data: AdminData; act: Act; say: Say }) {
  const presets = data.config.presets;
  const first: ParcelPreset = presets[0] ?? { name: "", length: 6, width: 4, height: 4, weight_oz: 16 };
  const [parcel, setParcel] = useState({
    length: String(first.length),
    width: String(first.width),
    height: String(first.height),
    weight_oz: String(first.weight_oz),
  });
  const [rates, setRates] = useState<RateQuote[] | null>(null);
  const [busy, setBusy] = useState("");
  const [labelUrl, setLabelUrl] = useState("");
  const [tracking, setTracking] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const shippoOn = data.integrations.shippo !== null;
  const pieces = o.items.reduce((n, i) => n + i.qty, 0);
  const tone = o.status === "paid" ? "hold" : o.status === "shipped" ? "ok" : "muted";
  const statusText = o.status === "paid" ? "To ship" : o.status === "shipped" ? "Shipped" : "Cancelled";

  const setDim = (key: keyof typeof parcel) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setParcel((cur) => ({ ...cur, [key]: e.target.value }));

  async function getRates() {
    setBusy("rates");
    setRates(null);
    const done = await act("label.rates", {
      order_id: o.id,
      parcel: {
        length: Number(parcel.length),
        width: Number(parcel.width),
        height: Number(parcel.height),
        weight_oz: Number(parcel.weight_oz),
      },
    });
    setBusy("");
    if (done && Array.isArray(done.rates)) setRates(done.rates as RateQuote[]);
  }

  async function buy(rate: RateQuote) {
    setBusy(rate.id);
    const done = await act("label.buy", {
      order_id: o.id,
      rate_id: rate.id,
      carrier: rate.carrier,
      service: rate.service,
      amount_cents: rate.amount_cents,
      again: !!o.shippo_transaction_id,
    });
    setBusy("");
    if (done) {
      setRates(null);
      if (typeof done.label_url === "string") setLabelUrl(done.label_url);
      say("Label bought. Order marked shipped.");
    }
  }

  async function openLabel() {
    setBusy("label");
    const done = await act("label.url", { order_id: o.id });
    setBusy("");
    if (done && typeof done.label_url === "string" && done.label_url) setLabelUrl(done.label_url);
    else if (done) say("Shippo did not return a label link.", true);
  }

  async function markShipped() {
    setBusy("ship");
    const done = await act("order.update", { id: o.id, status: "shipped", tracking_number: tracking });
    setBusy("");
    if (done) say("Order marked shipped");
  }

  async function cancel() {
    if (!confirmCancel) return setConfirmCancel(true);
    const done = await act("order.update", { id: o.id, status: "cancelled" });
    if (done) say("Order cancelled. Refund it in Stripe and add the stock back by hand.");
  }

  return (
    <article className="order">
      <div className="order-head">
        <h3>#{o.number}</h3>
        <span className={`pill ${tone}`}>{statusText}</span>
        <span className="hint">{when(o.paid_at ?? o.created_at)}</span>
        <b className="mono">{money(o.total_cents)}</b>
      </div>
      {o.stock_short && (
        <p className="warn">
          Stock ran short on this order: another sale took the last pieces first. Check the shelf before packing.
        </p>
      )}
      <div className="order-cols">
        <div>
          <span className="lbl">Ship to</span>
          {o.ship_to ? (
            <address>
              {o.ship_to.name}
              <br />
              {o.ship_to.street1}
              {o.ship_to.street2 ? (
                <>
                  <br />
                  {o.ship_to.street2}
                </>
              ) : null}
              <br />
              {o.ship_to.city}, {o.ship_to.state} {o.ship_to.zip}
            </address>
          ) : (
            <p className="hint">No address on file.</p>
          )}
          <p className="hint">
            {o.email}
            {o.phone ? ` · ${o.phone}` : ""}
          </p>
        </div>
        <div>
          <span className="lbl">
            {pieces} piece{pieces === 1 ? "" : "s"}
          </span>
          <ul>
            {o.items.map((it, i) => (
              <li key={i}>
                <span>
                  {it.qty} × {it.part_number || it.name}
                  {it.part_number ? ` · ${it.name}` : ""}
                </span>
                <span className="mono">{money(it.unit_price_cents * it.qty)}</span>
              </li>
            ))}
            <li className="hint">
              <span>Shipping {o.tax_cents ? "and tax" : ""}</span>
              <span className="mono">{money(o.shipping_cents + o.tax_cents)}</span>
            </li>
          </ul>
        </div>
      </div>

      {o.status === "shipped" && (
        <div className="panel">
          <p>
            {[o.carrier, o.service].filter(Boolean).join(" ") || "Shipped"}
            {o.tracking_number ? " · " : ""}
            {o.tracking_number &&
              (o.tracking_url?.startsWith("https://") ? (
                <a href={o.tracking_url} target="_blank" rel="noreferrer" className="mono">
                  {o.tracking_number}
                </a>
              ) : (
                <span className="mono">{o.tracking_number}</span>
              ))}
            {o.label_cost_cents != null ? ` · label ${money(o.label_cost_cents)}` : ""}
          </p>
          <div className="inline">
            {o.shippo_transaction_id && !labelUrl && (
              <button type="button" className="btn ghost sm" disabled={busy === "label"} onClick={openLabel}>
                {busy === "label" ? "Fetching…" : "Get label again"}
              </button>
            )}
            <button type="button" className="btn ghost sm" onClick={() => act("order.update", { id: o.id, status: "paid" })}>
              Move back to To ship
            </button>
          </div>
        </div>
      )}

      {labelUrl.startsWith("https://") && (
        <p>
          <a className="btn" href={labelUrl} target="_blank" rel="noreferrer">
            Open label to print
          </a>
        </p>
      )}

      {o.status === "paid" && (
        <div className="panel">
          <h3>Shipping label</h3>
          {!shippoOn && (
            <p className="hint">
              Shippo is not connected yet, so labels can&apos;t be bought here. Add SHIPPO_API_TOKEN in Vercel, or
              ship another way and record it below.
            </p>
          )}
          {shippoOn && (
            <>
              <div className="form">
                <label htmlFor={`preset-${o.id}`}>
                  Package
                  <select
                    id={`preset-${o.id}`}
                    defaultValue="0"
                    onChange={(e) => {
                      const p = presets[Number(e.target.value)];
                      if (p) {
                        setParcel({
                          length: String(p.length),
                          width: String(p.width),
                          height: String(p.height),
                          weight_oz: String(p.weight_oz),
                        });
                      }
                    }}
                  >
                    {presets.map((p, i) => (
                      <option key={i} value={i}>
                        {p.name} ({p.length}×{p.width}×{p.height} in)
                      </option>
                    ))}
                  </select>
                </label>
                <div className="two">
                  <label htmlFor={`w-${o.id}`}>
                    Weight (oz)
                    <input id={`w-${o.id}`} inputMode="decimal" value={parcel.weight_oz} onChange={setDim("weight_oz")} />
                  </label>
                  <label htmlFor={`l-${o.id}`}>
                    Length (in)
                    <input id={`l-${o.id}`} inputMode="decimal" value={parcel.length} onChange={setDim("length")} />
                  </label>
                  <label htmlFor={`wd-${o.id}`}>
                    Width (in)
                    <input id={`wd-${o.id}`} inputMode="decimal" value={parcel.width} onChange={setDim("width")} />
                  </label>
                  <label htmlFor={`h-${o.id}`}>
                    Height (in)
                    <input id={`h-${o.id}`} inputMode="decimal" value={parcel.height} onChange={setDim("height")} />
                  </label>
                </div>
              </div>
              <div>
                <button type="button" className="btn" disabled={busy === "rates"} onClick={getRates}>
                  {busy === "rates" ? "Getting rates…" : "Get rates"}
                </button>
              </div>
              {rates && (
                <div className="rates">
                  <p className="hint">
                    The customer paid {money(o.shipping_cents)} for shipping. Buying a label charges your Shippo
                    account.
                  </p>
                  {rates.slice(0, 8).map((r) => (
                    <div className="rate" key={r.id}>
                      <span>
                        {r.carrier} {r.service}
                        {r.days ? ` · about ${r.days} day${r.days === 1 ? "" : "s"}` : ""}
                      </span>
                      <span className="inline">
                        <b>{money(r.amount_cents)}</b>
                        <button type="button" className="btn sm" disabled={busy !== ""} onClick={() => buy(r)}>
                          {busy === r.id ? "Buying…" : "Buy label"}
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          <div className="form">
            <label htmlFor={`trk-${o.id}`}>
              Shipped another way? Tracking number (optional)
              <input id={`trk-${o.id}`} autoComplete="off" value={tracking} onChange={(e) => setTracking(e.target.value)} />
            </label>
            <div className="inline">
              <button type="button" className="btn ghost sm" disabled={busy === "ship"} onClick={markShipped}>
                Mark shipped
              </button>
              <button type="button" className="btn danger sm" onClick={cancel}>
                {confirmCancel ? "Tap again to cancel order" : "Cancel order"}
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
