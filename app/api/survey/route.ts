// The inventory survey's API. GET returns one location's captures and the parts
// worked out from them; POST runs one named action and returns the refreshed data.
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdmin, sameOrigin } from "@/lib/auth";
import { placeByType } from "@/lib/foundation-server";
import { TYPES } from "@/lib/catalog";
import type { Capture } from "@/lib/match";
import { mergeTyped } from "@/lib/reading";
import { T, adminDb, json } from "@/lib/server";
import { UUID, loadLocations, loadSurvey, normalizeCapture } from "@/lib/survey-server";
import { VisionError, readPhoto, visionReady } from "@/lib/vision";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

class ActionError extends Error {}
const fail = (message: string): never => {
  throw new ActionError(message);
};

type Payload = Record<string, unknown>;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const qty = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100000 ? Math.round(v) : null;
const uuid = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : fail("That item could not be found."));
const ids = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, 200);

async function must(q: PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await q;
  if (error) throw new Error(error.message);
}

async function getCapture(db: SupabaseClient, id: string): Promise<Capture> {
  const { data } = await db.from(T.captures).select("*").eq("id", id).maybeSingle();
  return data ? normalizeCapture(data) : fail("That capture no longer exists.");
}

async function photoBytes(db: SupabaseClient, path: string): Promise<{ bytes: Buffer; type: string }> {
  const { data, error } = await db.storage.from(T.privateBucket).download(path);
  if (error || !data) throw new Error(error?.message ?? "photo missing");
  return { bytes: Buffer.from(await data.arrayBuffer()), type: data.type || "image/jpeg" };
}

