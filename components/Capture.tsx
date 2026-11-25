"use client";
// The phone capture page. Everything here works with no signal: each capture
// is saved on the phone first and uploaded whenever a connection is there.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Capture as Saved, CaptureKind } from "@/lib/match";
import {
  allItems,
  keepStorage,
  pruneSent,
  putItem,
  removeItem,
  sendItem,
  type Queued,
} from "@/lib/outbox";
import { prepare, warmDecoder } from "@/lib/scan";
import { Modal, Toast, type ToastState } from "./ui";

/** `local` marks a location made on this phone that the server has not confirmed yet. */
type Place = { id: string; name: string; local?: boolean };
type Fields = Queued["fields"];
type Offline = "checking" | "storing" | "ready" | "partial" | "unsupported";

const KIND: Record<CaptureKind, string> = {
  card: "Inventory card",
  bin: "Parts bin",
  code: "Scanned code",
  manual: "Typed entry",
};

const newId = (): string =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16),
      );

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing: the choice just is not remembered */
  }
};

/** Today's captures show the time; older ones show the day. */
function time(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** One line saying what a capture holds. */
function summary(item: Queued): string {
  const r = item.result;
  const f = item.fields;
  const bits: string[] = [];
  const pn = r?.part_number || f.part_number;
  if (pn) bits.push(pn);
  const aisle = r?.aisle || f.aisle;
  const bin = r?.bin || f.bin;
  if (aisle || bin) bits.push([aisle && `Aisle ${aisle}`, bin && `Bin ${bin}`].filter(Boolean).join(" "));
  const onHand = r?.qty_on_card ?? f.qty_on_card;
  if (onHand != null) bits.push(`card says ${onHand}`);
  const count = r?.count_seen ?? f.count_seen;
  if (count != null) bits.push(`${r?.count_confidence === "low" ? "about " : ""}${count} counted`);
  if (!pn && item.codes.length) bits.push(`code ${item.codes[0]}`);
  if (bits.length) return bits.join(" · ");
  if (item.state === "queued") return "Will be read once uploaded";
  if (r?.status === "pending") return "Uploaded. Photo reading is not switched on yet.";
  if (r?.status === "failed") return r.read_error || "The photo could not be read.";
  return r?.description || "Nothing readable in this photo yet";
}

function badge(item: Queued): { tone: string; text: string } {
  if (item.state === "error") return { tone: "bad", text: "Not accepted" };
  if (item.state === "queued") return { tone: "hold", text: "On this phone" };
  if (item.result?.status === "failed") return { tone: "bad", text: "Needs a look" };
  if (item.result?.status === "pending") return { tone: "muted", text: "Uploaded" };
  return { tone: "ok", text: "Read" };
}

const numberOrNull = (text: string): number | null => {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

function FieldForm({ value, onChange }: { value: Fields; onChange: (next: Fields) => void }) {
  const set = (key: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [key]: e.target.value });
  const num = (key: "qty_on_card" | "count_seen") => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [key]: numberOrNull(e.target.value) });
  return (
    <div className="form">
      <label htmlFor="c-pn">
        Part number
        <input id="c-pn" className="mono" autoComplete="off" autoCapitalize="characters" value={value.part_number ?? ""} onChange={set("part_number")} />
      </label>
      <div className="two">
        <label htmlFor="c-aisle">
          Aisle
          <input id="c-aisle" autoComplete="off" value={value.aisle ?? ""} onChange={set("aisle")} />
        </label>
        <label htmlFor="c-bin">
          Bin
          <input id="c-bin" autoComplete="off" value={value.bin ?? ""} onChange={set("bin")} />
        </label>
      </div>
      <div className="two">
        <label htmlFor="c-card">
          On hand, per the card
          <input id="c-card" inputMode="numeric" autoComplete="off" value={value.qty_on_card ?? ""} onChange={num("qty_on_card")} />
        </label>
        <label htmlFor="c-count">
          Counted in the bin
          <input id="c-count" inputMode="numeric" autoComplete="off" value={value.count_seen ?? ""} onChange={num("count_seen")} />
        </label>
      </div>
      <label htmlFor="c-desc">
        Description
        <input id="c-desc" autoComplete="off" value={value.description ?? ""} onChange={set("description")} />
      </label>
      <label htmlFor="c-notes">
        Notes
        <input id="c-notes" autoComplete="off" value={value.notes ?? ""} onChange={set("notes")} />
      </label>
    </div>
  );
}

