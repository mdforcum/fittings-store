"use client";
// Back-office view of an inventory survey: the parts worked out from every
// capture at a location, what still needs a look, and what has no match yet.
import { useCallback, useEffect, useMemo, useState } from "react";
import { FLAG_TEXT, normPart, type Capture, type Flag, type SurveyPart } from "@/lib/match";
import type { SurveyData, SurveyReply } from "@/lib/survey-types";
import type { Say } from "../Admin";
import { Modal } from "../ui";

type Filter = "all" | "look" | "nocard" | "nobin";
type Draft = {
  part_number: string;
  upc: string;
  aisle: string;
  bin: string;
  qty_on_card: string;
  count_seen: string;
  description: string;
  notes: string;
};

const KIND: Record<Capture["kind"], string> = { card: "Card", bin: "Bin", code: "Code", manual: "Typed" };
const FLAG_TONE: Record<Flag, string> = {
  conflict: "bad",
  confirm: "hold",
  mismatch: "bad",
  rough_count: "muted",
  lookalike: "hold",
};

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";

const toDraft = (c: Capture): Draft => ({
  part_number: c.part_number,
  upc: c.upc,
  aisle: c.aisle,
  bin: c.bin,
  qty_on_card: c.qty_on_card == null ? "" : String(c.qty_on_card),
  count_seen: c.count_seen == null ? "" : String(c.count_seen),
  description: c.description,
  notes: c.notes,
});

/** "" gives null (clear it); junk gives undefined (leave it alone). */
const toCount = (text: string): number | null | undefined => {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
};

function Thumb({ capture, onOpen }: { capture: Capture; onOpen: () => void }) {
  return (
    <button type="button" className="sv-thumb" onClick={onOpen} title={`${KIND[capture.kind]}, ${day(capture.captured_at)}`}>
      {capture.photo_url ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed link to a private survey photo
        <img src={capture.photo_url} alt={`${KIND[capture.kind]} photo`} loading="lazy" />
      ) : (
        <span>Aa</span>
      )}
      <small>{KIND[capture.kind]}</small>
    </button>
  );
}

