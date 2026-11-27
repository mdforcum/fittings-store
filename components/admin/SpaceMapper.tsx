"use client";
// Back office: the Space mapper. Snap or upload photos of a shop with a short
// note on each, let the reader draft the layout file and ask what it could not
// tell, answer, check the layout, and put it on the shelf map. Built for a
// phone in the shop. The file format is in lib/spacemap.ts.
//
// Used in two places: the back office (every dealer's locations) and the dealer
// portal (scope "dealer": only the signed-in dealer's own locations). The
// server decides what each sign-in may see; this screen only shows it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { prepare } from "@/lib/scan";
import { nameAt, outlineRows, parseSpaceMap } from "@/lib/spacemap";
import { MAX_PHOTOS } from "@/lib/spacemap-read";
import type { SpaceMapSummary, SpaceMapView } from "@/lib/spacemap-server";

export type Say = (text: string, bad?: boolean) => void;
export type MapperScope = "admin" | "dealer";
type ListData = { maps: SpaceMapSummary[]; locations: Array<{ id: string; code: string; name: string; dealer: string; mapped: boolean }>; vision: boolean };
type Reply = { ok: boolean; message?: string; map?: SpaceMapView; vision?: boolean; problems?: number; spots?: number; adds?: number; changes?: number } & Partial<ListData>;
type Waiting = { id: string; blob: Blob; thumb: string; note: string };

