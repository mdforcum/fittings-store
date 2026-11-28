"use client";
// The dealer page's Home: a quick look at what is waiting on this dealer's
// shelves, what went out this week and what is running low.
import { useEffect, useState } from "react";
import type { PortalData, PortalEvent } from "@/app/api/dealer/route";
import { MODE_LABEL, checkStep, eventText, type ShipCheckMode } from "@/lib/roles";
import { dealerNeeds, waited } from "@/lib/home";
import type { LowLine } from "@/lib/operations";
import InstallHint from "./InstallHint";

type Reply = { ok: boolean; message?: string; data?: PortalData; result?: Record<string, unknown> };
type Call = (body: Record<string, unknown>) => Promise<Reply>;
type View = "open" | "done" | "stock";

export default function DealerHome({ data, call, go, reload, onData }: { data: PortalData; call: Call; go: (v: View) => void; reload: () => Promise<void>; onData: (d: PortalData) => void }) {
  const manager = data.me.role === "manager";
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [acting, setActing] = useState("");
  const [mode, setMode] = useState<ShipCheckMode>(data.rules.ship_check);
  const [hold, setHold] = useState(String(data.rules.count_hold_over));
  const [events, setEvents] = useState<PortalEvent[] | null>(null);

  async function act(key: string, body: Record<string, unknown>, okText: string) {
    setActing(key);
    const r = await call(body);
    setActing("");
    if (r.ok && r.data) {
      onData(r.data);
      setNote({ text: okText, bad: false });
      if (events) void showEvents();
      return true;
    }
    setNote({ text: r.message ?? "That didn't save. Try again.", bad: true });
    return false;
  }
  async function showEvents() {
    const r = await call({ action: "events.list" });
    setEvents(r.ok ? ((r.result?.events as PortalEvent[]) ?? []) : []);
  }
  // Orders packed and waiting for their second check.
  const waitingCheck = data.rules.ready
    ? data.orders.filter((o) => o.lines.some((l) => !o.shipped.some((s) => s.location_id === l.location_id) && checkStep(data.rules.ship_check, o.checks?.[l.location_id], data.me).state === "wait")).length
    : 0;
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
  const toPull = needs.open - needs.pulled;
  const locName = (id: string) => (data.locations.length > 1 ? (data.locations.find((l) => l.id === id)?.name ?? "") : "");

  const tiles: Array<{ key: string; n: number | string; label: string; detail: string; to: View; tone: "todo" | "bad" | "clear" }> = [
    // With saved check-offs the work splits in two: still to pull, and pulled and ready to pack.
    ...(data.pull_ready
      ? [
          { key: "open", n: toPull, label: toPull === 1 ? "Order to pull" : "Orders to pull", detail: toPull && longest ? `Longest wait: ${longest}` : "Parts still on your shelf", to: "open" as View, tone: (toPull ? "todo" : "clear") as "todo" | "clear" },
          { key: "pack", n: needs.pulled, label: needs.pulled === 1 ? "Order to pack and ship" : "Orders to pack and ship", detail: "Every part checked off", to: "open" as View, tone: (needs.pulled ? "todo" : "clear") as "todo" | "clear" },
        ]
      : [{ key: "open", n: needs.open, label: needs.open === 1 ? "Order to pull and ship" : "Orders to pull and ship", detail: longest ? `Longest wait: ${longest}` : "Parts on your shelf, not shipped yet", to: "open" as View, tone: (needs.open ? "todo" : "clear") as "todo" | "clear" }]),
    ...(data.rules.ready && data.rules.ship_check !== "off"
      ? [{ key: "check", n: waitingCheck, label: waitingCheck === 1 ? "Order waiting for a check" : "Orders waiting for a check", detail: data.rules.ship_check === "manager" ? "Packed. A manager has to check before it ships" : "Packed. A second person has to check before it ships", to: "open" as View, tone: (waitingCheck ? "todo" : "clear") as "todo" | "clear" }]
      : []),
    ...(data.rules.ready && data.waiting.length
      ? [{ key: "counts", n: data.waiting.length, label: manager ? (data.waiting.length === 1 ? "Count to approve" : "Counts to approve") : data.waiting.length === 1 ? "Count waiting on a manager" : "Counts waiting on a manager", detail: `A change of more than ${data.rules.count_hold_over} needs a manager's OK`, to: "stock" as View, tone: "todo" as const }]
      : []),
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
          {data.refresh_minutes > 0
            ? ` This page checks for new orders every ${data.refresh_minutes} minute${data.refresh_minutes === 1 ? "" : "s"}. Press Refresh to check now.`
            : " Press Refresh to check for new orders."}
        </p>
        <button type="button" className="btn ghost" disabled={busy} onClick={refresh}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <InstallHint />
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
      {note && (
        <p className={note.bad ? "err" : "pf-note"} role={note.bad ? "alert" : "status"}>
          {note.text}
        </p>
      )}

      {data.rules.ready && data.waiting.length > 0 && (
        <section aria-labelledby="dh-counts">
          <h2 id="dh-counts">{manager ? "Counts to approve" : "Your counts waiting on a manager"}</h2>
          <ul className="home-list dh-waiting">
            {data.waiting.map((w) => (
              <li key={w.id}>
                <span>
                  {w.part_number && <span className="mono">{w.part_number} </span>}
                  {w.name}
                  <span className="hint">
                    {" "}
                    · {w.asked_name} counted {w.to_qty} (it was {w.from_qty}
                    {w.now !== w.from_qty ? `, now ${w.now}` : ""}){locName(w.location_id) ? ` at ${locName(w.location_id)}` : ""}
                  </span>
                </span>
                {manager && (
                  <span className="inline">
                    <button type="button" className="btn" disabled={!!acting} onClick={() => act(`y${w.id}`, { action: "count.decide", id: w.id, approve: true }, `${w.name}: count set to ${w.to_qty}.`)}>
                      {acting === `y${w.id}` ? "Saving…" : `Set to ${w.to_qty}`}
                    </button>
                    <button type="button" className="btn ghost" disabled={!!acting} onClick={() => act(`n${w.id}`, { action: "count.decide", id: w.id, approve: false }, `${w.name}: count left at ${w.now}.`)}>
                      Leave at {w.now}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

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
      {data.rules.ready && manager && (
        <section aria-labelledby="dh-rules">
          <h2 id="dh-rules">Shop rules</h2>
          <form
            className="card dh-rules"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number.parseInt(hold, 10);
              if (!Number.isInteger(n) || n < 0) return setNote({ text: "Enter a whole number, 0 or more.", bad: true });
              void act("rules", { action: "rules.save", ship_check: mode, count_hold_over: n }, "Shop rules saved.");
            }}
          >
            <label htmlFor="dh-mode">
              Before an order ships
              <select id="dh-mode" value={mode} onChange={(e) => setMode(e.target.value as ShipCheckMode)}>
                {(Object.keys(MODE_LABEL) as ShipCheckMode[]).map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">
              With a check on, one person marks an order packed and a different person checks it before a label or tracking can be saved. A manager can
              pass it alone by giving a reason, and that is kept on the record.
            </p>
            <label htmlFor="dh-hold">
              A worker&apos;s count waits for a manager when it changes the number by more than
              <input id="dh-hold" inputMode="numeric" autoComplete="off" value={hold} onChange={(e) => setHold(e.target.value.replace(/\D/g, ""))} />
            </label>
            <p className="hint">Set it to 0 and every change a worker makes waits. A manager&apos;s own counts never wait.</p>
            <button type="submit" className="btn" disabled={!!acting}>
              {acting === "rules" ? "Saving…" : "Save shop rules"}
            </button>
          </form>
        </section>
      )}

      {data.rules.ready && manager && (
        <section aria-labelledby="dh-log">
          <div className="home-row">
            <h2 id="dh-log">Who did what</h2>
            <button type="button" className="btn ghost" onClick={() => (events ? setEvents(null) : void showEvents())}>
              {events ? "Hide" : "Show the last 60"}
            </button>
          </div>
          {events &&
            (events.length ? (
              <ul className="home-list">
                {events.map((e) => (
                  <li key={e.id}>
                    <span>{eventText(e)}</span>
                    <span className="hint">{new Date(e.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Nothing yet. Packing, checking, shipping and counting will show here with each person&apos;s name.</p>
            ))}
        </section>
      )}
    </div>
  );
}