export default function Survey({ say }: { say: Say }) {
  const [data, setData] = useState<SurveyData | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [naming, setNaming] = useState<{ id: string | null; name: string } | null>(null);
  const [armed, setArmed] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async (location?: string) => {
    try {
      const res = await fetch(`/api/survey${location ? `?location=${encodeURIComponent(location)}` : ""}`, { cache: "no-store" });
      const reply = (await res.json()) as SurveyReply;
      if (reply.ok) setData(reply.data);
      else setError(reply.message);
    } catch {
      setError("The survey could not be reached. Check your connection and reload.");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const locationId = data?.location_id ?? null;
  const act = useCallback(
    async (action: string, payload: Record<string, unknown> = {}) => {
      try {
        const res = await fetch("/api/survey", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ location_id: locationId ?? undefined, ...payload, action }),
        });
        const reply = (await res.json()) as SurveyReply;
        if (reply.ok) {
          setData(reply.data);
          return reply.result ?? {};
        }
        say(reply.message, true);
        return null;
      } catch {
        say("That change did not save. Check your connection and try again.", true);
        return null;
      }
    },
    [locationId, say],
  );

  const byId = useMemo(() => new Map((data?.captures ?? []).map((c) => [c.id, c])), [data]);

  if (error) {
    return (
      <p className="empty err" role="alert">
        {error}
      </p>
    );
  }
  if (!data) return <p className="empty">Loading the survey…</p>;

  const { parts, waiting, unread } = data.survey;
  const location = data.locations.find((l) => l.id === data.location_id) ?? null;
  const needsLook = (p: SurveyPart) => p.flags.some((f) => f !== "rough_count");
  const counts = {
    all: parts.length,
    look: parts.filter(needsLook).length,
    nocard: parts.filter((p) => !p.has_card).length,
    nobin: parts.filter((p) => !p.has_bin).length,
  };
  const shown = parts.filter((p) =>
    filter === "look" ? needsLook(p) : filter === "nocard" ? !p.has_card : filter === "nobin" ? !p.has_bin : true,
  );
  const open = editing ? (byId.get(editing) ?? null) : null;
  const openStore = open ? data.store[normPart(open.part_number)] : undefined;
  const unreadPhotos = data.captures.filter((c) => c.status !== "read" && c.photo && !c.edited).length;

  function edit(c: Capture) {
    setDraft(toDraft(c));
    setArmed("");
    setEditing(c.id);
  }

  async function saveEdit() {
    if (!open || !draft) return;
    const onCard = toCount(draft.qty_on_card);
    const seen = toCount(draft.count_seen);
    if (onCard === undefined || seen === undefined) {
      say("Quantities must be whole numbers, 0 or more.", true);
      return;
    }
    const done = await act("capture.update", {
      id: open.id,
      fields: {
        part_number: draft.part_number,
        upc: draft.upc,
        aisle: draft.aisle,
        bin: draft.bin,
        description: draft.description,
        notes: draft.notes,
        qty_on_card: onCard,
        count_seen: seen,
      },
    });
    if (done) setEditing(null);
  }

  async function readAll() {
    setBusy("read");
    let total = 0;
    for (let round = 0; round < 60; round++) {
      const result = await act("capture.read");
      if (!result) break;
      total += Number(result.read ?? 0);
      if (Number(result.failed ?? 0) > 0) {
        say("Some photos could not be read. Open them to see why, or type the details in.", true);
        break;
      }
      if (!Number(result.remaining ?? 0)) break;
    }
    if (total) say(`${total} photo${total === 1 ? "" : "s"} read.`);
    setBusy("");
  }

  async function saveName() {
    if (!naming) return;
    const done = naming.id
      ? await act("location.rename", { id: naming.id, name: naming.name })
      : await act("location.create", { name: naming.name });
    if (done) setNaming(null);
  }

  const field = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => (d ? { ...d, [key]: e.target.value } : d));

  return (
    <>
      <div className="inv-head">
        <div>
          <p className="eyebrow">Inventory survey</p>
          <h1>Survey</h1>
        </div>
        <a className="btn" href="/capture">
          Open capture on this device
        </a>
      </div>
      <p className="sub">
        Photograph inventory cards and parts bins from your phone in any order. Captures that share a part number, a
        scanned code, or an aisle and bin are grouped into one part here, however far apart they were taken.
      </p>

      <div className="card">
        <div className="inline">
          <label htmlFor="sv-loc" className="lbl" style={{ margin: 0 }}>
            Location
          </label>
          <select
            id="sv-loc"
            className="field sv-pick"
            value={data.location_id ?? ""}
            onChange={(e) => {
              setFilter("all");
              void load(e.target.value);
            }}
          >
            {data.locations.length === 0 && <option value="">No locations yet</option>}
            {data.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.captures})
              </option>
            ))}
          </select>
          <button type="button" className="btn ghost sm" onClick={() => setNaming({ id: null, name: "" })}>
            New location
          </button>
          {location && (
            <>
              <button type="button" className="btn ghost sm" onClick={() => setNaming({ id: location.id, name: location.name })}>
                Rename
              </button>
              <button
                type="button"
                className="btn danger sm"
                onClick={async () => {
                  if (armed !== "location") {
                    setArmed("location");
                    return;
                  }
                  setArmed("");
                  if (await act("location.delete", { id: location.id })) say("Location and its captures deleted.");
                }}
              >
                {armed === "location" ? `Tap again to delete all ${location.captures} captures` : "Delete"}
              </button>
            </>
          )}
        </div>
        {naming && (
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
          >
            <input
              className="field sv-pick"
              aria-label="Location name"
              placeholder="Shop or room name"
              autoFocus
              maxLength={60}
              value={naming.name}
              onChange={(e) => setNaming({ ...naming, name: e.target.value })}
            />
            <button type="submit" className="btn sm">
              Save
            </button>
            <button type="button" className="btn ghost sm" onClick={() => setNaming(null)}>
              Cancel
            </button>
          </form>
        )}
        {!data.reading && (
          <p className="warn">
            Photo reading is off. Photos upload and are kept, but nothing is read from them until ANTHROPIC_API_KEY is
            added in Vercel (Project, Settings, Environment Variables) and the site is redeployed.
          </p>
        )}
        {data.reading && unreadPhotos > 0 && (
          <div className="inline">
            <span className="warn">
              {unreadPhotos} photo{unreadPhotos === 1 ? " has" : "s have"} not been read yet.
            </span>
            <button type="button" className="btn sm" disabled={busy === "read"} onClick={readAll}>
              {busy === "read" ? "Reading…" : "Read them now"}
            </button>
          </div>
        )}
      </div>

      {!location ? (
        <p className="empty">Add a location, then open capture on your phone to start photographing.</p>
      ) : (
        <>
          <div className="chips" role="group" aria-label="Show">
            {(
              [
                ["all", "All parts"],
                ["look", "Needs a look"],
                ["nocard", "No card yet"],
                ["nobin", "No bin photo yet"],
              ] as Array<[Filter, string]>
            ).map(([key, label]) => (
              <button key={key} type="button" className="chip" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                {label}
                <span className="n">{counts[key]}</span>
              </button>
            ))}
          </div>

          {shown.length === 0 ? (
            <p className="empty">
              {parts.length === 0 ? "No parts yet. Captures appear here as soon as they upload." : "Nothing in this view."}
            </p>
          ) : (
            <ul className="sv-list">
              {shown.map((p) => {
                const inStore = data.store[normPart(p.part_number)];
                const best = p.counted ?? p.card_qty;
                return (
                  <li key={p.key} className="sv-part">
                    <div className="sv-head">
                      <div className="sv-id">
                        <strong className="mono">{p.part_number || "No part number yet"}</strong>
                        <span>{p.description || p.part_type || "No description"}</span>
                      </div>
                      <span className="sv-where mono">
                        {p.aisle || p.bin ? [p.aisle && `Aisle ${p.aisle}`, p.bin && `Bin ${p.bin}`].filter(Boolean).join(" · ") : "No location"}
                      </span>
                    </div>
                    <div className="sv-nums">
                      <span className={`pill ${p.has_card ? "ok" : "muted"}`}>
                        {p.card_qty != null ? `Card says ${p.card_qty}` : p.has_card ? "Card, no quantity read" : "No card yet"}
                        {p.card_at ? ` · ${day(p.card_at)}` : ""}
                      </span>
                      <span className={`pill ${p.has_bin ? "ok" : "muted"}`}>
                        {p.counted != null
                          ? `${p.counted_confidence === "low" ? "About " : ""}${p.counted} in bin${p.counted_confidence && p.counted_confidence !== "high" ? ` (${p.counted_confidence} confidence)` : ""}`
                          : p.has_bin
                            ? "Bin, not counted"
                            : "No bin photo yet"}
                        {p.counted_at ? ` · ${day(p.counted_at)}` : ""}
                      </span>
                      {p.flags.map((f) => (
                        <span key={f} className={`pill ${FLAG_TONE[f]}`}>
                          {FLAG_TEXT[f]}
                        </span>
                      ))}
                    </div>
                    {p.counted_note && <p className="hint">{p.counted_note}</p>}
                    {p.flags.includes("conflict") && (
                      <p className="warn">
                        {p.part_number} and {p.other_numbers.join(", ")} ended up in one group. Open the capture that is
                        wrong and correct it, or separate it from this part.
                      </p>
                    )}
                    {p.flags.includes("lookalike") && (
                      <p className="warn">
                        Looks like {p.lookalikes.join(", ")} elsewhere in this survey. If it is the same part, correct the
                        number on one of them and they will join.
                      </p>
                    )}
                    {p.by_location.length > 0 && (
                      <div className="inline">
                        <span className="warn">
                          {p.by_location.length === 1 ? "One capture is" : `${p.by_location.length} captures are`} here only
                          because of the aisle and bin. Same part?
                        </span>
                        <button type="button" className="btn sm" onClick={() => act("capture.confirm", { ids: p.by_location })}>
                          Yes, same part
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={async () => {
                            for (const id of p.by_location) await act("capture.unlink", { id });
                          }}
                        >
                          No, separate
                        </button>
                      </div>
                    )}
                    <div className="sv-thumbs">
                      {p.captures.map((id) => {
                        const c = byId.get(id);
                        return c ? <Thumb key={id} capture={c} onOpen={() => edit(c)} /> : null;
                      })}
                    </div>
                    {p.part_number && (
                      <div className="inline sv-store">
                        {inStore ? (
                          <>
                            <span className="hint">
                              In the shop catalog as {inStore.name}, quantity {inStore.qty}.
                            </span>
                            {best != null && best !== inStore.qty && (
                              <button
                                type="button"
                                className="btn ghost sm"
                                onClick={async () => {
                                  if (await act("part.set_qty", { product_id: inStore.id, qty: best })) say(`Shop quantity set to ${best}.`);
                                }}
                              >
                                Set shop quantity to {best}
                              </button>
                            )}
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={async () => {
                              const made = await act("part.to_store", {
                                name: p.description || p.part_type || p.part_number,
                                part_number: p.part_number,
                                description: p.description,
                              });
                              if (made) say("Added to the shop catalog with quantity 0 and no price. Finish it under Inventory.");
                            }}
                          >
                            Add to shop catalog
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {waiting.length + unread.length > 0 && (
            <div className="card">
              <h2>Waiting for a match</h2>
              <p className="hint">
                Nothing in these could be tied to a part yet. They will join on their own when a later capture supplies
                the link, or you can open one and type its part number or bin.
              </p>
              <div className="sv-thumbs">
                {[...waiting, ...unread].map((c) => (
                  <Thumb key={c.id} capture={c} onOpen={() => edit(c)} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <Modal
        open={!!open}
        onClose={() => setEditing(null)}
        title={open ? `${KIND[open.kind]} · ${day(open.captured_at)}` : "Capture"}
        footer={
          open && (
            <>
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  if (armed !== "capture") {
                    setArmed("capture");
                    return;
                  }
                  if (await act("capture.delete", { id: open.id })) setEditing(null);
                }}
              >
                {armed === "capture" ? "Tap again to delete" : "Delete"}
              </button>
              <button type="button" className="btn" onClick={saveEdit}>
                Save
              </button>
            </>
          )
        }
      >
        {open && draft && (
          <>
            {open.photo_url && (
              // eslint-disable-next-line @next/next/no-img-element -- signed link to a private survey photo
              <img className="cap-photo" src={open.photo_url} alt="The captured photo" />
            )}
            {open.status === "failed" && <p className="err">{open.read_error}</p>}
            {open.status === "pending" && <p className="hint">This photo has not been read yet.</p>}
            {open.codes.length > 0 && <p className="hint mono">Scanned: {open.codes.join(", ")}</p>}
            {open.count_note && <p className="hint">{open.count_note}</p>}
            <div className="form">
              <label htmlFor="e-pn">
                Part number
                <input id="e-pn" className="mono" autoComplete="off" value={draft.part_number} onChange={field("part_number")} />
              </label>
              <div className="two">
                <label htmlFor="e-aisle">
                  Aisle
                  <input id="e-aisle" autoComplete="off" value={draft.aisle} onChange={field("aisle")} />
                </label>
                <label htmlFor="e-bin">
                  Bin
                  <input id="e-bin" autoComplete="off" value={draft.bin} onChange={field("bin")} />
                </label>
              </div>
              <div className="two">
                <label htmlFor="e-card">
                  On hand, per the card
                  <input id="e-card" inputMode="numeric" autoComplete="off" value={draft.qty_on_card} onChange={field("qty_on_card")} />
                </label>
                <label htmlFor="e-count">
                  Counted in the bin
                  <input id="e-count" inputMode="numeric" autoComplete="off" value={draft.count_seen} onChange={field("count_seen")} />
                </label>
              </div>
              <label htmlFor="e-upc">
                UPC
                <input id="e-upc" className="mono" inputMode="numeric" autoComplete="off" value={draft.upc} onChange={field("upc")} />
              </label>
              <label htmlFor="e-desc">
                Description
                <input id="e-desc" autoComplete="off" value={draft.description} onChange={field("description")} />
              </label>
              <label htmlFor="e-notes">
                Notes
                <input id="e-notes" autoComplete="off" value={draft.notes} onChange={field("notes")} />
              </label>
            </div>
            <div className="inline">
              {open.bin &&
                (open.use_location ? (
                  <button type="button" className="btn ghost sm" onClick={() => act("capture.unlink", { id: open.id })}>
                    Stop matching this by its bin
                  </button>
                ) : (
                  <button type="button" className="btn ghost sm" onClick={() => act("capture.relink", { id: open.id })}>
                    Match this by its bin again
                  </button>
                ))}
              {open.photo && openStore && (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={async () => {
                    if (await act("capture.to_product_photo", { id: open.id, product_id: openStore.id })) {
                      say(`Photo added to ${openStore.name} in the shop.`);
                    }
                  }}
                >
                  Use as a shop photo for {openStore.name}
                </button>
              )}
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
