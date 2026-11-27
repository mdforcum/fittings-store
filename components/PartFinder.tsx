"use client";
// One box that finds a part every way a counter or a shelf needs: type a few
// words, type or scan a part number or UPC and press Enter, scan a bin code to
// see everything in that bin, or take a photo. A plug-in barcode scanner works
// as it is: it types the code and presses Enter.
import { useRef, useState } from "react";
import { exactLookup, goesWith, photoMatches, smartSearch, type LookupBin, type LookupIndex, type LookupPart, type PhotoMatch, type PhotoRead } from "@/lib/lookup";
import { prepare } from "@/lib/scan";

export type PhotoReply = { read?: PhotoRead; problem?: string };

type Props = {
  parts: LookupPart[];
  index: LookupIndex;
  /** How many are on the shelf being worked, for ranking and the row text. */
  shelf?: (id: string) => number | undefined;
  onPick: (id: string) => void;
  /** Sends a photo to be read. Leave out to hide photo lookup. */
  photo?: (image: string, type: string) => Promise<PhotoReply>;
  /** Remembers a barcode for a part (back office). Leave out to hide the offer. */
  onLink?: (code: string, id: string) => Promise<boolean>;
  /** Called when a bin code is found, with every part in it. */
  onBin?: (bin: LookupBin) => void;
  /** Called as the box changes, for a screen that filters its own list. */
  onQuery?: (q: string) => void;
  /** Show matches under the box (off when the screen shows its own list). */
  results?: boolean;
  meta?: (id: string) => string;
  label: string;
  inputId: string;
  itemClass?: string;
  pickWord?: string;
};

function toBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export default function PartFinder({ parts, index, shelf, onPick, photo, onLink, onBin, onQuery, results = true, meta, label, inputId, itemClass = "pf-match", pickWord = "Add" }: Props) {
  const [q, setQ] = useState("");
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [bin, setBin] = useState<LookupBin | null>(null);
  const [several, setSeveral] = useState<string[]>([]);
  const [unknown, setUnknown] = useState("");
  const [linking, setLinking] = useState("");
  const [busy, setBusy] = useState("");
  const [seen, setSeen] = useState<{ read: PhotoRead; matches: PhotoMatch[] } | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const part = (id: string) => parts.find((p) => p.id === id);

  function change(v: string) {
    setQ(v);
    onQuery?.(v);
  }
  function clearPanels() {
    setBin(null);
    setSeveral([]);
    setSeen(null);
  }
  function pick(id: string, how = "") {
    if (unknown && onLink && linking !== id) {
      // A barcode nobody has seen before: offer to remember it for this part.
      setLinking(id);
      return;
    }
    onPick(id);
    setNote(how ? { text: `${how}: ${part(id)?.name ?? id}`, bad: false } : null);
    change("");
    clearPanels();
    setUnknown("");
    setLinking("");
    box.current?.focus();
  }

  /** A whole code: from Enter, a scanner, or a barcode found in a photo. Returns true when it meant something. */
  function resolve(code: string, how: string): boolean {
    const hit = exactLookup(code, parts, index);
    if (!hit) return false;
    clearPanels();
    setUnknown("");
    if (hit.kind === "bin") {
      setBin(hit.bin);
      onBin?.(hit.bin);
      setNote({ text: `Bin ${hit.bin.code}: ${hit.bin.product_ids.length} part${hit.bin.product_ids.length === 1 ? "" : "s"}`, bad: false });
      change("");
      return true;
    }
    if (hit.ids.length === 1) pick(hit.ids[0], hit.because || how);
    else {
      setSeveral(hit.ids);
      setNote({ text: `${hit.ids.length} parts share that number. Pick one.`, bad: false });
    }
    return true;
  }

  function enter() {
    const code = q.trim();
    if (!code) return;
    if (resolve(code, "Found")) return;
    const found = smartSearch(code, parts, index, shelf, 2);
    if (found.length === 1) return pick(found[0].id, "Found");
    if (/^\d{6,14}$/.test(code) && onLink) {
      setUnknown(code);
      setNote({ text: `Barcode ${code} isn't linked to a part yet. Find the part below and pick it to link them.`, bad: false });
      change("");
      return;
    }
    if (!found.length) setNote({ text: "Nothing matches that. Check the number, or try a word from the name.", bad: true });
  }

  async function fromPhoto(file: File | undefined) {
    if (!file) return;
    setBusy("photo");
    setNote(null);
    clearPanels();
    try {
      const shot = await prepare(file, true);
      for (const code of shot.codes) {
        if (resolve(code, `Scanned ${code}`)) return;
      }
      if (shot.codes.length && onLink) {
        setUnknown(shot.codes[0]);
        setNote({ text: `Barcode ${shot.codes[0]} isn't linked to a part yet. Find the part below and pick it to link them.`, bad: false });
        return;
      }
      if (!photo) return setNote({ text: shot.codes.length ? `No part has the barcode ${shot.codes[0]}.` : "No barcode found in that photo. Type the number instead.", bad: true });
      const r = await photo(toBase64(shot.bytes), shot.type);
      if (!r.read) return setNote({ text: r.problem ?? "The photo couldn't be read. Type the number instead.", bad: true });
      setSeen({ read: r.read, matches: photoMatches(r.read, parts, index) });
    } catch {
      setNote({ text: "That photo couldn't be opened. Try again.", bad: true });
    } finally {
      setBusy("");
    }
  }

  const found = results && q.trim() ? smartSearch(q, parts, index, shelf) : [];
  const row = (id: string, because: string, key: string) => {
    const p = part(id);
    if (!p) return null;
    return (
      <li key={key}>
        <button type="button" className={itemClass} onClick={() => pick(id)}>
          <span>
            {p.part_number && <span className="mono">{p.part_number} </span>}
            {p.name}
            {because && <span className="hint"> · {because}</span>}
          </span>
          <span className="hint">{meta ? meta(id) : pickWord}</span>
        </button>
      </li>
    );
  };

  return (
    <div className="pf">
      <div className="pf-top">
        <label htmlFor={inputId}>
          {label}
          <input
            id={inputId}
            ref={box}
            type="search"
            autoComplete="off"
            autoCapitalize="characters"
            enterKeyHint="search"
            placeholder="Part number, UPC, bin or name"
            value={q}
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                enter();
              }
            }}
          />
        </label>
        <label className={`btn ghost pf-cam${busy ? " busy" : ""}`}>
          {busy === "photo" ? "Reading…" : photo ? "Photo or barcode" : "Scan barcode"}
          <input type="file" accept="image/*" capture="environment" disabled={!!busy} onChange={(e) => { void fromPhoto(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
      </div>
      <p className="hint pf-help">Type, or scan with a barcode scanner. Enter picks an exact match.</p>
      {note && (
        <p className={note.bad ? "err" : "pf-note"} role={note.bad ? "alert" : "status"}>
          {note.text}
        </p>
      )}

      {linking && onLink && (
        <div className="pf-panel">
          <p>
            Link barcode <b className="mono">{unknown}</b> to <b>{part(linking)?.name}</b>? Next time a scan finds it.
          </p>
          <div className="pf-actions">
            <button
              type="button"
              className="btn"
              disabled={busy === "link"}
              onClick={async () => {
                setBusy("link");
                const ok = await onLink(unknown, linking);
                setBusy("");
                if (ok) {
                  const id = linking;
                  setUnknown("");
                  setLinking("");
                  onPick(id);
                  setNote({ text: `Barcode linked to ${part(id)?.name ?? id}.`, bad: false });
                  change("");
                }
              }}
            >
              {busy === "link" ? "Saving…" : "Link and pick"}
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                const id = linking;
                setUnknown("");
                setLinking("");
                onPick(id);
                change("");
              }}
            >
              Pick without linking
            </button>
          </div>
        </div>
      )}

      {seen && (
        <div className="pf-panel">
          <p>
            <b>A computer read this photo. Check it before you use it.</b>{" "}
            {seen.read.part_number || seen.read.upc || seen.read.description
              ? `It read: ${[seen.read.part_number && `part number ${seen.read.part_number}`, seen.read.upc && `barcode ${seen.read.upc}`, seen.read.description && `"${seen.read.description}"`].filter(Boolean).join(", ")}.`
              : "It couldn't read a number or a name."}
          </p>
          {seen.matches.length ? (
            <ul className="pf-list">{seen.matches.map((m) => row(m.id, `${m.because}${m.why === "words" ? " (a guess)" : ""}`, `photo-${m.id}`))}</ul>
          ) : (
            <p className="hint">No part in the catalog matches that. Type the number or a word from the name.</p>
          )}
        </div>
      )}

      {bin && results && (
        <div className="pf-panel">
          <p>
            <b>Bin {bin.code}</b> <span className="hint">{bin.line}</span> holds {bin.product_ids.length} part{bin.product_ids.length === 1 ? "" : "s"}:
          </p>
          <ul className="pf-list">{bin.product_ids.map((id) => row(id, "", `bin-${id}`))}</ul>
        </div>
      )}
      {several.length > 0 && <ul className="pf-list">{several.map((id) => row(id, "", `several-${id}`))}</ul>}
      {found.length > 0 && <ul className="pf-list" aria-label="Matching parts">{found.map((f) => row(f.id, f.because, f.id))}</ul>}
      {results && q.trim() !== "" && found.length === 0 && <p className="hint">No parts match.</p>}
    </div>
  );
}

/** After a part is picked: the others in its bin, and what sold with it before. */
export function GoesWith({ id, index, parts, skip, onPick, meta }: { id: string; index: LookupIndex; parts: LookupPart[]; skip: Set<string>; onPick: (id: string) => void; meta?: (id: string) => string }) {
  const g = goesWith(id, index, skip);
  const known = (x: string) => parts.some((p) => p.id === x);
  const sameBin = g.sameBin.filter(known).slice(0, 6);
  const soldWith = g.soldWith.filter(known).slice(0, 3);
  if (!sameBin.length && !soldWith.length) return null;
  const chip = (x: string) => {
    const p = parts.find((y) => y.id === x)!;
    return (
      <li key={x}>
        <button type="button" className="pf-chip" onClick={() => onPick(x)}>
          {p.part_number ? `${p.part_number} ` : ""}
          {p.name}
          {meta ? <span className="hint"> · {meta(x)}</span> : null}
        </button>
      </li>
    );
  };
  return (
    <div className="pf-with">
      {soldWith.length > 0 && (
        <>
          <p className="hint">Sold with it before:</p>
          <ul>{soldWith.map(chip)}</ul>
        </>
      )}
      {sameBin.length > 0 && (
        <>
          <p className="hint">Also in bin {g.bin?.code}:</p>
          <ul>{sameBin.map(chip)}</ul>
        </>
      )}
    </div>
  );
}
