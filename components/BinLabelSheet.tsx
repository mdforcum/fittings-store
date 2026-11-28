"use client";
// Printable bin labels: each spot's code in big letters and as a bar code, with
// its plain-words line. Pick the sheet, pick which spots, press Print.
import { useMemo, useState } from "react";
import { SHEETS, pagesOf, sheetById, type BinLabel } from "@/lib/bin-labels";
import { code128Svg } from "@/lib/code128";

type Top = { id: string; name: string };

export default function BinLabelSheet({ labels, tops, back, problem }: { labels: BinLabel[]; tops: Top[]; back: { href: string; text: string }; problem?: string }) {
  const [sheetId, setSheetId] = useState(SHEETS[0].id);
  const [top, setTop] = useState(tops.length === 1 ? tops[0].id : "all");
  const [every, setEvery] = useState(false);
  const [skip, setSkip] = useState("");
  const [under, setUnder] = useState("");
  const sheet = sheetById(sheetId);
  const chosen = useMemo(() => {
    const prefix = under.trim().toUpperCase();
    return labels.filter((l) => (top === "all" || l.top === top) && (every || l.leaf) && (!prefix || l.code.startsWith(prefix)));
  }, [labels, top, every, under]);
  const pages = pagesOf(chosen, sheet, Number.parseInt(skip, 10) || 0);
  const per = sheet.cols * sheet.rows;

  return (
    <main className="wrap bl">
      <style>{`@page { size: letter; margin: ${sheet.marginTop}in ${sheet.marginSide}in 0; }`}</style>
      <div className="bl-controls">
        <p className="eyebrow">Shelf map</p>
        <h1>Bin labels</h1>
        <p className="sub">
          Each label has the bin&apos;s code as text and as a bar code. Stick one on every bin: scanning it in the part finder lists every part kept
          there.
        </p>
        {problem && (
          <p className="err" role="alert">
            {problem}
          </p>
        )}
        {!problem && labels.length === 0 && <p className="empty">No shelf spots yet. Add aisles and bins on the shelf map first, then come back to print their labels.</p>}
        {labels.length > 0 && (
          <div className="bl-form">
            <label htmlFor="bl-sheet">
              Label sheet
              <select id="bl-sheet" value={sheetId} onChange={(e) => setSheetId(e.target.value)}>
                {SHEETS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {tops.length > 1 && (
              <label htmlFor="bl-top">
                Location
                <select id="bl-top" value={top} onChange={(e) => setTop(e.target.value)}>
                  <option value="all">Every location</option>
                  {tops.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label htmlFor="bl-under">
              Only codes starting with
              <input id="bl-under" autoComplete="off" autoCapitalize="characters" placeholder={labels.find((l) => !l.leaf)?.code ?? "A"} value={under} onChange={(e) => setUnder(e.target.value)} />
            </label>
            <label htmlFor="bl-skip">
              Skip used places on the first sheet
              <input id="bl-skip" inputMode="numeric" autoComplete="off" placeholder="0" value={skip} onChange={(e) => setSkip(e.target.value.replace(/\D/g, ""))} />
            </label>
            <label className="bl-check">
              <input type="checkbox" checked={every} onChange={(e) => setEvery(e.target.checked)} /> Also print labels for aisles and sections, not only bins
            </label>
          </div>
        )}
        {labels.length > 0 && (
          <>
            <p className="hint">{sheet.note} In the print window, set the scale to 100% (&quot;actual size&quot;), not &quot;fit to page&quot;, so the labels line up.</p>
            <p role="status">
              <b>{chosen.length}</b> label{chosen.length === 1 ? "" : "s"} on <b>{pages.length}</b> sheet{pages.length === 1 ? "" : "s"} ({per} to a sheet).
            </p>
            <div className="inline">
              <button type="button" className="btn" disabled={!chosen.length} onClick={() => window.print()}>
                Print labels
              </button>
              <a className="btn ghost" href={back.href}>
                {back.text}
              </a>
            </div>
          </>
        )}
        {labels.length === 0 && (
          <a className="btn ghost" href={back.href}>
            {back.text}
          </a>
        )}
      </div>

      {pages.map((page, n) => (
        <div
          key={n}
          className={`bl-page bl-${sheet.id}`}
          style={{ gridTemplateColumns: `repeat(${sheet.cols}, ${sheet.width}in)`, gridAutoRows: `${sheet.height}in`, columnGap: `${sheet.gapX}in`, rowGap: `${sheet.gapY}in` }}
        >
          {page.map((l, i) =>
            l ? (
              <div className="bl-label" key={l.id}>
                <span className="bl-code">{l.code}</span>
                <span className="bl-bars" dangerouslySetInnerHTML={{ __html: code128Svg(l.code, 30) }} />
                <span className="bl-line">{l.line}</span>
              </div>
            ) : (
              <div className="bl-label bl-blank" key={`blank-${i}`} aria-hidden="true" />
            ),
          )}
        </div>
      ))}
    </main>
  );
}
