"use client";
// Back office: price requests from the shop. Freight carts (priced to the
// customer's ZIP code) and items sold by quote land here.
import { useState } from "react";
import type { AdminData, QuoteRequest } from "@/lib/admin-types";
import type { Act, Say } from "../Admin";

type Props = { data: AdminData; act: Act; say: Say };
type View = "open" | "closed" | "all";

const SOURCE: Record<QuoteRequest["source"], string> = {
  product: "Item priced by quote",
  freight: "Freight cart",
  list: "Parts list",
  phone: "Phone",
};
const STATUS: Record<QuoteRequest["status"], string> = {
  new: "New",
  quoted: "Price sent",
  won: "Won",
  lost: "Lost",
  cancelled: "Cancelled",
};
const open = (q: QuoteRequest) => q.status === "new" || q.status === "quoted";
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function Quotes({ data, act, say }: Props) {
  const [view, setView] = useState<View>("open");
  const list = data.quotes.filter((q) => (view === "all" ? true : view === "open" ? open(q) : !open(q)));
  const counts = { open: data.quotes.filter(open).length, closed: data.quotes.filter((q) => !open(q)).length, all: data.quotes.length };
  const views: Array<[View, string]> = [
    ["open", "Open"],
    ["closed", "Closed"],
    ["all", "All"],
  ];
  return (
    <section className="quotes">
      <div className="inv-head">
        <div>
          <p className="eyebrow">Back office</p>
          <h1>Quotes</h1>
        </div>
      </div>
      <div className="chips" role="group" aria-label="Quote status">
        {views.map(([id, label]) => (
          <button key={id} type="button" className="chip" aria-pressed={view === id} onClick={() => setView(id)}>
            {label}
            <span className="n">{counts[id]}</span>
          </button>
        ))}
      </div>
      {list.length === 0 && (
        <p className="empty">
          {view === "open" ? "No open requests." : "Nothing here yet."} Freight carts and items sold by quote land here when a
          customer asks for a price.
        </p>
      )}
      {list.map((q) => (
        <QuoteCard key={q.id} q={q} act={act} say={say} />
      ))}
    </section>
  );
}

function QuoteCard({ q, act, say }: { q: QuoteRequest; act: Act; say: Say }) {
  const [answer, setAnswer] = useState(q.answer);
  const [busy, setBusy] = useState(false);
  async function save(status?: QuoteRequest["status"]) {
    setBusy(true);
    const done = await act("quote.update", { id: q.id, answer, ...(status ? { status } : {}) });
    setBusy(false);
    if (done) say(status ? `Request #${q.number}: ${STATUS[status].toLowerCase()}` : "Saved");
  }
  const tone = q.status === "new" ? "hold" : q.status === "won" ? "ok" : "muted";
  return (
    <article className="quote">
      <div className="order-head">
        <h3>#{q.number}</h3>
        <span className={`pill ${tone}`}>{STATUS[q.status]}</span>
        <span className="hint">
          {SOURCE[q.source]} · {when(q.created_at)}
        </span>
      </div>
      <p>
        <b>{q.name || "No name given"}</b>
        {q.company ? `, ${q.company}` : ""}
        {q.phone && (
          <>
            {" · "}
            <a href={`tel:${q.phone.replace(/[^\d+]/g, "")}`}>{q.phone}</a>
          </>
        )}
        {q.email && (
          <>
            {" · "}
            <a href={`mailto:${q.email}?subject=${encodeURIComponent(`Your price request #${q.number}`)}`}>{q.email}</a>
          </>
        )}
        {q.zip ? ` · ships to ${q.zip}` : ""}
      </p>
      {q.machine && <p className="hint">Machine: {q.machine}</p>}
      <ul>
        {q.lines.map((l, i) => (
          <li key={i}>
            {l.qty} × <span className="mono">{l.number}</span>
            {l.note ? ` · ${l.note}` : ""}
          </li>
        ))}
      </ul>
      {q.notes && <p>&ldquo;{q.notes}&rdquo;</p>}
      <div className="form">
        <label htmlFor={`qa-${q.id}`}>
          Price given and notes (kept here; send it by phone or email)
          <textarea id={`qa-${q.id}`} rows={2} value={answer} onChange={(e) => setAnswer(e.target.value)} />
        </label>
        <div className="inline">
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => save()}>
            Save note
          </button>
          {q.status === "new" && (
            <button type="button" className="btn sm" disabled={busy} onClick={() => save("quoted")}>
              Price sent
            </button>
          )}
          {open(q) && (
            <>
              <button type="button" className="btn ghost sm" disabled={busy} onClick={() => save("won")}>
                Won
              </button>
              <button type="button" className="btn ghost sm" disabled={busy} onClick={() => save("lost")}>
                Lost
              </button>
            </>
          )}
          {!open(q) && (
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => save("new")}>
              Reopen
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
