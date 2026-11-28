"use client";
// Pulling one location's part of an order on the dealer page: every part with
// its bin, checked off by scanning it (a plug-in scanner, the camera, or a
// typed number) or by tapping it. A wrong part is called out. Check-offs are
// saved with the person's name once supabase/add-pull-marks.sql has run;
// before that they last on this screen only, as they always did.
import { useRef, useState } from "react";
import type { PortalData, PortalOrder } from "@/app/api/dealer/route";
import { EMPTY_INDEX, type LookupIndex, type LookupPart } from "@/lib/lookup";
import { pullProgress, pulled, scanForPull, scanSay, type PullLine } from "@/lib/pulling";
import LiveScan from "./LiveScan";

type Reply = { ok: boolean; message?: string; data?: PortalData; result?: Record<string, unknown> };
type Call = (body: Record<string, unknown>) => Promise<Reply>;

// Loaded once, the first time anything is scanned: the numbers and bins this dealer's parts answer to,
// and the catalog's names so a wrong part can be named.
let indexOnce: Promise<LookupIndex> | null = null;
let catalogOnce: Promise<LookupPart[]> | null = null;
export function forgetPullData() {
  indexOnce = null;
  catalogOnce = null;
}
const loadIndex = (call: Call) => (indexOnce ??= call({ action: "lookup.index" }).then((r) => (r.ok && r.result?.index ? (r.result.index as LookupIndex) : EMPTY_INDEX)));
const loadCatalog = (call: Call) =>
  (catalogOnce ??= call({ action: "stock.load" }).then((r) => (r.ok && r.result?.stock ? ((r.result.stock as { products: LookupPart[] }).products ?? []) : [])));

export default function DealerPull({
  o,
  loc,
  lines,
  saved,
  shipped,
  call,
  onData,
}: {
  o: PortalOrder;
  loc: string;
  lines: PullLine[];
  /** Check-offs are kept on the server. */
  saved: boolean;
  shipped: boolean;
  call: Call;
  onData: (d: PortalData) => void;
}) {
  // Counts as this screen believes them: the server's, with any tap or scan not yet answered on top.
  const [mine, setMine] = useState<Record<string, number>>({});
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [code, setCode] = useState("");
  const [live, setLive] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const now = lines.map((l) => ({ ...l, picked: Math.min(mine[l.product_id] ?? l.picked, l.qty) }));
  const progress = pullProgress(now);
  const inputId = `pull-${o.id}-${loc}`;

  async function mark(productId: string, qty: number) {
    setMine((m) => ({ ...m, [productId]: qty }));
    if (!saved) return;
    const r = await call({ action: "pull.mark", order_id: o.id, location_id: loc, product_id: productId, qty });
    if (r.ok && r.data) {
      onData(r.data);
      // The server's count is now the truth for this part.
      setMine((m) => {
        const next = { ...m };
        delete next[productId];
        return next;
      });
      return;
    }
    setMine((m) => {
      const next = { ...m };
      delete next[productId];
      return next;
    });
    setNote({ text: r.message ?? "That check-off didn't save. Try again.", bad: true });
  }

  async function scanned(raw: string) {
    const text = raw.trim();
    if (!text) return;
    const index = await loadIndex(call);
    let result = scanForPull(text, now, index);
    // A code that isn't on this order: bring in the catalog once, so the wrong part can be named.
    if (result.kind === "unknown" || (result.kind === "wrong" && !result.name)) result = scanForPull(text, now, index, await loadCatalog(call));
    const say = scanSay(result, o.number);
    setNote(say);
    if (say.bad) navigator.vibrate?.([120, 60, 120]);
    if (result.kind === "picked") void mark(result.product_id, result.picked);
    setCode("");
  }

  return (
    <div className="pl">
      {!shipped && (
        <div className="pl-scan">
          <label htmlFor={inputId}>
            Scan or type a part or bin
            <input
              id={inputId}
              ref={box}
              type="search"
              autoComplete="off"
              autoCapitalize="characters"
              enterKeyHint="done"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void scanned(code);
                }
              }}
            />
          </label>
          <button type="button" className="btn ghost" aria-pressed={live} onClick={() => setLive(!live)}>
            {live ? "Stop camera" : "Scan with camera"}
          </button>
        </div>
      )}
      {live && !shipped && <LiveScan onCode={(c) => void scanned(c)} onClose={() => setLive(false)} />}
      {note && (
        <p className={note.bad ? "pl-wrong" : "pf-note"} role={note.bad ? "alert" : "status"}>
          {note.text}
        </p>
      )}
      <ul className="po-lines pl-lines">
        {now.map((l) => {
          const done = pulled(l);
          return (
            <li key={l.product_id} className={done ? "done" : ""}>
              <label className="po-check">
                <input type="checkbox" checked={done} disabled={shipped} onChange={() => void mark(l.product_id, done ? 0 : l.qty)} />
                <span className="po-qty">{l.qty}</span>
                <span>
                  {l.part_number && <span className="mono">{l.part_number} </span>}
                  {l.name}
                  {l.qty > 1 && l.picked > 0 && !done && <b className="pl-count"> · {l.picked} of {l.qty}</b>}
                  <span className="hint pl-where">
                    {l.bin ? (
                      <>
                        Bin <span className="mono">{l.bin.code}</span>
                      </>
                    ) : (
                      "No bin on the shelf map yet"
                    )}
                    {saved && done && l.picked_name ? ` · pulled by ${l.picked_name}` : ""}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {!shipped && (
        <p className="hint pl-progress" role="status">
          {progress.done ? "All pulled." : `${progress.have} of ${progress.need} pulled.`}
          {!saved ? " These ticks stay on this screen only." : ""}
        </p>
      )}
    </div>
  );
}
