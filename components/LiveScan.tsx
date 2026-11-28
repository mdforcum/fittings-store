"use client";
// A live camera view that reads bar codes as they pass in front of the lens:
// no photo to take, no button to press. Uses the phone's own reader where
// there is one and the built-in decoder otherwise. The camera is switched off
// the moment this closes.
import { useEffect, useRef, useState } from "react";
import { findCodes } from "@/lib/scan";

/** Plain words for why the camera didn't open. */
export function cameraProblem(name: string): string {
  if (name === "NotAllowedError" || name === "SecurityError") return "The camera is turned off for this site. Allow the camera in your browser's settings, or use Photo or barcode instead.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this device. Type the number, or use a plug-in scanner.";
  if (name === "NotReadableError") return "Another app is using the camera. Close it and try again.";
  return "The camera couldn't be opened. Use Photo or barcode instead.";
}

/**
 * A label held in front of the camera counts once, however long it stays
 * there. It counts again only after it has been out of view this long, so
 * scanning the same part twice means taking it away and bringing it back.
 */
export const AWAY_MS = 1500;

export default function LiveScan({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const handler = useRef(onCode);
  const [error, setError] = useState("");
  const [last, setLast] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    handler.current = onCode;
  }, [onCode]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = new Map<string, number>();
    const tick = async () => {
      if (stopped) return;
      const v = video.current;
      try {
        if (v && v.readyState >= 2 && v.videoWidth > 0) {
          const frame = await createImageBitmap(v);
          let codes: string[] = [];
          try {
            codes = await findCodes(frame);
          } finally {
            frame.close();
          }
          const now = Date.now();
          const fresh = codes.find((c) => (seen.get(c) ?? 0) < now - AWAY_MS);
          for (const c of codes) seen.set(c, now);
          if (fresh && !stopped) {
            navigator.vibrate?.(60);
            setLast(fresh);
            handler.current(fresh);
          }
        }
      } catch {
        /* a frame that couldn't be read: try the next one */
      }
      if (!stopped) timer = setTimeout(tick, 220);
    };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
      } catch (e) {
        if (!stopped) setError(cameraProblem((e as { name?: string })?.name ?? ""));
        return;
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current;
      if (!v) return;
      v.srcObject = stream;
      await v.play().catch(() => undefined);
      if (stopped) return;
      setReady(true);
      void tick();
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="ls" role="group" aria-label="Camera scanner">
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : (
        <div className="ls-view">
          <video ref={video} playsInline muted aria-label="Camera view" />
          <span className="ls-guide" aria-hidden="true" />
        </div>
      )}
      <p className="hint" role="status">
        {error ? "" : last ? `Read ${last}. Hold the next label in the box.` : ready ? "Hold a bar code or bin label in the box. It reads on its own." : "Starting the camera…"}
      </p>
      <button type="button" className="btn ghost" onClick={onClose}>
        {error ? "Close" : "Stop camera"}
      </button>
    </div>
  );
}
