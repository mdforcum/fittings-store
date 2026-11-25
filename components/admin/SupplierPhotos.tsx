"use client";
// Supplier photos: reads the distributor's own catalog pages, finds the photo
// for each part we stock, and holds it until permission is recorded.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SupplierData, SupplierReply } from "@/lib/survey-types";
import type { Say } from "../Admin";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

export default function SupplierPhotos({ say }: { say: Say }) {
  const [data, setData] = useState<SupplierData | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [pages, setPages] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const stop = useRef(false);

  const call = useCallback(
    async (body: Record<string, unknown> | null) => {
      try {
        const res = await fetch("/api/supplier", {
          method: body ? "POST" : "GET",
          cache: "no-store",
          ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
        });
        const reply = (await res.json()) as SupplierReply;
        if (reply.ok) {
          setData(reply.data);
          return reply;
        }
        if (body) say(reply.message, true);
        else setError(reply.message);
      } catch {
        if (body) say("That did not go through. Check your connection.", true);
        else setError("The supplier photos could not be reached. Check your connection and reload.");
      }
      return null;
    },
    [say],
  );

  useEffect(() => {
    const t = setTimeout(() => void call(null), 0);
    return () => {
      clearTimeout(t);
      stop.current = true;
    };
  }, [call]);

  /** Works through the queue one request at a time, waiting as long as the supplier asks between each. */
  const work = useCallback(async () => {
    stop.current = false;
    setRunning(true);
    for (let i = 0; i < 400 && !stop.current; i++) {
      const reply = await call({ action: "step" });
      if (!reply) break;
      const result = (reply.result ?? {}) as { wait?: number; remaining?: number };
      if (!result.remaining) break;
      for (let s = Math.max(1, result.wait ?? 1); s > 0 && !stop.current; s--) {
        setCountdown(s);
        await new Promise((r) => setTimeout(r, 1000));
      }
      setCountdown(0);
    }
    setCountdown(0);
    setRunning(false);
  }, [call]);

  if (error) {
    return (
      <p className="empty err" role="alert">
        {error}
      </p>
    );
  }
  if (!data) return <p className="empty">Loading supplier photos…</p>;

  const found = data.products.filter((p) => p.found && !p.imported.length && !p.queued);
  const imported = data.products.filter((p) => p.imported.length).length;
  const delay = data.crawl_delay ?? 60;

  return (
    <>
      <div className="inv-head">
        <div>
          <p className="eyebrow">{data.source.name}</p>
          <h1>Supplier photos</h1>
        </div>
      </div>
      <p className="sub">
        Finds the supplier&apos;s own product photo for each part you stock, matched by part number, and adds it to the
        shop once you have their permission.
      </p>

      <div className="card">
        <h2>Permission</h2>
        <div className="inline">
          <span className={`pill ${data.permission ? "ok" : "hold"}`}>
            {data.permission ? "Recorded: imported photos show in the shop" : "Not recorded: imported photos are on hold"}
          </span>
          {data.permission_at && <span className="hint">since {when(data.permission_at)}</span>}
        </div>
        <p className="hint">
          Product photos belong to whoever took them. Until {data.source.name} says you may use theirs, anything imported
          here stays in the back office and shoppers never see it. Turn this on once you have their answer in writing,
          and note who gave it.
        </p>
        <div className="form">
          <label htmlFor="sp-note">
            Who gave permission, and when
            <input
              id="sp-note"
              autoComplete="off"
              maxLength={300}
              placeholder="e.g. Email from Jane at Burns Ag, Dec 2"
              value={note ?? data.permission_note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>
        <div className="inline">
          {data.permission ? (
            <button
              type="button"
              className="btn danger sm"
              onClick={async () => {
                if (await call({ action: "permission.set", granted: false, note: note ?? data.permission_note })) {
                  say("Supplier photos taken out of the shop and put back on hold.");
                }
              }}
            >
              Withdraw: take supplier photos out of the shop
            </button>
          ) : (
            <button
              type="button"
              className="btn sm"
              disabled={!(note ?? data.permission_note).trim()}
              onClick={async () => {
                if (await call({ action: "permission.set", granted: true, note: note ?? data.permission_note })) {
                  say("Permission recorded. Imported photos now show in the shop.");
                }
              }}
            >
              Permission received: show them in the shop
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <h2>1. Read their catalog pages</h2>
        <p className="hint">
          These are the category pages on {data.source.host} that list the parts you stock. The importer reads each one
          for part numbers and photos. It follows the site&apos;s published rules for automated readers: it never uses
          site search, and it waits {delay} seconds between requests because that is what the site asks for.
        </p>
        <div className="form">
          <label htmlFor="sp-pages">
            Category pages, one per line
            <textarea
              id="sp-pages"
              className="mono"
              spellCheck={false}
              value={pages ?? data.listings.join("\n")}
              onChange={(e) => setPages(e.target.value)}
            />
          </label>
        </div>
        <div className="inline">
          {pages !== null && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={async () => {
                const urls = pages.split(/\s+/).filter(Boolean);
                if (await call({ action: "listings.set", urls })) {
                  setPages(null);
                  say("Pages saved.");
                }
              }}
            >
              Save pages
            </button>
          )}
          <button
            type="button"
            className="btn sm"
            disabled={running}
            onClick={async () => {
              if (await call({ action: "scan.start" })) void work();
            }}
          >
            Read these pages
          </button>
          <span className="hint">
            {data.index_count} part{data.index_count === 1 ? "" : "s"} known
            {data.scanned_at ? `, last read ${when(data.scanned_at)}` : ""}
          </span>
        </div>
      </div>

      {(data.queue > 0 || running || data.last_error) && (
        <div className="card">
          <h2>Progress</h2>
          <div className="inline">
            <span className={`pill ${running ? "ok" : "hold"}`}>
              {data.queue} request{data.queue === 1 ? "" : "s"} to go
            </span>
            {running && <span className="hint mono">{countdown ? `next in ${countdown}s` : "working…"}</span>}
            {!running && data.queue > 0 && (
              <button type="button" className="btn sm" onClick={() => void work()}>
                Carry on
              </button>
            )}
            {running && (
              <button type="button" className="btn ghost sm" onClick={() => (stop.current = true)}>
                Pause
              </button>
            )}
            {data.queue > 0 && !running && (
              <button type="button" className="btn ghost sm" onClick={() => call({ action: "queue.clear" })}>
                Clear the queue
              </button>
            )}
          </div>
          {running && (
            <p className="hint">
              Keep this tab open. About {Math.ceil((data.queue * delay) / 60)} minute{data.queue * delay > 60 ? "s" : ""} left.
              If you close it, press Carry on next time and it picks up where it stopped.
            </p>
          )}
          {data.last_error && <p className="warn">{data.last_error}</p>}
        </div>
      )}

      <div className="card">
        <div className="inline" style={{ justifyContent: "space-between" }}>
          <h2>2. Match and import</h2>
          <button
            type="button"
            className="btn sm"
            disabled={running || found.length === 0}
            onClick={async () => {
              if (await call({ action: "import.queue" })) void work();
            }}
          >
            Import all {found.length} found
          </button>
        </div>
        <p className="hint">
          {imported} of {data.products.length} items have a supplier photo. Your own photos always stay first in the shop.
        </p>
        <ul className="sp-list">
          {data.products.map((p) => (
            <li key={p.id} className="sp-row">
              <div className="sp-pic">
                {p.imported[0]?.preview_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- imported copy, already sized
                  <img src={p.imported[0].preview_url} alt={`Supplier photo of ${p.name}`} loading="lazy" />
                ) : p.found ? (
                  // eslint-disable-next-line @next/next/no-img-element -- preview straight from the supplier's page
                  <img src={p.found.image_url} alt={`Supplier photo of ${p.name}`} loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <span>—</span>
                )}
              </div>
              <div className="sp-info">
                <strong>{p.name}</strong>
                <span className="mono">{p.part_number || "No part number"}</span>
                {p.found && !p.imported.length && (
                  <a className="hint" href={p.found.page_url} target="_blank" rel="noreferrer">
                    Found: {p.found.name}
                  </a>
                )}
                {!p.found && !p.imported.length && !p.queued && (
                  <form
                    className="inline"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (await call({ action: "page.queue", product_id: p.id, url: links[p.id] ?? "" })) {
                        setLinks((l) => ({ ...l, [p.id]: "" }));
                        void work();
                      }
                    }}
                  >
                    <input
                      className="field"
                      aria-label={`Supplier product page for ${p.name}`}
                      placeholder={`Paste its page on ${data.source.host}`}
                      value={links[p.id] ?? ""}
                      onChange={(e) => setLinks((l) => ({ ...l, [p.id]: e.target.value }))}
                    />
                    <button type="submit" className="btn ghost sm" disabled={running || !(links[p.id] ?? "").trim()}>
                      Fetch
                    </button>
                  </form>
                )}
              </div>
              <div className="sp-act">
                {p.imported.length > 0 ? (
                  <>
                    <span className={`pill ${p.imported[0].published ? "ok" : "hold"}`}>
                      {p.imported[0].published ? "In the shop" : "On hold"}
                    </span>
                    <button type="button" className="linkbtn" onClick={() => call({ action: "photo.remove", id: p.imported[0].id })}>
                      Remove
                    </button>
                  </>
                ) : p.queued ? (
                  <span className="pill muted">Queued</span>
                ) : p.found ? (
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={running}
                    onClick={async () => {
                      if (await call({ action: "import.queue", product_ids: [p.id] })) void work();
                    }}
                  >
                    Import
                  </button>
                ) : (
                  <span className="pill muted">{data.index_count ? "Not found" : "Not read yet"}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
