"use client";
// The dealer page's Home: a quick look at what is waiting on this dealer's
// shelves, what went out this week and what is running low.
import { useEffect, useState } from "react";
import type { PortalData } from "@/app/api/dealer/route";
import { dealerNeeds, waited } from "@/lib/home";
import type { LowLine } from "@/lib/operations";

type Reply = { ok: boolean; message?: string; result?: Record<string, unknown> };
type Call = (body: Record<string, unknown>) => Promise<Reply>;
type View = "open" | "done" | "stock";

export default function DealerHome({ data, call, go, reload }: { data: PortalData; call: Call; go: (v: View) => void; reload: () => Promise<void> }) {
  const [low, setLow] = useState<LowLine[] | null>(null);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    call({ action: "home" }).then((r) => {
      if (!live) return;
      setLow(r.ok ? ((r.result?.low as LowLine[]) ?? []) : []);
      setAt(Date.now());
    });
    return () => {
      live = false;
    };
  }, [call]);

  async function refresh() {
    setBusy(true);
    await reload();
    const r = await call({ action: "home" });
    if (r.ok) setLow((r.result?.low as LowLine[]) ?? []);
    setAt(Date.now());
    setBusy(false);
  }

  const needs = dealerNeeds(data.orders, at || 0);
  const lines = low ?? [];
  const out = lines.filter((l) => l.qty <= 0).length;
  const running = lines.length - out;
  const longest = needs.open && needs.oldest && at ? waited(needs.oldest, at) : "";
  const locName = (id: string) => (data.locations.length > 1 ? (data.locations.find((l) => l.id === id)?.name ?? "") : "");

  const tiles: Array<{ key: string; n: number | string; label: string; detail: string; to: View; tone: "todo" | "bad" | "clear" }> = [
    { key: "open", n: needs.open, label: needs.open === 1 ? "Order to pull and ship" : "Orders to pull and ship", detail: longest ? `Longest wait: ${longest}` : "Parts on your shelf, not shipped yet", to: "open", tone: needs.open ? "todo" : "clear" },
    { key: "low", n: low ? running : "…", label: "Running low", detail: "At or under the low-stock number, or under a month left", to: "stock", tone: running ? "todo" : "clear" },
    { key: "out", n: low ? out : "…", label: "Out on your shelf", detail: "Parts you stock or sold that are at zero", to: "stock", tone: out ? "bad" : "clear" },
    { key: "done", n: at ? needs.shipped7 : "…", label: "Shipped in the last 7 days", detail: "Orders you finished", to: "done", tone: "clear" },
  ];

  return (
    <div className="home">
      <div className="home-row">
        <p className="sub" role="status">
          {needs.open ? `${needs.open} order${needs.open === 1 ? "" : "s"} waiting on you.` : "Nothing is waiting on you."}
          {at ? ` Updated ${new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.` : ""}
        </p>
        <button type="button" className="btn ghost" disabled={busy} onClick={refresh}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <section aria-labelledby="dh-needs">
        <h2 id="dh-needs">Needs you now</h2>
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
      </section>
      {lines.length > 0 && (
        <section aria-labelledby="dh-low">
          <div className="home-row">
            <h2 id="dh-low">Running low first</h2>
            <button type="button" className="btn ghost" onClick={() => go("stock")}>
              Open Stock
            </button>
          </div>
          <ul className="home-list">
            {lines.slice(0, 5).map((l) => (
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
    </div>
  );
}
