"use client";
// Back office: hose requests as they come in, and which places can build hoses.
import { useCallback, useEffect, useState } from "react";
import { buildSheet, cleanBuild } from "@/lib/hose";
import type { Say } from "../Admin";

type Request = {
  id: string;
  number: number;
  tag: string;
  mode: "now" | "shop";
  status: string;
  name: string;
  phone: string;
  email: string;
  zip: string;
  machine: string;
  builder_id: string | null;
  created_at: string;
  build: { tag: string; spec: unknown } | null;
};
type Place = { id: string; name: string; phone: string; hours: string; builds_hoses: boolean; one_hour: boolean; hose_lines: string };

const STATUSES = [
  ["new", "New"],
  ["sent", "Sent to builder"],
  ["building", "Building"],
  ["ready", "Ready"],
  ["done", "Picked up or shipped"],
  ["cancelled", "Cancelled"],
] as const;

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
  try {
    const r = await fetch("/api/hose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as { ok: boolean; message?: string };
  } catch {
    return { ok: false, message: "No connection. Try again." };
  }
}

export default function Hoses({ say }: { say: Say }) {
  const [state, setState] = useState<{ requests: Request[]; places: Place[] } | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/hose?admin=1", { cache: "no-store" });
      const body = (await r.json()) as { ok: boolean; message?: string; requests?: Request[]; places?: Place[] };
      if (!body.ok) setError(body.message ?? "Could not load.");
      else {
        setError("");
        setState({ requests: body.requests ?? [], places: body.places ?? [] });
      }
    } catch {
      setError("No connection.");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  async function setStatus(r: Request, status: string, builder_id?: string) {
    const res = await post({ action: "admin.status", id: r.id, status, builder_id });
    if (!res.ok) say(res.message ?? "That did not save.", true);
    await load();
  }

  async function savePlace(p: Place) {
    const res = await post({ action: "admin.place", place: p });
    say(res.ok ? `${p.name} saved` : (res.message ?? "That did not save."), !res.ok);
    await load();
  }

  if (error) return <p className="err">{error}</p>;
  if (!state) return <p className="hint">Loading…</p>;
  const builders = state.places.filter((p) => p.builds_hoses);
  const waiting = state.requests.filter((r) => r.mode === "now" && (r.status === "new" || r.status === "sent"));

  return (
    <div className="hs">
      <div className="lead">
        <p className="eyebrow">Hydraulic hose</p>
        <h1>Hose requests</h1>
        <p className="sub">
          {waiting.length ? `${waiting.length} machine-down request${waiting.length === 1 ? "" : "s"} waiting.` : "Nothing machine-down waiting."} The
          page checks for new ones every 30 seconds. <a href="/hose">Open the hose builder</a>
        </p>
      </div>

      {state.requests.length === 0 && <p className="empty">No requests yet.</p>}
      <ul className="hs-list">
        {state.requests.map((r) => {
          const build = cleanBuild(r.build?.spec);
          const sheet = buildSheet(build, r.tag);
          return (
            <li key={r.id} className={`hs-item ${r.mode === "now" && r.status === "new" ? "urgent" : ""}`}>
              <div className="hs-head">
                <span className={`pill ${r.mode === "now" ? "bad" : "muted"}`}>{r.mode === "now" ? "Machine down" : "Shop order"}</span>
                <strong>
                  #{r.number} · {sheet.title}
                </strong>
                <span className="hint">
                  {new Date(r.created_at).toLocaleString()} · {r.name || "No name"} ·{" "}
                  {r.phone ? <a href={`tel:${r.phone.replace(/[^\d+]/g, "")}`}>{r.phone}</a> : r.email}
                  {r.zip ? ` · ${r.zip}` : ""}
                  {r.machine ? ` · ${r.machine}` : ""}
                </span>
              </div>
              <div className="inline">
                <label className="sr" htmlFor={`st-${r.id}`}>
                  Status
                </label>
                <select id={`st-${r.id}`} className="field" value={r.status} onChange={(e) => setStatus(r, e.target.value)}>
                  {STATUSES.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
                <label className="sr" htmlFor={`bd-${r.id}`}>
                  Builder
                </label>
                <select id={`bd-${r.id}`} className="field" value={r.builder_id ?? ""} onChange={(e) => setStatus(r, r.status === "new" && e.target.value ? "sent" : r.status, e.target.value)}>
                  <option value="">No builder yet</option>
                  {builders.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn ghost sm" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {open === r.id ? "Hide build sheet" : "Build sheet"}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => navigator.clipboard?.writeText(sheet.text).then(() => say("Build sheet copied"), () => say("Copy did not work", true))}
                >
                  Copy for the builder
                </button>
              </div>
              {open === r.id && (
                <dl className="hs-sheet">
                  {sheet.lines.map((l) => (
                    <div key={l.label}>
                      <dt>{l.label}</dt>
                      <dd>{l.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ul>

      <section className="hs-places">
        <h2>Build points</h2>
        <p className="hint">
          Places with a crimper that can build hoses. Machine-down customers are shown the ones that promise a one-hour build.
          Places come from the survey; add one from the phone page first.
        </p>
        {state.places.length === 0 && <p className="hint">No places yet.</p>}
        {state.places.map((p) => (
          <PlaceRow key={p.id} place={p} onSave={savePlace} />
        ))}
      </section>
    </div>
  );
}

function PlaceRow({ place, onSave }: { place: Place; onSave: (p: Place) => void }) {
  const [p, setP] = useState(place);
  const id = place.id.slice(0, 8);
  return (
    <div className="hs-place">
      <strong>{place.name}</strong>
      <label className="inline" htmlFor={`pb-${id}`}>
        <input id={`pb-${id}`} type="checkbox" checked={p.builds_hoses} onChange={(e) => setP({ ...p, builds_hoses: e.target.checked, one_hour: e.target.checked && p.one_hour })} />
        Builds hoses
      </label>
      <label className="inline" htmlFor={`p1-${id}`}>
        <input id={`p1-${id}`} type="checkbox" disabled={!p.builds_hoses} checked={p.one_hour} onChange={(e) => setP({ ...p, one_hour: e.target.checked })} />
        Promises a build within the hour
      </label>
      <input className="field" aria-label={`Phone, ${place.name}`} placeholder="Phone" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} />
      <input className="field" aria-label={`Hours, ${place.name}`} placeholder="Hours, e.g. Mon–Fri 7–5, Sat 7–noon" value={p.hours} onChange={(e) => setP({ ...p, hours: e.target.value })} />
      <input className="field" aria-label={`Hose lines, ${place.name}`} placeholder="Hose lines they stock" value={p.hose_lines} onChange={(e) => setP({ ...p, hose_lines: e.target.value })} />
      <button type="button" className="btn ghost sm" onClick={() => onSave(p)}>
        Save
      </button>
    </div>
  );
}
