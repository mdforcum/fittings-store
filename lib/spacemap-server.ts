// Server side of the Space mapper: the saved maps and their photos, the read
// (photos and notes in, layout file and questions out), and putting a file on
// the shelf map. The file format and its rules are in lib/spacemap.ts.
//
// Every map is the file of one store location. The API (app/api/spacemap)
// decides which locations the signed-in person may use; everything here takes
// the location and works only inside it.
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { T } from "./server";
import type { Spot } from "./shelf";
import { fileProblem, locationScope, mapFromSpots, parseSpaceMap, planApply, printSpaceMap, type ApplyPlan, type BoundSpot, type Problem } from "./spacemap";
import {
  LAYOUT_PROMPT,
  LAYOUT_SCHEMA,
  MAX_PHOTOS,
  answerQuestions,
  cleanLayout,
  layoutRequest,
  mergeQuestions,
  photoCaption,
  type Question,
} from "./spacemap-read";
import { askVision } from "./vision";

export const MAPS = "fittings_space_maps";
export const PHOTOS = "fittings_space_photos";
const SPOTS = "fittings_shelf_spots";
/** Most photos one map keeps. A read takes the newest MAX_PHOTOS of them. */
export const MAX_KEPT = 80;
/** Most photo reads one map gets in a day, so one login cannot run up the reading bill. */
export const MAX_READS_A_DAY = 30;

/** A store location a map can belong to. `dealer` is the dealer's name. */
export type MapLocation = { id: string; name: string; code: string; dealer_id: string; dealer: string };

export type Reading = { summary: string; seen: string[]; guessed: string[]; at: string | null; photo_ids: string[] };
export type SpacePhoto = { id: string; note: string; created_at: string; url: string | null };
export type SpaceMapRow = {
  id: string;
  /** The store location this file maps. Null only on a map from before maps had locations. */
  location_id: string | null;
  created_by: string;
  updated_by: string;
  reads_day: string | null;
  reads_today: number;
  name: string;
  notes: string;
  markup: string;
  qa: Question[];
  reading: Reading;
  applied_markup: string;
  applied_at: string | null;
  updated_at: string;
};
export type SpaceMapView = Omit<SpaceMapRow, "reads_day" | "reads_today"> & {
  location: { name: string; code: string; dealer: string };
  photos: SpacePhoto[];
  /** What putting the file on the shelf map would do, or null while the file has problems or the shelf map is not set up. */
  plan: Omit<ApplyPlan, "rows"> | null;
  /** Why this file cannot go on the shelf map as it stands (wrong top line, a code clash), or "". */
  blocked: string;
  /** The file is on the shelf map exactly as it stands. */
  applied_same: boolean;
};
export type SpaceMapSummary = { id: string; name: string; location_id: string; code: string; dealer: string; photos: number; spots: number; open: number; applied_at: string | null; updated_at: string };

/** The table or column is missing until the setup file has run. */
export const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || e.code === "42703" || /does not exist|schema cache/i.test(e.message ?? ""));

const text = (v: unknown) => (typeof v === "string" ? v : "");

export function normalizeMap(raw: Record<string, unknown>): SpaceMapRow {
  const r = (raw.reading && typeof raw.reading === "object" ? raw.reading : {}) as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const qa = (Array.isArray(raw.qa) ? raw.qa : [])
    .map((q) => (q && typeof q === "object" ? (q as Record<string, unknown>) : {}))
    .filter((q) => typeof q.id === "string" && typeof q.question === "string")
    .map((q) => ({
      id: q.id as string,
      question: q.question as string,
      why: text(q.why),
      choices: strings(q.choices),
      answer: typeof q.answer === "string" ? q.answer : null,
    }));
  return {
    id: text(raw.id),
    location_id: typeof raw.location_id === "string" ? raw.location_id : null,
    created_by: text(raw.created_by),
    updated_by: text(raw.updated_by),
    reads_day: typeof raw.reads_day === "string" ? raw.reads_day.slice(0, 10) : null,
    reads_today: typeof raw.reads_today === "number" ? raw.reads_today : 0,
    name: text(raw.name),
    notes: text(raw.notes),
    markup: text(raw.markup),
    qa,
    reading: { summary: text(r.summary), seen: strings(r.seen), guessed: strings(r.guessed), at: typeof r.at === "string" ? r.at : null, photo_ids: strings(r.photo_ids) },
    applied_markup: text(raw.applied_markup),
    applied_at: typeof raw.applied_at === "string" ? raw.applied_at : null,
    updated_at: text(raw.updated_at),
  };
}

