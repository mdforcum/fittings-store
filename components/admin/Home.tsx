"use client";
// Back office Home: what needs doing now, sales at a glance, orders that cross
// between Backroad Iron and its dealers, and the shortcuts this person picked.
import { useCallback, useEffect, useState } from "react";
import type { AdminData } from "@/lib/admin-types";
import { DEFAULT_SHORTCUTS, NAV_GROUPS, SHORTCUTS_KEY, SHORTCUT_LIMIT, TAB_NAMES, readShortcuts, toggleShortcut, type Tab } from "@/lib/admin-nav";
import { money } from "@/lib/catalog";
import { alertsWaiting, networkOrders, orderNeeds, salesSummary, stockNeeds, waited, type PickProgress, type SaleRow, type SalesSpan } from "@/lib/home";
import type { LowLine } from "@/lib/operations";
import { NO_PLACES } from "@/lib/places";
import type { Act } from "../Admin";

type Props = { data: AdminData; act: Act; go: (t: Tab) => void; reload: () => Promise<void> };
type Extra = { progress: PickProgress; low: LowLine[]; sales: SaleRow[]; capped: boolean; hoses: number; alerts: { queued: number; failed: number }; at: number };
type Tone = "todo" | "bad" | "clear";

export default function Home({ data, act, go, reload }: Props) {
  const [extra, setExtra] = useState<Extra | null>(null);
  const [busy, setBusy] = useState(false);
  const [shortcuts, setShortcuts] = useState<Tab[]>(DEFAULT_SHORTCUTS);
  const [editing, setEditing] = useState(false);
  const opsReady = !!data.ops?.ready;

  const load = useCallback(async () => {
    const r = await act("home.load");
    if (r)
      setExtra({
        progress: (r.progress as PickProgress) ?? {},
        low: (r.low as LowLine[]) ?? [],
        sales: (r.sales as SaleRow[]) ?? [],
        capped: r.capped === true,
        hoses: Number(r.hoses ?? 0),
        alerts: (r.alerts as Extra["alerts"]) ?? { queued: 0, failed: 0 },
        at: Date.now(),
      });
  }, [act]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        setShortcuts(readShortcuts(window.localStorage.getItem(SHORTCUTS_KEY)));
      } catch {
        /* storage blocked: the starting set shows */
      }
      if (opsReady) void load();
    }, 0);
    return () => clearTimeout(t);
  }, [load, opsReady]);

  function pick(t: Tab) {
    const next = toggleShortcut(shortcuts, t);
    setShortcuts(next);
    try {
      window.localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(next));
    } catch {
      /* storage blocked: the pick lasts until reload */
    }
  }

  async function refresh() {
    setBusy(true);
    await reload();
    if (opsReady) await load();
    setBusy(false);
  }

  const places = data.places ?? NO_PLACES;
  const now = extra?.at ?? 0;
  const needs = orderNeeds(data.orders, extra?.progress ?? {});
  const stock = stockNeeds(data.products, extra?.low ?? []);
  const quotes = data.quotes.filter((q) => q.status === "new").length;
  const net = networkOrders(data.orders, places.locations, places.dealers, data.storefronts ?? [], data.routing?.house_dealer_id ?? null);
  const sales = extra ? salesSummary(extra.sales, extra.at, new Date(extra.at).setHours(0, 0, 0, 0)) : null;
  const locName = (id: string) => places.locations.find((l) => l.id === id)?.name ?? "";
  const longest = needs.oldestPaid && now ? waited(needs.oldestPaid, now) : "";
  const open = needs.toPull + needs.toShip + needs.toPickUp;
  const hoses = extra?.hoses ?? 0;
  const unsent = alertsWaiting(extra?.alerts ?? { queued: 0, failed: 0 }, !!data.ops?.email || !!data.ops?.text);

  const tiles: Array<{ key: string; n: number; label: string; detail: string; to: Tab; tone: Tone }> = [
    { key: "pull", n: needs.toPull, label: needs.toPull === 1 ? "Order to pull" : "Orders to pull", detail: needs.toPull && longest ? `Longest wait: ${longest}` : "Paid, parts still on the shelf", to: "orders", tone: needs.toPull ? "todo" : "clear" },
    { key: "ship", n: needs.toShip, label: needs.toShip === 1 ? "Order to ship" : "Orders to ship", detail: "Every part checked off", to: "orders", tone: needs.toShip ? "todo" : "clear" },
    ...(needs.toPickUp ? [{ key: "pickup", n: needs.toPickUp, label: needs.toPickUp === 1 ? "Order ready for pickup" : "Orders ready for pickup", detail: "Waiting for the customer", to: "orders" as Tab, tone: "todo" as Tone }] : []),
    ...(needs.short ? [{ key: "short", n: needs.short, label: needs.short === 1 ? "Order short on stock" : "Orders short on stock", detail: "A shelf came up short when it was paid", to: "orders" as Tab, tone: "bad" as Tone }] : []),
    { key: "low", n: stock.low, label: "Running low", detail: opsReady ? "At or under the low-stock number, or under a month left" : "Switches on with the operations database change", to: "alerts", tone: stock.low ? "todo" : "clear" },
    { key: "out", n: stock.out, label: "Out of stock", detail: "Hidden from shoppers until restocked", to: "inventory", tone: stock.out ? "bad" : "clear" },
    { key: "quotes", n: quotes, label: quotes === 1 ? "Quote to answer" : "Quotes to answer", detail: "New requests nobody has answered", to: "quotes", tone: quotes ? "todo" : "clear" },
    ...(hoses ? [{ key: "hoses", n: hoses, label: hoses === 1 ? "Hose request to look at" : "Hose requests to look at", detail: "New requests nobody has opened", to: "hoses" as Tab, tone: "todo" as Tone }] : []),
    ...(unsent.n ? [{ key: "alerts", n: unsent.n, label: unsent.n === 1 ? "Dealer alert not sent" : "Dealer alerts not sent", detail: unsent.detail, to: "alerts" as Tab, tone: (unsent.failed ? "bad" : "todo") as Tone }] : []),
    ...(stock.noPrice ? [{ key: "price", n: stock.noPrice, label: stock.noPrice === 1 ? "Part needs a price" : "Parts need a price", detail: "In stock but can't be sold yet", to: "inventory" as Tab, tone: "todo" as Tone }] : []),
  ];

  const line = (s: SalesSpan["web"]) => (s.n ? `${money(s.cents)} · ${s.n} sale${s.n === 1 ? "" : "s"}` : "None");
  const spans: Array<[string, SalesSpan | undefined]> = [
    ["Today", sales?.today],
    ["Last 7 days", sales?.week],
    ["Last 30 days", sales?.month],
  ];

  return (
    <div className="home">
      <div className="inv-head">
        <div>
          <p className="eyebrow">Back office</p>
          <h1>Home</h1>
        </div>
        <button type="button" className="btn ghost" disabled={busy} onClick={refresh}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="sub" role="status">
        {open ? `${open} open order${open === 1 ? "" : "s"}.` : "No open orders."}
        {extra ? ` Updated ${new Date(extra.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.` : ""}
      </p>

      <section aria-labelledby="home-short">
        <div className="home-row">
          <h2 id="home-short">My shortcuts</h2>
          <button type="button" className="btn ghost sm" aria-expanded={editing} onClick={() => setEditing(!editing)}>
            {editing ? "Done" : "Change shortcuts"}
          </button>
        </div>
        {shortcuts.length ? (
          <ul className="home-shortcuts">
            {shortcuts.map((t) => (
              <li key={t}>
                <button type="button" className="home-go" onClick={() => go(t)}>
                  {TAB_NAMES[t]}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">No shortcuts yet. Press Change shortcuts to pick the pages you use most.</p>
        )}
        {editing && (
          <div className="card home-edit">
            <p className="hint">
              Tick the pages you want one tap away, up to {SHORTCUT_LIMIT}. They show in the order you tick them. This is saved on this device only.
            </p>
            {NAV_GROUPS.filter((g) => g.id !== "home").map((g) => (
              <fieldset key={g.id}>
                <legend>{g.name}</legend>
                {g.tabs.map((t) => {
                  const on = shortcuts.includes(t);
                  return (
                    <label key={t} className="home-check">
                      <input type="checkbox" checked={on} disabled={!on && shortcuts.length >= SHORTCUT_LIMIT} onChange={() => pick(t)} /> {TAB_NAMES[t]}
                    </label>
                  );
                })}
              </fieldset>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="home-needs">
        <h2 id="home-needs">Needs you now</h2>
        <ul className="home-tiles">
          {tiles.map((t) => (
            <li key={t.key}>
              <button type="button" className={`home-tile ${t.tone}`} onClick={() => go(t.to)}>
                <span className="home-n">{t.n}</span>
                <span className="home-label">{t.label}</span>
                <span className="hint">{t.detail}</span>
              </button>
            </li>
          ))}
        </ul>
        {!extra && opsReady && <p className="hint">Checking what has been pulled…</p>}
      </section>

      {stock.top.length > 0 && (
        <section aria-labelledby="home-low">
          <div className="home-row">
            <h2 id="home-low">Running low first</h2>
            <button type="button" className="btn ghost sm" onClick={() => go("alerts")}>
              See all {stock.low}
            </button>
          </div>
          <ul className="home-list">
            {stock.top.map((l) => (
              <li key={`${l.product_id}:${l.location_id}`}>
                <span>
                  {l.part_number && <span className="mono">{l.part_number} </span>}
                  {l.name}
                </span>
                <span className="hint">
                  {l.qty} left{locName(l.location_id) ? ` at ${locName(l.location_id)}` : ""}
                  {l.days_left != null ? ` · about ${l.days_left} day${l.days_left === 1 ? "" : "s"} at this pace` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {opsReady && (
        <section aria-labelledby="home-sales">
          <h2 id="home-sales">Sales</h2>
          <div className="home-scroll">
            <table className="home-sales">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Web orders</th>
                  <th scope="col">Counter sales</th>
                </tr>
              </thead>
              <tbody>
                {spans.map(([name, s]) => (
                  <tr key={name}>
                    <th scope="row">{name}</th>
                    <td>
                      {s ? line(s.web) : "…"}
                      {s && s.refunded > 0 && <span className="hint"> ({money(s.refunded)} refunded since)</span>}
                    </td>
                    <td>{s ? line(s.counter) : "…"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">
            Web orders count the parts, before shipping and tax, on orders paid in that time. Counter sales are what was rung up.
            {extra?.capped ? " There were too many sales to add up here, so these numbers are low." : ""}
          </p>
        </section>
      )}

      {data.routing?.ready && places.dealers.length > 1 && (
        <section aria-labelledby="home-net">
          <div className="home-row">
            <h2 id="home-net">Orders shared with dealers</h2>
            <button type="button" className="btn ghost sm" onClick={() => go("statements")}>
              Dealer pay
            </button>
          </div>
          <div className="home-net">
            <div className="card">
              <p className="home-n">{net.outTotal}</p>
              <p className="home-label">Going out: our orders, a dealer&apos;s shelf</p>
              {net.out.length ? (
                <ul className="home-list">
                  {net.out.map((d) => (
                    <li key={d.dealer_id}>
                      <span>{d.name}</span>
                      <span className="hint">
                        {d.orders} open order{d.orders === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint">{data.routing.route_orders ? "No open Backroad Iron order is waiting on a dealer." : "Sending orders to dealers is turned off."}</p>
              )}
            </div>
            <div className="card">
              <p className="home-n">{net.inTotal}</p>
              <p className="home-label">Coming in: a dealer&apos;s store, our shelf</p>
              {net.into.length ? (
                <ul className="home-list">
                  {net.into.map((d) => (
                    <li key={d.dealer_id}>
                      <span>{d.name}</span>
                      <span className="hint">
                        {d.orders} open order{d.orders === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint">No open dealer store order needs parts from our shelf.</p>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
