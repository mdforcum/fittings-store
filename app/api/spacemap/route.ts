// The Space mapper's API. Photos and notes of a shop go in; a layout file
// (lib/spacemap.ts) and the reader's questions come out; the file goes on the
// shelf map when the person says so.
//
// Who may do what:
//   - Every map is the file of one store location, and every request is made
//     under a sign-in: a dealer's own login (scope "dealer", from the dealer
//     portal) or the back office.
//   - A dealer login sees and changes only the maps of its own dealer's
//     locations. Anything else answers "no longer exists", the same as a map
//     that was never there.
//   - The back office sees every dealer's maps, and is the only one that can
//     delete a map.
//   - Each change records who made it.
//
// GET                              the maps this sign-in may use, and its locations
// GET  ?id=<map>                   one map: file, photos, questions, what applying would do
// POST form {meta, photo}          add a photo {id, photo_id, note}
// POST {action:"map.create"}       {location_id}
// POST {action:"map.save"}         {id, notes?, markup?}
// POST {action:"map.delete"}       {id} (back office only)
// POST {action:"photo.note"}       {id, photo_id, note}
// POST {action:"photo.remove"}     {id, photo_id}
// POST {action:"read"}             {id, answers?: {<question id>: text}} read the photos again
// POST {action:"apply"}            {id} put the file on the shelf map
// Dealer-portal requests add scope=dealer (query, body or meta).
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdmin, sameOrigin } from "@/lib/auth";
import { currentDealer } from "@/lib/dealer-session";
import { T, adminDb, json } from "@/lib/server";
import { parseSpaceMap } from "@/lib/spacemap";
import {
  MAPS,
  MAX_KEPT,
  MAX_READS_A_DAY,
  PHOTOS,
  applyMap,
  countRead,
  firstMarkup,
  listMaps,
  loadMap,
  loadSpots,
  missing,
  normalizeMap,
  readMap,
  storeLocations,
  viewMap,
  type MapLocation,
  type SpaceMapRow,
} from "@/lib/spacemap-server";
import { VisionError, visionReady } from "@/lib/vision";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const bad = (message: string, status = 400) => json({ ok: false, message }, status);
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const line = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const GONE = "That map no longer exists.";

/** The person behind a request: the back office, or one dealer's login. */
type Actor = { kind: "admin" | "dealer"; by: string; dealerId: string | null };

/**
 * A dealer-portal request is judged only by the dealer login, a back-office
 * request only by the back-office sign-in: being signed in to one never
 * widens what the other may see.
 */
async function actorFor(db: SupabaseClient, scope: unknown): Promise<Actor | null> {
  if (scope === "dealer") {
    const s = await currentDealer(db);
    return s ? { kind: "dealer", by: s.user.email, dealerId: s.dealer.id } : null;
  }
  return (await isAdmin()) ? { kind: "admin", by: "Backroad Iron back office", dealerId: null } : null;
}

const setup = (a: Actor) =>
  a.kind === "admin"
    ? "The Space mapper is not set up yet: run supabase/add-space-maps.sql and supabase/add-space-map-locations.sql on the database."
    : "Shop layout is not switched on yet. Ask Backroad Iron.";

/** The map and its location, or null when it is not there or not this person's. */
async function mine(db: SupabaseClient, a: Actor, id: unknown): Promise<{ row: SpaceMapRow; loc: MapLocation } | null> {
  if (!isId(id)) return null;
  const [row, locations] = await Promise.all([loadMap(db, id), storeLocations(db, a.dealerId)]);
  const loc = row?.location_id ? locations.find((l) => l.id === row.location_id) : undefined;
  return row && loc ? { row, loc } : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const db = adminDb();
  const a = await actorFor(db, url.searchParams.get("scope"));
  if (!a) return bad("Please sign in again.", 401);
  const id = url.searchParams.get("id");
  try {
    if (!id) {
      const locations = await storeLocations(db, a.dealerId);
      const [maps, spots] = await Promise.all([listMaps(db, locations), loadSpots(db)]);
      if (!maps || !spots) return bad(setup(a), 503);
      const mapped = new Set(maps.map((m) => m.location_id));
      return json({
        ok: true,
        maps,
        locations: locations.map((l) => ({ id: l.id, name: l.name, code: l.code, dealer: l.dealer, mapped: mapped.has(l.id) })),
        vision: visionReady(),
      });
    }
    const found = await mine(db, a, id);
    if (!found) return bad(GONE, 404);
    return json({ ok: true, map: await viewMap(db, found.row, found.loc, a.kind === "admin"), vision: visionReady() });
  } catch (e) {
    if (missing(e as { code?: string; message?: string })) return bad(setup(a), 503);
    console.error("space map load failed", e);
    return bad("The map could not be loaded.", 500);
  }
}