/** The shelf map, each top spot with its location, or null before the setup files have run. */
export async function loadSpots(db: SupabaseClient): Promise<BoundSpot[] | null> {
  const s = await db.from(SPOTS).select("id, parent_id, level, code, label, sort, location_id").limit(20000);
  if (missing(s.error)) return null;
  if (s.error) throw new Error(s.error.message);
  return ((s.data ?? []) as BoundSpot[]).map((x) => ({ ...x, location_id: x.location_id ?? null }));
}

/** Store locations: every dealer's (the back office), or one dealer's own. */
export async function storeLocations(db: SupabaseClient, dealerId: string | null): Promise<MapLocation[]> {
  let q = db.from("fittings_locations").select("id, name, code, dealer_id, kind, sort").eq("kind", "store");
  if (dealerId) q = q.eq("dealer_id", dealerId);
  const [l, d] = await Promise.all([q.order("sort", { ascending: true }).limit(500), db.from("fittings_dealers").select("id, name").limit(500)]);
  if (l.error) throw new Error(l.error.message);
  const names = new Map((d.data ?? []).map((x) => [x.id as string, text(x.name)]));
  return (l.data ?? [])
    .filter((x) => typeof x.dealer_id === "string" && (!dealerId || x.dealer_id === dealerId))
    .map((x) => ({ id: x.id as string, name: text(x.name), code: text(x.code), dealer_id: x.dealer_id as string, dealer: names.get(x.dealer_id as string) ?? "" }));
}

type PhotoRow = { id: string; path: string; note: string; created_at: string };

async function loadPhotos(db: SupabaseClient, mapId: string): Promise<PhotoRow[]> {
  const p = await db.from(PHOTOS).select("id, path, note, created_at").eq("map_id", mapId).order("created_at", { ascending: true }).limit(MAX_KEPT);
  if (p.error) throw new Error(p.error.message);
  return (p.data ?? []) as PhotoRow[];
}

export async function loadMap(db: SupabaseClient, id: string): Promise<SpaceMapRow | null> {
  const m = await db.from(MAPS).select("*").eq("id", id).maybeSingle();
  if (m.error) throw new Error(m.error.message);
  return m.data ? normalizeMap(m.data as Record<string, unknown>) : null;
}

/** One map as the screen shows it: its photos with viewing links, and what applying it would do. */
export async function viewMap(db: SupabaseClient, row: SpaceMapRow, loc: MapLocation, mayAdopt: boolean): Promise<SpaceMapView> {
  const [photos, spots] = await Promise.all([loadPhotos(db, row.id), loadSpots(db)]);
  const links = new Map<string, string>();
  if (photos.length) {
    const { data } = await db.storage.from(T.privateBucket).createSignedUrls(photos.map((p) => p.path), 60 * 60 * 6);
    for (const item of data ?? []) if (item.path && item.signedUrl) links.set(item.path, item.signedUrl);
  }
  const parsed = parseSpaceMap(row.markup);
  let plan: SpaceMapView["plan"] = null;
  let blocked = "";
  if (!parsed.problems.length && parsed.count) {
    const scope = spots ? locationScope(spots, loc, mayAdopt) : null;
    blocked = fileProblem(parsed.map, loc.code) ?? (scope && !scope.ok ? scope.message : "");
    if (scope?.ok && !blocked) {
      const { adds, changes, same, extra } = planApply(parsed.map, scope.spots, () => "new");
      plan = { adds, changes, same, extra };
    }
  }
  // The read count is the server's business, not the screen's.
  const { reads_day: _day, reads_today: _n, ...shown } = row;
  void _day;
  void _n;
  return {
    ...shown,
    location: { name: loc.name, code: loc.code, dealer: loc.dealer },
    photos: photos.map((p) => ({ id: p.id, note: p.note, created_at: p.created_at, url: links.get(p.path) ?? null })),
    plan,
    blocked,
    applied_same: !!row.applied_at && !parsed.problems.length && printSpaceMap(parsed.map) === row.applied_markup,
  };
}

