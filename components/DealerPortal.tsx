"use client";
// The dealer portal: orders with parts on this dealer's shelves, a pick list
// to print or check off, "mark shipped" with tracking, and the month's
// statement. Everything a dealer needs without a back-office login.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PortalData, PortalOrder, PortalQuote } from "@/app/api/dealer/route";
import { money } from "@/lib/catalog";
import { DEALER_REFRESH_MINUTES } from "@/lib/operations";
import { OVERRIDE_MIN, checkStep, type DealerRules, type Role } from "@/lib/roles";
import DealerHome from "./DealerHome";
import DealerStock from "./DealerStock";
import { KIND_LABEL, monthName, monthOf, totals, type SettlementRow } from "@/lib/settlements";
import SpaceMapper from "./admin/SpaceMapper";
import { Toast, type ToastState } from "./ui";

type Reply = { ok: boolean; message?: string; data?: PortalData; result?: Record<string, unknown> };

const DEALER_VIEWS = ["home", "open", "done", "stock", "statement", "layout"] as const;
type DealerView = (typeof DEALER_VIEWS)[number];

async function call(body: Record<string, unknown>): Promise<Reply> {
  try {
    const r = await fetch("/api/dealer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as Reply;
  } catch {
    return { ok: false, message: "No connection. Try again." };
  }
}

function SignIn({ onIn }: { onIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const r = await call({ action: "login", email, password });
    setBusy(false);
    if (r.ok) onIn();
    else setError(r.message ?? "Sign-in failed.");
  }
  return (
    <main className="center portal">
      <p className="eyebrow">Dealer orders</p>
      <h1>Sign in</h1>
      <form className="form" onSubmit={submit}>
        <label htmlFor="de">
          Email
          <input id="de" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label htmlFor="dp">
          Password
          <input id="dp" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        <div>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
      <p className="hint">No login yet, or forgot your password? Ask Backroad Iron to set one up for you.</p>
    </main>
  );
}

function address(o: PortalOrder): string {
  const a = o.ship_to;
  if (!a) return "";
  return [a.name, a.street1, a.street2, [a.city, a.state].filter(Boolean).join(", ") + (a.zip ? ` ${a.zip}` : "")].filter(Boolean).join("\n");
}

type Bought = { order: number; carrier: string; tracking_number: string; label_url: string; charge_cents: number; warning?: string };
type ShipFns = {
  onShip: (o: PortalOrder, loc: string, carrier: string, tracking: string, pickup: boolean) => Promise<boolean>;
  onBought: (data: PortalData | undefined, bought: Bought) => void;
};

/** Opens a saved label again. Label links run out, so a fresh one is fetched each time. */
function LabelLink({ orderId, loc }: { orderId: string; loc: string }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (url)
    return (
      <a className="btn ghost" href={url} target="_blank" rel="noopener noreferrer">
        Open label (PDF)
      </a>
    );
  return (
    <>
      <button
        type="button"
        className="btn ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await call({ action: "label.url", order_id: orderId, location_id: loc });
          setBusy(false);
          const link = String(r.result?.label_url ?? "");
          if (r.ok && link.startsWith("https://")) setUrl(link);
          else setError(r.message ?? "The label could not be opened. Try again.");
        }}
      >
        {busy ? "Getting label…" : "Reprint label"}
      </button>
      {error && <p className="err">{error}</p>}
    </>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
type Me = { id: string; name: string; role: Role };

/**
 * The second check before an order ships, when the dealer asks for one: one
 * person marks it packed, a different person (or a manager) checks it, and only
 * then does the shipping step show. A manager can pass it with a written reason.
 */
function CheckGate({ o, loc, me, rules, onData, children }: { o: PortalOrder; loc: string; me: Me; rules: DealerRules; onData: (d: PortalData) => void; children: React.ReactNode }) {
  const check = o.checks?.[loc];
  const step = checkStep(rules.ready ? rules.ship_check : "off", check, me);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [overriding, setOverriding] = useState(false);
  if (step.state === "none") return <>{children}</>;

  async function send(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setError("");
    const r = await call({ action, order_id: o.id, location_id: loc, ...extra });
    setBusy("");
    if (r.ok && r.data) return onData(r.data);
    setError(r.message ?? "That didn't save. Try again.");
  }
  const rule = rules.ship_check === "manager" ? "a manager" : "a second person";

  if (step.state === "done" && check) {
    return (
      <>
        <p className="po-checked" role="status">
          Packed by {check.packed_name}.{" "}
          {check.override_reason
            ? `${check.checked_name} overrode the second check on ${clock(check.checked_at ?? "")}: ${check.override_reason}`
            : `Checked by ${check.checked_name} on ${clock(check.checked_at ?? "")}.`}
        </p>
        {children}
      </>
    );
  }

  if (step.state === "pack") {
    return (
      <div className="po-check">
        <p>This shop has {rule} check every order before it ships. Pull and pack the parts, then press the button.</p>
        <button type="button" className="btn" disabled={!!busy} onClick={() => send("check.pack")}>
          {busy ? "Saving…" : "Packed. Ready for a check"}
        </button>
        {error && <p className="err" role="alert">{error}</p>}
      </div>
    );
  }

  if (step.state !== "wait" || !check) return null;
  const sayReason = `ovr-${o.id}-${loc}`;
  return (
    <div className="po-check">
      <p role="status">
        <b>Waiting for a check.</b> Packed by {check.packed_name} on {clock(check.packed_at)}.
      </p>
      {step.canCheck && (
        <button type="button" className="btn" disabled={!!busy} onClick={() => send("check.pass")}>
          {busy === "check.pass" && !overriding ? "Saving…" : "I checked it. OK to ship"}
        </button>
      )}
      {step.why && <p className="hint">{step.why}</p>}
      {!step.canCheck && !step.canOverride && (
        <p className="hint">Have {rule === "a manager" ? "a manager" : "someone else"} sign in on this device, or open this order on their own.</p>
      )}
      {step.canOverride &&
        (overriding ? (
          <div className="po-override">
            <label htmlFor={sayReason}>
              Why is this shipping without a second check?
              <input id={sayReason} maxLength={300} autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <p className="hint">Your name and this reason are kept on the order&apos;s record.</p>
            <div className="inline">
              <button type="button" className="btn ghost" disabled={!!busy || reason.trim().length < OVERRIDE_MIN} onClick={() => send("check.pass", { override: true, reason })}>
                {busy ? "Saving…" : "Override and allow shipping"}
              </button>
              <button type="button" className="btn ghost" onClick={() => setOverriding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn ghost" onClick={() => setOverriding(true)}>
            Manager override
          </button>
        ))}
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  );
}

/** One location's part of an order: buy a label here, or type in tracking from the dealer's own carrier account. */
function ShipStop({ o, loc, labels, onShip, onBought }: { o: PortalOrder; loc: string; labels: boolean } & ShipFns) {
  const pickup = o.ship_method === "pickup";
  const [mode, setMode] = useState<"label" | "tracking">(labels && !pickup ? "label" : "tracking");
  const [carrier, setCarrier] = useState("UPS");
  const [tracking, setTracking] = useState("");
  const guess = o.packages?.[loc];
  const [box, setBox] = useState({ weight_lb: guess?.weight_lb ?? "", length: guess?.length ?? "", width: guess?.width ?? "", height: guess?.height ?? "" });
  const guessed = !!guess && (guess.weight_lb !== "" || guess.length !== "");
  const [quotes, setQuotes] = useState<PortalQuote[] | null>(null);
  const [from, setFrom] = useState("");
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const id = `${o.id}-${loc}`;
  const chosen = quotes?.find((q) => q.token === pick);
  const setDim = (k: keyof typeof box) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setBox({ ...box, [k]: e.target.value.replace(/[^\d.]/g, "") });
    setQuotes(null);
    setPick("");
  };

  async function rates(e: React.FormEvent) {
    e.preventDefault();
    setBusy("rates");
    setError("");
    const r = await call({ action: "label.rates", order_id: o.id, location_id: loc, parcel: box });
    setBusy("");
    if (!r.ok) return setError(r.message ?? "Rates could not be loaded. Try again.");
    const list = (r.result?.quotes as PortalQuote[]) ?? [];
    setQuotes(list);
    setFrom(String(r.result?.from ?? ""));
    setPick(list[0]?.token ?? "");
  }

  async function buy() {
    if (!chosen) return;
    setBusy("buy");
    setError("");
    const r = await call({ action: "label.buy", order_id: o.id, location_id: loc, token: chosen.token });
    setBusy("");
    if (!r.ok) {
      setQuotes(null);
      return setError(r.message ?? "The label could not be bought. Try again.");
    }
    onBought(r.data, {
      order: o.number,
      carrier: String(r.result?.carrier ?? chosen.carrier),
      tracking_number: String(r.result?.tracking_number ?? ""),
      label_url: String(r.result?.label_url ?? ""),
      charge_cents: Number(r.result?.charge_cents ?? chosen.price_cents),
      warning: typeof r.result?.warning === "string" ? r.result.warning : undefined,
    });
  }

  if (mode === "label") {
    return (
      <div className="po-label">
        <form className="po-box" onSubmit={rates} aria-label={`Package for order ${o.number}`}>
          <label htmlFor={`w-${id}`}>
            Weight, lb
            <input id={`w-${id}`} inputMode="decimal" autoComplete="off" value={box.weight_lb} onChange={setDim("weight_lb")} />
          </label>
          <label htmlFor={`l-${id}`}>
            Length, in
            <input id={`l-${id}`} inputMode="decimal" autoComplete="off" value={box.length} onChange={setDim("length")} />
          </label>
          <label htmlFor={`wd-${id}`}>
            Width, in
            <input id={`wd-${id}`} inputMode="decimal" autoComplete="off" value={box.width} onChange={setDim("width")} />
          </label>
          <label htmlFor={`h-${id}`}>
            Height, in
            <input id={`h-${id}`} inputMode="decimal" autoComplete="off" value={box.height} onChange={setDim("height")} />
          </label>
          {guessed && (
            <p className="hint po-guess">
              {guess.length ? "Weight and box size" : "Weight"} filled in from the part{o.lines.filter((l) => l.location_id === loc).length === 1 ? "'s" : "s'"} saved details. Weigh the packed
              box and change it if it&apos;s off.
            </p>
          )}
          {!quotes && (
            <button type="submit" className="btn" disabled={!!busy || !box.weight_lb || !box.length || !box.width || !box.height}>
              {busy === "rates" ? "Getting rates…" : "Get label rates"}
            </button>
          )}
        </form>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        {quotes && (
          <fieldset className="po-quotes">
            <legend>Pick a service</legend>
            {quotes.map((q) => (
              <label key={q.token} className="po-quote">
                <input type="radio" name={`q-${id}`} checked={pick === q.token} onChange={() => setPick(q.token)} />
                <span>
                  {q.carrier} {q.service}
                  {q.days ? <span className="hint"> · about {q.days} day{q.days === 1 ? "" : "s"}</span> : null}
                </span>
                <b className="mono">{money(q.price_cents)}</b>
              </label>
            ))}
            <p className="hint">
              The label price comes off your statement.{from ? ` It ships from ${from}.` : ""}
            </p>
            <button type="button" className="btn" disabled={!!busy || !chosen} onClick={buy}>
              {busy === "buy" ? "Buying label…" : chosen ? `Buy label for ${money(chosen.price_cents)}` : "Buy label"}
            </button>
          </fieldset>
        )}
        <button type="button" className="btn ghost" onClick={() => setMode("tracking")}>
          Use my own carrier account instead
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="po-ship">
        {!pickup && (
          <>
            <label>
              Carrier
              <select value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                {["UPS", "FedEx", "USPS", "Freight", "Other"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Tracking number
              <input value={tracking} onChange={(e) => setTracking(e.target.value)} autoComplete="off" inputMode="text" />
            </label>
          </>
        )}
        <button
          type="button"
          className="btn"
          disabled={!!busy || (!pickup && !tracking.trim())}
          onClick={async () => {
            setBusy("ship");
            await onShip(o, loc, carrier, tracking, pickup);
            setBusy("");
          }}
        >
          {busy === "ship" ? "Saving…" : pickup ? "Mark picked up" : "Mark shipped"}
        </button>
      </div>
      {labels && !pickup && (
        <button type="button" className="btn ghost" onClick={() => setMode("label")}>
          Buy a label here instead
        </button>
      )}
    </>
  );
}

function OrderCard({
  o,
  locations,
  labels,
  me,
  rules,
  onData,
  onShip,
  onBought,
}: { o: PortalOrder; locations: PortalData["locations"]; labels: boolean; me: Me; rules: DealerRules; onData: (d: PortalData) => void } & ShipFns) {
  const locs = [...new Set(o.lines.map((l) => l.location_id))];
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const name = (id: string) => locations.find((l) => l.id === id)?.name ?? "";
  const pickup = o.ship_method === "pickup";
  return (
    <li className="po-card">
      <div className="po-head">
        <h2>Order #{o.number}</h2>
        <span className={`pill ${o.status === "shipped" ? "ok" : "hold"}`}>{o.status === "shipped" ? "Done" : pickup ? "Customer picks up" : "To ship"}</span>
        <span className="hint">{new Date(o.created_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
      </div>
      {locs.map((loc) => {
        const done = o.shipped.find((s) => s.location_id === loc);
        const lines = o.lines.filter((l) => l.location_id === loc);
        return (
          <div className="po-stop" key={loc}>
            <h3>{locs.length > 1 || locations.length > 1 ? `From ${name(loc)}` : "Pull these parts"}</h3>
            <ul className="po-lines">
              {lines.map((l) => (
                <li key={l.product_id}>
                  <label className="po-check">
                    <input type="checkbox" checked={!!picked[`${loc}:${l.product_id}`]} onChange={(e) => setPicked({ ...picked, [`${loc}:${l.product_id}`]: e.target.checked })} />
                    <span className="po-qty">{l.qty}</span>
                    <span>
                      {l.part_number && <span className="mono">{l.part_number} </span>}
                      {l.name}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {done ? (
              <div className="po-done">
                <p className="pill ok">
                  {done.carrier === "Picked up" ? "Picked up" : `Shipped ${done.carrier} ${done.tracking_number}`} on {new Date(done.shipped_at).toLocaleDateString("en-US")}
                </p>
                {done.has_label && <LabelLink orderId={o.id} loc={loc} />}
                {done.has_label && <p className="hint po-wrong">Bought the wrong label? Email Backroad Iron and we&apos;ll void it.</p>}
              </div>
            ) : (
              <CheckGate o={o} loc={loc} me={me} rules={rules} onData={onData}>
                <ShipStop o={o} loc={loc} labels={labels} onShip={onShip} onBought={onBought} />
              </CheckGate>
            )}
          </div>
        );
      })}
      {!pickup && o.ship_to && (
        <div className="po-to">
          <h3>Ship to</h3>
          <pre>{address(o)}</pre>
          {o.phone && <p className="hint">Phone for the carrier: {o.phone}</p>}
        </div>
      )}
      {pickup && o.customer_name && <p>For {o.customer_name}</p>}
      {o.notes && <p className="hint">Note: {o.notes}</p>}
    </li>
  );
}

function Statement() {
  const [month, setMonth] = useState(monthOf(new Date().toISOString()));
  const [rows, setRows] = useState<SettlementRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    call({ action: "statement", month }).then((r) => {
      if (!live) return;
      if (r.ok) {
        setRows((r.result?.rows as SettlementRow[]) ?? []);
        setError("");
      } else setError(r.message ?? "The statement could not be loaded.");
    });
    return () => {
      live = false;
    };
  }, [month]);
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setDate(15);
    d.setMonth(d.getMonth() - i);
    return monthOf(d.toISOString());
  });
  const t = rows ? totals(rows) : null;
  return (
    <section className="po-statement">
      <h2>Your statement</h2>
      <label className="po-month">
        Month
        <select value={month} onChange={(e) => setMonth(e.target.value)}>
          {months.map((m) => (
            <option key={m} value={m}>
              {monthName(m)}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="err">{error}</p>}
      {rows && !rows.length && <p className="empty">Nothing for {monthName(month)}.</p>}
      {rows && rows.length > 0 && t && (
        <>
          <p className="po-total">
            {t.net >= 0 ? "Backroad Iron owes you" : "You owe Backroad Iron"} <strong>{money(Math.abs(t.net))}</strong> for {monthName(month)}
            {t.waiting ? ` (${t.waiting} line${t.waiting === 1 ? "" : "s"} still waiting on the card fee)` : ""}.
          </p>
          <ul className="po-rows">
            {rows.map((r, i) => (
              <li key={`${r.order_id}-${i}`}>
                <span>{r.order_number ? `#${r.order_number}` : "Order"}</span>
                <span>{KIND_LABEL[r.kind]}</span>
                <span className="mono">{r.net_cents == null ? "waiting" : money(r.net_cents)}</span>
                <span className="hint">{r.paid_at ? `Paid ${r.paid_note}` : "Not paid yet"}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export default function DealerPortal() {
  const [data, setData] = useState<PortalData | null>(null);
  const [state, setState] = useState<"loading" | "out" | "in" | "error">("loading");
  const [message, setMessage] = useState("");
  const [view, setViewState] = useState<DealerView>("home");
  // The address's "#view" keeps the view through a reload and makes Back work.
  const setView = useCallback((v: DealerView) => {
    setViewState(v);
    if (window.location.hash.replace("#", "") !== v) window.location.hash = v;
  }, []);
  useEffect(() => {
    const read = () => {
      const h = window.location.hash.replace("#", "");
      setViewState((DEALER_VIEWS as readonly string[]).includes(h) ? (h as DealerView) : "home");
    };
    const first = setTimeout(read, 0);
    window.addEventListener("hashchange", read);
    return () => {
      clearTimeout(first);
      window.removeEventListener("hashchange", read);
    };
  }, []);
  const [bought, setBought] = useState<Bought | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const say = useCallback((text: string, bad = false) => setToast({ text, bad, at: Date.now() }), []);
  const clearToast = useCallback(() => setToast(null), []);

  // True once the page has loaded for a signed-in dealer.
  const up = useRef(false);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dealer", { cache: "no-store" });
      const body = (await r.json()) as Reply;
      if (r.status === 401) {
        up.current = false;
        return setState("out");
      }
      // A refresh that fails once the page is up (no signal in the shop) leaves the page as it is,
      // so photos waiting to send from Shop layout are not thrown away.
      if (!body.ok || !body.data) {
        setMessage(body.message ?? "Your orders could not be loaded.");
        if (!up.current) setState("error");
        return;
      }
      setData(body.data);
      setMessage("");
      up.current = true;
      setState("in");
    } catch {
      if (up.current) return;
      setMessage("No connection. Try again.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  // The page reloads on its own only now and then (the minutes come from config), and only while it
  // is on screen. Refresh checks right away.
  const minutes = data?.refresh_minutes ?? DEALER_REFRESH_MINUTES;
  useEffect(() => {
    if (!(minutes > 0)) return;
    const every = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, minutes * 60_000);
    return () => clearInterval(every);
  }, [load, minutes]);
  const [checking, setChecking] = useState(false);

  if (state === "loading") return <main className="center portal"><p>Loading your orders…</p></main>;
  if (state === "out") return <SignIn onIn={() => void load()} />;
  if (state === "error" || !data)
    return (
      <main className="center portal">
        <p className="err">{message}</p>
        <button type="button" className="btn" onClick={() => void load()}>
          Try again
        </button>
      </main>
    );

  const open = data.orders.filter((o) => o.lines.some((l) => !o.shipped.some((s) => s.location_id === l.location_id)));
  const done = data.orders.filter((o) => !open.includes(o));
  const list = view === "open" ? open : done;

  return (
    <main className="wrap portal">
      <header className="po-top">
        <div>
          <p className="eyebrow">Dealer orders</p>
          <h1>{data.dealer.name}</h1>
          <p className="hint po-who">
            Signed in as {data.me.name}
            {data.rules.ready ? ` (${data.me.role})` : ""}. Not you? Sign out and sign in as yourself, so the record is right.
          </p>
        </div>
        <div className="po-top-actions">
          <button
            type="button"
            className="btn ghost"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              await load();
              setChecking(false);
              say("Checked for new orders.");
            }}
          >
            {checking ? "Checking…" : "Check for new orders"}
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              // The pick list is the To pull view: show it first, then print.
              if (view === "open") return window.print();
              setView("open");
              setTimeout(() => window.print(), 150);
            }}
          >
            Print pick list
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={async () => {
              await call({ action: "logout" });
              setState("out");
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <nav className="po-tabs" aria-label="Views">
        {(
          [
            ["home", "Home"],
            ["open", `To pull (${open.length})`],
            ["done", "Done"],
            ["stock", "Stock"],
            ["statement", "Statement"],
            ["layout", "Shop layout"],
          ] as const
        )
          // The statement is money: managers only.
          .filter(([k]) => k !== "statement" || data.me.role === "manager")
          .map(([k, label]) => (
          <button key={k} type="button" className="tab" aria-current={view === k ? "page" : undefined} onClick={() => setView(k)}>
            {label}
          </button>
        ))}
      </nav>
      {message && (
        <p className="err" role="alert">
          {message}
        </p>
      )}
      {bought && (
        <div className="po-notice" role="status">
          <p>
            {bought.warning ??
              `Label bought for order #${bought.order}: ${bought.carrier} ${bought.tracking_number}. ${money(bought.charge_cents)} will show on your statement.`}
          </p>
          {bought.label_url.startsWith("https://") && (
            <a className="btn" href={bought.label_url} target="_blank" rel="noopener noreferrer">
              Print label (PDF)
            </a>
          )}
        </div>
      )}
      {view === "home" ? (
        <DealerHome data={data} call={call} go={setView} reload={load} onData={setData} />
      ) : view === "layout" ? (
        <SpaceMapper scope="dealer" say={say} />
      ) : view === "stock" ? (
        <DealerStock locations={data.locations} supportEmail={data.support_email} call={call} onHeld={() => void load()} />
      ) : view === "statement" ? (
        data.me.role === "manager" ? <Statement /> : <p className="empty">The statement is for managers. Ask your manager.</p>
      ) : list.length === 0 ? (
        <p className="empty">{view === "open" ? "Nothing to pull right now. New orders show up here, and you'll get an alert if one is set up." : "No finished orders in the last 90 days."}</p>
      ) : (
        <ul className="po-list">
          {list.map((o) => (
            <OrderCard
              key={o.id}
              o={o}
              locations={data.locations}
              labels={data.labels}
              me={data.me}
              rules={data.rules}
              onData={(d) => {
                setData(d);
                setMessage("");
              }}
              onBought={(next, b) => {
                if (next) setData(next);
                setBought(b);
                setMessage("");
              }}
              onShip={async (ord, loc, carrier, tracking, pickup) => {
                const r = await call({ action: "ship", order_id: ord.id, location_id: loc, carrier, tracking_number: tracking, pickup });
                if (r.ok && r.data) {
                  setData(r.data);
                  setMessage("");
                  return true;
                }
                if (!r.ok && /sign in/i.test(r.message ?? "")) setState("out");
                setMessage(r.message ?? "That didn't save. Try again.");
                return false;
              }}
            />
          ))}
        </ul>
      )}
      <p className="hint po-help">
        Questions about an order or a payment?{" "}
        {data.support_email ? (
          <>
            Email <a href={`mailto:${data.support_email}`}>{data.support_email}</a>.
          </>
        ) : (
          "Email Backroad Iron."
        )}
      </p>
      <Toast toast={toast} clear={clearToast} />
    </main>
  );
}