async function addPhoto(db: SupabaseClient, a: Actor, meta: Record<string, unknown>, photo: Blob | null): Promise<Response> {
  if (!isId(meta.id) || !isId(meta.photo_id)) return bad("That photo is missing its id.");
  if (!photo) return bad("That upload has no photo.");
  const ext = TYPES[photo.type];
  if (!ext || photo.size > 4_000_000) return bad("Use a JPG, PNG or WebP photo under 4 MB.", 413);
  const found = await mine(db, a, meta.id);
  if (!found) return bad(GONE, 404);
  const { row, loc } = found;
  const have = await db.from(PHOTOS).select("id, map_id").eq("map_id", row.id).limit(MAX_KEPT + 1);
  if (have.error) throw new Error(have.error.message);
  const ids = (have.data ?? []).map((r) => r.id as string);
  if (!ids.includes(meta.photo_id)) {
    if (ids.length >= MAX_KEPT) return bad(`A map keeps ${MAX_KEPT} photos. Remove some old ones first; what they showed is already in the file.`);
    // The phone makes the photo's id; one that already belongs to another map is not ours to overwrite.
    const taken = await db.from(PHOTOS).select("id").eq("id", meta.photo_id).maybeSingle();
    if (taken.error) throw new Error(taken.error.message);
    if (taken.data) return bad("That photo could not be saved. Take it again.");
  }
  const path = `spacemap/${row.id}/${meta.photo_id}.${ext}`;
  const up = await db.storage.from(T.privateBucket).upload(path, Buffer.from(await photo.arrayBuffer()), { contentType: photo.type, upsert: true });
  if (up.error) throw new Error(up.error.message);
  const saved = await db.from(PHOTOS).upsert({ id: meta.photo_id, map_id: row.id, path, note: line(meta.note, 400), added_by: a.by }, { onConflict: "id" });
  if (saved.error) throw new Error(saved.error.message);
  return json({ ok: true, map: await viewMap(db, row, loc, a.kind === "admin") });
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return bad("That request came from somewhere else.", 403);
  const db = adminDb();
  let body: Record<string, unknown> = {};
  let photo: Blob | null = null;
  const isForm = (req.headers.get("content-type") ?? "").includes("multipart/form-data");
  try {
    if (isForm) {
      const form = await req.formData();
      body = JSON.parse(String(form.get("meta") ?? "")) as Record<string, unknown>;
      const file = form.get("photo");
      if (file instanceof Blob && file.size > 0) photo = file;
    } else {
      body = (await req.json()) as Record<string, unknown>;
    }
  } catch {
    return bad("That request was not readable.");
  }
  if (!body || typeof body !== "object") return bad("That request was not readable.");
  const a = await actorFor(db, body.scope);
  if (!a) return bad("Please sign in again.", 401);
  const mayAdopt = a.kind === "admin";

  try {
    if (isForm) return await addPhoto(db, a, body, photo);

    if (body.action === "map.create") {
      const loc = isId(body.location_id) ? (await storeLocations(db, a.dealerId)).find((l) => l.id === body.location_id) : undefined;
      if (!loc) return bad("Pick one of your locations.");
      if (!loc.code) {
        return bad(a.kind === "admin" ? "Give this location a short code under Dealers, Dealers and locations first; every shelf code starts with it." : "This location has no short code yet. Ask Backroad Iron to set one.");
      }
      const spots = await loadSpots(db);
      const made = await db
        .from(MAPS)
        .insert({ name: loc.name.slice(0, 80) || loc.code, location_id: loc.id, markup: firstMarkup(loc, spots), created_by: a.by, updated_by: a.by })
        .select("*")
        .single();
      if (made.error?.code === "23505") return bad("This location already has a map. Open it from the list.");
      if (made.error) throw made.error;
      return json({ ok: true, map: await viewMap(db, normalizeMap(made.data as Record<string, unknown>), loc, mayAdopt) });
    }

    const found = await mine(db, a, body.id);
    if (!found) return bad(GONE, 404);
    const { row, loc } = found;

    if (body.action === "map.save") {
      const change: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: a.by };
      if (typeof body.notes === "string") change.notes = body.notes.replace(/\r\n?/g, "\n").trim().slice(0, 4000);
      if (typeof body.markup === "string") {
        if (body.markup.length > 200_000) return bad("That file is too long to save.");
        change.markup = body.markup.replace(/\r\n?/g, "\n");
      }
      const saved = await db.from(MAPS).update(change).eq("id", row.id).select("*").single();
      if (saved.error) throw new Error(saved.error.message);
      return json({ ok: true, map: await viewMap(db, normalizeMap(saved.data as Record<string, unknown>), loc, mayAdopt) });
    }

    if (body.action === "map.delete") {
      if (a.kind !== "admin") return bad("Only Backroad Iron can delete a map.", 403);
      const photos = await db.from(PHOTOS).select("path").eq("map_id", row.id).limit(MAX_KEPT);
      const paths = (photos.data ?? []).map((p) => p.path as string);
      if (paths.length) await db.storage.from(T.privateBucket).remove(paths);
      const gone = await db.from(MAPS).delete().eq("id", row.id);
      if (gone.error) throw new Error(gone.error.message);
      return json({ ok: true });
    }

    if (body.action === "photo.note" || body.action === "photo.remove") {
      if (!isId(body.photo_id)) return bad("That photo no longer exists.");
      // The photo must be one of this map's own.
      const hit = await db.from(PHOTOS).select("id, path").eq("id", body.photo_id).eq("map_id", row.id).maybeSingle();
      if (hit.error) throw new Error(hit.error.message);
      if (!hit.data) return bad("That photo no longer exists.");
      if (body.action === "photo.note") {
        const { error } = await db.from(PHOTOS).update({ note: line(body.note, 400) }).eq("id", body.photo_id).eq("map_id", row.id);
        if (error) throw new Error(error.message);
      } else {
        await db.storage.from(T.privateBucket).remove([hit.data.path as string]);
        const { error } = await db.from(PHOTOS).delete().eq("id", body.photo_id).eq("map_id", row.id);
        if (error) throw new Error(error.message);
      }
      await db.from(MAPS).update({ updated_at: new Date().toISOString(), updated_by: a.by }).eq("id", row.id);
      return json({ ok: true, map: await viewMap(db, { ...row, updated_by: a.by }, loc, mayAdopt) });
    }

    if (body.action === "read") {
      if (!visionReady()) {
        return bad(a.kind === "admin" ? "Photo reading is not switched on yet: add ANTHROPIC_API_KEY in Vercel. Until then you can write the file by hand." : "Photo reading is not switched on yet. Ask Backroad Iron.", 503);
      }
      if (!(await countRead(db, row))) return bad(`This map has had its ${MAX_READS_A_DAY} photo reads for today. It can be read again tomorrow.`, 429);
      const answers = body.answers && typeof body.answers === "object" ? (body.answers as Record<string, unknown>) : {};
      try {
        const { row: next, problems } = await readMap(db, row, loc, answers, a.by);
        return json({ ok: true, map: await viewMap(db, next, loc, mayAdopt), problems: problems.length, spots: parseSpaceMap(next.markup).count });
      } catch (e) {
        if (e instanceof VisionError) return bad(e.message, 502);
        throw e;
      }
    }

    if (body.action === "apply") {
      const done = await applyMap(db, row, loc, mayAdopt, a.by);
      if (!done.ok) return bad(done.message);
      return json({ ok: true, map: await viewMap(db, done.row, loc, mayAdopt), adds: done.adds, changes: done.changes });
    }

    return bad("Unknown action.");
  } catch (e) {
    if (missing(e as { code?: string; message?: string })) return bad(setup(a), 503);
    console.error("space map change failed", e);
    return bad("That did not save. Try again.", 500);
  }
}
