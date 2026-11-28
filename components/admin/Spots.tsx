"use client";
// Back office: where parts sit. A tree of shelf spots the shop names and
// codes for itself (location, building, area, aisle, section, bin, sub-bins),
// and the spot each item sits in. The part page prints the spot's line and code.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Product } from "@/lib/catalog";
import { LEVELS, findIt, nextLevel, normCode, treeRows, type Spot } from "@/lib/shelf";
import type { Say } from "../Admin";

type State = { spots: Spot[]; placed: Array<{ id: string; spot_id: string }> };
type Draft = { id: string | null; parent_id: string | null; level: string; code: string; label: string; sort: number };

async function call(body?: Record<string, unknown>): Promise<{ ok: boolean; message?: string } & Partial<State>> {
  try {
    const r = body
      ? await fetch("/api/spots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      : await fetch("/api/spots", { cache: "no-store" });
    return (await r.json()) as { ok: boolean; message?: string } & Partial<State>;
  } catch {
    return { ok: false, message: "No connection. Try again." };
  }
}

export default function Spots({ products, say }: { products: Product[]; say: Say }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [find, setFind] = useState("");

  const load = useCallback(async () => {
    const body = await call();
    if (!body.ok) return setError(body.message ?? "Could not load.");
    setError("");
    setState({ spots: body.spots ?? [], placed: body.placed ?? [] });
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    return () => clearTimeout(first);
  }, [load]);

  const rows = useMemo(() => treeRows(state?.spots ?? []), [state]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of state?.placed ?? []) m.set(p.spot_id, (m.get(p.spot_id) ?? 0) + 1);
    return m;
  }, [state]);
  const spotOf = useMemo(() => new Map((state?.placed ?? []).map((p) => [p.id, p.spot_id])), [state]);

  async function save() {
    if (!draft) return;
    const res = await call({ action: "spot.save", ...draft });
    if (!res.ok) return say(res.message ?? "That did not save.", true);
    say(draft.id ? "Spot saved" : "Spot added");
    setDraft(null);
    await load();
  }

  async function remove(s: Spot) {
    const res = await call({ action: "spot.delete", id: s.id });
    say(res.ok ? "Spot removed" : (res.message ?? "That did not remove."), !res.ok);
    if (res.ok) await load();
  }

  async function assign(p: Product, spotId: string) {
    const res = await call({ action: "spot.assign", product_id: p.id, spot_id: spotId || null });
    say(res.ok ? (spotId ? `${p.name} placed` : `${p.name} taken off the shelf map`) : (res.message ?? "That did not save."), !res.ok);
    if (res.ok) await load();
  }

  if (error) return <p className="err">{error}</p>;
  if (!state) return <p className="hint">Loading…</p>;

  const q = find.trim().toLowerCase();
  const shown = q
    ? products.filter((p) => p.name.toLowerCase().includes(q) || p.part_number.toLowerCase().includes(q)).slice(0, 30)
    : [];
  const preview = draft
    ? findIt(
        [...state.spots.filter((s) => s.id !== draft.id), { ...draft, id: draft.id ?? "new", code: normCode(draft.code) ?? (draft.code || "?") }],
        draft.id ?? "new",
      )
    : null;

  return (
    <div className="hs">
      <div className="lead">
        <p className="eyebrow">Shelf map</p>
        <h1>Where parts sit</h1>
        <p className="sub">
          Build the map from the top: location, building, area, aisle, section, bin. Name each level your way and give it a short code. The part page
          shows the whole line, so a customer and the counter look in the same place.
        </p>
      </div>

      <div className="inline">
        <button type="button" className="btn" onClick={() => setDraft({ id: null, parent_id: null, level: LEVELS[0], code: "", label: "", sort: 0 })}>
          Add a location
        </button>
        <a className="btn ghost" href="/admin/labels" target="_blank" rel="noopener">
          Print bin labels
        </a>
      </div>

      {draft && (
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h2>{draft.id ? "Change spot" : "New spot"}</h2>
          <label htmlFor="sp-level">Level</label>
          <input id="sp-level" className="field" list="sp-levels" value={draft.level} maxLength={24} onChange={(e) => setDraft({ ...draft, level: e.target.value })} />
          <datalist id="sp-levels">
            {LEVELS.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
          <label htmlFor="sp-code">Code (1 to 6 letters or digits)</label>
          <input id="sp-code" className="field" value={draft.code} maxLength={6} autoCapitalize="characters" onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
          <label htmlFor="sp-label">Name in plain words (optional)</label>
          <input
            id="sp-label"
            className="field"
            value={draft.label}
            maxLength={60}
            placeholder={`${draft.level || "Level"} ${draft.code || ""}`.trim()}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
          {preview && (
            <p className="hint">
              Shows as: {preview.line} · Code {preview.code}
            </p>
          )}
          <div className="inline">
            <button type="submit" className="btn">
              Save
            </button>
            <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {rows.length === 0 && <p className="empty">No spots yet. Start with a location.</p>}
      <ul className="hs-list">
        {rows.map((r) => (
          <li key={r.spot.id} className="hs-item" style={{ marginLeft: `${r.depth * 16}px` }}>
            <div className="hs-head">
              <strong>
                {r.spot.label || `${r.spot.level} ${r.spot.code}`} <span className="mono">{r.code}</span>
              </strong>
              <span className="hint">
                {r.spot.level}
                {counts.get(r.spot.id) ? ` · ${counts.get(r.spot.id)} item${counts.get(r.spot.id) === 1 ? "" : "s"}` : ""}
              </span>
            </div>
            <div className="inline">
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setDraft({ id: null, parent_id: r.spot.id, level: nextLevel(r.spot), code: "", label: "", sort: 0 })}
              >
                Add inside
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setDraft({ ...r.spot })}>
                Change
              </button>
              <button type="button" className="btn ghost sm" onClick={() => void remove(r.spot)}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="panel">
        <h2>Place an item</h2>
        <label htmlFor="sp-find">Find an item by name or part number</label>
        <input id="sp-find" className="field" value={find} onChange={(e) => setFind(e.target.value)} placeholder="e.g. 6-6 JIC or 1845C" />
        {q && shown.length === 0 && <p className="hint">No items match.</p>}
        <ul className="hs-list">
          {shown.map((p) => (
            <li key={p.id} className="hs-item">
              <label htmlFor={`sp-${p.id}`}>
                {p.name}
                {p.part_number ? ` · ${p.part_number}` : ""}
              </label>
              <select id={`sp-${p.id}`} className="field" value={spotOf.get(p.id) ?? ""} onChange={(e) => void assign(p, e.target.value)}>
                <option value="">Not placed</option>
                {rows.map((r) => (
                  <option key={r.spot.id} value={r.spot.id}>
                    {r.code} · {r.line}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
