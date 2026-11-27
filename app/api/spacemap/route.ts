// Back office: the Space mapper. Photos and notes of a shop go in; a layout
// file (lib/spacemap.ts) and the reader's questions come out; the file goes on
// the shelf map when the person says so. Admin only.
//
// GET                              every map, in brief
// GET  ?id=<map>                   one map: file, photos, questions, what applying would do
// POST form {meta, photo}          add a photo {id, photo_id, note}
// POST {action:"map.create"}       {name, code, from_spot?}
// POST {action:"map.save"}         {id, name?, notes?, markup?}
// POST {action:"map.delete"}       {id}
// POST {action:"photo.note"}       {id, photo_id, note}
// POST {action:"photo.remove"}     {id, photo_id}
// POST {action:"read"}             {id, answers?: {<question id>: text}} read the photos again
// POST {action:"apply"}            {id} put the file on the shelf map
import { isAdmin, sameOrigin } from "@/lib/auth";
import { T, adminDb, json } from "@/lib/server";
import { normCode } from "@/lib/shelf";
import { parseSpaceMap } from "@/lib/spacemap";
import {
  MAPS,
  MAX_KEPT,
  PHOTOS,
  applyMap,
  firstMarkup,
  listMaps,
  loadMap,
  loadSpots,
  missing,
  normalizeMap,
  readMap,
  viewMap,
} from "@/lib/spacemap-server";
import { VisionError, visionReady } from "@/lib/vision";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SETUP = "The Space mapper is not set up yet: run supabase/add-space-maps.sql on the database.";
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const bad = (message: string, status = 400) => json({ ok: false, message }, status);
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const line = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

export async function GET(req: Request) {
  if (!(await isAdmin())) return bad("Please sign in again.", 401);
  const id = new URL(req.url).searchParams.get("id");
  try {
    const db = adminDb();
    if (!id) {
      const [maps, spots] = await Promise.all([listMaps(db), loadSpots(db)]);
      if (!maps) return bad(SETUP, 503);
      const locations = (spots ?? []).filter((s) => !s.parent_id).map((s) => ({ id: s.id, code: s.code, name: s.label || `${s.level} ${s.code}` }));
      return json({ ok: true, maps, locations, vision: visionReady(), shelf_ready: !!spots });
    }
    if (!isId(id)) return bad("That map no longer exists.", 404);
    const row = await loadMap(db, id);
    if (!row) return bad("That map no longer exists.", 404);
    return json({ ok: true, map: await viewMap(db, row), vision: visionReady() });
  } catch (e) {
    if (missing(e as { code?: string; message?: string })) return bad(SETUP, 503);
    console.error("space map load failed", e);
    return bad("The map could not be loaded.", 500);
  }
}

