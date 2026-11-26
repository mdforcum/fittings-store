"use client";
// "What are you working on?" Pick a machine from the lineup, or type the
// serial off its plate and let the store say which machine and year it is.
// The choice is kept in this browser only.
import { useEffect, useMemo, useState } from "react";
import { MACHINE_KINDS, machineLabel } from "@/lib/foundation";
import type { Garage, MyMachine } from "@/lib/browse";
import { Modal } from "./ui";

type Listed = { id: string; make: string; kind: string; series: string; model: string; year_from: number | null; year_to: number | null };
type Match = { machine_id: string; make: string; model: string; series: string; year: number | null; sentence: string; confirmed: boolean };

export default function MachinePicker({
  open,
  onClose,
  garage,
  onPick,
  onSwitch,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  garage: Garage;
  onPick: (m: MyMachine) => void;
  onSwitch: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [way, setWay] = useState<"list" | "serial">("list");
  const [list, setList] = useState<Listed[] | null>(null);
  const [listError, setListError] = useState("");
  const [kind, setKind] = useState("");
  const [make, setMake] = useState("");
  const [find, setFind] = useState("");
  const [serial, setSerial] = useState("");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [serialNote, setSerialNote] = useState("");
  const [narrow, setNarrow] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || list) return;
    let gone = false;
    fetch("/api/machines?list=1")
      .then((r) => r.json())
      .then((b: { ok: boolean; machines?: Listed[]; message?: string }) => {
        if (gone) return;
        if (b.ok) setList(b.machines ?? []);
        else setListError(b.message ?? "The machine list could not be loaded.");
      })
      .catch(() => !gone && setListError("No connection. Try again."));
    return () => {
      gone = true;
    };
  }, [open, list]);

  const kinds = useMemo(() => MACHINE_KINDS.filter((k) => (list ?? []).some((m) => m.kind === k.id)), [list]);
  const makes = useMemo(() => [...new Set((list ?? []).filter((m) => !kind || m.kind === kind).map((m) => m.make))].sort(), [list, kind]);
  const needle = find.trim().toLowerCase();
  const shown = (list ?? [])
    .filter((m) => (!kind || m.kind === kind) && (!make || m.make === make))
    .filter((m) => !needle || machineLabel(m).toLowerCase().includes(needle))
    .slice(0, 80);

  async function check() {
    setBusy(true);
    setSerialNote("");
    setMatches(null);
    try {
      const r = await fetch(`/api/machines?serial=${encodeURIComponent(serial.trim())}`);
      const b = (await r.json()) as { ok: boolean; message?: string; matches?: Match[] };
      if (!b.ok) setSerialNote(b.message ?? "That did not work.");
      else if (!b.matches?.length) setSerialNote("We don't have that serial on our list yet. Pick the machine instead, and keep the serial: we'll still use it.");
      else {
        setNarrow("");
        setMatches(b.matches);
      }
    } catch {
      setSerialNote("No connection. Try again.");
    }
    setBusy(false);
  }

  const pickListed = (m: Listed) => onPick({ id: m.id, label: `${m.make} ${m.model}`, serial: serial.trim() });

  return (
    <Modal open={open} onClose={onClose} title="Your machine">
      <div className="mp">
        {garage.machines.length > 0 && (
          <section>
            <h3>Saved on this device</h3>
            <ul className="mp-saved">
              {garage.machines.map((m) => (
                <li key={m.id}>
                  <label>
                    <input type="radio" name="mp-active" checked={garage.active === m.id} onChange={() => onSwitch(m.id)} />
                    <span>
                      {m.label}
                      {m.serial && <small className="hint"> · serial {m.serial}</small>}
                    </span>
                  </label>
                  <button type="button" className="linkbtn" onClick={() => onRemove(m.id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="chips" role="group" aria-label="How to find your machine">
          <button type="button" className="chip" aria-pressed={way === "list"} onClick={() => setWay("list")}>
            Pick from the list
          </button>
          <button type="button" className="chip" aria-pressed={way === "serial"} onClick={() => setWay("serial")}>
            Type the serial
          </button>
        </div>

        {way === "serial" ? (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (serial.trim()) void check();
            }}
          >
            <label htmlFor="mp-serial">
              Serial number or PIN, from the plate on the machine
              <input id="mp-serial" autoComplete="off" value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="e.g. JJG0213787" />
            </label>
            <button type="submit" className="btn" disabled={busy || !serial.trim()}>
              {busy ? "Checking…" : "Find my machine"}
            </button>
            {serialNote && (
              <p className="hint" role="status">
                {serialNote}
              </p>
            )}
            {matches && matches.length > 8 && (
              <label htmlFor="mp-narrow">
                {matches.length} models share this serial numbering. Type your model to narrow it down
                <input id="mp-narrow" autoComplete="off" value={narrow} onChange={(e) => setNarrow(e.target.value)} placeholder="e.g. 580B" />
              </label>
            )}
            {matches && (
              <ul className="mp-list" role="status">
                {matches.length > 1 && matches.length <= 8 && <li className="hint">This numbering is shared by several models. Pick the one on your plate.</li>}
                {matches
                  .filter((m) => !narrow.trim() || `${m.make} ${m.model} ${m.series}`.toLowerCase().includes(narrow.trim().toLowerCase()))
                  .map((m) => (
                  <li key={m.machine_id}>
                    <button
                      type="button"
                      className="mp-row"
                      onClick={() => onPick({ id: m.machine_id, label: `${m.make} ${m.model}`, serial: serial.trim() })}
                    >
                      <strong>{m.sentence}</strong>
                      {m.series && <small className="hint">{m.series}</small>}
                    </button>
                  </li>
                  ))}
              </ul>
            )}
          </form>
        ) : listError ? (
          <p className="err" role="alert">
            {listError}
          </p>
        ) : !list ? (
          <p className="hint">Loading the machine list…</p>
        ) : list.length === 0 ? (
          <p className="hint">The machine list is being set up. Search by part number for now.</p>
        ) : (
          <div className="form">
            <div className="two">
              <label htmlFor="mp-kind">
                Kind
                <select
                  id="mp-kind"
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    setMake("");
                  }}
                >
                  <option value="">Any kind</option>
                  {kinds.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="mp-make">
                Make
                <select id="mp-make" value={make} onChange={(e) => setMake(e.target.value)}>
                  <option value="">Any make</option>
                  {makes.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label htmlFor="mp-find">
              Model
              <input id="mp-find" autoComplete="off" placeholder="e.g. 1066, 580 Super M, 320D" value={find} onChange={(e) => setFind(e.target.value)} />
            </label>
            <ul className="mp-list">
              {shown.map((m) => (
                <li key={m.id}>
                  <button type="button" className="mp-row" onClick={() => pickListed(m)}>
                    <strong>{machineLabel(m)}</strong>
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="hint">No machine matches. Try fewer letters, or type the serial instead.</li>}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
