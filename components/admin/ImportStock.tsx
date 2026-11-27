"use client";
// Spreadsheet import: a CSV of part numbers and counts for one location.
// Shows exactly what will change before anything is saved.
import { useState } from "react";
import { money } from "@/lib/catalog";
import { IMPORT_LIMIT, importPlan, importSummary, importUnchanged, parseCsv, type ImportCode, type ImportLine } from "@/lib/operations";
import type { Places } from "@/lib/places";
import type { Product } from "@/lib/catalog";
import type { Act, Say } from "../Admin";
import { Modal } from "../ui";

export default function ImportStock({
  products,
  places,
  at,
  act,
  say,
  onClose,
  codes = [],
}: {
  /** Barcodes already linked to parts, so a UPC column can find them. */
  codes?: ImportCode[];
  products: Product[];
  places: Places;
  at: string;
  act: Act;
  say: Say;
  onClose: () => void;
}) {
  const [loc, setLoc] = useState(at || places.default_location_id || places.locations[0]?.id || "");
  const [file, setFile] = useState("");
  const [rows, setRows] = useState<string[][] | null>(null);
  const [busy, setBusy] = useState(false);
  const plan = rows && loc ? importPlan(rows, products, places.onhand, loc, codes) : null;
  const sum = plan ? importSummary(plan.lines) : null;
  const locName = places.locations.find((l) => l.id === loc)?.name ?? "";

  async function read(f: File | undefined) {
    if (!f) return;
    if (f.size > 2_000_000) return say("That file is too big. Keep it under 2 MB.", true);
    if (!/\.(csv|txt)$/i.test(f.name)) return say("Save the spreadsheet as CSV first (File, Save as, CSV).", true);
    setFile(f.name);
    setRows(parseCsv(await f.text()));
  }

  async function apply() {
    if (!plan || !sum) return;
    const lines = plan.lines
      .filter((l) => !l.problem && !importUnchanged(l))
      .map((l) => ({ product_id: l.product_id, part_number: l.part_number, name: l.name, qty: l.qty, price_cents: l.price_cents, ...(l.upc_new ? { upc: l.upc } : {}) }));
    if (!lines.length) return say("Nothing to change: every count already matches.", true);
    setBusy(true);
    const done = await act("import.apply", { location_id: loc, lines, note: `Spreadsheet import: ${file}`.slice(0, 120) });
    setBusy(false);
    if (done) {
      const linked = Number(done.linked ?? 0);
      const left = Number(done.barcodes_left ?? 0);
      say(
        `Imported ${lines.length} line${lines.length === 1 ? "" : "s"} at ${locName}${sum.add ? `, ${sum.add} new part${sum.add === 1 ? "" : "s"}` : ""}${linked ? `, ${linked} barcode${linked === 1 ? "" : "s"} linked` : ""}.${left ? ` ${left} barcode${left === 1 ? " was" : "s were"} not linked.` : ""}`,
        left > 0,
      );
      onClose();
    }
  }

  const base = (l: ImportLine) =>
    !l.product_id
      ? `New part, count ${l.qty}`
      : l.qty === l.now
        ? l.price_cents != null
          ? `Count stays ${l.now}, price ${money(l.price_cents)}`
          : l.upc_new
            ? `Count stays ${l.now}`
            : "No change"
        : `Count ${l.now} → ${l.qty}${l.price_cents != null ? `, price ${money(l.price_cents)}` : ""}`;
  const changes = (l: ImportLine) => (l.problem ? l.problem : `${base(l)}${l.upc_new ? `, links barcode ${l.upc}` : ""}`);

  return (
    <Modal open onClose={onClose} title="Import a spreadsheet">
      <div className="form">
        <p className="hint">
          Save your spreadsheet as CSV with a heading row. Columns: <b>Part number</b> and <b>Qty</b>, plus <b>Name</b> for new parts and <b>Price</b> if you
          want to set it. Add a <b>UPC</b> column to link each barcode to its part, so a scan finds it; a row with a barcode that is already linked needs no
          part number. Each count replaces the count at the location you pick, like a recount. Up to {IMPORT_LIMIT} rows.
        </p>
        <label htmlFor="imp-loc">
          Counts are for
          <select id="imp-loc" value={loc} onChange={(e) => setLoc(e.target.value)}>
            {places.dealers.map((d) => {
              const locs = places.locations.filter((l) => l.dealer_id === d.id);
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
        <label htmlFor="imp-file">
          CSV file
          <input id="imp-file" type="file" accept=".csv,text/csv,.txt" onChange={(e) => void read(e.target.files?.[0])} />
        </label>
        {plan?.problem && (
          <p className="err" role="alert">
            {plan.problem}
          </p>
        )}
        {plan && sum && !plan.problem && (
          <>
            <p>
              At {locName}: <b>{sum.update}</b> to change, <b>{sum.add}</b> new, {sum.same} already right
              {sum.skip ? (
                <>
                  , <b className="bad-text">{sum.skip} skipped</b> (see below)
                </>
              ) : null}
              .
            </p>
            <ul className="imp-list">
              {plan.lines
                .filter((l) => l.problem || !importUnchanged(l))
                .slice(0, 300)
                .map((l) => (
                  <li key={l.row} className={l.problem ? "bad" : ""}>
                    <span className="hint">Row {l.row}</span>
                    <span>
                      <span className="mono">{l.part_number || "—"}</span> {l.name}
                    </span>
                    <span>{changes(l)}</span>
                  </li>
                ))}
            </ul>
            <div className="inline">
              <button type="button" className="btn" disabled={busy || sum.update + sum.add === 0} onClick={apply}>
                {busy ? "Importing…" : `Import ${sum.update + sum.add} line${sum.update + sum.add === 1 ? "" : "s"}`}
              </button>
              <button type="button" className="btn ghost" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