async function addPhoto(req: Request): Promise<Response> {
  let meta: Record<string, unknown>;
  let photo: Blob | null = null;
  try {
    const form = await req.formData();
    meta = JSON.parse(String(form.get("meta") ?? "")) as Record<string, unknown>;
    const file = form.get("photo");
    if (file instanceof Blob && file.size > 0) photo = file;
  } catch {
    return bad("That photo could not be read.");
  }
  if (!isId(meta?.id) || !isId(meta?.photo_id)) return bad("That photo is missing its id.");
  if (!photo) return bad("That upload has no photo.");
  const ext = TYPES[photo.type];
  if (!ext || photo.size > 4_000_000) return bad("Use a JPG, PNG or WebP photo under 4 MB.", 413);
  const db = adminDb();
  const map = await loadMap(db, meta.id);
  if (!map) return bad("That map no longer exists.", 404);
  const have = await db.from(PHOTOS).select("id").eq("map_id", map.id).limit(MAX_KEPT + 1);
  if (have.error) throw new Error(have.error.message);
  const ids = (have.data ?? []).map((r) => r.id as string);
  if (!ids.includes(meta.photo_id) && ids.length >= MAX_KEPT) {
    return bad(`A map keeps ${MAX_KEPT} photos. Remove some old ones first; what they showed is already in the file.`);
  }
  const path = `spacemap/${map.id}/${meta.photo_id}.${ext}`;
  const up = await db.storage.from(T.privateBucket).upload(path, Buffer.from(await photo.arrayBuffer()), { contentType: photo.type, upsert: true });
  if (up.error) throw new Error(up.error.message);
  // Safe to send twice: the phone makes the photo's id.
  const saved = await db.from(PHOTOS).upsert({ id: meta.photo_id, map_id: map.id, path, note: line(meta.note, 400) }, { onConflict: "id" });
  if (saved.error) throw new Error(saved.error.message);
  return json({ ok: true, map: await viewMap(db, map) });
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return bad("That request came from somewhere else.", 403);
  if (!(await isAdmin())) return bad("Please sign in again.", 401);
  try {
    if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) return await addPhoto(req);

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return bad("That request was not readable.");
    }
    const db = adminDb();

    if (body.action === "map.create") {
      const name = line(body.name, 80);
      if (!name) return bad("Give the map a name, like the shop's name.");
      const fromSpot = isId(body.from_spot) ? body.from_spot : null;
      const code = normCode(String(body.code ?? ""));
      if (!fromSpot && !code) return bad("Give the location a short code: 1 to 6 letters or digits, like MCD.");
      const spots = await loadSpots(db);
      const made = await db.from(MAPS).insert({ name, markup: firstMarkup(name, code ?? "", spots, fromSpot) }).select("*").single();
      if (made.error) throw made.error;
      return json({ ok: true, map: await viewMap(db, normalizeMap(made.data as Record<string, unknown>)) });
    }

    if (!isId(body.id)) return bad("That map no longer exists.", 404);
    const row = await loadMap(db, body.id);
    if (!row) return bad("That map no longer exists.", 404);

    if (body.action === "map.save") {
      const change: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof body.name === "string") {
        const name = line(body.name, 80);
        if (!name) return bad("A map needs a name.");
        change.name = name;
      }
      if (typeof body.notes === "string") change.notes = body.notes.replace(/\r\n?/g, "\n").trim().slice(0, 4000);
      if (typeof body.markup === "string") {
        if (body.markup.length > 200_000) return bad("That file is too long to save.");
        change.markup = body.markup.replace(/\r\n?/g, "\n");
      }
      const saved = await db.from(MAPS).update(change).eq("id", row.id).select("*").single();
      if (saved.error) throw new Error(saved.error.message);
      return json({ ok: true, map: await viewMap(db, normalizeMap(saved.data as Record<string, unknown>)) });
    }

    if (body.action === "map.delete") {
      const photos = await db.from(PHOTOS).select("path").eq("map_id", row.id).limit(MAX_KEPT);
      const paths = (photos.data ?? []).map((p) => p.path as string);
      if (paths.length) await db.storage.from(T.privateBucket).remove(paths);
      const gone = await db.from(MAPS).delete().eq("id", row.id);
      if (gone.error) throw new Error(gone.error.message);
      return json({ ok: true });
    }

    if (body.action === "photo.note" || body.action === "photo.remove") {
      if (!isId(body.photo_id)) return bad("That photo no longer exists.");
      const found = await db.from(PHOTOS).select("id, path").eq("id", body.photo_id).eq("map_id", row.id).maybeSingle();
      if (found.error) throw new Error(found.error.message);
      if (!found.data) return bad("That photo no longer exists.");
      if (body.action === "photo.note") {
        const { error } = await db.from(PHOTOS).update({ note: line(body.note, 400) }).eq("id", body.photo_id);
        if (error) throw new Error(error.message);
      } else {
        await db.storage.from(T.privateBucket).remove([found.data.path as string]);
        const { error } = await db.from(PHOTOS).delete().eq("id", body.photo_id);
        if (error) throw new Error(error.message);
      }
      return json({ ok: true, map: await viewMap(db, row) });
    }

    if (body.action === "read") {
      if (!visionReady()) return bad("Photo reading is not switched on yet: add ANTHROPIC_API_KEY in Vercel. Until then you can write the file by hand.", 503);
      const answers = body.answers && typeof body.answers === "object" ? (body.answers as Record<string, unknown>) : {};
      try {
        const { row: next, problems } = await readMap(db, row, answers);
        return json({ ok: true, map: await viewMap(db, next), problems: problems.length, spots: parseSpaceMap(next.markup).count });
      } catch (e) {
        if (e instanceof VisionError) return bad(e.message, 502);
        throw e;
      }
    }

    if (body.action === "apply") {
      const done = await applyMap(db, row);
      if (!done.ok) return bad(done.message);
      return json({ ok: true, map: await viewMap(db, done.row), adds: done.adds, changes: done.changes });
    }

    return bad("Unknown action.");
  } catch (e) {
    if (missing(e as { code?: string; message?: string })) return bad(SETUP, 503);
    console.error("space map change failed", e);
    return bad("That did not save. Try again.", 500);
  }
}