const fieldsOf = (item: Queued): Fields => {
  const r = item.result;
  if (!r) return item.fields;
  return {
    part_number: r.part_number,
    aisle: r.aisle,
    bin: r.bin,
    qty_on_card: r.qty_on_card,
    count_seen: r.count_seen,
    description: r.description,
    notes: r.notes,
  };
};

export default function Capture() {
  const [items, setItems] = useState<Queued[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [placeId, setPlaceId] = useState("");
  const [online, setOnline] = useState(true);
  const [offline, setOffline] = useState<Offline>("checking");
  const [signIn, setSignIn] = useState(false);
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Fields>({});
  const [typing, setTyping] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const syncing = useRef(false);
  const inputs = { card: useRef<HTMLInputElement>(null), bin: useRef<HTMLInputElement>(null), code: useRef<HTMLInputElement>(null) };

  const say = useCallback((text: string, bad = false) => setToast({ text, bad, at: Date.now() }), []);
  const clearToast = useCallback(() => setToast(null), []);
  const refresh = useCallback(async () => {
    try {
      setItems(await allItems());
    } catch {
      say("This browser is not letting the page store captures. Leave private browsing and reload.", true);
    }
  }, [say]);

  /** Uploads whatever is waiting, three at a time. Stops quietly when the signal goes. */
  const sync = useCallback(async () => {
    if (syncing.current || !navigator.onLine) return;
    syncing.current = true;
    try {
      const waiting = (await allItems()).filter((i) => i.state === "queued").reverse();
      let halted = false;
      const worker = async () => {
        while (!halted) {
          const next = waiting.shift();
          if (!next) return;
          const result = await sendItem(next);
          if (result === "auth") setSignIn(true);
          if (result === "auth" || result === "retry") halted = true;
          else if (result === "sent") setSignIn(false);
          await refresh();
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      await pruneSent();
    } catch {
      /* storage hiccup; the next pass will pick it up */
    } finally {
      syncing.current = false;
      await refresh();
    }
  }, [refresh]);

  // Start-up: what is on the phone, where we were, and get ready for no signal.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const saved = read<Place[]>("capture.places", []);
      setPlaces(saved);
      setPlaceId(read<string>("capture.place", "") || saved[0]?.id || "");
      setOnline(navigator.onLine);
      await refresh();
      void keepStorage();

      try {
        const res = await fetch("/api/survey?only=locations", { cache: "no-store" });
        if (res.status === 401) setSignIn(true);
        const reply = (await res.json()) as { ok?: boolean; locations?: Place[]; reading?: boolean };
        if (!cancelled && reply.ok && reply.locations) {
          const fromServer = reply.locations.map((l) => ({ id: l.id, name: l.name }));
          const known = new Set(fromServer.map((l) => l.id));
          // Merge with what is on screen right now, not what was there when the request left:
          // a location added in the meantime, or made earlier with no signal, must not vanish.
          setPlaces((current) => {
            const merged = [...fromServer, ...current.filter((l) => l.local && !known.has(l.id))];
            write("capture.places", merged);
            return merged;
          });
          setPlaceId((cur) => cur || fromServer[0]?.id || "");
          setReading(reply.reading !== false);
        }
      } catch {
        /* no signal: carry on with what the phone remembers */
      }
      void sync();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [refresh, sync]);

  useEffect(() => {
    const up = () => {
      setOnline(true);
      void sync();
    };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    const timer = setInterval(() => void sync(), 20_000);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      clearInterval(timer);
    };
  }, [sync]);

  // Offline copy of this page: ask the service worker to store it and its scripts.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      const t = setTimeout(() => setOffline("unsupported"), 0);
      return () => clearTimeout(t);
    }
    const heard = (event: MessageEvent) => {
      const data = event.data as { type?: string; ready?: boolean } | null;
      if (data?.type === "stored") setOffline(data.ready ? "ready" : "partial");
    };
    navigator.serviceWorker.addEventListener("message", heard);
    let cancelled = false;
    (async () => {
      try {
        await navigator.serviceWorker.register("/sw.js", { scope: "/capture" });
        const reg = await navigator.serviceWorker.ready;
        await warmDecoder();
        if (cancelled) return;
        const urls = new Set<string>(["/capture"]);
        const add = (href: string | null) => {
          if (!href) return;
          const u = new URL(href, location.href);
          if (u.origin === location.origin && u.pathname.startsWith("/_next/static/")) urls.add(u.pathname + u.search);
        };
        document.querySelectorAll<HTMLScriptElement>("script[src]").forEach((el) => add(el.src));
        document.querySelectorAll<HTMLLinkElement>("link[href]").forEach((el) => add(el.href));
        performance.getEntriesByType("resource").forEach((entry) => add(entry.name));
        setOffline("storing");
        reg.active?.postMessage({ type: "store", urls: [...urls] });
      } catch {
        if (!cancelled) setOffline("unsupported");
      }
    })();
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("message", heard);
    };
  }, []);

  // If the remembered location is gone (deleted in the back office), fall back to the first one.
  const place = places.find((p) => p.id === placeId) ?? places[0] ?? null;

  function choosePlace(id: string) {
    setPlaceId(id);
    write("capture.place", id);
  }

  function addPlace() {
    const name = (naming ?? "").trim().slice(0, 60);
    if (!name) return;
    const made: Place = { id: newId(), name, local: true };
    setPlaces((current) => {
      const next = [...current, made];
      write("capture.places", next);
      return next;
    });
    choosePlace(made.id);
    setNaming(null);
    // Tell the server now if we can; otherwise it learns the name with the first capture.
    fetch("/api/survey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "location.create", id: made.id, name }),
    }).catch(() => undefined);
  }

  async function save(kind: CaptureKind, file: Blob | null, fields: Fields) {
    if (!place) {
      say("Choose or add a location first.", true);
      return;
    }
    setBusy(true);
    try {
      const photo = file ? await prepare(file, kind !== "card") : null;
      const item: Queued = {
        id: newId(),
        location_id: place.id,
        location_name: place.name,
        kind,
        captured_at: new Date().toISOString(),
        fields,
        codes: photo?.codes ?? [],
        bytes: photo?.bytes ?? null,
        type: photo?.type ?? "",
        thumb: photo?.thumb ?? "",
        state: "queued",
        message: "",
        result: null,
        tries: 0,
      };
      await putItem(item);
      await refresh();
      if (kind === "code") {
        say(item.codes.length ? `Found ${item.codes[0]}` : "No code found in that photo. Saved anyway; it will be read after upload.", !item.codes.length);
      } else {
        say(navigator.onLine ? "Saved. Uploading…" : "Saved on this phone.");
      }
      void sync();
    } catch {
      say("That capture could not be saved. The phone may be out of storage.", true);
    }
    setBusy(false);
  }

  const snap = (kind: "card" | "bin" | "code") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (file) void save(kind, file, {});
  };

  const open = items.find((i) => i.id === openId) ?? null;

  function show(item: Queued) {
    setDraft(fieldsOf(item));
    setConfirmDrop(false);
    setOpenId(item.id);
  }

  async function saveFix() {
    if (!open) return;
    if (open.state !== "sent") {
      await putItem({ ...open, fields: draft, state: "queued", message: "" });
      await refresh();
      setOpenId(null);
      void sync();
      return;
    }
    try {
      const res = await fetch("/api/survey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "capture.update", id: open.id, location_id: open.location_id, fields: draft }),
      });
      const reply = (await res.json()) as { ok?: boolean; message?: string };
      if (!reply.ok) {
        say(reply.message ?? "That change did not save.", true);
        return;
      }
      const result = { ...(open.result as Saved), ...draft, status: "read", edited: true } as Saved;
      await putItem({ ...open, result });
      await refresh();
      setOpenId(null);
      say("Saved.");
    } catch {
      say("No signal. Uploaded captures can be corrected once you are back online.", true);
    }
  }

  async function drop() {
    if (!open) return;
    if (!confirmDrop) {
      setConfirmDrop(true);
      return;
    }
    if (open.state === "sent") {
      try {
        await fetch("/api/survey", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "capture.delete", id: open.id, location_id: open.location_id }),
        });
      } catch {
        say("No signal. Delete uploaded captures from the back office, or try again online.", true);
        return;
      }
    }
    await removeItem(open.id);
    await refresh();
    setOpenId(null);
  }

  const here = items.filter((i) => i.location_id === place?.id);
  const waiting = items.filter((i) => i.state === "queued").length;
  const offlineText: Record<Offline, string> = {
    checking: "Getting ready for offline use…",
    storing: "Getting ready for offline use…",
    ready: "Ready for offline use",
    partial: "Offline copy incomplete. Reload with signal.",
    unsupported: "This browser cannot open the page offline",
  };

  return (
    <>
      <header className="top">
        <div className="wrap">
          <a className="brand" href="/capture">
            Capture
          </a>
          <nav aria-label="Capture">
            <a href="/admin">Back office</a>
          </nav>
        </div>
      </header>
      <main className="wrap cap">
        <div className="cap-status" role="status">
          <span className={`pill ${online ? "ok" : "hold"}`}>{online ? "Online" : "No signal"}</span>
          <span className={`pill ${waiting ? "hold" : "muted"}`}>
            {waiting ? `${waiting} waiting to upload` : "Nothing waiting"}
          </span>
          <span className={`pill ${offline === "ready" ? "ok" : offline === "partial" || offline === "unsupported" ? "bad" : "muted"}`}>
            {offlineText[offline]}
          </span>
        </div>
        {signIn && (
          <p className="warn" role="alert">
            Your sign-in has run out. Captures are safe on this phone. <a href="/admin">Sign in again</a> when you have
            signal and they will upload.
          </p>
        )}
        {!reading && online && (
          <p className="hint">
            Photos are being saved but not read yet: add ANTHROPIC_API_KEY in Vercel and redeploy to switch reading on.
          </p>
        )}

        <div className="cap-place">
          <label htmlFor="place" className="lbl">
            Location
          </label>
          {naming === null ? (
            <div className="inline">
              <select id="place" className="field" value={place?.id ?? ""} onChange={(e) => choosePlace(e.target.value)}>
                {places.length === 0 && <option value="">Add a location to begin</option>}
                {places.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button type="button" className="btn ghost sm" onClick={() => setNaming("")}>
                New
              </button>
            </div>
          ) : (
            <form
              className="inline"
              onSubmit={(e) => {
                e.preventDefault();
                addPlace();
              }}
            >
              <input
                id="place"
                className="field"
                placeholder="Shop or room name"
                autoFocus
                maxLength={60}
                value={naming}
                onChange={(e) => setNaming(e.target.value)}
              />
              <button type="submit" className="btn sm">
                Add
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setNaming(null)}>
                Cancel
              </button>
            </form>
          )}
        </div>

        <div className="cap-grid">
          <button type="button" className="cap-btn" disabled={busy || !place} onClick={() => inputs.card.current?.click()}>
            <b>Inventory card</b>
            <span>Part number, on hand, aisle and bin</span>
          </button>
          <button type="button" className="cap-btn" disabled={busy || !place} onClick={() => inputs.bin.current?.click()}>
            <b>Parts bin</b>
            <span>Counts the parts, reads any label</span>
          </button>
          <button type="button" className="cap-btn" disabled={busy || !place} onClick={() => inputs.code.current?.click()}>
            <b>Scan a code</b>
            <span>Barcode, UPC or QR</span>
          </button>
          <button
            type="button"
            className="cap-btn"
            disabled={busy || !place}
            onClick={() => {
              setDraft({});
              setTyping(true);
            }}
          >
            <b>Type it in</b>
            <span>No photo needed</span>
          </button>
        </div>
        {(["card", "bin", "code"] as const).map((kind) => (
          <input
            key={kind}
            ref={inputs[kind]}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            aria-label={`Take a photo: ${KIND[kind]}`}
            onChange={snap(kind)}
          />
        ))}
        {busy && <p className="hint">Saving…</p>}

        <h2 className="cap-h">
          Captured here <span>{here.length}</span>
        </h2>
        {here.length === 0 ? (
          <p className="empty">Nothing captured at this location on this phone yet.</p>
        ) : (
          <ul className="cap-list">
            {here.map((item) => {
              const b = badge(item);
              return (
                <li key={item.id}>
                  <button type="button" className="cap-row" onClick={() => show(item)}>
                    <span className="thumb">
                      {/* eslint-disable-next-line @next/next/no-img-element -- a preview already stored on the phone */}
                      {item.thumb ? <img src={item.thumb} alt="" /> : <span className="cap-none">Aa</span>}
                    </span>
                    <span className="cap-info">
                      <strong>
                        {KIND[item.kind]} <small>{time(item.captured_at)}</small>
                      </strong>
                      <span>{item.state === "error" ? item.message : summary(item)}</span>
                    </span>
                    <span className={`pill ${b.tone}`}>{b.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      <Modal
        open={typing}
        onClose={() => setTyping(false)}
        title="Type it in"
        footer={
          <>
            <button type="button" className="btn ghost" onClick={() => setTyping(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              disabled={!(draft.part_number || draft.bin)}
              onClick={() => {
                setTyping(false);
                void save("manual", null, draft);
              }}
            >
              Save
            </button>
          </>
        }
      >
        <p className="hint">A part number or a bin is enough. It will be matched with photos of the same part.</p>
        <FieldForm value={draft} onChange={setDraft} />
      </Modal>

      <Modal
        open={!!open}
        onClose={() => setOpenId(null)}
        title={open ? KIND[open.kind] : "Capture"}
        footer={
          <>
            <button type="button" className="btn danger" onClick={drop}>
              {confirmDrop ? "Tap again to delete" : "Delete"}
            </button>
            <button type="button" className="btn" onClick={saveFix}>
              Save
            </button>
          </>
        }
      >
        {open && (
          <>
            {(open.result?.photo_url || open.thumb) && (
              // eslint-disable-next-line @next/next/no-img-element -- the capture's own photo
              <img className="cap-photo" src={(online && open.result?.photo_url) || open.thumb} alt="The captured photo" />
            )}
            <p className="hint">
              {time(open.captured_at)}
              {open.codes.length ? ` · code ${open.codes.join(", ")}` : ""}
              {open.result?.count_note ? ` · ${open.result.count_note}` : ""}
            </p>
            {open.state === "error" && <p className="err">{open.message}</p>}
            {open.result?.status === "failed" && <p className="err">{open.result.read_error}</p>}
            <FieldForm value={draft} onChange={setDraft} />
          </>
        )}
      </Modal>
      <Toast toast={toast} clear={clearToast} />
    </>
  );
}
