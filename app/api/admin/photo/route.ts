// Receives one product photo (already shrunk in the browser) and stores it.
import crypto from "node:crypto";
import { isAdmin, sameOrigin } from "@/lib/auth";
import { T, adminDb, json } from "@/lib/server";

export const dynamic = "force-dynamic";

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export async function POST(req: Request) {
  if (!sameOrigin(req) || !(await isAdmin())) return json({ error: "unauthorized" }, 401);
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim();
  const ext = EXT[type];
  if (!id || !ext) return json({ error: "bad_request", message: "Use a JPG, PNG or WebP photo." }, 400);

  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 4_000_000) {
    return json({ error: "too_large", message: "That photo is too large." }, 413);
  }

  const db = adminDb();
  const product = await db.from(T.products).select("id, photos").eq("id", id).maybeSingle();
  if (!product.data) return json({ error: "not_found", message: "That item no longer exists." }, 404);

  const path = `${id}/${crypto.randomUUID()}.${ext}`;
  const up = await db.storage.from(T.bucket).upload(path, bytes, { contentType: type, cacheControl: "31536000" });
  if (up.error) return json({ error: "storage", message: "The photo could not be saved." }, 500);

  const photos = [...((product.data.photos as string[] | null) ?? []), path];
  const saved = await db.from(T.products).update({ photos, updated_at: new Date().toISOString() }).eq("id", id);
  if (saved.error) {
    await db.storage.from(T.bucket).remove([path]);
    return json({ error: "server", message: "The photo could not be saved." }, 500);
  }
  return json({ ok: true, path, photos });
}