/** The maps of these locations, oldest first, or null before the setup files have run. */
export async function listMaps(db: SupabaseClient, locations: MapLocation[]): Promise<SpaceMapSummary[] | null> {
  const [m, p] = await Promise.all([
    db.from(MAPS).select("id, name, location_id, markup, qa, applied_at, updated_at").order("created_at", { ascending: true }).limit(500),
    db.from(PHOTOS).select("map_id").limit(20000),
  ]);
  if (missing(m.error) || missing(p.error)) return null;
  if (m.error) throw new Error(m.error.message);
  const counts = new Map<string, number>();
  for (const r of p.data ?? []) counts.set(r.map_id as string, (counts.get(r.map_id as string) ?? 0) + 1);
  const mine = new Map(locations.map((l) => [l.id, l]));
  const out: SpaceMapSummary[] = [];
  for (const raw of m.data ?? []) {
    const row = normalizeMap(raw as Record<string, unknown>);
    const loc = row.location_id ? mine.get(row.location_id) : undefined;
    if (!loc) continue; // another dealer's, or a map with no location: not this person's to see
    out.push({
      id: row.id,
      name: row.name,
      location_id: loc.id,
      code: loc.code,
      dealer: loc.dealer,
      photos: counts.get(row.id) ?? 0,
      spots: parseSpaceMap(row.markup).count,
      open: row.qa.filter((q) => q.answer === null).length,
      applied_at: row.applied_at,
      updated_at: row.updated_at,
    });
  }
  return out;
}

/** The file a new map starts with: the location's own top line, and whatever its shelf map already holds. */
export function firstMarkup(loc: MapLocation, spots: BoundSpot[] | null): string {
  const scope = spots ? locationScope(spots, loc, false) : null;
  if (scope?.ok && scope.rootId) return printSpaceMap(mapFromSpots(scope.spots, loc.name, scope.rootId));
  return printSpaceMap({ name: loc.name, notes: [], roots: [{ level: "Location", code: loc.code, label: loc.name.slice(0, 60), deadEnd: false, children: [] }], starts: [], links: [] });
}

export type ReadResult = { row: SpaceMapRow; problems: Problem[] };

/**
 * Reads the map's photos and notes and saves the new layout file and
 * questions. `answers` are the person's replies to the open questions. A file
 * that comes back with lines we cannot use gets one more try with the problems
 * spelled out. Throws VisionError with a plain message when the reader fails.
 */
export async function readMap(db: SupabaseClient, row: SpaceMapRow, loc: MapLocation, answers: Record<string, unknown>, by: string): Promise<ReadResult> {
  const [all, spots] = await Promise.all([loadPhotos(db, row.id), loadSpots(db)]);
  const photos = all.slice(-MAX_PHOTOS);
  const images = await Promise.all(
    photos.map(async (p, i) => {
      const file = await db.storage.from(T.privateBucket).download(p.path);
      if (file.error || !file.data) throw new Error(`photo ${p.id} could not be loaded: ${file.error?.message ?? "empty"}`);
      return {
        bytes: Buffer.from(await file.data.arrayBuffer()),
        mediaType: p.path.endsWith(".png") ? "image/png" : p.path.endsWith(".webp") ? "image/webp" : "image/jpeg",
        caption: photoCaption(i + 1, p.note),
      };
    }),
  );

  // What is already on the shelf map for this location (and only this one), so codes that hold parts are kept.
  const now = parseSpaceMap(row.markup);
  const scope = spots ? locationScope(spots, loc, false) : null;
  const shelf = scope?.ok && scope.rootId ? printSpaceMap(mapFromSpots(scope.spots, "", scope.rootId)) : "";

  const asked = answerQuestions(row.qa, answers);
  const ask = async (problems?: Problem[], markup = row.markup) =>
    cleanLayout(
      await askVision({
        system: LAYOUT_PROMPT,
        tool: "record_layout",
        description: "Record the shop's layout file and the questions still to ask.",
        schema: LAYOUT_SCHEMA,
        images,
        text: layoutRequest({ name: loc.name, code: loc.code, notes: row.notes, markup, shelf, asked, problems, photoCount: images.length }),
        maxTokens: 12000,
        timeoutMs: 110_000,
      }),
    );

  let layout = await ask();
  let parsed = parseSpaceMap(layout.markup);
  if (parsed.problems.length || !parsed.count) {
    const again = await ask(parsed.problems.length ? parsed.problems : [{ line: 1, text: "The file had no spots in it." }], layout.markup || row.markup);
    const reparsed = parseSpaceMap(again.markup);
    if (reparsed.count && reparsed.problems.length <= parsed.problems.length) {
      layout = again;
      parsed = reparsed;
    }
  }
  // Never swap a file that reads for one that does not.
  const keepOld = !parsed.count && now.count > 0;
  const next = {
    markup: keepOld ? row.markup : parsed.problems.length ? layout.markup : printSpaceMap(parsed.map),
    qa: mergeQuestions(asked, layout.questions),
    reading: { summary: layout.summary, seen: layout.seen, guessed: layout.guessed, at: new Date().toISOString(), photo_ids: photos.map((p) => p.id) },
    updated_at: new Date().toISOString(),
    updated_by: by,
  };
  const saved = await db.from(MAPS).update(next).eq("id", row.id).select("*").single();
  if (saved.error) throw new Error(saved.error.message);
  return { row: normalizeMap(saved.data as Record<string, unknown>), problems: keepOld ? [] : parsed.problems };
}

