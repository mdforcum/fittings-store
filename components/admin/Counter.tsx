"use client";
// Counter sales: a walk-in or phone sale rung up at one location. The parts
// come off that location's count right away, so the web store stays right.
import { useEffect, useState } from "react";
import type { AdminData } from "@/lib/admin-types";
import { money } from "@/lib/catalog";
import { EMPTY_INDEX, type LookupIndex, type PhotoRead } from "@/lib/lookup";
import { counterLines, counterTotal, counterWarnings } from "@/lib/operations";
import type { Act, Say } from "../Admin";
import PartFinder, { GoesWith } from "../PartFinder";

type Props = { data: AdminData; act: Act; say: Say };
type Line = { key: number; product_id: string; qty: string; price: string };
type Sale = { id: number; location_id: string; lines: Array<{ product_id: string; qty: number; price_cents: number }>; total_cents: number; paid_by: string; note: string; rung_by: string; created_at: string };

const AT_KEY = "inv-location";
const toCents = (s: string) => {
  const t = s.replace(/[$,\s]/g, "");
  return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : Number.NaN;
};

export default function Counter({ data, act, say }: Props) {
  const places = data.places;
  const stores = places.locations.filter((l) => l.active);
  const [loc, setLoc] = useState("");
  const [index, setIndex] = useState<LookupIndex>(EMPTY_INDEX);
  const [last, setLast] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [next, setNext] = useState(1);
  const [paidBy, setPaidBy] = useState("cash");
  const [note, setNote] = useState("");
  const [by, setBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [sales, setSales] = useState<Sale[] | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(AT_KEY) ?? "";
        setLoc(saved && places.locations.some((l) => l.id === saved) ? saved : (places.default_location_id ?? stores[0]?.id ?? ""));
      } catch {
        setLoc(places.default_location_id ?? stores[0]?.id ?? "");
      }
    }, 0);
    return () => clearTimeout(t);
    // Only on first show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!data.ops?.ready) return;
    let live = true;
    act("lookup.index").then((r) => {
      if (live && r?.index) setIndex(r.index as LookupIndex);
    });
    act("counter.list").then((r) => {
      if (live && r) setSales((r.sales as Sale[]) ?? []);
    });
    return () => {
      live = false;
    };
  }, [act, data.ops?.ready]);

  if (!data.ops?.ready || !places.ready) {
    return (
      <>
        <h1>Counter sale</h1>
        <p className="empty">Counter sales switch on when supabase/add-operations.sql has run.</p>
      </>
    );
  }

  const onShelf = (id: string) => places.onhand[id]?.[loc] ?? 0;
  const product = (id: string) => data.products.find((p) => p.id === id);
  const meta = (id: string) => {
    const p = product(id);
    return `${onShelf(id)} here · ${p?.price_cents != null ? money(p.price_cents) : "no price"}`;
  };
  const clean = counterLines(lines.map((l) => ({ product_id: l.product_id, qty: Number.parseInt(l.qty, 10) || 0, price_cents: toCents(l.price) })));
  const total = counterTotal(clean);
  const warnings = counterWarnings(
    clean,
    Object.fromEntries(clean.map((l) => [l.product_id, onShelf(l.product_id)])),
    data.held ?? {},
    Object.fromEntries(clean.map((l) => [l.product_id, product(l.product_id)?.qty ?? 0])),
  ).map((w) => {
    const id = w.split(":")[0];
    return w.replace(id, product(id)?.name ?? id);
  });
  const badPrice = lines.some((l) => Number.isNaN(toCents(l.price)));
  const short = clean.some((l) => l.qty > onShelf(l.product_id));
  const locName = (id: string) => places.locations.find((l) => l.id === id)?.name ?? "";

  function add(id: string) {
    const p = product(id);
    if (!p) return;
    const cur = lines.find((l) => l.product_id === id);
    if (cur) setLines(lines.map((l) => (l.key === cur.key ? { ...l, qty: String((Number.parseInt(l.qty, 10) || 0) + 1) } : l)));
    else {
      setLines([...lines, { key: next, product_id: id, qty: "1", price: p.price_cents != null ? (p.price_cents / 100).toFixed(2) : "" }]);
      setNext(next + 1);
    }
    setLast(id);
  }

  async function ring() {
    if (!loc) return say("Pick the location you're selling from.", true);
    if (!clean.length) return say("Add at least one part.", true);
    if (badPrice) return say("Enter each price as dollars, like 12.50.", true);
    if (short) return say("Some parts aren't on this shelf in that number. Fix the count or the quantity.", true);
    setBusy(true);
    const r = await act("counter.sale", { location_id: loc, lines: clean, paid_by: paidBy, note, by });
    setBusy(false);
    if (r) {
      say(`Sale #${String(r.sale_id)} rung up: ${money(total)}. The count at ${locName(loc)} is updated.`);
      setLines([]);
      setLast("");
      setNote("");
      const list = await act("counter.list");
      if (list) setSales((list.sales as Sale[]) ?? []);
    }
  }

  return (
    <div className="counter">
      <h1>Counter sale</h1>
      <p className="hint">For a walk-in or phone sale. Take the money the way you do now; this takes the parts off the shelf count so the web store stays right.</p>
      <div className="form counter-top">
        <label htmlFor="ct-loc">
          Selling from
          <select id="ct-loc" value={loc} onChange={(e) => setLoc(e.target.value)}>
            {places.dealers.map((d) => {
              const locs = stores.filter((l) => l.dealer_id === d.id);
              return locs.length ? (
                <optgroup key={d.id} label={d.name}>
                  {locs.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
        </label>
      </div>
      <PartFinder
        parts={data.products}
        index={index}
        shelf={onShelf}
        onPick={add}
        meta={meta}
        label="Add a part"
        inputId="ct-q"
        keepScanning
        itemClass="ct-match"
        photo={async (image, type) => {
          const r = await act("lookup.photo", { image, type });
          return r ? { read: r.read as PhotoRead } : { problem: "The photo couldn't be read. Type the number instead." };
        }}
        onLink={async (code, id) => {
          const r = await act("upc.link", { product_id: id, code });
          if (r?.index) setIndex(r.index as LookupIndex);
          return !!r;
        }}
      />
      {last && lines.some((l) => l.product_id === last) && (
        <GoesWith id={last} index={index} parts={data.products} skip={new Set(lines.map((l) => l.product_id))} onPick={add} meta={meta} />
      )}

      {lines.length > 0 && (
        <ul className="ct-lines">
          {lines.map((l) => {
            const p = product(l.product_id);
            return (
              <li key={l.key}>
                <span className="ct-name">
                  {p?.part_number && <span className="mono">{p.part_number} </span>}
                  {p?.name ?? l.product_id}
                  <span className="hint"> · {onShelf(l.product_id)} on this shelf</span>
                </span>
                <label>
                  Qty
                  <input inputMode="numeric" value={l.qty} onChange={(e) => setLines(lines.map((x) => (x.key === l.key ? { ...x, qty: e.target.value.replace(/\D/g, "") } : x)))} />
                </label>
                <label>
                  Each $
                  <input inputMode="decimal" value={l.price} aria-invalid={Number.isNaN(toCents(l.price))} onChange={(e) => setLines(lines.map((x) => (x.key === l.key ? { ...x, price: e.target.value } : x)))} />
                </label>
                <button type="button" className="btn ghost sm" onClick={() => setLines(lines.filter((x) => x.key !== l.key))} aria-label={`Remove ${p?.name ?? "part"}`}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {warnings.map((w) => (
        <p key={w} className="warn">
          {w}
        </p>
      ))}

      {lines.length > 0 && (
        <div className="form">
          <div className="three">
            <label htmlFor="ct-paid">
              Paid by
              <select id="ct-paid" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
                <option value="cash">Cash</option>
                <option value="card">Card</option>
                <option value="check">Check</option>
                <option value="account">On account</option>
              </select>
            </label>
            <label htmlFor="ct-note">
              Note <span className="hint">(optional)</span>
              <input id="ct-note" maxLength={200} autoComplete="off" placeholder="Customer or ticket number" value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <label htmlFor="ct-by">
              Rung up by <span className="hint">(optional)</span>
              <input id="ct-by" maxLength={80} autoComplete="off" value={by} onChange={(e) => setBy(e.target.value)} />
            </label>
          </div>
          <p className="ct-total">
            Total <b className="mono">{money(total)}</b>
          </p>
          <div className="inline">
            <button type="button" className="btn" disabled={busy || short || badPrice} onClick={ring}>
              {busy ? "Saving…" : "Ring up sale"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setLines([])}>
              Clear
            </button>
          </div>
        </div>
      )}

      <h2 className="ct-recent-head">Recent counter sales</h2>
      {sales == null ? (
        <p className="hint">Loading…</p>
      ) : sales.length === 0 ? (
        <p className="empty">No counter sales yet.</p>
      ) : (
        <ul className="ct-recent">
          {sales.map((s) => (
            <li key={s.id}>
              <span className="mono">#{s.id}</span>
              <span>
                {new Date(s.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {locName(s.location_id)}
              </span>
              <span>
                {s.lines.reduce((n, l) => n + l.qty, 0)} part{s.lines.reduce((n, l) => n + l.qty, 0) === 1 ? "" : "s"}
                {s.note ? ` · ${s.note}` : ""}
              </span>
              <span className="mono">
                {money(s.total_cents)} {s.paid_by}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
