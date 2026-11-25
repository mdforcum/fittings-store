"use client";
// The hose builder: three ways to describe the hose (photos, a tag or part
// number, or by hand), one build sheet, and two ways to order it.
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  EMPTY_BUILD,
  END_FAMILIES,
  GENDER_LABEL,
  HOSE_DASHES,
  HOSE_TYPES,
  SHAPES,
  buildSheet,
  checkBuild,
  dashLabel,
  familyOf,
  identifyThread,
  measurePoint,
  parseLayline,
  type Build,
  type HoseEnd,
  type SheetLine,
} from "@/lib/hose";
import type { HoseReading } from "@/lib/hose-read";
import { prepare } from "@/lib/scan";

type Way = "photo" | "number" | "hand";
type Builder = { id: string; name: string; phone: string; hours: string; one_hour: boolean };
type Done = { number: number; tag: string; sheet: { title: string; lines: SheetLine[]; text: string }; builders: Builder[]; store: { phone: string; email: string }; mode: "now" | "shop" };

/** Numbers stay text while typed, so "12." is not lost. */
type Draft = Omit<Build, "rated_psi" | "system_psi" | "length_in" | "angle" | "qty"> & {
  rated_psi: string;
  system_psi: string;
  length_in: string;
  angle: string;
  qty: string;
};

const toDraft = (b: Build): Draft => ({
  ...b,
  rated_psi: b.rated_psi == null ? "" : String(b.rated_psi),
  system_psi: b.system_psi == null ? "" : String(b.system_psi),
  length_in: b.length_in ? String(b.length_in) : "",
  angle: b.angle == null ? "" : String(b.angle),
  qty: String(b.qty),
});

