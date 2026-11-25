// Receives one capture from the phone: a photo (already shrunk on the phone),
// any codes it found, and anything typed in. Stores it, reads the photo if
// reading is switched on, and answers with what was read.
//
// Safe to send twice: the phone makes the capture's id, so a retry after a
// dropped connection lands on the same row instead of making a second one.
import { isAdmin, sameOrigin } from "@/lib/auth";
import type { Capture, CaptureKind } from "@/lib/match";
import { mergeTyped, type Reading } from "@/lib/reading";
import { T, adminDb, json } from "@/lib/server";
import { UUID, normalizeCapture, withPhotoLinks } from "@/lib/survey-server";
import type { CaptureMeta } from "@/lib/survey-types";
import { VisionError, readPhoto, visionReady } from "@/lib/vision";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KINDS: CaptureKind[] = ["card", "bin", "code", "manual"];
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const qty = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100000 ? Math.round(v) : null;

const bad = (message: string, status = 400) => json({ ok: false, message }, status);

export async function POST(req: Request) {
  if (!sameOrigin(req) || !(await isAdmin())) return bad("Please sign in again.", 401);

  let meta: CaptureMeta;
  let photo: Blob | null = null;
  try {
    const form = await req.formData();
    meta = JSON.parse(String(form.get("meta") ?? "")) as CaptureMeta;
    const file = form.get("photo");
    if (file instanceof Blob && file.size > 0) photo = file;
  } catch {
    return bad("That capture could not be read.");
  }

  if (!UUID.test(meta?.id ?? "") || !UUID.test(meta?.location_id ?? "")) return bad("That capture is missing its id.");
  const kind = KINDS.includes(meta.kind) ? meta.kind : null;
  if (!kind) return bad("That capture has no type.");
  if (kind !== "manual" && !photo) return bad("That capture has no photo.");
  if (photo && (!TYPES.has(photo.type) || photo.size > 4_000_000)) {
    return bad("Use a JPG, PNG or WebP photo under 4 MB.", 413);
  }
  const when = new Date(meta.captured_at);
  const capturedAt = Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 86_400_000 ? new Date() : when;

  const f = meta.fields ?? {};
  const typed: Partial<Capture> = {
    part_number: str(f.part_number, 60),
    upc: str(f.upc, 20).replace(/\D/g, ""),
    description: str(f.description, 200),
    aisle: str(f.aisle, 20),
    bin: str(f.bin, 20),
    qty_on_card: qty(f.qty_on_card),
    count_seen: qty(f.count_seen),
    notes: str(f.notes, 300),
  };
  const codes = (Array.isArray(meta.codes) ? meta.codes : [])
    .map((c) => str(c, 80))
    .filter(Boolean)
    .slice(0, 10);
  const typedSomething = !!(typed.part_number || typed.aisle || typed.bin || typed.qty_on_card != null || typed.count_seen != null);

  try {
    const db = adminDb();

    // A location made on the phone while out of signal arrives with its first capture.
    const loc = await db.from(T.locations).select("id").eq("id", meta.location_id).maybeSingle();
    if (!loc.data) {
      const name = str(meta.location_name, 60);
      if (!name) return bad("That location no longer exists. Pick another and try again.", 409);
      const made = await db.from(T.locations).upsert({ id: meta.location_id, name });
      if (made.error) throw new Error(made.error.message);
    }

    const existing = await db.from(T.captures).select("*").eq("id", meta.id).maybeSingle();
    if (existing.data && existing.data.status === "read") {
      const [done] = await withPhotoLinks(db, [normalizeCapture(existing.data)]);
      return json({ ok: true, capture: done });
    }

    let path: string | null = (existing.data?.photo as string | null) ?? null;
    let bytes: Buffer | null = null;
    if (photo) {
      bytes = Buffer.from(await photo.arrayBuffer());
      path = `${meta.location_id}/${meta.id}.${photo.type === "image/png" ? "png" : photo.type === "image/webp" ? "webp" : "jpg"}`;
      const up = await db.storage
        .from(T.privateBucket)
        .upload(path, bytes, { contentType: photo.type, upsert: true });
      if (up.error) throw new Error(up.error.message);
    }

    let read: Reading | null = null;
    let status: Capture["status"] = "read";
    let readError = "";
    if (photo && bytes) {
      if (!visionReady()) {
        status = "pending";
        readError = "Photo reading is not switched on yet.";
      } else {
        try {
          read = await readPhoto(kind, bytes, photo.type);
        } catch (e) {
          status = "failed";
          readError = e instanceof VisionError ? e.message : "The photo could not be read.";
          if (!(e instanceof VisionError)) console.error("capture read failed", e);
        }
      }
    }

    const row = {
      id: meta.id,
      location_id: meta.location_id,
      kind,
      captured_at: capturedAt.toISOString(),
      status,
      read_error: readError,
      photo: path,
      codes,
      edited: kind === "manual" || typedSomething,
      ...mergeTyped(typed, read),
    };
    const saved = await db.from(T.captures).upsert(row).select("*").single();
    if (saved.error) throw new Error(saved.error.message);
    const [capture] = await withPhotoLinks(db, [normalizeCapture(saved.data)]);
    return json({ ok: true, capture });
  } catch (e) {
    console.error("capture upload failed", e);
    return bad("That capture did not save. It will be tried again.", 500);
  }
}
