// Server side of the Space mapper: the saved maps and their photos, the read
// (photos and notes in, layout file and questions out), and putting a file on
// the shelf map. The file format and its rules are in lib/spacemap.ts.
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { T } from "./server";
import type { Spot } from "./shelf";
import { mapFromSpots, parseSpaceMap, planApply, printSpaceMap, type ApplyPlan, type Problem } from "./spacemap";
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

export type Reading = { summary: string; seen: string[]; guessed: string[]; at: string | null; photo_ids: string[] };
export type SpacePhoto = { id: string; note: string; created_at: string; url: string | null };
export type SpaceMapRow = {
  id: string;
  name: string;
  notes: string;
  markup: string;
  qa: Question[];
  reading: Reading;
  applied_markup: string;
  applied_at: string | null;
  updated_at: string;
};
export type SpaceMapView = SpaceMapRow & {
  photos: SpacePhoto[];
  /** What putting the file on the shelf map would do, or null while the file has problems or the shelf map is not set up. */
  plan: Omit<ApplyPlan, "rows"> | null;
  /** The file is on the shelf map exactly as it stands. */
  applied_same: boolean;
};
export type SpaceMapSummary = { id: string; name: string; photos: number; spots: number; open: number; applied_at: string | null; updated_at: string };

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

/** The shelf map, or null before add-shelf-spots.sql has run. */
export async function loadSpots(db: SupabaseClient): Promise<Spot[] | null> {
  const s = await db.from(SPOTS).select("id, parent_id, level, code, label, sort").limit(20000);
  if (missing(s.error)) return null;
  if (s.error) throw new Error(s.error.message);
  return (s.data ?? []) as Spot[];
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
export async function viewMap(db: SupabaseClient, row: SpaceMapRow): Promise<SpaceMapView> {
  const [photos, spots] = await Promise.all([loadPhotos(db, row.id), loadSpots(db)]);
  const links = new Map<string, string>();
  if (photos.length) {
    const { data } = await db.storage.from(T.privateBucket).createSignedUrls(photos.map((p) => p.path), 60 * 60 * 6);
    for (const item of data ?? []) if (item.path && item.signedUrl) links.set(item.path, item.signedUrl);
  }
  const parsed = parseSpaceMap(row.markup);
  let plan: SpaceMapView["plan"] = null;
  if (spots && !parsed.problems.length && parsed.count) {
    const { adds, changes, same, extra } = planApply(parsed.map, spots, () => "new");
    plan = { adds, changes, same, extra };
  }
  return {
    ...row,
    photos: photos.map((p) => ({ id: p.id, note: p.note, created_at: p.created_at, url: links.get(p.path) ?? null })),
    plan,
    applied_same: !!row.applied_at && !parsed.problems.length && printSpaceMap(parsed.map) === row.applied_markup,
  };
}

/** Every map, oldest first, or null before add-space-maps.sql has run. */
export async function listMaps(db: SupabaseClient): Promise<SpaceMapSummary[] | null> {
  const [m, p] = await Promise.all([
    db.from(MAPS).select("id, name, markup, qa, applied_at, updated_at").order("created_at", { ascending: true }).limit(200),
    db.from(PHOTOS).select("map_id").limit(20000),
  ]);
  if (missing(m.error) || missing(p.error)) return null;
  if (m.error) throw new Error(m.error.message);
  const counts = new Map<string, number>();
  for (const r of p.data ?? []) counts.set(r.map_id as string, (counts.get(r.map_id as string) ?? 0) + 1);
  return (m.data ?? []).map((raw) => {
    const row = normalizeMap(raw as Record<string, unknown>);
    return {
      id: row.id,
      name: row.name,
      photos: counts.get(row.id) ?? 0,
      spots: parseSpaceMap(row.markup).count,
      open: row.qa.filter((q) => q.answer === null).length,
      applied_at: row.applied_at,
      updated_at: row.updated_at,
    };
  });
}

/** The file a new map starts with: one location, or a copy of a location already on the shelf map. */
export function firstMarkup(name: string, code: string, spots: Spot[] | null, fromSpot: string | null): string {
  if (fromSpot && spots?.some((s) => s.id === fromSpot && !s.parent_id)) return printSpaceMap(mapFromSpots(spots, name, fromSpot));
  return printSpaceMap({ name, notes: [], roots: [{ level: "Location", code, label: name.slice(0, 60), deadEnd: false, children: [] }], starts: [], links: [] });
}

export type ReadResult = { row: SpaceMapRow; problems: Problem[] };

/**
 * Reads the map's photos and notes and saves the new layout file and
 * questions. `answers` are the person's replies to the open questions. A file
 * that comes back with lines we cannot use gets one more try with the problems
 * spelled out. Throws VisionError with a plain message when the reader fails.
 */
export async function readMap(db: SupabaseClient, row: SpaceMapRow, answers: Record<string, unknown>): Promise<ReadResult> {
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

  // What is already on the shelf map under this file's locations, so codes that hold parts are kept.
  const now = parseSpaceMap(row.markup);
  const rootCodes = new Set(now.map.roots.map((r) => r.code));
  const shelfRoots = (spots ?? []).filter((s) => !s.parent_id && rootCodes.has(s.code));
  const shelf = shelfRoots.length
    ? printSpaceMap({ name: "", notes: [], roots: shelfRoots.flatMap((r) => mapFromSpots(spots!, "", r.id).roots), starts: [], links: [] })
    : "";

  const asked = answerQuestions(row.qa, answers);
  const ask = async (problems?: Problem[], markup = row.markup) =>
    cleanLayout(
      await askVision({
        system: LAYOUT_PROMPT,
        tool: "record_layout",
        description: "Record the shop's layout file and the questions still to ask.",
        schema: LAYOUT_SCHEMA,
        images,
        text: layoutRequest({ name: row.name, notes: row.notes, markup, shelf, asked, problems, photoCount: images.length }),
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
  };
  const saved = await db.from(MAPS).update(next).eq("id", row.id).select("*").single();
  if (saved.error) throw new Error(saved.error.message);
  return { row: normalizeMap(saved.data as Record<string, unknown>), problems: keepOld ? [] : parsed.problems };
}

export type Applied = { ok: true; row: SpaceMapRow; adds: number; changes: number } | { ok: false; message: string };

/** Puts the file on the shelf map: adds the spots that are missing, updates names and order, removes nothing. */
export async function applyMap(db: SupabaseClient, row: SpaceMapRow): Promise<Applied> {
  const parsed = parseSpaceMap(row.markup);
  if (parsed.problems.length) {
    const n = parsed.problems.length;
    return { ok: false, message: `Fix the ${n === 1 ? "problem" : `${n} problems`} in the file first.` };
  }
  if (!parsed.count) return { ok: false, message: "The file has no spots yet." };
  const spots = await loadSpots(db);
  if (!spots) return { ok: false, message: "Shelf spots are not set up yet: run supabase/add-shelf-spots.sql on the database." };
  const plan = planApply(parsed.map, spots, () => crypto.randomUUID());
  // Parents come before their children in plan.rows, so each batch finds its parents already there.
  for (let i = 0; i < plan.rows.length; i += 500) {
    const { error } = await db.from(SPOTS).upsert(plan.rows.slice(i, i + 500), { onConflict: "id" });
    if (error) throw new Error(error.message);
  }
  const markup = printSpaceMap(parsed.map);
  const now = new Date().toISOString();
  const saved = await db.from(MAPS).update({ markup, applied_markup: markup, applied_at: now, updated_at: now }).eq("id", row.id).select("*").single();
  if (saved.error) throw new Error(saved.error.message);
  return { ok: true, row: normalizeMap(saved.data as Record<string, unknown>), adds: plan.adds, changes: plan.changes };
}

/** The files on the shelf map, for the pick walk. Empty before the setup file has run. */
export async function appliedMarkups(db: SupabaseClient): Promise<string[]> {
  const m = await db.from(MAPS).select("applied_markup").not("applied_at", "is", null).order("applied_at", { ascending: true }).limit(200);
  if (m.error) return [];
  return (m.data ?? []).map((r) => text((r as Record<string, unknown>).applied_markup)).filter(Boolean);
}