/** Accepts 36, 36.5, 36 1/2 and 36-1/2. */
function inches(s: string): number {
  const t = s.trim().replace(/["”]|in(ches)?$/i, "").trim();
  const m = t.match(/^(\d+)?[\s-]*(?:(\d+)\/(\d+))?$/);
  if (m && (m[1] || m[2])) return Number(m[1] ?? 0) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(/,/g, "")));

const fromDraft = (d: Draft): Build => ({
  ...d,
  rated_psi: num(d.rated_psi),
  system_psi: num(d.system_psi),
  length_in: inches(d.length_in) || 0,
  angle: d.angle.trim() === "" ? null : Number(d.angle),
  qty: Number(d.qty) || 0,
});

export default function HoseBuilder({ storeName, phone, reading }: { storeName: string; phone: string; reading: boolean }) {
  const [way, setWay] = useState<Way>(reading ? "photo" : "hand");
  const [d, setD] = useState<Draft>(toDraft(EMPTY_BUILD));
  const [tag, setTag] = useState("");
  const [read, setRead] = useState<HoseReading | null>(null);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  const build = useMemo(() => fromDraft(d), [d]);
  const problems = checkBuild(build);
  const ready = shown && !problems.some((p) => p.blocking);
  const sheet = ready ? buildSheet(build, tag || "Assigned when ordered") : null;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((cur) => ({ ...cur, [k]: v }));
  const setEnd = (which: "end_a" | "end_b", patch: Partial<HoseEnd>) =>
    setD((cur) => {
      const next = { ...cur[which], ...patch };
      const fam = familyOf(next.family);
      if (fam && !fam.genders.includes(next.gender)) next.gender = fam.genders[0];
      if (fam && !fam.sizes.some((s) => s.dash === next.dash)) {
        next.dash = fam.sizes.find((s) => s.dash === cur.hose_dash)?.dash ?? fam.sizes[0].dash;
      }
      return { ...cur, [which]: next };
    });

  function applyBuild(b: Build, t = "") {
    setD(toDraft(b));
    setTag(t);
    setShown(true);
    setWay("hand");
  }

  if (done) return <Confirmation done={done} storeName={storeName} />;

  return (
    <>
      <header className="top">
        <div className="wrap">
          <Link className="brand" href="/">
            {storeName}
          </Link>
          <nav aria-label="Store">
            <Link href="/">Shop</Link>
            <Link href="/hose" aria-current="page">
              Hose builder
            </Link>
          </nav>
        </div>
      </header>
      <main className="wrap hb">
        <div className="lead">
          <p className="eyebrow">Hydraulic hose assemblies</p>
          <h1>Replace a hose, built right the first time</h1>
          <p className="sub">
            Machine down? Describe the hose and we route it to a builder near you.
            {phone ? (
              <>
                {" "}
                Or call <a href={`tel:${phone.replace(/[^\d+]/g, "")}`}>{phone}</a>.
              </>
            ) : null}
          </p>
        </div>

        <div className="hb-ways" role="tablist" aria-label="How to describe the hose">
          {(
            [
              ["photo", "Snap the old hose"],
              ["number", "Tag or part number"],
              ["hand", "Build it by hand"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={way === id} className="chip" onClick={() => setWay(id)}>
              {label}
            </button>
          ))}
        </div>

        {way === "photo" && (
          <PhotoRead
            reading={reading}
            onRead={(r) => {
              setRead(r);
              const b: Build = { ...fromDraft(d) };
              if (r.hose_dash) b.hose_dash = r.hose_dash;
              if (r.hose_type) b.hose_type = r.hose_type;
              if (r.brand) b.brand = r.brand;
              const line = parseLayline(r.layline).line;
              if (line) b.hose_line = line;
              if (r.working_psi) b.rated_psi = r.working_psi;
              if (r.length_in) b.length_in = r.length_in;
              const ends = r.ends.map((e): HoseEnd | null =>
                familyOf(e.family)
                  ? {
                      family: e.family,
                      gender: e.gender === "male" ? "male" : "female_swivel",
                      shape: (SHAPES.find((s) => s.id === e.shape)?.id ?? "straight") as HoseEnd["shape"],
                      dash: e.dash ?? r.hose_dash ?? b.hose_dash,
                    }
                  : null,
              );
              if (ends[0]) b.end_a = ends[0];
              if (ends[1]) b.end_b = ends[1];
              applyBuild(b);
            }}
          />
        )}
        {way === "number" && <NumberLookup onFound={(b, t) => applyBuild(b, t)} />}

        {read && way === "hand" && <ReadSummary r={read} />}

        {way === "hand" && (
          <form className="form hb-form" onSubmit={(e) => e.preventDefault()} noValidate>
            {tag && (
              <p className="hb-tag">
                Building a copy of <strong>{tag}</strong>. Change anything and it gets a new tag number.
              </p>
            )}
            <fieldset>
              <legend>Hose</legend>
              <div className="two">
                <label htmlFor="h-dash">
                  Size (inside diameter)
                  <select id="h-dash" value={d.hose_dash} onChange={(e) => set("hose_dash", Number(e.target.value))}>
                    {HOSE_DASHES.map((x) => (
                      <option key={x.dash} value={x.dash}>
                        {dashLabel(x.dash)} · {x.id} in
                      </option>
                    ))}
                  </select>
                </label>
                <label htmlFor="h-type">
                  Type printed on the hose
                  <select id="h-type" value={d.hose_type} onChange={(e) => set("hose_type", e.target.value)}>
                    {HOSE_TYPES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label htmlFor="h-psi">
                  Working pressure on the hose (psi)
                  <input id="h-psi" inputMode="numeric" autoComplete="off" placeholder="e.g. 4000" value={d.rated_psi} onChange={(e) => set("rated_psi", e.target.value)} />
                </label>
                <label htmlFor="h-sys">
                  System pressure, if known (psi)
                  <input id="h-sys" inputMode="numeric" autoComplete="off" value={d.system_psi} onChange={(e) => set("system_psi", e.target.value)} />
                </label>
                <label htmlFor="h-brand">
                  Maker, if printed
                  <input id="h-brand" autoComplete="off" maxLength={40} placeholder="Gates, Parker…" value={d.brand} onChange={(e) => set("brand", e.target.value)} />
                </label>
                <label htmlFor="h-line">
                  Hose line, if printed
                  <input id="h-line" autoComplete="off" maxLength={40} value={d.hose_line} onChange={(e) => set("hose_line", e.target.value)} />
                </label>
              </div>
              <p className="hint">The working pressure is printed along the hose, often as WP followed by psi or bar.</p>
            </fieldset>

            <EndPicker label="End A" end={d.end_a} onChange={(p) => setEnd("end_a", p)} />
            <EndPicker label="End B" end={d.end_b} onChange={(p) => setEnd("end_b", p)} />
            <ThreadHelp onPick={(which, p) => setEnd(which, p)} />

            <fieldset>
              <legend>Length and angle</legend>
              <div className="two">
                <label htmlFor="h-len">
                  Overall length (in)
                  <input id="h-len" inputMode="decimal" autoComplete="off" placeholder="36 1/2" value={d.length_in} onChange={(e) => set("length_in", e.target.value)} />
                </label>
                {d.end_a.shape !== "straight" && d.end_b.shape !== "straight" && (
                  <label htmlFor="h-ang">
                    Angle between the elbows (°)
                    <input id="h-ang" inputMode="numeric" autoComplete="off" placeholder="0 to 359" value={d.angle} onChange={(e) => set("angle", e.target.value)} />
                  </label>
                )}
                <label htmlFor="h-qty">
                  How many
                  <input id="h-qty" inputMode="numeric" autoComplete="off" value={d.qty} onChange={(e) => set("qty", e.target.value)} />
                </label>
                <label htmlFor="h-cover">
                  Cover
                  <select id="h-cover" value={d.sleeve} onChange={(e) => set("sleeve", e.target.value as Build["sleeve"])}>
                    <option value="none">None</option>
                    <option value="nylon">Nylon sleeve</option>
                    <option value="spring_guard">Spring guard</option>
                    <option value="fire">Fire sleeve</option>
                  </select>
                </label>
              </div>
              <p className="hint">
                Measure from the {measurePoint(d.end_a)} at A to the {measurePoint(d.end_b)} at B.
                {d.end_a.shape !== "straight" && d.end_b.shape !== "straight"
                  ? " For the angle, look down the hose from end A and measure clockwise from A to B; 0 means both point the same way."
                  : ""}
              </p>
              <label htmlFor="h-notes">
                Anything else the builder should know
                <textarea id="h-notes" maxLength={500} value={d.notes} onChange={(e) => set("notes", e.target.value)} />
              </label>
            </fieldset>

            {!shown && (
              <button type="button" className="btn" onClick={() => setShown(true)}>
                Check the build
              </button>
            )}
            {shown && problems.length > 0 && (
              <ul className="hb-problems" aria-live="polite">
                {problems.map((p, i) => (
                  <li key={i} className={p.blocking ? "err" : "hint"}>
                    {p.text}
                  </li>
                ))}
              </ul>
            )}
          </form>
        )}

        {sheet && (
          <>
            <Sheet title={sheet.title} lines={sheet.lines} />
            <Order build={build} tag={tag} onDone={setDone} />
          </>
        )}
      </main>
    </>
  );
}

function EndPicker({ label, end, onChange }: { label: string; end: HoseEnd; onChange: (p: Partial<HoseEnd>) => void }) {
  const fam = familyOf(end.family) ?? END_FAMILIES[0];
  const id = label.replace(/\W/g, "").toLowerCase();
  return (
    <fieldset>
      <legend>{label}</legend>
      <div className="two">
        <label htmlFor={`${id}-fam`}>
          Connection
          <select id={`${id}-fam`} value={end.family} onChange={(e) => onChange({ family: e.target.value })}>
            {END_FAMILIES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${id}-gen`}>
          Male or female
          <select id={`${id}-gen`} value={end.gender} onChange={(e) => onChange({ gender: e.target.value as HoseEnd["gender"] })}>
            {fam.genders.map((g) => (
              <option key={g} value={g}>
                {GENDER_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${id}-shape`}>
          Shape
          <select id={`${id}-shape`} value={end.shape} onChange={(e) => onChange({ shape: e.target.value as HoseEnd["shape"] })}>
            {SHAPES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${id}-size`}>
          Thread size
          <select id={`${id}-size`} value={end.dash} onChange={(e) => onChange({ dash: Number(e.target.value) })}>
            {fam.sizes.map((s) => (
              <option key={s.dash} value={s.dash}>
                {fam.id.startsWith("metric") ? `${s.dash} mm tube` : dashLabel(s.dash)} · {s.thread}
              </option>
            ))}
          </select>
        </label>
      </div>
      {fam.note && <p className="hint">{fam.note}</p>}
    </fieldset>
  );
}

function ThreadHelp({ onPick }: { onPick: (which: "end_a" | "end_b", p: Partial<HoseEnd>) => void }) {
  const [open, setOpen] = useState(false);
  const [od, setOd] = useState("");
  const [tpi, setTpi] = useState("");
  const [unit, setUnit] = useState<"in" | "mm">("in");
  const major = unit === "mm" ? Number(od) / 25.4 : Number(od);
  const matches = major > 0 ? identifyThread(major, unit === "in" && Number(tpi) > 0 ? Number(tpi) : null, unit === "mm" && Number(tpi) > 0 ? Number(tpi) : null).slice(0, 6) : [];
  if (!open) {
    return (
      <button type="button" className="linkbtn" onClick={() => setOpen(true)}>
        Not sure which thread? Measure it.
      </button>
    );
  }
  return (
    <fieldset className="hb-measure">
      <legend>Measure a thread</legend>
      <p className="hint">
        Measure across the outside of the threads with calipers. On a female swivel, measure inside the nut&rsquo;s threads and
        add the thread depth, or measure the male end it screws onto. A thread gauge gives the threads per inch (or pitch in mm).
      </p>
      <div className="two">
        <label htmlFor="t-od">
          Outside diameter
          <input id="t-od" inputMode="decimal" autoComplete="off" value={od} onChange={(e) => setOd(e.target.value)} />
        </label>
        <label htmlFor="t-unit">
          Unit
          <select id="t-unit" value={unit} onChange={(e) => setUnit(e.target.value as "in" | "mm")}>
            <option value="in">inches</option>
            <option value="mm">mm</option>
          </select>
        </label>
        <label htmlFor="t-tpi">
          {unit === "in" ? "Threads per inch (optional)" : "Pitch in mm (optional)"}
          <input id="t-tpi" inputMode="decimal" autoComplete="off" value={tpi} onChange={(e) => setTpi(e.target.value)} />
        </label>
      </div>
      {major > 0 && matches.length === 0 && <p className="hint">Nothing matches that measurement. Check it, or call us.</p>}
      {matches.length > 0 && (
        <ul className="hb-matches">
          {matches.map((m) => (
            <li key={`${m.family.id}-${m.size.dash}`}>
              <span>
                <strong>{m.family.label}</strong> {m.size.thread}
                <small>{m.family.seal}</small>
              </span>
              <span className="inline">
                <button type="button" className="btn ghost sm" onClick={() => onPick("end_a", { family: m.family.id, dash: m.size.dash })}>
                  Use for A
                </button>
                <button type="button" className="btn ghost sm" onClick={() => onPick("end_b", { family: m.family.id, dash: m.size.dash })}>
                  Use for B
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

function PhotoRead({ reading, onRead }: { reading: boolean; onRead: (r: HoseReading) => void }) {
  const [files, setFiles] = useState<Record<string, { blob: Blob; thumb: string } | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!reading) {
    return <p className="hint">Photo reading is not switched on yet. Use a tag number or build it by hand.</p>;
  }
  async function pick(key: string, file: File | undefined) {
    if (!file) return;
    try {
      const p = await prepare(file, false);
      setFiles((cur) => ({ ...cur, [key]: { blob: new Blob([p.bytes], { type: p.type }), thumb: p.thumb } }));
    } catch {
      setError("That photo could not be opened. Try another.");
    }
  }
  async function send() {
    setError("");
    setBusy(true);
    try {
      const form = new FormData();
      for (const [k, v] of Object.entries(files)) if (v) form.append(k, v.blob, `${k}.jpg`);
      const r = await fetch("/api/hose", { method: "POST", body: form });
      const body = (await r.json()) as { ok: boolean; message?: string; reading?: HoseReading };
      if (!body.ok || !body.reading) setError(body.message ?? "The photos could not be read.");
      else onRead(body.reading);
    } catch {
      setError("No connection. Try again, or build it by hand.");
    } finally {
      setBusy(false);
    }
  }
  const shots = [
    ["layline", "The printing along the hose", "Turn the hose until the text faces you. Fill the frame."],
    ["end_a", "One end", "Side on, with a tape or a coin beside it for scale."],
    ["end_b", "The other end", "Same again for the other fitting."],
  ] as const;
  return (
    <section className="hb-photos">
      <div className="hb-shots">
        {shots.map(([key, title, tip]) => (
          <label key={key} className="hb-shot">
            {files[key] ? (
              // eslint-disable-next-line @next/next/no-img-element -- local preview
              <img src={files[key]!.thumb} alt="" />
            ) : (
              <span className="hb-plus" aria-hidden="true">
                +
              </span>
            )}
            <strong>{title}</strong>
            <small>{tip}</small>
            <input type="file" accept="image/*" capture="environment" onChange={(e) => pick(key, e.target.files?.[0])} />
          </label>
        ))}
      </div>
      <button type="button" className="btn" disabled={busy || !Object.values(files).some(Boolean)} onClick={send}>
        {busy ? "Reading the photos…" : "Read the hose"}
      </button>
      {error && <p className="err">{error}</p>}
      <p className="hint">You check everything we read before anything is built.</p>
    </section>
  );
}

function NumberLookup({ onFound }: { onFound: (b: Build, tag: string) => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function find() {
    setError("");
    const v = q.trim();
    if (!v) return;
    setBusy(true);
    try {
      const isTag = /^BH-/i.test(v);
      const r = await fetch(`/api/hose?${isTag ? "tag" : "number"}=${encodeURIComponent(v)}`, { cache: "no-store" });
      const body = (await r.json()) as { ok: boolean; message?: string; build?: Build; tag?: string };
      if (!body.ok || !body.build) setError(body.message ?? "Nothing found.");
      else onFound(body.build, body.tag ?? "");
    } catch {
      setError("No connection. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="form hb-number">
      <label htmlFor="h-q">
        Our tag number (BH-…) or the OEM part number
        <input id="h-q" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && find()} />
      </label>
      <button type="button" className="btn" disabled={busy} onClick={find}>
        {busy ? "Looking…" : "Find the build"}
      </button>
      {error && <p className="err">{error}</p>}
    </section>
  );
}

function ReadSummary({ r }: { r: HoseReading }) {
  return (
    <section className={`hb-read ${r.confidence}`}>
      <h2>What we read</h2>
      {r.layline ? (
        <p>
          Printed on the hose: <code>{r.layline}</code>
        </p>
      ) : (
        <p>No printing was readable on the hose.</p>
      )}
      {r.ends.map((e, i) => (
        <p key={i}>
          End {i ? "B" : "A"}: {familyOf(e.family)?.label ?? "not sure"}
          {e.why ? `, because ${e.why.charAt(0).toLowerCase()}${e.why.slice(1)}` : ""}
          {e.stamped ? ` Stamped: ${e.stamped}.` : ""}
        </p>
      ))}
      <p>
        <strong>Confidence: {r.confidence}.</strong> {r.ask || "Check each field below against the old hose before ordering."}
      </p>
    </section>
  );
}

function Sheet({ title, lines }: { title: string; lines: SheetLine[] }) {
  return (
    <section className="hb-sheet" aria-label="Build sheet">
      <h2>Build sheet</h2>
      <p className="hb-sheet-title">{title}</p>
      <dl>
        {lines.map((l) => (
          <div key={l.label}>
            <dt>{l.label}</dt>
            <dd>{l.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Order({ build, tag, onDone }: { build: Build; tag: string; onDone: (d: Done) => void }) {
  const [mode, setMode] = useState<"now" | "shop" | null>(null);
  const [c, setC] = useState({ name: "", phone: "", email: "", zip: "", machine: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const put = (k: keyof typeof c) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setC((cur) => ({ ...cur, [k]: e.target.value }));

  async function send() {
    if (!mode) return;
    setError("");
    setBusy(true);
    try {
      const r = await fetch("/api/hose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request", mode, build, tag, contact: c }),
      });
      const body = (await r.json()) as Omit<Done, "mode"> & { ok: boolean; message?: string };
      if (!body.ok) setError(body.message ?? "That did not send. Try again.");
      else onDone({ ...body, mode });
    } catch {
      setError("No connection. Try again, or call us.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="hb-order">
      <h2>Get it built</h2>
      <div className="hb-modes">
        <button type="button" className="hb-mode" aria-pressed={mode === "now"} onClick={() => setMode("now")}>
          <strong>Machine down</strong>
          <span>Built at the nearest builder that can do it within the hour. You pick it up.</span>
        </button>
        <button type="button" className="hb-mode" aria-pressed={mode === "shop"} onClick={() => setMode("shop")}>
          <strong>Shop or spare</strong>
          <span>We confirm the price, then build it and ship it or hold it for pickup.</span>
        </button>
      </div>
      {mode && (
        <div className="form">
          <div className="two">
            <label htmlFor="o-name">
              Name
              <input id="o-name" autoComplete="name" value={c.name} onChange={put("name")} />
            </label>
            <label htmlFor="o-phone">
              Phone{mode === "now" ? " (needed)" : ""}
              <input id="o-phone" type="tel" autoComplete="tel" value={c.phone} onChange={put("phone")} />
            </label>
            <label htmlFor="o-email">
              Email
              <input id="o-email" type="email" autoComplete="email" value={c.email} onChange={put("email")} />
            </label>
            <label htmlFor="o-zip">
              ZIP code
              <input id="o-zip" inputMode="numeric" autoComplete="postal-code" value={c.zip} onChange={put("zip")} />
            </label>
          </div>
          <label htmlFor="o-machine">
            Machine (make, model)
            <input id="o-machine" autoComplete="off" placeholder="Case IH Magnum 340" value={c.machine} onChange={put("machine")} />
          </label>
          <button type="button" className="btn" disabled={busy} onClick={send}>
            {busy ? "Sending…" : mode === "now" ? "Send to a builder now" : "Request this build"}
          </button>
          {error && <p className="err">{error}</p>}
        </div>
      )}
    </section>
  );
}

function Confirmation({ done, storeName }: { done: Done; storeName: string }) {
  const call = done.builders.filter((b) => b.phone);
  return (
    <>
      <header className="top">
        <div className="wrap">
          <Link className="brand" href="/">
            {storeName}
          </Link>
        </div>
      </header>
      <main className="wrap hb">
        <div className="lead">
          <p className="eyebrow">Request {done.number}</p>
          <h1>{done.mode === "now" ? "Your build sheet is in" : "Request received"}</h1>
          <p className="sub">
            Tag number <strong>{done.tag}</strong>. It goes on the finished hose, so the next one is a single number.
          </p>
        </div>
        {done.mode === "now" && (
          <section className="hb-call">
            {call.length > 0 ? (
              <>
                <h2>Call the builder now</h2>
                <p>Give them request {done.number}. They have the build sheet.</p>
                <ul>
                  {call.map((b) => (
                    <li key={b.id}>
                      <strong>{b.name}</strong> <a href={`tel:${b.phone.replace(/[^\d+]/g, "")}`}>{b.phone}</a>
                      {b.hours ? <small>{b.hours}</small> : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <h2>Call us now</h2>
                <p>
                  No builder near you has promised a one-hour build yet, so we will place it for you.
                  {done.store.phone ? (
                    <>
                      {" "}
                      Call <a href={`tel:${done.store.phone.replace(/[^\d+]/g, "")}`}>{done.store.phone}</a> and give request {done.number}.
                    </>
                  ) : null}
                </p>
              </>
            )}
          </section>
        )}
        <Sheet title={done.sheet.title} lines={done.sheet.lines} />
        <p className="inline">
          <button type="button" className="btn ghost" onClick={() => window.print()}>
            Print the build sheet
          </button>
          <Link className="btn ghost" href="/hose">
            Build another
          </Link>
        </p>
      </main>
    </>
  );
}
