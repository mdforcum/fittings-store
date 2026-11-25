// Server side of the supplier photo importer: the queue, the polite fetching,
// and holding or publishing what was imported.
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normPart } from "./match";
import { T, getConfig, setConfig } from "./server";
import {
  allowedByRobots,
  largeImage,
  matchParts,
  parseListing,
  parseProductPage,
  parseRobots,
  sameSite,
  type IndexRow,
  type Robots,
  type SupplierSource,
} from "./supplier";
import type { SupplierData, SupplierJob } from "./survey-types";

export type SupplierState = {
  permission: boolean;
  permission_note: string;
  permission_at: string | null;
  listings: string[];
  queue: SupplierJob[];
  robots: (Robots & { fetched_at: string }) | null;
  next_fetch_at: string | null;
  scanned_at: string | null;
  /** Listing pages read since the last scan was started; caps a runaway "next page" chain. */
  pages: number;
  last_error: string;
};

const MIN_GAP_S = 5; // even when a supplier asks for no delay
const MAX_PAGES_PER_SCAN = 60;
const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const key = (source: SupplierSource) => `supplier:${source.id}`;

export async function loadState(db: SupabaseClient, source: SupplierSource): Promise<SupplierState> {
  const saved = (await getConfig<Partial<SupplierState>>(db, key(source))) ?? {};
  return {
    permission: saved.permission === true,
    permission_note: saved.permission_note ?? "",
    permission_at: saved.permission_at ?? null,
    listings: Array.isArray(saved.listings) && saved.listings.length ? saved.listings : source.listings,
    queue: Array.isArray(saved.queue) ? saved.queue : [],
    robots: saved.robots ?? null,
    next_fetch_at: saved.next_fetch_at ?? null,
    scanned_at: saved.scanned_at ?? null,
    pages: typeof saved.pages === "number" ? saved.pages : 0,
    last_error: saved.last_error ?? "",
  };
}

export const saveState = (db: SupabaseClient, source: SupplierSource, state: SupplierState) =>
  setConfig(db, key(source), state);

const secondsUntil = (iso: string | null) => (iso ? Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 1000)) : 0);

async function politeFetch(url: string, agent: string, accept: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { "User-Agent": agent, Accept: accept },
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  // A redirect must not carry the importer off the supplier's own site.
  if (res.url && new URL(res.url).hostname !== new URL(url).hostname) throw new Error("redirected off the supplier's site");
  return res;
}

type PhotoRow = {
  id: string;
  product_id: string;
  image_url: string;
  page_url: string;
  held_path: string;
  public_path: string | null;
};

/** Copies a held photo into the public bucket and adds it to the item's shop photos. */
export async function publish(db: SupabaseClient, row: PhotoRow): Promise<void> {
  if (row.public_path) return;
  const product = await db.from(T.products).select("id, photos").eq("id", row.product_id).maybeSingle();
  if (!product.data) return;
  const file = await db.storage.from(T.privateBucket).download(row.held_path);
  if (file.error || !file.data) throw new Error(file.error?.message ?? "held photo missing");
  const ext = row.held_path.split(".").pop() ?? "jpg";
  const path = `${row.product_id}/supplier-${row.id}.${ext}`;
  const up = await db.storage.from(T.bucket).upload(path, Buffer.from(await file.data.arrayBuffer()), {
    contentType: file.data.type || "image/jpeg",
    cacheControl: "31536000",
    upsert: true,
  });
  if (up.error) throw new Error(up.error.message);
  const photos = ((product.data.photos as string[] | null) ?? []).filter((p) => p !== path);
  // The owner's own photos stay first; the supplier's photo goes after them.
  await db.from(T.products).update({ photos: [...photos, path], updated_at: new Date().toISOString() }).eq("id", row.product_id);
  await db.from(T.supplierPhotos).update({ public_path: path }).eq("id", row.id);
}

/** Takes a published supplier photo back out of the shop. The held copy is kept. */
export async function unpublish(db: SupabaseClient, row: PhotoRow): Promise<void> {
  if (!row.public_path) return;
  const product = await db.from(T.products).select("id, photos").eq("id", row.product_id).maybeSingle();
  if (product.data) {
    const photos = ((product.data.photos as string[] | null) ?? []).filter((p) => p !== row.public_path);
    await db.from(T.products).update({ photos, updated_at: new Date().toISOString() }).eq("id", row.product_id);
  }
  await db.storage.from(T.bucket).remove([row.public_path]);
  await db.from(T.supplierPhotos).update({ public_path: null }).eq("id", row.id);
}

