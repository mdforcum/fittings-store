"use client";
// The dealer page's Stock tab: a dealer keeps its own shelf counts right.
// Set a count, take one off for a counter sale, see what's running low, or
// load a count spreadsheet. Counts only: prices and new parts are set by
// Backroad Iron.
import { useEffect, useMemo, useState } from "react";
import type { PortalData, PortalStock } from "@/app/api/dealer/route";
import { money } from "@/lib/catalog";
import { IMPORT_LIMIT, dealerCountLines, importPlan, parseCsv } from "@/lib/operations";

type Reply = { ok: boolean; message?: string; result?: Record<string, unknown> };
type Call = (body: Record<string, unknown>) => Promise<Reply>;

const SHOW = 60;

export default function DealerStock({ locations, supportEmail, call }: { locations: PortalData["locations"]; supportEmail: string; call: Call }) {
  const [stock, setStock] = useState<PortalStock | null>(null);
  const [loc, setLoc] = useState(locations[0]?.id ?? "");
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let live = true;
    call({ action: "stock.load" }).then((r) => {
      if (!live) return;
      if (r.ok && r.result?.stock) setStock(r.result.stock as PortalStock);
      else setNote({ text: r.message ?? "Your stock could not be loaded. Try again.", bad: true });
    });
    return () => {
      live = false;
    };
  }, [call]);

  const onShelf = (id: string): number | undefined => stock?.onhand[id]?.[loc];
  const needle = q.trim().toLowerCase();
  const list = useMemo(() => {
    if (!stock) return [];
    const has = (id: string) => stock.onhand[id]?.[loc] !== undefined;
    const hit = (p: PortalStock["products"][number]) => p.name.toLowerCase().includes(needle) || p.part_number.toLowerCase().includes(needle);
    // With no search: what's on this shelf. With a search: anything in the catalog that matches.
    return stock.products.filter((p) => (needle ? hit(p) : has(p.id))).sort((a, b) => Number(has(b.id)) - Number(has(a.id)));
  }, [stock, loc, needle]);
  const low = (stock?.low ?? []).filter((l) => l.location_id === loc);
  const locName = locations.find((l) => l.id === loc)?.name ?? "";

  function done(r: Reply, okText: string) {
    setBusy("");
    if (r.ok && r.result?.stock) {
      setStock(r.result.stock as PortalStock);
      setNote({ text: okText, bad: false });
      return true;
    }
    setNote({ text: r.message ?? "That didn't save. Try again.", bad: true });
    return false;
  }

  async function saveCount(id: string, name: string) {
    const n = Number.parseInt(typed[id] ?? "", 10);
    if (!Number.isInteger(n) || n < 0) return setNote({ text: "Enter the count as a whole number, 0 or more.", bad: true });
    setBusy(`count:${id}`);
    const ok = done(await call({ action: "stock.count", location_id: loc, lines: [{ product_id: id, qty: n }] }), `${name}: count set to ${n} at ${locName}.`);
    if (ok) setTyped((t) => ({ ...t, [id]: "" }));
  }

  async function soldOne(id: string, name: string) {
    setBusy(`sold:${id}`);
    done(await call({ action: "stock.sold", location_id: loc, product_id: id, qty: 1 }), `Took 1 ${name} off the shelf at ${locName}.`);
  }

  const plan = rows && stock ? importPlan(rows, stock.products, stock.onhand, loc) : null;
  const counts = plan && !plan.problem ? dealerCountLines(plan.lines) : null;

  async function readFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 2_000_000) return setNote({ text: "That file is too big. Keep it under 2 MB.", bad: true });
    if (!/\.(csv|txt)$/i.test(f.name)) return setNote({ text: "Save the spreadsheet as CSV first (File, Save as, CSV).", bad: true });
    setFileName(f.name);
    setRows(parseCsv(await f.text()));
  }

  async function applyImport() {
    if (!counts?.apply.length) return;
    setBusy("import");
    const ok = done(await call({ action: "stock.count", location_id: loc, lines: counts.apply }), `${counts.apply.length} count${counts.apply.length === 1 ? "" : "s"} updated at ${locName} from ${fileName}.`);
    if (ok) {
      setRows(null);
      setImporting(false);
    }
  }

  if (!stock) return <p className={note?.bad ? "err" : "hint"}>{note?.text ?? "Loading your stock…"}</p>;
  if (!locations.length) return <p className="empty">No location is set up for you yet. Email Backroad Iron to add one.</p>;

  return (
    <section className="ds">
      <h2>Your stock</h2>
      <p className="hint">
        Keep these counts right and the web store sells only what you have. Prices and new parts are set by Backroad Iron
        {supportEmail ? (
          <>
            : email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
          </>
        ) : null}
        .
      </p>
      {locations.length > 1 && (
        <label className="ds-field" htmlFor="ds-loc">
          Location
          <select id="ds-loc" value={loc} onChange={(e) => setLoc(e.target.value)}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {note && (
        <p className={note.bad ? "err" : "po-saved"} role={note.bad ? "alert" : "status"}>
          {note.text}
        </p>
      )}

      {low.length > 0 && (
        <details className="ds-low">
          <summary>
            Running low: {low.length} part{low.length === 1 ? "" : "s"}
          </summary>
          <ul>
            {low.slice(0, 100).map((l) => (
              <li key={l.product_id}>
                <span>
                  {l.part_number && <span className="mono">{l.part_number} </span>}
                  {l.name}
                </span>
                <span>
                  <b className="mono">{l.qty}</b> left
                  {l.sold30 ? ` · ${l.sold30} sold in 30 days` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <label className="ds-field" htmlFor="ds-q">
        Find a part
        <input id="ds-q" type="search" autoComplete="off" placeholder="Part number or name" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {list.length === 0 ? (
        <p className="empty">{needle ? "No part matches. If it's missing from the catalog, email Backroad Iron to add it." : "Nothing is on this shelf yet. Search for a part to give it a count."}</p>
      ) : (
        <ul className="ds-list">
          {list.slice(0, SHOW).map((p) => {
            const have = onShelf(p.id);
            const value = typed[p.id] ?? "";
            return (
              <li key={p.id}>
                <div className="ds-name">
                  <span>
                    {p.part_number && <span className="mono">{p.part_number} </span>}
                    {p.name}
                  </span>
                  <span className="hint">
                    {have === undefined ? "Not on your shelf yet" : `On your shelf: ${have}`}
                    {p.price_cents ? ` · ${money(p.price_cents)}` : " · no price yet"}
                  </span>
                </div>
                <label htmlFor={`ds-c-${p.id}`}>
                  New count
                  <input id={`ds-c-${p.id}`} inputMode="numeric" autoComplete="off" value={value} onChange={(e) => setTyped({ ...typed, [p.id]: e.target.value.replace(/\D/g, "") })} />
                </label>
                <button type="button" className="btn" disabled={!!busy || value === "" || Number(value) === have} onClick={() => saveCount(p.id, p.name)}>
                  {busy === `count:${p.id}` ? "Saving…" : "Save count"}
                </button>
                <button type="button" className="btn ghost" disabled={!!busy || !have} onClick={() => soldOne(p.id, p.name)} aria-label={`Sold 1 ${p.name} at the counter`}>
                  {busy === `sold:${p.id}` ? "Saving…" : "Sold 1"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {list.length > SHOW && <p className="hint">Showing the first {SHOW}. Search to narrow it down.</p>}

      <div className="ds-import">
        {!importing ? (
          <button type="button" className="btn ghost" onClick={() => setImporting(true)}>
            Load a count spreadsheet
          </button>
        ) : (
          <>
            <h3>Load a count spreadsheet</h3>
            <p className="hint">
              Save your spreadsheet as CSV with a heading row and two columns: <b>Part number</b> and <b>Qty</b>. Each count replaces the count at {locName}. Up
              to {IMPORT_LIMIT} rows.
            </p>
            <label className="ds-field" htmlFor="ds-file">
              CSV file
              <input id="ds-file" type="file" accept=".csv,text/csv,.txt" onChange={(e) => void readFile(e.target.files?.[0])} />
            </label>
            {plan?.problem && (
              <p className="err" role="alert">
                {plan.problem}
              </p>
            )}
            {counts && (
              <>
                <p>
                  <b>{counts.apply.length}</b> count{counts.apply.length === 1 ? "" : "s"} to change, {counts.same} already right
                  {counts.unknown.length ? `, ${counts.unknown.length} not in the catalog` : ""}
                  {counts.bad.length ? `, ${counts.bad.length} with a problem` : ""}.
                </p>
                {counts.unknown.length > 0 && (
                  <p className="hint">
                    Not in the catalog (left out): {counts.unknown.slice(0, 12).map((l) => l.part_number).join(", ")}
                    {counts.unknown.length > 12 ? "…" : ""}. Email Backroad Iron to add them.
                  </p>
                )}
                {counts.bad.length > 0 && (
                  <p className="hint">
                    Left out:{" "}
                    {counts.bad
                      .slice(0, 6)
                      .map((l) => `row ${l.row} (${l.problem || "no count"})`)
                      .join("; ")}
                    {counts.bad.length > 6 ? "…" : ""}
                  </p>
                )}
                <div className="ds-actions">
                  <button type="button" className="btn" disabled={!!busy || counts.apply.length === 0} onClick={applyImport}>
                    {busy === "import" ? "Saving…" : `Update ${counts.apply.length} count${counts.apply.length === 1 ? "" : "s"}`}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => {
                      setRows(null);
                      setImporting(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
