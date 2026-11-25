// The catalog foundation's API, back office only.
// GET ?id=<item> returns the categories, places and that item's details.
// POST { action: "details.save", id, details } saves them and returns the fresh copy.
import { isAdmin, sameOrigin } from "@/lib/auth";
import { DetailsError, SchemaMissing, loadDetails, loadMeta, saveDetails } from "@/lib/foundation-server";
import { adminDb, json } from "@/lib/server";

export const dynamic = "force-dynamic";

function problem(e: unknown, what: string): Response {
  if (e instanceof SchemaMissing) return json({ ok: false, message: e.message, setup: true }, 503);
  if (e instanceof DetailsError) return json({ ok: false, message: e.message }, 400);
  console.error(what, e);
  return json({ ok: false, message: "That did not work. Try again." }, 500);
}

export async function GET(req: Request) {
  if (!(await isAdmin())) return json({ ok: false, message: "Please sign in again." }, 401);
  const id = (new URL(req.url).searchParams.get("id") ?? "").slice(0, 80);
  try {
    const db = adminDb();
    const [meta, details] = await Promise.all([loadMeta(db), id ? loadDetails(db, id) : Promise.resolve(null)]);
    if (id && !details) return json({ ok: false, message: "That item no longer exists." }, 404);
    return json({ ok: true, meta, details });
  } catch (e) {
    return problem(e, "catalog load failed");
  }
}

export async function POST(req: Request) {
  if (!sameOrigin(req) || !(await isAdmin())) return json({ ok: false, message: "Please sign in again." }, 401);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, message: "That request could not be read." }, 400);
  }
  if (body.action !== "details.save") return json({ ok: false, message: "Unknown action." }, 400);
  const id = typeof body.id === "string" ? body.id.slice(0, 80) : "";
  const details = body.details && typeof body.details === "object" ? (body.details as Record<string, unknown>) : null;
  if (!id || !details) return json({ ok: false, message: "That request was missing the item." }, 400);
  try {
    const db = adminDb();
    return json({ ok: true, details: await saveDetails(db, id, details) });
  } catch (e) {
    return problem(e, "catalog save failed");
  }
}
