"use client";
// Running low by location, and the outbox of dealer alerts (order and
// running-low messages by email and text).
import { useEffect, useState } from "react";
import type { AdminData } from "@/lib/admin-types";
import type { LowLine } from "@/lib/operations";
import type { Act, Say } from "../Admin";

type Props = { data: AdminData; act: Act; say: Say };
type Alert = { id: number; dealer_id: string | null; topic: string; channel: string; send_to: string; subject: string; status: string; error: string; created_at: string };

const STATUS: Record<string, [string, string]> = {
  queued: ["hold", "Waiting"],
  sent: ["ok", "Sent"],
  failed: ["bad", "Didn't send"],
  not_sent: ["muted", "Not sent"],
};

export default function Alerts({ data, act, say }: Props) {
  const places = data.places;
  const [low, setLow] = useState<LowLine[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [busy, setBusy] = useState("");
  const [only, setOnly] = useState("");

  useEffect(() => {
    if (!data.ops?.ready) return;
    let live = true;
    Promise.all([act("lowstock.load"), act("alerts.list")]).then(([l, a]) => {
      if (!live) return;
      if (l) setLow((l.lines as LowLine[]) ?? []);
      if (a) setAlerts((a.alerts as Alert[]) ?? []);
    });
    return () => {
      live = false;
    };
  }, [act, data.ops?.ready]);

  if (!data.ops?.ready) {
    return (
      <>
        <h1>Running low and alerts</h1>
        <p className="empty">This switches on when supabase/add-operations.sql has run.</p>
      </>
    );
  }

  const locName = (id: string) => places.locations.find((l) => l.id === id)?.name ?? "";
  const dealerName = (id: string | null) => places.dealers.find((d) => d.id === id)?.name ?? "";
  const shown = (low ?? []).filter((l) => !only || l.location_id === only);
  const sendable = data.ops.email || data.ops.text;

  async function refreshAlerts() {
    const a = await act("alerts.list");
    if (a) setAlerts((a.alerts as Alert[]) ?? []);
  }

  return (
    <div className="alerts">
      <h1>Running low</h1>
      <p className="hint">
        Parts at or under the low-stock number in Settings ({data.settings.low_stock}), or with less than about 30 days left at the pace of the last 30 days of
        sales at that location.
      </p>
      <div className="inline">
        <label htmlFor="low-loc">
          Location{" "}
          <select id="low-loc" value={only} onChange={(e) => setOnly(e.target.value)}>
            <option value="">All locations</option>
            {places.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn ghost sm"
          disabled={busy === "low"}
          onClick={async () => {
            setBusy("low");
            const r = await act("lowstock.send");
            setBusy("");
            if (r) {
              const n = Number(r.queued ?? 0);
              say(n ? `${n} running-low message${n === 1 ? "" : "s"} ${sendable ? "sent" : "saved to the outbox"}.` : "No dealer has alert contacts and parts running low.");
              await refreshAlerts();
            }
          }}
        >
          {busy === "low" ? "Working…" : "Send dealers their lists now"}
        </button>
      </div>
      {low == null ? (
        <p className="hint">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="empty">Nothing is running low{only ? ` at ${locName(only)}` : ""}.</p>
      ) : (
        <ul className="low-list">
          {shown.slice(0, 300).map((l) => (
            <li key={`${l.location_id}-${l.product_id}`}>
              <span>
                {l.part_number && <span className="mono">{l.part_number} </span>}
                {l.name}
              </span>
              <span className="hint">{locName(l.location_id)}</span>
              <span>
                <b className="mono">{l.qty}</b> left
                {l.sold30 ? ` · ${l.sold30} sold in 30 days` : ""}
                {l.days_left != null ? ` · about ${l.days_left} day${l.days_left === 1 ? "" : "s"}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2>Dealer alerts</h2>
      <p className="hint">
        {sendable
          ? `Order alerts go out by ${[data.ops.email && "email", data.ops.text && "text"].filter(Boolean).join(" and ")} when a paid order needs parts from a dealer's shelves. Running-low lists go out each Monday morning.`
          : "No email or text service is set up, so messages wait here. To send them, add RESEND_API_KEY and ALERT_FROM_EMAIL (email) or TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (texts) in Vercel, then redeploy. Dealers can still see every order on their dealer page."}
      </p>
      {sendable && (
        <div className="inline">
          <button
            type="button"
            className="btn ghost sm"
            disabled={!!busy}
            onClick={async () => {
              setBusy("send");
              const r = await act("alerts.retry");
              setBusy("");
              if (r) {
                say(`Sent ${Number(r.sent ?? 0)}${r.failed ? `, ${Number(r.failed)} didn't go` : ""}.`);
                await refreshAlerts();
              }
            }}
          >
            {busy === "send" ? "Sending…" : "Send waiting and failed messages"}
          </button>
        </div>
      )}
      {alerts == null ? (
        <p className="hint">Loading…</p>
      ) : alerts.length === 0 ? (
        <p className="empty">No alerts yet.</p>
      ) : (
        <ul className="low-list">
          {alerts.map((a) => {
            const [tone, label] = STATUS[a.status] ?? ["muted", a.status];
            return (
              <li key={a.id}>
                <span>
                  {a.subject || (a.topic === "low_stock" ? "Running low" : "Order alert")}
                  <span className="hint"> · {dealerName(a.dealer_id)}</span>
                </span>
                <span className="hint">
                  {a.channel === "sms" ? "Text" : "Email"} to <span className="mono">{a.send_to}</span>
                </span>
                <span>
                  <span className={`pill ${tone}`}>{label}</span> <span className="hint">{new Date(a.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  {a.error ? <span className="hint"> · {a.error}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
