"use client";
// Back office: the machine lineup. The shop's machine picker and every "fits"
// row point at these. Add one at a time, or paste a whole lineup.
import { useCallback, useEffect, useMemo, useState } from "react";
import { MACHINE_KINDS, machineLabel, type Machine, type MachineKind } from "@/lib/foundation";
import type { Say } from "../Admin";
import { Modal } from "../ui";

type Row = Machine & { parts: number };
type Form = {
  id?: string;
  make: string;
  kind: MachineKind | "";
  series: string;
  model: string;
  year_from: string;
  year_to: string;
  prefixes: string;
  breaks: Array<{ serial: string; note: string }>;
  notes: string;
};

const EMPTY: Form = { make: "", kind: "", series: "", model: "", year_from: "", year_to: "", prefixes: "", breaks: [], notes: "" };

const kindLabel = (k: string) => MACHINE_KINDS.find((m) => m.id === k)?.label ?? k;

async function post(body: Record<string, unknown>): Promise<Record<string, unknown> & { ok: boolean; message?: string }> {
  try {
    const r = await fetch("/api/catalog", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as Record<string, unknown> & { ok: boolean; message?: string };
  } catch {
    return { ok: false, message: "No connection. Try again." };
  }
}

export default function Machines({ say }: { say: Say }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [setup, setSetup] = useState(false);
  const [make, setMake] = useState("");
  const [editing, setEditing] = useState<Form | null>(null);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState("");
  const [pasteNote, setPasteNote] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/catalog?machines=1", { cache: "no-store" });
      const body = (await r.json()) as { ok: boolean; message?: string; setup?: boolean; machines?: Row[] };
      if (!body.ok) {
        setError(body.message ?? "Could not load.");
        setSetup(Boolean(body.setup));
      } else {
        setError("");
        setRows(body.machines ?? []);
      }
    } catch {
      setError("No connection.");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const makes = useMemo(() => [...new Set((rows ?? []).map((r) => r.make))], [rows]);
  const shown = (rows ?? []).filter((r) => !make || r.make === make);
  const groups = MACHINE_KINDS.map((k) => ({ ...k, rows: shown.filter((r) => r.kind === k.id) })).filter((g) => g.rows.length);

  function edit(r?: Row) {
    setFormError("");
    setEditing(
      r
        ? {
            id: r.id,
            make: r.make,
            kind: r.kind,
            series: r.series,
            model: r.model,
            year_from: r.year_from ? String(r.year_from) : "",
            year_to: r.year_to ? String(r.year_to) : "",
            prefixes: r.serial_prefixes.join(", "),
            breaks: r.serial_breaks,
            notes: r.notes,
          }
        : { ...EMPTY, make: make || "" },
    );
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setFormError("");
    const res = await post({
      action: "machine.save",
      machine: {
        id: editing.id,
        make: editing.make,
        kind: editing.kind,
        series: editing.series,
        model: editing.model,
        year_from: editing.year_from,
        year_to: editing.year_to,
        serial_prefixes: editing.prefixes,
        serial_breaks: editing.breaks,
        notes: editing.notes,
      },
    });
    setBusy(false);
    if (!res.ok) {
      setFormError(res.message ?? "That did not save.");
      return;
    }
    say(`${editing.make} ${editing.model} saved`);
    setEditing(null);
    await load();
  }

  async function remove(r: Row) {
    const res = await post({ action: "machine.delete", id: r.id });
    say(res.ok ? `${r.make} ${r.model} removed` : (res.message ?? "That did not work."), !res.ok);
    await load();
  }

  async function addPasted() {
    setBusy(true);
    setPasteNote("");
    const res = await post({ action: "machines.add", text: paste });
    setBusy(false);
    if (!res.ok) {
      setPasteNote(res.message ?? "Nothing was added.");
      return;
    }
    const added = Number(res.added ?? 0);
    const skipped = (res.skipped as string[] | undefined) ?? [];
    say(`${added} machine${added === 1 ? "" : "s"} added`);
    setPasteNote(skipped.length ? `Already on the list, left as they were: ${skipped.slice(0, 12).join(", ")}${skipped.length > 12 ? "…" : ""}` : "");
    if (added) setPaste("");
    await load();
  }

  if (error) {
    return (
      <div className={setup ? "det-note" : undefined} role="status">
        {setup && <strong>One setup step first. </strong>}
        {error}
      </div>
    );
  }
  if (!rows) return <p className="hint">Loading…</p>;

  return (
    <div className="mc">
      <div className="lead">
        <p className="eyebrow">Catalog</p>
        <h1>Machines</h1>
        <p className="sub">
          The lineup customers pick from and parts are matched to. {rows.length} machine{rows.length === 1 ? "" : "s"} so far.
        </p>
      </div>

      <div className="inline">
        <button type="button" className="btn" onClick={() => edit()}>
          Add a machine
        </button>
        {makes.length > 1 && (
          <select className="field" aria-label="Show make" value={make} onChange={(e) => setMake(e.target.value)}>
            <option value="">Every make</option>
            {makes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
      </div>

      {groups.length === 0 && <p className="empty">No machines yet. Add one, or paste a lineup below.</p>}
      {groups.map((g) => (
        <section key={g.id} className="mc-group">
          <h2>{g.label}</h2>
          <ul className="mc-list">
            {g.rows.map((r) => (
              <li key={r.id}>
                <span>
                  <strong>{machineLabel(r)}</strong>
                  <small className="hint">
                    {r.serial_prefixes.length ? `Prefixes ${r.serial_prefixes.join(", ")} · ` : ""}
                    {r.serial_breaks.length ? `${r.serial_breaks.length} serial break${r.serial_breaks.length === 1 ? "" : "s"} · ` : ""}
                    {r.parts} part{r.parts === 1 ? "" : "s"} listed
                  </small>
                </span>
                <span className="inline">
                  <button type="button" className="btn ghost sm" onClick={() => edit(r)}>
                    Edit
                  </button>
                  <button type="button" className="btn ghost sm" disabled={r.parts > 0} title={r.parts ? "Parts list this machine" : undefined} onClick={() => remove(r)}>
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section className="mc-paste">
        <h2>Paste a lineup</h2>
        <p className="hint">
          One machine per line: make, kind, series, model, first year, last year, serial prefixes. Everything after the model can be
          left off; separate several serial prefixes with spaces. Machines already on the list are skipped, never changed.
        </p>
        <pre className="hint">
          Case IH, tractor, 66 series, 1066{"\n"}Case, backhoe, 580 series, 580 Super N{"\n"}Cat, dozer, D series, D6T
        </pre>
        <label className="sr" htmlFor="mc-paste">
          Machines to add
        </label>
        <textarea id="mc-paste" rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} />
        {pasteNote && <p className="hint" role="status">{pasteNote}</p>}
        <button type="button" className="btn" disabled={busy || !paste.trim()} onClick={addPasted}>
          {busy ? "Adding…" : "Add these machines"}
        </button>
      </section>

      {editing && (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={editing.id ? `${editing.make} ${editing.model}` : "Add a machine"}
          footer={
            <>
              {formError && (
                <p className="err" role="alert" style={{ marginRight: "auto" }}>
                  {formError}
                </p>
              )}
              <button type="button" className="btn ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="button" className="btn" disabled={busy} onClick={save}>
                {busy ? "Saving…" : "Save machine"}
              </button>
            </>
          }
        >
          <div className="form det">
            <div className="two">
              <label htmlFor="m-make">
                Make
                <input id="m-make" maxLength={40} placeholder="Case IH" value={editing.make} onChange={(e) => setEditing({ ...editing, make: e.target.value })} />
              </label>
              <label htmlFor="m-kind">
                Kind
                <select id="m-kind" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as MachineKind })}>
                  <option value="">Pick one</option>
                  {MACHINE_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {kindLabel(k.id)}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="m-series">
                Series
                <input id="m-series" maxLength={40} placeholder="66 series" value={editing.series} onChange={(e) => setEditing({ ...editing, series: e.target.value })} />
              </label>
              <label htmlFor="m-model">
                Model
                <input id="m-model" maxLength={40} placeholder="1066" value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })} />
              </label>
              <label htmlFor="m-from">
                First year
                <input id="m-from" inputMode="numeric" maxLength={4} value={editing.year_from} onChange={(e) => setEditing({ ...editing, year_from: e.target.value })} />
              </label>
              <label htmlFor="m-to">
                Last year
                <input id="m-to" inputMode="numeric" maxLength={4} placeholder="Still built" value={editing.year_to} onChange={(e) => setEditing({ ...editing, year_to: e.target.value })} />
              </label>
            </div>
            <label htmlFor="m-prefixes">
              Serial prefixes
              <input
                id="m-prefixes"
                autoComplete="off"
                placeholder="Cat machines: three characters each, separated by commas"
                value={editing.prefixes}
                onChange={(e) => setEditing({ ...editing, prefixes: e.target.value.toUpperCase() })}
              />
            </label>
            <section>
              <h3>Serial breaks</h3>
              <p className="hint">Where the maker changed parts partway through the model. Parts lists ask for the serial when it matters.</p>
              {editing.breaks.map((b, i) => (
                <div className="det-fit-top" key={i}>
                  <input
                    aria-label="Serial where the change starts"
                    placeholder="Serial"
                    maxLength={40}
                    value={b.serial}
                    onChange={(e) => setEditing({ ...editing, breaks: editing.breaks.map((x, j) => (j === i ? { ...x, serial: e.target.value } : x)) })}
                  />
                  <input
                    aria-label="What changed"
                    placeholder="What changed"
                    maxLength={200}
                    value={b.note}
                    onChange={(e) => setEditing({ ...editing, breaks: editing.breaks.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)) })}
                  />
                  <button type="button" className="x" aria-label="Remove break" onClick={() => setEditing({ ...editing, breaks: editing.breaks.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                </div>
              ))}
              <button type="button" className="btn ghost sm" onClick={() => setEditing({ ...editing, breaks: [...editing.breaks, { serial: "", note: "" }] })}>
                Add a serial break
              </button>
            </section>
            <label htmlFor="m-notes">
              Notes
              <textarea id="m-notes" rows={2} maxLength={400} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
