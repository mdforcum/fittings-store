"use client";
// Dealer statements: what each outside dealer is owed, month by month.
import { useEffect, useState } from "react";
import type { AdminData } from "@/lib/admin-types";
import { money } from "@/lib/catalog";
import { bpsToPercent, monthName, monthOf, statementCsv, totals, type SettlementRow } from "@/lib/settlements";
import type { Act, Say } from "../Admin";

type Props = { data: AdminData; act: Act; say: Say };

export default function Statements({ data, act, say }: Props) {
  const house = data.routing?.house_dealer_id;
  const dealers = (data.places?.dealers ?? []).filter((d) => d.id !== house);
  const [dealer, setDealer] = useState(dealers[0]?.id ?? "");
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState(monthOf(new Date().toISOString()));
  const [rows, setRows] = useState<SettlementRow[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const dealerName = dealers.find((d) => d.id === dealer)?.name ?? "";

  // Months that have lines, for the picker.
  useEffect(() => {
    if (!dealer) return;
    let live = true;
    act("statements.load", { dealer_id: dealer }).then((r) => {
      if (live) setMonths(((r?.months as string[]) ?? []).filter(Boolean));
    });
    return () => {
      live = false;
    };
  }, [act, dealer, version]);

  useEffect(() => {
    if (!dealer) return;
    let live = true;
    act("statements.load", { dealer_id: dealer, month }).then((r) => {
      if (live) setRows((r?.rows as SettlementRow[]) ?? []);
    });
    return () => {
      live = false;
    };
  }, [act, dealer, month, version]);

  if (!data.routing?.ready) {
    return (
      <>
        <h1>Dealer statements</h1>
        <p className="empty">Dealer statements switch on when the routing database change has run.</p>
      </>
    );
  }
  if (!dealers.length) {
    return (
      <>
        <h1>Dealer statements</h1>
        <p className="empty">No outside dealers yet. Add one in Settings.</p>
      </>
    );
  }

  const t = totals(rows ?? []);
  const monthChoices = [...new Set([monthOf(new Date().toISOString()), ...months, month])].sort().reverse();

  async function fillFees() {
    setBusy(true);
    const r = await act("statements.fees", {});
    setBusy(false);
    if (r) {
      say(r.filled ? `Filled in ${r.filled} card fee${r.filled === 1 ? "" : "s"} from Stripe` : "Stripe hasn't settled those fees yet. Try again later.");
      setVersion((v) => v + 1);
    }
  }

  async function markPaid(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) return say("Say how it was paid, like Check 1041 or ACH Dec 5.", true);
    setBusy(true);
    const r = await act("statements.pay", { dealer_id: dealer, month, note });
    setBusy(false);
    if (r) {
      say(`Marked ${r.paid} line${r.paid === 1 ? "" : "s"} paid`);
      setNote("");
      setVersion((v) => v + 1);
    }
  }

  function download() {
    const blob = new Blob([statementCsv(dealerName, month, rows ?? [])], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${dealerName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="statements">
      <div className="inv-head">
        <div>
          <p className="eyebrow">Back office</p>
          <h1>Dealer statements</h1>
        </div>
      </div>
      <div className="form st-pick">
        <div className="two">
          <label htmlFor="st-dealer">
            Dealer
            <select id="st-dealer" value={dealer} onChange={(e) => setDealer(e.target.value)}>
              {dealers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="st-month">
            Month
            <select id="st-month" value={month} onChange={(e) => setMonth(e.target.value)}>
              {monthChoices.map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <h2 className="st-title">
        {dealerName}, {monthName(month)}
      </h2>
      {rows === null ? (
        <p className="hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="empty">Nothing for {dealerName} in {monthName(month)}.</p>
      ) : (
        <>
          <dl className="st-sum">
            <div>
              <dt>Parts shipped</dt>
              <dd>{money(t.parts)}</dd>
            </div>
            <div>
              <dt>Shipping collected</dt>
              <dd>{money(t.shipping)}</dd>
            </div>
            <div>
              <dt>Backroad Iron&apos;s cut</dt>
              <dd>−{money(t.cut)}</dd>
            </div>
            <div>
              <dt>Card fees</dt>
              <dd>−{money(t.fee)}</dd>
            </div>
            <div className="st-owed">
              <dt>Owed to {dealerName}</dt>
              <dd>{money(t.net)}</dd>
            </div>
            <div>
              <dt>Not paid yet</dt>
              <dd>{money(t.unpaidNet)}</dd>
            </div>
          </dl>
          {t.waiting > 0 && (
            <p className="warn-line" role="status">
              {t.waiting} line{t.waiting === 1 ? " is" : "s are"} waiting on Stripe&apos;s card fee, so {t.waiting === 1 ? "it isn't" : "they aren't"} in
              the owed total yet.{" "}
              <button type="button" className="btn ghost sm" disabled={busy} onClick={fillFees}>
                Fill in card fees
              </button>
            </p>
          )}
          <div className="st-table-wrap">
            <table className="st-table">
              <caption className="sr">
                {dealerName} statement lines for {monthName(month)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Order</th>
                  <th scope="col">From</th>
                  <th scope="col" className="num">Parts</th>
                  <th scope="col" className="num">Shipping</th>
                  <th scope="col" className="num">Cut</th>
                  <th scope="col" className="num">Card fee</th>
                  <th scope="col" className="num">Owed</th>
                  <th scope="col">Paid</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.order_id}>
                    <td data-label="Date">{new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" })}</td>
                    <td data-label="Order">{r.order_number != null ? `#${r.order_number}` : "—"}</td>
                    <td data-label="From">{r.kind === "routed" ? "Backroad Iron order" : "Own store"}</td>
                    <td className="num" data-label="Parts">{money(r.parts_cents)}</td>
                    <td className="num" data-label="Shipping">{money(r.shipping_cents)}</td>
                    <td className="num" data-label="Cut">
                      <span>
                        −{money(r.cut_cents)} <span className="hint">({bpsToPercent(r.cut_bps)}%)</span>
                      </span>
                    </td>
                    <td className="num" data-label="Card fee">{r.card_fee_cents == null ? "waiting" : `−${money(r.card_fee_cents)}`}</td>
                    <td className="num" data-label="Owed">
                      <b>{r.net_cents == null ? "—" : money(r.net_cents)}</b>
                    </td>
                    <td data-label="Paid">{r.paid_at ? `${new Date(r.paid_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${r.paid_note}` : "Not yet"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="inline st-actions">
            <button type="button" className="btn ghost sm" onClick={() => window.print()}>
              Print
            </button>
            <button type="button" className="btn ghost sm" onClick={download}>
              Download spreadsheet
            </button>
          </div>
          {t.unpaid > 0 && (
            <form className="form st-pay" onSubmit={markPaid}>
              <label htmlFor="st-note">
                Paid {dealerName} {money(t.unpaidNet)} for {monthName(month)}? How:
                <input id="st-note" maxLength={120} autoComplete="off" placeholder="Check 1041, ACH Dec 5" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button type="submit" className="btn" disabled={busy || t.waiting > 0}>
                Mark {t.unpaid} line{t.unpaid === 1 ? "" : "s"} paid
              </button>
              {t.waiting > 0 && <p className="hint">Fill in the card fees first, so the amount is final.</p>}
            </form>
          )}
        </>
      )}
      <p className="hint st-foot">
        One line for each paid order where {dealerName} shipped parts. Lines are kept as written; payments are added, never edited.
      </p>
    </div>
  );
}