export async function allPhotos(db: SupabaseClient, source: SupplierSource): Promise<PhotoRow[]> {
  const { data, error } = await db.from(T.supplierPhotos).select("*").eq("source", source.id);
  if (error) throw new Error(error.message);
  return (data ?? []) as PhotoRow[];
}

/**
 * Makes at most one request to the supplier, then records when the next one
 * may go. The screen calls this again and again until the queue is empty.
 */
export async function step(
  db: SupabaseClient,
  source: SupplierSource,
  origin: string,
): Promise<{ did: string; wait: number; remaining: number }> {
  const state = await loadState(db, source);
  const wait = secondsUntil(state.next_fetch_at);
  if (wait > 0 || state.queue.length === 0) return { did: "", wait, remaining: state.queue.length };

  const agent = `FittingsStoreImporter/1.0 (+${origin}; contact via that site)`;
  const gap = () => new Date(Date.now() + Math.max(state.robots?.crawl_delay ?? 10, MIN_GAP_S) * 1000).toISOString();
  const done = async (did: string) => {
    await saveState(db, source, state);
    return { did, wait: secondsUntil(state.next_fetch_at), remaining: state.queue.length };
  };

  // The supplier's rules come first, refreshed once a day.
  const stale = !state.robots || Date.now() - Date.parse(state.robots.fetched_at) > 86_400_000;
  if (stale) {
    try {
      const res = await politeFetch(`https://${source.host}/robots.txt`, agent, "text/plain");
      if (res.ok) {
        state.robots = { ...parseRobots(await res.text()), fetched_at: new Date().toISOString() };
      } else if (res.status === 404) {
        state.robots = { disallow: [], crawl_delay: 10, fetched_at: new Date().toISOString() };
      } else {
        throw new Error(`robots.txt answered ${res.status}`);
      }
      state.last_error = "";
    } catch (e) {
      state.last_error = "The supplier's site could not be reached to check its rules. Trying again shortly.";
      console.error("robots fetch failed", e);
      state.next_fetch_at = new Date(Date.now() + 60_000).toISOString();
      return done("retry");
    }
    state.next_fetch_at = gap();
    return done("rules");
  }

  const job = state.queue[0];
  const url = job.t === "image" ? largeImage(job.image_url) : job.url;
  const target = sameSite(url, source.host);
  if (!target || !allowedByRobots(url, state.robots!)) {
    state.queue.shift();
    state.last_error = `Skipped a page the supplier's site asks automated readers not to open: ${url.slice(0, 120)}`;
    return done("skipped");
  }

  try {
    if (job.t === "image") {
      const res = await politeFetch(url, agent, "image/webp,image/jpeg,image/png");
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      const ext = IMAGE_TYPES[type];
      if (!res.ok || !ext) throw new Error(`photo answered ${res.status} ${type}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 4_500_000) throw new Error("photo is empty or too large");
      const id = crypto.randomUUID();
      const held = `supplier/${source.id}/${job.product_id}/${id}.${ext}`;
      const up = await db.storage.from(T.privateBucket).upload(held, bytes, { contentType: type });
      if (up.error) throw new Error(up.error.message);
      const row: PhotoRow = {
        id,
        product_id: job.product_id,
        image_url: job.image_url,
        page_url: job.page_url,
        held_path: held,
        public_path: null,
      };
      const saved = await db.from(T.supplierPhotos).upsert({ ...row, source: source.id }, { onConflict: "product_id,image_url", ignoreDuplicates: true }).select("id");
      if (saved.error) throw new Error(saved.error.message);
      if (!saved.data?.length) {
        await db.storage.from(T.privateBucket).remove([held]); // already imported earlier
      } else if (state.permission) {
        await publish(db, row);
      }
    } else {
      const res = await politeFetch(url, agent, "text/html");
      if (!res.ok) throw new Error(`page answered ${res.status}`);
      const html = (await res.text()).slice(0, 3_000_000);
      if (job.t === "listing") {
        const { items, next } = parseListing(html, url, source.host);
        const rows = items.map((it) => ({
          source: source.id,
          part_norm: normPart(it.part_number),
          part_number: it.part_number,
          name: it.name,
          page_url: it.page_url,
          image_url: it.image_url,
          seen_at: new Date().toISOString(),
        }));
        if (rows.length) {
          const saved = await db.from(T.supplierIndex).upsert(rows);
          if (saved.error) throw new Error(saved.error.message);
        }
        state.pages += 1;
        if (next && state.pages < MAX_PAGES_PER_SCAN && !state.queue.some((j) => j.t === "listing" && j.url === next)) {
          state.queue.splice(1, 0, { t: "listing", url: next });
        }
        state.scanned_at = new Date().toISOString();
      } else {
        const page = parseProductPage(html, source.host);
        if (!page.image_url) throw new Error("no product photo on that page");
        state.queue.splice(1, 0, { t: "image", image_url: page.image_url, page_url: url, product_id: job.product_id });
      }
    }
    state.queue.shift();
    state.last_error = "";
  } catch (e) {
    console.error("supplier step failed", job.t, e);
    job.tries = (job.tries ?? 0) + 1;
    if (job.tries >= 3) {
      state.queue.shift();
      state.last_error =
        job.t === "page"
          ? "That page did not have a product photo the importer could find."
          : "One request to the supplier failed three times and was skipped.";
    } else {
      state.last_error = "A request to the supplier failed. Trying it again.";
    }
  }
  state.next_fetch_at = gap();
  return done(job.t);
}

export async function loadSupplier(db: SupabaseClient, source: SupplierSource): Promise<SupplierData> {
  const [state, products, index, photos] = await Promise.all([
    loadState(db, source),
    db.from(T.products).select("id, name, part_number, photos, sort").order("sort", { ascending: true }),
    db.from(T.supplierIndex).select("part_norm, part_number, name, page_url, image_url").eq("source", source.id).limit(20000),
    allPhotos(db, source),
  ]);
  if (products.error) throw new Error(products.error.message);
  const rows = (index.data ?? []) as IndexRow[];
  const list = (products.data ?? []).map((p) => ({
    id: p.id as string,
    name: p.name as string,
    part_number: (p.part_number as string) ?? "",
    photos: ((p.photos as string[] | null) ?? []) as string[],
  }));
  const found = matchParts(list, rows);

  const held = photos.filter((p) => !p.public_path).map((p) => p.held_path);
  const links = new Map<string, string>();
  if (held.length) {
    const { data } = await db.storage.from(T.privateBucket).createSignedUrls(held, 60 * 60 * 6);
    for (const item of data ?? []) if (item.path && item.signedUrl) links.set(item.path, item.signedUrl);
  }
  const publicUrl = (path: string) => db.storage.from(T.bucket).getPublicUrl(path).data.publicUrl;
  const queuedFor = new Set(state.queue.flatMap((j) => (j.t === "listing" ? [] : [j.product_id])));

  return {
    source: { id: source.id, name: source.name, host: source.host },
    permission: state.permission,
    permission_note: state.permission_note,
    permission_at: state.permission_at,
    listings: state.listings,
    index_count: rows.length,
    scanned_at: state.scanned_at,
    queue: state.queue.length,
    wait: secondsUntil(state.next_fetch_at),
    crawl_delay: state.robots?.crawl_delay ?? null,
    last_error: state.last_error,
    products: list.map((p) => {
      const mine = photos.filter((ph) => ph.product_id === p.id);
      const supplierPaths = new Set(mine.map((ph) => ph.public_path).filter(Boolean));
      const hit = found.get(p.id) ?? null;
      return {
        id: p.id,
        name: p.name,
        part_number: p.part_number,
        own_photos: p.photos.filter((path) => !supplierPaths.has(path)).length,
        found: hit ? { part_number: hit.part_number, name: hit.name, page_url: hit.page_url, image_url: hit.image_url } : null,
        imported: mine.map((ph) => {
          const live = !!ph.public_path && p.photos.includes(ph.public_path);
          return {
            id: ph.id,
            published: live,
            preview_url: live ? publicUrl(ph.public_path!) : (links.get(ph.held_path) ?? ""),
            page_url: ph.page_url,
          };
        }),
        queued: queuedFor.has(p.id),
      };
    }),
  };
}