/** Reads one stored photo again and saves the result. Hand-entered captures are left alone. */
async function reread(db: SupabaseClient, c: Capture): Promise<boolean> {
  if (!c.photo || c.edited) return false;
  try {
    const { bytes, type } = await photoBytes(db, c.photo);
    const read = await readPhoto(c.kind, bytes, type);
    await must(db.from(T.captures).update({ status: "read", read_error: "", ...mergeTyped({}, read) }).eq("id", c.id));
    return true;
  } catch (e) {
    const message = e instanceof VisionError ? e.message : "The photo could not be read.";
    if (!(e instanceof VisionError)) console.error("reread failed", e);
    await must(db.from(T.captures).update({ status: "failed", read_error: message }).eq("id", c.id));
    return false;
  }
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function run(action: string, a: Payload, db: SupabaseClient): Promise<Record<string, unknown>> {
  switch (action) {
    case "location.create": {
      const name = str(a.name, 60) || fail("Give the location a name.");
      const id = typeof a.id === "string" && UUID.test(a.id) ? a.id : crypto.randomUUID();
      await must(db.from(T.locations).upsert({ id, name }));
      return { location_id: id };
    }

    case "location.rename": {
      const name = str(a.name, 60) || fail("Give the location a name.");
      await must(db.from(T.locations).update({ name }).eq("id", uuid(a.id)));
      return {};
    }

    case "location.delete": {
      const id = uuid(a.id);
      const rows = await db.from(T.captures).select("photo").eq("location_id", id).not("photo", "is", null);
      const paths = (rows.data ?? []).map((r) => r.photo as string);
      await must(db.from(T.locations).delete().eq("id", id));
      for (let i = 0; i < paths.length; i += 500) await db.storage.from(T.privateBucket).remove(paths.slice(i, i + 500));
      return {};
    }

    case "capture.update": {
      const c = await getCapture(db, uuid(a.id));
      const f = (a.fields ?? {}) as Payload;
      const patch: Record<string, unknown> = { edited: true, status: "read", read_error: "" };
      if (typeof f.part_number === "string") patch.part_number = str(f.part_number, 60);
      if (typeof f.upc === "string") patch.upc = str(f.upc, 20).replace(/\D/g, "");
      if (typeof f.description === "string") patch.description = str(f.description, 200);
      if (typeof f.aisle === "string") patch.aisle = str(f.aisle, 20);
      if (typeof f.bin === "string") patch.bin = str(f.bin, 20);
      if (typeof f.notes === "string") patch.notes = str(f.notes, 600);
      if ("qty_on_card" in f) patch.qty_on_card = f.qty_on_card === null ? null : (qty(f.qty_on_card) ?? fail("Quantity must be 0 or more."));
      if ("count_seen" in f) {
        const n = f.count_seen === null ? null : (qty(f.count_seen) ?? fail("The count must be 0 or more."));
        patch.count_seen = n;
        if (n !== c.count_seen) {
          patch.count_confidence = n == null ? null : "high";
          patch.count_note = n == null ? "" : "Counted by hand.";
        }
      }
      await must(db.from(T.captures).update(patch).eq("id", c.id));
      return {};
    }

    case "capture.confirm": {
      const list = ids(a.ids);
      if (list.length) await must(db.from(T.captures).update({ confirmed: true }).in("id", list));
      return {};
    }

    case "capture.unlink": {
      await must(db.from(T.captures).update({ use_location: false, confirmed: false }).eq("id", uuid(a.id)));
      return {};
    }

    case "capture.relink": {
      await must(db.from(T.captures).update({ use_location: true }).eq("id", uuid(a.id)));
      return {};
    }

    case "capture.delete": {
      const c = await getCapture(db, uuid(a.id));
      await must(db.from(T.captures).delete().eq("id", c.id));
      if (c.photo) await db.storage.from(T.privateBucket).remove([c.photo]);
      return {};
    }

    case "capture.read": {
      if (!visionReady()) fail("Add ANTHROPIC_API_KEY in Vercel and redeploy to switch photo reading on.");
      const location = uuid(a.location_id);
      const waiting = await db
        .from(T.captures)
        .select("*")
        .eq("location_id", location)
        .in("status", ["pending", "failed"])
        .eq("edited", false)
        .not("photo", "is", null)
        .order("captured_at", { ascending: true })
        .limit(40);
      const list = (waiting.data ?? []).map(normalizeCapture);
      // A few at a time keeps each request short; the screen calls again until none are left.
      const batch = list.slice(0, 4);
      const results = await Promise.all(batch.map((c) => reread(db, c)));
      const failed = results.filter((ok) => !ok).length;
      return { read: results.length - failed, failed, remaining: failed ? 0 : list.length - batch.length };
    }

    case "part.to_store": {
      const name = str(a.name, 80) || fail("Give the item a name.");
      const partNumber = str(a.part_number, 40);
      const type = TYPES.some((t) => t.id === a.type) ? (a.type as string) : "other";
      let newId = slug(partNumber || name) || "item";
      const clash = await db.from(T.products).select("id").eq("id", newId).maybeSingle();
      if (clash.data) newId = `${newId}-${Math.random().toString(36).slice(2, 6)}`;
      const top = await db.from(T.products).select("sort").order("sort", { ascending: false }).limit(1);
      const sort = ((top.data?.[0]?.sort as number | undefined) ?? 0) + 10;
      await must(
        db.from(T.products).insert({
          id: newId,
          name,
          part_number: partNumber,
          description: str(a.description, 600),
          type,
          qty: 0,
          sort,
        }),
      );
      await placeByType(db, newId, type);
      return { product_id: newId };
    }

    case "part.set_qty": {
      const n = qty(a.qty) ?? fail("Quantity must be 0 or more.");
      const id = str(a.product_id, 80) || fail("That item could not be found.");
      await must(db.from(T.products).update({ qty: n, updated_at: new Date().toISOString() }).eq("id", id));
      return {};
    }

    case "capture.to_product_photo": {
      const c = await getCapture(db, uuid(a.id));
      const productId = str(a.product_id, 80);
      const product = await db.from(T.products).select("id, photos").eq("id", productId).maybeSingle();
      if (!product.data) fail("That store item no longer exists.");
      if (!c.photo) fail("That capture has no photo.");
      const { bytes, type } = await photoBytes(db, c.photo!);
      const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
      const path = `${productId}/${crypto.randomUUID()}.${ext}`;
      const up = await db.storage.from(T.bucket).upload(path, bytes, { contentType: type, cacheControl: "31536000" });
      if (up.error) throw new Error(up.error.message);
      const photos = [...((product.data!.photos as string[] | null) ?? []), path];
      await must(db.from(T.products).update({ photos, updated_at: new Date().toISOString() }).eq("id", productId));
      return {};
    }

    default:
      return fail("Unknown action.");
  }
}

export async function GET(req: Request) {
  if (!(await isAdmin())) return json({ ok: false, message: "Please sign in again." }, 401);
  try {
    const params = new URL(req.url).searchParams;
    // The phone only needs the list of locations, not every capture.
    if (params.get("only") === "locations") {
      return json({ ok: true, locations: await loadLocations(adminDb()), reading: visionReady() });
    }
    return json({ ok: true, data: await loadSurvey(adminDb(), params.get("location")) });
  } catch (e) {
    console.error("survey load failed", e);
    return json({ ok: false, message: "The survey could not be loaded." }, 500);
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
  const db = adminDb();
  try {
    const result = await run(str(body.action, 40), body, db);
    const location = (result.location_id as string | undefined) ?? str(body.location_id, 40) ?? null;
    return json({ ok: true, data: await loadSurvey(db, location || null), result });
  } catch (e) {
    if (e instanceof ActionError) return json({ ok: false, message: e.message }, 400);
    console.error("survey action failed", body.action, e);
    return json({ ok: false, message: "That change did not save. Try again." }, 500);
  }
}
