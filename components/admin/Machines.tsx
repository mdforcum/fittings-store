"use client";
// Back office: the machine lineup. The shop's machine picker and every "fits"
// row point at these. Add one at a time, or paste a whole lineup.
import { useCallback, useEffect, useMemo, useState } from "react";
import { MACHINE_KINDS, machineLabel, type Machine, type MachineKind } from "@/lib/foundation";
import { CONFIDENCES } from "@/lib/serials";
import type { Say } from "../Admin";
import { Modal } from "../ui";

type Row = Machine & { parts: number; runs: number };
type Run = { id: string; prefix: string; serial_from: string; serial_to: string; year: number | null; note: string; confidence: string; source: string };
type Match = { machine_id: string; sentence: string; note: string; confirmed: boolean };
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
  const [starter, setStarter] = useState<{ name: string; machines: number } | null>(null);
  const [confirmLoad, setConfirmLoad] = useState(false);
  const [find, setFind] = useState("");
  const [serial, setSerial] = useState("");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [serialNote, setSerialNote] = useState("");
  const [runs, setRuns] = useState<Run[] | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/catalog?machines=1", { cache: "no-store" });
      const body = (await r.json()) as { ok: boolean; message?: string; setup?: boolean; machines?: Row[]; starter?: { name: string; machines: number } };
      if (!body.ok) {
        setError(body.message ?? "Could not load.");
        setSetup(Boolean(body.setup));
      } else {
        setError("");
        setRows(body.machines ?? []);
        setStarter(body.starter ?? null);
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
  const needle = find.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => (!make || r.make === make) && (!needle || machineLabel(r).toLowerCase().includes(needle)));
  const groups = MACHINE_KINDS.map((k) => ({ ...k, rows: shown.filter((r) => r.kind === k.id) })).filter((g) => g.rows.length);

  async function loadStarter() {
    setBusy(true);
    const res = await post({ action: "lineup.import" });
    setBusy(false);
    setConfirmLoad(false);
    if (!res.ok) {
      say(res.message ?? "That did not load.", true);
      return;
    }
    const problems = (res.problems as string[] | undefined) ?? [];
    say(`${res.machines} machines and ${res.runs} serial runs loaded${problems.length ? `; ${problems.length} skipped` : ""}`);
    await load();
  }

  async function checkSerial() {
    setSerialNote("");
    setMatches(null);
    try {
      const r = await fetch(`/api/machines?serial=${encodeURIComponent(serial.trim())}`, { cache: "no-store" });
      const body = (await r.json()) as { ok: boolean; message?: string; matches?: Match[] };
      if (!body.ok) setSerialNote(body.message ?? "That did not work.");
      else {
        setMatches(body.matches ?? []);
        if (!body.matches?.length) setSerialNote("No machine on the list takes that serial. Check the plate, or add the run from the machine's edit screen once you know it.");
      }
    } catch {
      setSerialNote("No connection.");
    }
  }

  async function loadRuns(id: string) {
    setRuns(null);
    try {
      const r = await fetch(`/api/catalog?runs=${encodeURIComponent(id)}`, { cache: "no-store" });
      const body = (await r.json()) as { ok: boolean; runs?: Run[] };
      setRuns(body.ok ? (body.runs ?? []) : []);
    } catch {
      setRuns([]);
    }
  }

  function edit(r?: Row) {
    setFormError("");
    setRuns(null);
    if (r) void loadRuns(r.id);
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

      {starter && (
        <div className="mc-paste">
          <h2>Starter lineup</h2>
          <p className="hint">
            {starter.machines} machines with their serial runs: Case IH row-crop tractors, Case 580 backhoes, Cat 311 to 336 excavators and
            Cat D series dozers, each run with its source. Loading again brings them up to date and replaces only this lineup&rsquo;s runs.
          </p>
          {confirmLoad ? (
            <div className="inline">
              <button type="button" className="btn" disabled={busy} onClick={loadStarter}>
                {busy ? "Loading…" : `Load ${starter.machines} machines`}
              </button>
              <button type="button" className="btn ghost" onClick={() => setConfirmLoad(false)}>
                Cancel
              </button>
              <span className="hint">Machines already on the list keep their parts; their names, years and notes are updated.</span>
            </div>
          ) : (
            <button type="button" className="btn ghost" onClick={() => setConfirmLoad(true)}>
              {rows.length ? "Load or refresh the starter lineup" : "Load the starter lineup"}
            </button>
          )}
        </div>
      )}

      <form
        className="mc-paste"
        onSubmit={(e) => {
          e.preventDefault();
          if (serial.trim()) void checkSerial();
        }}
      >
        <h2>Check a serial</h2>
        <p className="hint">Type the serial or the 17-character PIN from the plate. It tells which machine and year it is.</p>
        <div className="inline">
          <label className="sr" htmlFor="mc-serial">
            Serial number
          </label>
          <input id="mc-serial" className="field" autoComplete="off" placeholder="e.g. 8970281" value={serial} onChange={(e) => setSerial(e.target.value)} />
          <button type="submit" className="btn" disabled={!serial.trim()}>
            Check
          </button>
        </div>
        {serialNote && <p className="hint" role="status">{serialNote}</p>}
        {matches && matches.length > 0 && (
          <ul className="mc-matches" role="status">
            {matches.map((m) => (
              <li key={m.machine_id}>
                <strong>{m.sentence}</strong>
                {m.note && <small className="hint">{m.note}</small>}
              </li>
            ))}
            {matches.length > 1 && <li className="hint">Several machines share this numbering: the model on the plate decides.</li>}
          </ul>
        )}
      </form>

      <div className="inline">
        <button type="button" className="btn" onClick={() => edit()}>
          Add a machine
        </button>
        <label className="sr" htmlFor="mc-find">
          Find a machine
        </label>
        <input id="mc-find" className="field" placeholder="Find a model" value={find} onChange={(e) => setFind(e.target.value)} />
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
                    {r.runs ? `${r.runs} serial run${r.runs === 1 ? "" : "s"} · ` : ""}
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
            {editing.id && (
              <section>
                <h3>Serial runs</h3>
                {runs === null ? (
                  <p className="hint">Loading…</p>
                ) : runs.length === 0 ? (
                  <p className="hint">None yet.</p>
                ) : (
                  <ul className="mc-runs">
                    {runs.slice(0, 60).map((r) => (
                      <li key={r.id}>
                        <span>
                          {r.serial_from && r.serial_to
                            ? `${r.serial_from} to ${r.serial_to}`
                            : r.serial_from
                              ? `${r.serial_from} and up`
                              : r.serial_to
                                ? `Up to ${r.serial_to}`
                                : `Every ${r.prefix} serial`}
                          {r.year ? ` · ${r.year}` : ""}
                        </span>
                        <small className="hint">
                          {CONFIDENCES.find((c) => c.id === r.confidence)?.label ?? r.confidence}
                          {r.source && (
                            <>
                              {" · "}
                              <a href={r.source} target="_blank" rel="noreferrer">
                                source
                              </a>
                            </>
                          )}
                          {r.note ? ` · ${r.note}` : ""}
                        </small>
                      </li>
                    ))}
                    {runs.length > 60 && <li className="hint">and {runs.length - 60} more</li>}
                  </ul>
                )}
              </section>
            )}
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
