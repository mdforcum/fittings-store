"use client";
// Step-by-step measuring help for the hose builder. Each walkthrough is built
// from the ends the customer picked, and every one can be skipped.
import { useState } from "react";
import type { HoseEnd } from "@/lib/hose";
import { CLOCK, describeLength, steps, type Path } from "@/lib/measure";
import { prepare } from "@/lib/scan";

const PATHS: Array<{ id: Path; label: string; hint: string }> = [
  { id: "off", label: "Hose is off the machine", hint: "Lay it straight and measure it" },
  { id: "on", label: "Hose is still on the machine", hint: "Measure the route with a string" },
  { id: "angle", label: "Angle between the elbows", hint: "Look down the hose like a clock" },
];

export default function MeasureGuide({
  endA,
  endB,
  reading,
  onLength,
  onAngle,
}: {
  endA: HoseEnd;
  endB: HoseEnd;
  reading: boolean;
  onLength: (inches: number) => void;
  onAngle: (deg: number) => void;
}) {
  const [path, setPath] = useState<Path | null>(null);
  const [at, setAt] = useState(0);
  const elbows = endA.shape !== "straight" && endB.shape !== "straight";
  const list = path ? steps(path, endA, endB) : [];
  const step = list[at];
  const last = at === list.length - 1;

  if (!path) {
    return (
      <div className="mg-start" role="group" aria-label="How to measure">
        <p className="mg-q">Need help measuring?</p>
        <div className="mg-paths">
          {PATHS.filter((p) => p.id !== "angle" || elbows).map((p) => (
            <button
              key={p.id}
              type="button"
              className="mg-path"
              onClick={() => {
                setPath(p.id);
                setAt(0);
              }}
            >
              <strong>{p.label}</strong>
              <span>{p.hint}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const close = () => {
    setPath(null);
    setAt(0);
  };

  return (
    <section className="mg" aria-label="Measuring guide" aria-live="polite">
      <div className="mg-top">
        <span className="mg-count">
          Step {at + 1} of {list.length}
        </span>
        <button type="button" className="linkbtn" onClick={close}>
          Skip the guide
        </button>
      </div>
      <ol className="mg-dots" aria-hidden="true">
        {list.map((_, i) => (
          <li key={i} className={i === at ? "on" : i < at ? "done" : ""} />
        ))}
      </ol>
      <h3>{step.title}</h3>
      {step.warn && <p className="mg-warn">{step.warn}</p>}
      <p>{step.body}</p>

      {path === "off" && last && (
        reading ? (
          <TapePhotos
            onLength={(n) => {
              onLength(n);
              close();
            }}
          />
        ) : (
          <p className="hint">Type the length into the overall length box.</p>
        )
      )}
      {path === "angle" && last && (
        <div className="mg-clock" role="group" aria-label="Where end B points">
          {[315, 0, 45, 270, -1, 90, 225, 180, 135].map((deg) =>
            deg < 0 ? (
              <span key="a" className="mg-center" aria-hidden="true">
                A
              </span>
            ) : (
              <button
                key={deg}
                type="button"
                onClick={() => {
                  onAngle(deg);
                  close();
                }}
              >
                {CLOCK.find((c) => c.deg === deg)?.label}
                <small>{deg}°</small>
              </button>
            ),
          )}
        </div>
      )}

      <div className="mg-nav">
        <button type="button" className="btn ghost sm" disabled={at === 0} onClick={() => setAt(at - 1)}>
          Back
        </button>
        {last ? (
          <button type="button" className="btn sm" onClick={close}>
            Done
          </button>
        ) : (
          <button type="button" className="btn sm" onClick={() => setAt(at + 1)}>
            Next
          </button>
        )}
      </div>
    </section>
  );
}

function TapePhotos({ onLength }: { onLength: (inches: number) => void }) {
  const [files, setFiles] = useState<Record<string, { blob: Blob; thumb: string } | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);

  async function pick(key: string, file: File | undefined) {
    if (!file) return;
    try {
      const p = await prepare(file, false);
      setFiles((cur) => ({ ...cur, [key]: { blob: new Blob([p.bytes], { type: p.type }), thumb: p.thumb } }));
    } catch {
      setMsg({ text: "That photo could not be opened. Try another.", bad: true });
    }
  }

  async function send() {
    setMsg(null);
    setBusy(true);
    try {
      const form = new FormData();
      for (const [k, v] of Object.entries(files)) if (v) form.append(k, v.blob, `${k}.jpg`);
      const r = await fetch("/api/hose", { method: "POST", body: form });
      const body = (await r.json()) as {
        ok: boolean;
        message?: string;
        tape?: { a: number | null; b: number | null; length: number | null; note: string };
      };
      if (!body.ok || !body.tape) setMsg({ text: body.message ?? "The photos could not be read.", bad: true });
      else if (body.tape.length == null) {
        setMsg({ text: body.tape.note || "We could not read both ends of the tape. Retake the photos closer, or type the length in.", bad: true });
      } else {
        setMsg({ text: `Read ${describeLength(body.tape.length)}${body.tape.note ? `. ${body.tape.note}` : ""}`, bad: false });
        onLength(body.tape.length);
      }
    } catch {
      setMsg({ text: "No connection. Type the length in instead.", bad: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mg-tape">
      <div className="hb-shots">
        {(
          [
            ["tape_a", "Tape at end A"],
            ["tape_b", "Tape at end B"],
          ] as const
        ).map(([key, title]) => (
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
            <input type="file" accept="image/*" capture="environment" onChange={(e) => pick(key, e.target.files?.[0])} />
          </label>
        ))}
      </div>
      <button type="button" className="btn sm" disabled={busy || !files.tape_a || !files.tape_b} onClick={send}>
        {busy ? "Reading the tape…" : "Read the tape"}
      </button>
      {msg && <p className={msg.bad ? "err" : "ok"}>{msg.text}</p>}
    </div>
  );
}