const EFFORT_WORDS = { near: "a few steps", walk: "a walk", far: "far" } as const;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Talks to the API as the back office or as the signed-in dealer; the server checks the sign-in either way. */
function caller(scope: MapperScope) {
  return async (body?: Record<string, unknown> | FormData, id?: string): Promise<Reply> => {
    try {
      const r = !body
        ? await fetch(`/api/spacemap?scope=${scope}${id ? `&id=${id}` : ""}`, { cache: "no-store" })
        : body instanceof FormData
          ? await fetch("/api/spacemap", { method: "POST", body })
          : await fetch("/api/spacemap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, scope }) });
      return (await r.json()) as Reply;
    } catch {
      return { ok: false, message: "No connection. Try again." };
    }
  };
}

export default function SpaceMapper({ say, scope = "admin" }: { say: Say; scope?: MapperScope }) {
  const call = useMemo(() => caller(scope), [scope]);
  const office = scope === "admin";
  const [list, setList] = useState<ListData | null>(null);
  const [error, setError] = useState("");
  const [map, setMap] = useState<SpaceMapView | null>(null);
  const [vision, setVision] = useState(true);
  const [pick, setPick] = useState("");
  const [text, setText] = useState("");
  const [notes, setNotes] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [busy, setBusy] = useState("");
  const [sure, setSure] = useState(false);
  const sending = useRef(false);
  // The photos still to send, readable from inside a send that is already running.
  const queue = useRef<Waiting[]>([]);
  const setQueue = useCallback((next: (list: Waiting[]) => Waiting[]) => {
    queue.current = next(queue.current);
    setWaiting(queue.current);
  }, []);

  const loadList = useCallback(async () => {
    const body = await call();
    if (!body.ok) return setError(body.message ?? "Could not load.");
    setError("");
    setList({ maps: body.maps ?? [], locations: body.locations ?? [], vision: !!body.vision });
    setVision(!!body.vision);
  }, [call]);

  useEffect(() => {
    const first = setTimeout(() => void loadList(), 0);
    return () => clearTimeout(first);
  }, [loadList]);

  /** Shows a map as the server has it. Typed-in answers are kept unless the questions changed. */
  const show = useCallback((next: SpaceMapView, fresh = false) => {
    setMap(next);
    setText(next.markup);
    setNotes(next.notes);
    setSure(false);
    if (fresh) {
      setAnswers({});
      setSkipped({});
    }
  }, []);

  async function open(id: string) {
    setBusy("open");
    const body = await call(undefined, id);
    setBusy("");
    if (!body.ok || !body.map) return say(body.message ?? "That map could not be loaded.", true);
    setVision(body.vision ?? true);
    setQueue(() => []);
    show(body.map, true);
  }

  async function create(locationId: string) {
    setBusy("create");
    const body = await call({ action: "map.create", location_id: locationId });
    setBusy("");
    if (!body.ok || !body.map) return say(body.message ?? "That did not save.", true);
    setPick("");
    setQueue(() => []);
    show(body.map, true);
  }

  // Photos that have not reached the server yet go one at a time, and wait when there is no signal.
  const flush = useCallback(
    async (mapId: string) => {
      if (sending.current) return;
      sending.current = true;
      setBusy((b) => b || "upload");
      for (let w = queue.current[0]; w; w = queue.current[0]) {
        const form = new FormData();
        form.set("meta", JSON.stringify({ id: mapId, photo_id: w.id, note: w.note, scope }));
        form.set("photo", w.blob);
        const body = await call(form);
        if (!body.ok || !body.map) {
          say(body.message === "No connection. Try again." ? "No signal. The photos are waiting on this page; keep it open." : (body.message ?? "A photo did not save."), true);
          break;
        }
        const sent = w.id;
        const photos = body.map.photos;
        setQueue((list) => list.filter((x) => x.id !== sent));
        setMap((cur) => (cur && cur.id === mapId ? { ...cur, photos } : cur));
      }
      sending.current = false;
      setBusy((b) => (b === "upload" ? "" : b));
    },
    [say, setQueue, call, scope],
  );

  const mapId = map?.id;
  useEffect(() => {
    if (!mapId || !waiting.length) return;
    const retry = () => void flush(mapId);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [mapId, waiting.length, flush]);

  async function addPhotos(files: FileList | null) {
    if (!map || !files?.length) return;
    for (const file of Array.from(files).slice(0, 20)) {
      const p = await prepare(file, false);
      const added: Waiting = { id: crypto.randomUUID(), blob: new Blob([p.bytes], { type: p.type }), thumb: p.thumb, note: "" };
      setQueue((list) => [...list, added]);
    }
    void flush(map.id);
  }

  async function change(body: Record<string, unknown>, done?: string): Promise<boolean> {
    if (!map) return false;
    const res = await call({ ...body, id: map.id });
    if (!res.ok || !res.map) {
      say(res.message ?? "That did not save.", true);
      return false;
    }
    // Keep what is being typed in the file box when the change was about something else.
    setMap(res.map);
    if ("markup" in body || body.action === "apply") setText(res.map.markup);
    if (done) say(done);
    return true;
  }

  async function read() {
    if (!map) return;
    if (text !== map.markup && !(await change({ action: "map.save", markup: text }))) return;
    setBusy("read");
    const sent: Record<string, string> = {};
    for (const q of map.qa) {
      if (q.answer !== null) continue;
      if (skipped[q.id]) sent[q.id] = "";
      else if (answers[q.id]?.trim()) sent[q.id] = answers[q.id].trim();
    }
    const body = await call({ action: "read", id: map.id, answers: sent });
    setBusy("");
    if (!body.ok || !body.map) {
      say(body.message ?? "The photos could not be read.", true);
      // A dropped connection can hide a read that finished: show what the server has.
      const now = await call(undefined, map.id);
      if (now.ok && now.map && now.map.reading.at !== map.reading.at) show(now.map, true);
      return;
    }
    show(body.map, true);
    const open = body.map.qa.filter((q) => q.answer === null).length;
    say(open ? `${plural(body.spots ?? 0, "spot")} so far. ${plural(open, "question")} for you.` : `${plural(body.spots ?? 0, "spot")} mapped. No questions left.`);
  }

  async function apply() {
    if (!map) return;
    if (text !== map.markup && !(await change({ action: "map.save", markup: text }))) return;
    setBusy("apply");
    const body = await call({ action: "apply", id: map.id });
    setBusy("");
    if (!body.ok || !body.map) return say(body.message ?? "That did not save.", true);
    show(body.map);
    say(`On the shelf map: ${plural(body.adds ?? 0, "spot")} added, ${body.changes ?? 0} updated.`);
  }

  async function remove() {
    if (!map) return;
    const body = await call({ action: "map.delete", id: map.id });
    if (!body.ok) return say(body.message ?? "That did not delete.", true);
    say("Map deleted");
    setMap(null);
    await loadList();
  }

  function download() {
    if (!map) return;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${map.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "shop"}.spacemap.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const parsed = useMemo(() => parseSpaceMap(text), [text]);
  const rows = useMemo(() => outlineRows(parsed.map), [parsed]);

  if (error) return <p className="err">{error}</p>;
  if (!list) return <p className="hint">Loading…</p>;

  const noReading = office ? "Photo reading is not switched on yet (ANTHROPIC_API_KEY in Vercel). You can still write a layout file by hand." : "Photo reading is not switched on yet. Ask Backroad Iron.";

  if (!map) {
    const unmapped = list.locations.filter((l) => !l.mapped);
    const chosen = unmapped.find((l) => l.id === pick) ?? (unmapped.length === 1 ? unmapped[0] : undefined);
    return (
      <div className="hs">
        <div className="lead">
          <p className="eyebrow">{office ? "Space mapper" : "Shop layout"}</p>
          <h1>Map a shop from photos</h1>
          <p className="sub">
            Take photos of the aisles, shelves, bin tags, doors and stairs, with a short note on each if you like. The mapper writes the layout, asks
            about what it could not tell, and puts it on the shelf map so pick tickets take the shortest walk. Nothing is measured.{" "}
            {office ? "Each location has its own map, and a dealer's staff see only their own." : "Only your own staff and Backroad Iron can see your shop's map."}
          </p>
        </div>
        {!list.vision && <p className="hint">{noReading}</p>}
        {list.locations.length === 0 && <p className="empty">{office ? "No store locations yet. Add one in Settings first." : "No locations are set up for your login yet. Ask Backroad Iron."}</p>}
        <ul className="hs-list">
          {list.maps.map((m) => (
            <li key={m.id} className="hs-item">
              <div className="hs-head">
                <strong>
                  {m.name} <span className="mono">{m.code}</span>
                </strong>
                <span className="hint">
                  {office && m.dealer ? `${m.dealer} · ` : ""}
                  {plural(m.photos, "photo")} · {plural(m.spots, "spot")}
                  {m.open ? ` · ${plural(m.open, "question")} waiting` : ""}
                  {m.applied_at ? ` · on the shelf map since ${day(m.applied_at)}` : " · not on the shelf map yet"}
                </span>
              </div>
              <div className="inline">
                <button type="button" className="btn sm" disabled={busy === "open"} onClick={() => void open(m.id)}>
                  Open
                </button>
              </div>
            </li>
          ))}
        </ul>
        {unmapped.length > 0 && (
          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault();
              if (chosen) void create(chosen.id);
            }}
          >
            <h2>Start a map</h2>
            {unmapped.length > 1 && (
              <>
                <label htmlFor="sm-loc">Location</label>
                <select id="sm-loc" className="field" value={pick} onChange={(e) => setPick(e.target.value)}>
                  <option value="">Pick a location</option>
                  {unmapped.map((l) => (
                    <option key={l.id} value={l.id}>
                      {office && l.dealer ? `${l.dealer}: ` : ""}
                      {l.name}
                      {l.code ? ` (${l.code})` : " (no short code yet)"}
                    </option>
                  ))}
                </select>
              </>
            )}
            {chosen && (
              <p className="hint">
                {chosen.code
                  ? `${office && chosen.dealer ? `${chosen.dealer}: ` : ""}${chosen.name}. Every shelf code here starts with ${chosen.code}, like ${chosen.code}-1-07-12.`
                  : office
                    ? `${chosen.name} has no short code yet. Give it one in Settings first.`
                    : `${chosen.name} has no short code yet. Ask Backroad Iron to set one.`}
              </p>
            )}
            <div className="inline">
              <button type="submit" className="btn" disabled={busy === "create" || !chosen?.code}>
                Start
              </button>
            </div>
          </form>
        )}
      </div>
    );
  }

  const openQs = map.qa.filter((q) => q.answer === null);
  const answered = map.qa.filter((q) => q.answer !== null);
  const seenOf = new Map(map.reading.photo_ids.map((id, i) => [id, map.reading.seen[i] ?? ""]));
  const dirty = text !== map.markup;
  const photoCount = map.photos.length + waiting.length;
  const unread = map.photos.filter((p) => !map.reading.photo_ids.includes(p.id)).length;
  const reading = busy === "read";

  return (
    <div className="hs">
      <div className="lead">
        <p className="eyebrow">
          {office ? "Space mapper" : "Shop layout"}
          {office && map.location.dealer ? ` · ${map.location.dealer}` : ""}
        </p>
        <h1>{map.name}</h1>
        <div className="inline">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              setMap(null);
              void loadList();
            }}
          >
            All maps
          </button>
          <span className="hint">
            {plural(parsed.count, "spot")}
            {map.applied_at ? (map.applied_same && !dirty ? ` · on the shelf map since ${day(map.applied_at)}` : " · changed since it went on the shelf map") : " · not on the shelf map yet"}
            {map.updated_by ? ` · last changed by ${map.updated_by}` : ""}
          </span>
        </div>
      </div>

      <section className="panel" aria-labelledby="sm-h-photos">
        <h2 id="sm-h-photos">1. Photos and notes</h2>
        <p className="hint">
          Most useful: looking down each aisle from its end, the tags on a shelf, each door and stairway, and a hand sketch of the floor if you have
          one. Add a few words where the photo needs them, like &ldquo;aisle 3 from the counter end&rdquo;. No need to measure anything.
        </p>
        <div className="inline">
          <label className="btn">
            Take a photo
            <input className="sm-pick" type="file" accept="image/*" capture="environment" onChange={(e) => {
                void addPhotos(e.target.files).then(() => (e.target.value = ""));
              }} />
          </label>
          <label className="btn ghost">
            Add from this phone
            <input className="sm-pick" type="file" accept="image/*" multiple onChange={(e) => {
                void addPhotos(e.target.files).then(() => (e.target.value = ""));
              }} />
          </label>
        </div>
        {waiting.length > 0 && (
          <p className="hint" role="status">
            {plural(waiting.length, "photo")} still to send.{" "}
            {busy !== "upload" && (
              <button type="button" className="btn ghost sm" onClick={() => void flush(map.id)}>
                Send now
              </button>
            )}
          </p>
        )}
        <ul className="sm-photos">
          {map.photos.map((p, i) => (
            <li key={p.id} className="sm-photo">
              {p.url ? (
                // eslint-disable-next-line @next/next/no-img-element -- signed link to a private photo
                <img src={p.url} alt={`Photo ${i + 1}`} loading="lazy" />
              ) : (
                <span className="sm-nophoto">Photo {i + 1}</span>
              )}
              <div className="sm-photo-body">
                <label htmlFor={`sm-note-${p.id}`}>Photo {i + 1} note</label>
                <input
                  id={`sm-note-${p.id}`}
                  className="field"
                  defaultValue={p.note}
                  maxLength={400}
                  placeholder="What is this a photo of?"
                  onBlur={(e) => {
                    if (e.target.value.trim() !== p.note) void change({ action: "photo.note", photo_id: p.id, note: e.target.value });
                  }}
                />
                {seenOf.get(p.id) && <p className="hint">Read as: {seenOf.get(p.id)}</p>}
                <button type="button" className="btn ghost sm" onClick={() => void change({ action: "photo.remove", photo_id: p.id }, "Photo removed")}>
                  Remove
                </button>
              </div>
            </li>
          ))}
          {waiting.map((w) => (
            <li key={w.id} className="sm-photo">
              {/* eslint-disable-next-line @next/next/no-img-element -- preview made on this phone */}
              {w.thumb ? <img src={w.thumb} alt="Photo waiting to send" /> : <span className="sm-nophoto">Photo</span>}
              <div className="sm-photo-body">
                <label htmlFor={`sm-note-${w.id}`}>Note</label>
                <input
                  id={`sm-note-${w.id}`}
                  className="field"
                  value={w.note}
                  maxLength={400}
                  placeholder="What is this a photo of?"
                  onChange={(e) => setQueue((list) => list.map((x) => (x.id === w.id ? { ...x, note: e.target.value } : x)))}
                />
                <p className="hint">Sending…</p>
              </div>
            </li>
          ))}
        </ul>
        <label htmlFor="sm-notes">About this shop (optional)</label>
        <textarea
          id="sm-notes"
          className="field"
          rows={3}
          value={notes}
          maxLength={4000}
          placeholder="Anything that helps: picks start at the parts counter; aisles are numbered from the front door; the loft is up the stairs by the office."
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => {
            if (notes.trim() !== map.notes) void change({ action: "map.save", notes });
          }}
        />
        {map.photos.length > MAX_PHOTOS && (
          <p className="hint">
            A read takes the newest {MAX_PHOTOS} photos. What the older ones showed is already in the layout.
          </p>
        )}
        {!vision && <p className="hint">{noReading}</p>}
        <div className="inline">
          <button type="button" className="btn" disabled={!vision || !!busy || waiting.length > 0 || (photoCount === 0 && !notes.trim())} onClick={() => void read()}>
            {reading ? "Reading…" : map.reading.at ? (unread ? `Read again with ${plural(unread, "new photo")}` : "Read again") : "Read the layout"}
          </button>
          {reading && (
            <span className="hint" role="status">
              Looking at {plural(Math.min(map.photos.length, MAX_PHOTOS), "photo")}. This can take a minute or two; keep this page open.
            </span>
          )}
        </div>
      </section>

      {(map.reading.at || openQs.length > 0) && (
        <section className="panel" aria-labelledby="sm-h-q">
          <h2 id="sm-h-q">2. Questions</h2>
          {map.reading.summary && <p>{map.reading.summary}</p>}
          {map.reading.guessed.length > 0 && (
            <div>
              <p className="hint">Guessed, not seen. Check these:</p>
              <ul className="sm-plain">
                {map.reading.guessed.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </div>
          )}
          {openQs.length === 0 && map.reading.at && <p className="hint">No questions waiting. Add photos or notes and read again if something is missing.</p>}
          {openQs.map((q, i) => (
            <fieldset key={q.id} className="sm-q" disabled={reading}>
              <legend>
                {i + 1}. {q.question}
              </legend>
              {q.why && <p className="hint">{q.why}</p>}
              <div className="chips">
                {q.choices.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="chip"
                    aria-pressed={!skipped[q.id] && answers[q.id] === c}
                    onClick={() => {
                      setAnswers({ ...answers, [q.id]: answers[q.id] === c ? "" : c });
                      setSkipped({ ...skipped, [q.id]: false });
                    }}
                  >
                    {c}
                  </button>
                ))}
                <button type="button" className="chip" aria-pressed={!!skipped[q.id]} onClick={() => setSkipped({ ...skipped, [q.id]: !skipped[q.id] })}>
                  Skip
                </button>
              </div>
              <label htmlFor={`sm-a-${q.id}`}>{q.choices.length ? "Or in your own words" : "Your answer"}</label>
              <input
                id={`sm-a-${q.id}`}
                className="field"
                value={skipped[q.id] ? "" : (answers[q.id] ?? "")}
                maxLength={400}
                onChange={(e) => {
                  setAnswers({ ...answers, [q.id]: e.target.value });
                  setSkipped({ ...skipped, [q.id]: false });
                }}
              />
            </fieldset>
          ))}
          {openQs.length > 0 && (
            <div className="inline">
              <button type="button" className="btn" disabled={!!busy || !openQs.some((q) => skipped[q.id] || answers[q.id]?.trim())} onClick={() => void read()}>
                {reading ? "Reading…" : "Send answers"}
              </button>
              <span className="hint">Answer what you can. Anything left blank may be asked again.</span>
            </div>
          )}
          {answered.length > 0 && (
            <details>
              <summary>Earlier answers ({answered.length})</summary>
              <ul className="sm-plain">
                {answered.map((q) => (
                  <li key={q.id}>
                    {q.question} <b>{q.answer || "Skipped"}</b>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      <section className="panel" aria-labelledby="sm-h-layout">
        <h2 id="sm-h-layout">3. The layout</h2>
        {parsed.problems.length > 0 && (
          <div role="alert">
            <p className="err">{plural(parsed.problems.length, "line")} in the file can&rsquo;t be used:</p>
            <ul className="sm-plain">
              {parsed.problems.map((p, i) => (
                <li key={i}>
                  {p.line ? `Line ${p.line}: ` : ""}
                  {p.text}
                </li>
              ))}
            </ul>
          </div>
        )}
        {rows.length === 0 ? (
          <p className="hint">Nothing mapped yet.</p>
        ) : (
          <ol className="sm-outline">
            {rows.map((r) => (
              <li key={`${r.code}/${r.to}`} style={{ paddingLeft: `${r.depth * 14}px` }}>
                <span>
                  {r.label || (r.count > 1 ? `${r.level} ${r.from} to ${r.to}` : `${r.level} ${r.from}`)}
                  {r.count > 1 ? ` (${r.count})` : ""}
                  {r.deadEnd ? " · dead end" : ""}
                </span>
                <span className="mono">{r.count > 1 ? `${r.code}..${r.to}` : r.code}</span>
              </li>
            ))}
          </ol>
        )}
        {parsed.map.starts.map((s) => (
          <p key={s.at}>
            Picks start and finish at <b>{s.label || nameAt(parsed.map, s.at)}</b> <span className="mono">{s.at}</span>
          </p>
        ))}
        {rows.length > 0 && parsed.map.starts.length === 0 && <p className="hint">No start point yet, so a pick starts at the first aisle listed.</p>}
        {parsed.map.links.length > 0 && (
          <ul className="sm-plain">
            {parsed.map.links.map((l) => (
              <li key={`${l.a}/${l.b}`}>
                {nameAt(parsed.map, l.a)} <span className="mono">{l.a}</span> to {nameAt(parsed.map, l.b)} <span className="mono">{l.b}</span>: {EFFORT_WORDS[l.effort]}
                {l.via ? `, ${l.via}` : ""}
              </li>
            ))}
          </ul>
        )}
        <details>
          <summary>The file</summary>
          <label htmlFor="sm-file">Layout file. You can edit it here; the layout above follows as you type.</label>
          <textarea id="sm-file" className="field sm-file" rows={16} spellCheck={false} autoCapitalize="off" autoCorrect="off" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="inline">
            <button type="button" className="btn sm" disabled={!dirty || !!busy} onClick={() => void change({ action: "map.save", markup: text }, "File saved")}>
              Save file
            </button>
            <button type="button" className="btn ghost sm" onClick={download}>
              Download
            </button>
            <label className="btn ghost sm">
              Load a file
              <input className="sm-pick" type="file" accept=".txt,.spacemap,text/plain" onChange={(e) => {
                  void e.target.files?.[0]?.text().then((loaded) => {
                    setText(loaded.slice(0, 200_000));
                    e.target.value = "";
                  });
                }} />
            </label>
            {dirty && (
              <button type="button" className="btn ghost sm" onClick={() => setText(map.markup)}>
                Undo edits
              </button>
            )}
          </div>
        </details>
      </section>

      <section className="panel" aria-labelledby="sm-h-apply">
        <h2 id="sm-h-apply">4. Shelf map</h2>
        {map.applied_at && map.applied_same && !dirty ? (
          <p>On the shelf map since {day(map.applied_at)}. Pick tickets use its start point and links.</p>
        ) : parsed.problems.length > 0 ? (
          <p className="hint">Fix the lines listed above first.</p>
        ) : dirty ? (
          <p className="hint">Save the file to see what would change.</p>
        ) : map.blocked ? (
          <p className="err">{map.blocked}</p>
        ) : map.plan ? (
          <p>
            Putting this on the shelf map adds {plural(map.plan.adds, "spot")}
            {map.plan.changes ? ` and updates ${map.plan.changes}` : ""}.
            {map.plan.extra ? ` ${plural(map.plan.extra, "spot")} already there and not in this file ${map.plan.extra === 1 ? "is" : "are"} left alone.` : ""} Nothing is removed and no
            part moves.
          </p>
        ) : (
          <p className="hint">{parsed.count ? "The shelf map is not set up yet." : "Nothing to put on the shelf map yet."}</p>
        )}
        <div className="inline">
          <button type="button" className="btn" disabled={!!busy || parsed.problems.length > 0 || !parsed.count || (!dirty && (!!map.blocked || map.applied_same))} onClick={() => void apply()}>
            {busy === "apply" ? "Saving…" : map.applied_at ? "Update the shelf map" : "Put on the shelf map"}
          </button>
          {openQs.length > 0 && <span className="hint">{plural(openQs.length, "question")} still open. You can update the shelf map again later.</span>}
        </div>
      </section>

      {office && (
        <div className="inline">
          {sure ? (
            <>
              <span className="hint">Delete this map and its photos? Spots already on the shelf map stay; pick tickets stop using its start point and links.</span>
              <button type="button" className="btn danger sm" onClick={() => void remove()}>
                Yes, delete
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setSure(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="btn ghost sm" onClick={() => setSure(true)}>
              Delete this map
            </button>
          )}
        </div>
      )}
    </div>
  );
}