/** Counts one read against the map's day. False when today's reads are used up. */
export async function countRead(db: SupabaseClient, row: SpaceMapRow): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const used = row.reads_day === today ? row.reads_today : 0;
  if (used >= MAX_READS_A_DAY) return false;
  const { error } = await db.from(MAPS).update({ reads_day: today, reads_today: used + 1 }).eq("id", row.id);
  if (error) throw new Error(error.message);
  return true;
}

export type Applied = { ok: true; row: SpaceMapRow; adds: number; changes: number } | { ok: false; message: string };

/**
 * Puts the file on the shelf map, under its own location's top spot and
 * nowhere else: adds the spots that are missing, updates names and order,
 * removes nothing.
 */
export async function applyMap(db: SupabaseClient, row: SpaceMapRow, loc: MapLocation, mayAdopt: boolean, by: string): Promise<Applied> {
  const parsed = parseSpaceMap(row.markup);
  if (parsed.problems.length) {
    const n = parsed.problems.length;
    return { ok: false, message: `Fix the ${n === 1 ? "problem" : `${n} problems`} in the file first.` };
  }
  if (!parsed.count) return { ok: false, message: "The file has no spots yet." };
  const wrongFile = fileProblem(parsed.map, loc.code);
  if (wrongFile) return { ok: false, message: wrongFile };
  const spots = await loadSpots(db);
  if (!spots) return { ok: false, message: "The shelf map is not set up yet." };
  const scope = locationScope(spots, loc, mayAdopt);
  if (!scope.ok) return { ok: false, message: scope.message };
  if (scope.adopt && scope.rootId) {
    const { error } = await db.from(SPOTS).update({ location_id: loc.id }).eq("id", scope.rootId);
    if (error) throw new Error(error.message);
  }
  // Only this location's own spots are in play, so nothing outside them can be matched or changed.
  const plan = planApply(parsed.map, scope.spots, () => crypto.randomUUID());
  const rows: BoundSpot[] = plan.rows.map((r: Spot) => ({ ...r, location_id: r.parent_id ? null : loc.id }));
  // Parents come before their children, so each batch finds its parents already there.
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from(SPOTS).upsert(rows.slice(i, i + 500), { onConflict: "id" });
    if (error) throw new Error(error.message);
  }
  const markup = printSpaceMap(parsed.map);
  const now = new Date().toISOString();
  const saved = await db.from(MAPS).update({ markup, applied_markup: markup, applied_at: now, updated_at: now, updated_by: by }).eq("id", row.id).select("*").single();
  if (saved.error) throw new Error(saved.error.message);
  return { ok: true, row: normalizeMap(saved.data as Record<string, unknown>), adds: plan.adds, changes: plan.changes };
}

/** The files on the shelf map, for the pick walk. Empty before the setup file has run. */
export async function appliedMarkups(db: SupabaseClient): Promise<string[]> {
  const m = await db.from(MAPS).select("applied_markup").not("applied_at", "is", null).order("applied_at", { ascending: true }).limit(200);
  if (m.error) return [];
  return (m.data ?? []).map((r) => text((r as Record<string, unknown>).applied_markup)).filter(Boolean);
}
