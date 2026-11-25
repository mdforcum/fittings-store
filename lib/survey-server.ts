// Server-side helpers for the inventory survey.
import type { SupabaseClient } from "@supabase/supabase-js";
import { groupCaptures, normPart, type Capture } from "./match";
import { numberIndex } from "./foundation-server";
import { T } from "./server";
import type { Location, StoreMatch, SurveyData } from "./survey-types";
import { visionReady } from "./vision";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeCapture(row: Record<string, unknown>): Capture {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const kind = s(row.kind);
  const status = s(row.status);
  const conf = s(row.count_confidence);
  return {
    id: s(row.id),
    location_id: s(row.location_id),
    kind: kind === "card" || kind === "bin" || kind === "code" ? kind : "manual",
    captured_at: s(row.captured_at),
    status: status === "read" || status === "failed" ? status : "pending",
    read_error: s(row.read_error),
    photo: s(row.photo) || null,
    part_number: s(row.part_number),
    upc: s(row.upc),
    description: s(row.description),
    part_type: s(row.part_type),
    aisle: s(row.aisle),
    bin: s(row.bin),
    qty_on_card: n(row.qty_on_card),
    count_seen: n(row.count_seen),
    count_confidence: conf === "high" || conf === "medium" || conf === "low" ? conf : null,
    count_note: s(row.count_note),
    codes: Array.isArray(row.codes) ? row.codes.filter((x): x is string => typeof x === "string") : [],
    notes: s(row.notes),
    use_location: row.use_location !== false,
    confirmed: row.confirmed === true,
    edited: row.edited === true,
  };
}

/** Adds a short-lived viewing link to each capture that has a photo. */
export async function withPhotoLinks(db: SupabaseClient, captures: Capture[]): Promise<Capture[]> {
  const paths = captures.map((c) => c.photo).filter((p): p is string => !!p);
  if (paths.length === 0) return captures;
  const links = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 500) {
    const { data } = await db.storage.from(T.privateBucket).createSignedUrls(paths.slice(i, i + 500), 60 * 60 * 6);
    for (const item of data ?? []) if (item.path && item.signedUrl) links.set(item.path, item.signedUrl);
  }
  return captures.map((c) => (c.photo ? { ...c, photo_url: links.get(c.photo) ?? null } : c));
}

export async function loadLocations(db: SupabaseClient): Promise<Location[]> {
  const [locs, rows] = await Promise.all([
    db.from(T.locations).select("id, name, created_at").order("created_at", { ascending: true }),
    db.from(T.captures).select("location_id").limit(20000),
  ]);
  if (locs.error) throw new Error(locs.error.message);
  const counts = new Map<string, number>();
  for (const r of rows.data ?? []) counts.set(r.location_id as string, (counts.get(r.location_id as string) ?? 0) + 1);
  return (locs.data ?? []).map((l) => ({ id: l.id as string, name: l.name as string, captures: counts.get(l.id as string) ?? 0 }));
}

export async function loadSurvey(db: SupabaseClient, wanted: string | null): Promise<SurveyData> {
  const locations = await loadLocations(db);
  const location = locations.find((l) => l.id === wanted) ?? locations[0] ?? null;
  let captures: Capture[] = [];
  if (location) {
    const rows = await db
      .from(T.captures)
      .select("*")
      .eq("location_id", location.id)
      .order("captured_at", { ascending: false })
      .limit(4000);
    if (rows.error) throw new Error(rows.error.message);
    captures = await withPhotoLinks(db, (rows.data ?? []).map(normalizeCapture));
  }
  const [products, numbers] = await Promise.all([
    db.from(T.products).select("id, name, part_number, qty, photos"),
    numberIndex(db),
  ]);
  const store: Record<string, StoreMatch> = {};
  const byId = new Map<string, StoreMatch>();
  for (const p of products.data ?? []) {
    const match: StoreMatch = {
      id: p.id as string,
      name: p.name as string,
      qty: (p.qty as number) ?? 0,
      photos: Array.isArray(p.photos) ? p.photos.length : 0,
    };
    byId.set(match.id, match);
    const key = normPart((p.part_number as string) ?? "");
    if (key) store[key] = match;
  }
  // A card that shows an OEM or supplier number still finds our item through its cross-references.
  for (const [key, id] of numbers) {
    const match = byId.get(id);
    if (match && !store[key]) store[key] = match;
  }
  return {
    locations,
    location_id: location?.id ?? null,
    captures,
    survey: groupCaptures(captures),
    store,
    reading: visionReady(),
  };
}
