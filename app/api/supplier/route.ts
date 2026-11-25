// Supplier photo importer API. GET returns where things stand; POST runs one
// named action. The "step" action makes at most one request to the supplier.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdmin, sameOrigin } from "@/lib/auth";
import { T, adminDb, json } from "@/lib/server";
import { SOURCES, sameSite, sourceById, type SupplierSource } from "@/lib/supplier";
import { allPhotos, loadState, loadSupplier, publish, saveState, step, unpublish } from "@/lib/supplier-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

class ActionError extends Error {}
const fail = (message: string): never => {
  throw new ActionError(message);
};

type Payload = Record<string, unknown>;
const str = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function run(action: string, a: Payload, db: SupabaseClient, source: SupplierSource, origin: string) {
  switch (action) {
    case "step":
      return step(db, source, origin);

    case "permission.set": {
      const state = await loadState(db, source);
      const granted = a.granted === true;
      state.permission = granted;
      state.permission_note = str(a.note, 300);
      state.permission_at = granted ? new Date().toISOString() : null;
      await saveState(db, source, state);
      // Flipping the switch moves every imported photo into, or back out of, the shop.
      for (const row of await allPhotos(db, source)) {
        if (granted) await publish(db, row);
        else await unpublish(db, row);
      }
      return {};
    }

    case "listings.set": {
      const urls = (Array.isArray(a.urls) ? a.urls : [])
        .map((u) => sameSite(str(u, 400), source.host)?.toString() ?? "")
        .filter(Boolean)
        .slice(0, 30);
      if (urls.length === 0) fail(`Add at least one category page from ${source.host}.`);
      const state = await loadState(db, source);
      state.listings = [...new Set(urls)];
      await saveState(db, source, state);
      return {};
    }

    case "scan.start": {
      const state = await loadState(db, source);
      const waiting = new Set(state.queue.flatMap((j) => (j.t === "listing" ? [j.url] : [])));
      for (const url of state.listings) if (!waiting.has(url)) state.queue.push({ t: "listing", url });
      state.pages = 0;
      state.last_error = "";
      await saveState(db, source, state);
      return {};
    }

    case "import.queue": {
      const data = await loadSupplier(db, source);
      const wanted = Array.isArray(a.product_ids) ? new Set(a.product_ids.map((x) => str(x, 80))) : null;
      const state = await loadState(db, source);
      let added = 0;
      for (const p of data.products) {
        if (!p.found || p.imported.length || p.queued) continue;
        if (wanted && !wanted.has(p.id)) continue;
        state.queue.push({ t: "image", image_url: p.found.image_url, page_url: p.found.page_url, product_id: p.id });
        added += 1;
      }
      if (added === 0) fail("Nothing new to import. Scan the supplier's pages first, or paste a product page for the item.");
      await saveState(db, source, state);
      return { added };
    }

    case "page.queue": {
      const productId = str(a.product_id, 80);
      const url = sameSite(str(a.url, 400), source.host) ?? fail(`Paste a product page from ${source.host}.`);
      const product = await db.from(T.products).select("id").eq("id", productId).maybeSingle();
      if (!product.data) fail("That item no longer exists.");
      const state = await loadState(db, source);
      state.queue.push({ t: "page", url: url!.toString(), product_id: productId });
      await saveState(db, source, state);
      return {};
    }

    case "queue.clear": {
      const state = await loadState(db, source);
      state.queue = [];
      state.last_error = "";
      await saveState(db, source, state);
      return {};
    }

    case "photo.remove": {
      const id = str(a.id, 60);
      const row = (await allPhotos(db, source)).find((p) => p.id === id) ?? fail("That photo is already gone.");
      await unpublish(db, row!);
      await db.storage.from(T.privateBucket).remove([row!.held_path]);
      await db.from(T.supplierPhotos).delete().eq("id", id);
      return {};
    }

    default:
      return fail("Unknown action.");
  }
}

export async function GET() {
  if (!(await isAdmin())) return json({ ok: false, message: "Please sign in again." }, 401);
  try {
    return json({ ok: true, data: await loadSupplier(adminDb(), SOURCES[0]) });
  } catch (e) {
    console.error("supplier load failed", e);
    return json({ ok: false, message: "The supplier photos could not be loaded." }, 500);
  }
}

export async function POST(req: Request) {
  if (!sameOrigin(req) || !(await isAdmin())) return json({ ok: false, message: "Please sign in again." }, 401);
  let body: Payload;
  try {
    body = (await req.json()) as Payload;
  } catch {
    return json({ ok: false, message: "That request could not be read." }, 400);
  }
  const source = sourceById(str(body.source, 40)) ?? SOURCES[0];
  const db = adminDb();
  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  try {
    const result = await run(str(body.action, 40), body, db, source, origin);
    return json({ ok: true, data: await loadSupplier(db, source), result });
  } catch (e) {
    if (e instanceof ActionError) return json({ ok: false, message: e.message }, 400);
    console.error("supplier action failed", body.action, e);
    return json({ ok: false, message: "That did not work. Try again." }, 500);
  }
}
