// Back office: the shelf-spot tree (location down to bin) and which spot each
// item sits in. Admin only. The storefront reads spots through getShopCatalog.
//
// GET                          the tree, and each item's spot
// POST {action:"spot.save"}    add or change a spot {id?, parent_id, level, code, label, sort}
// POST {action:"spot.delete"}  remove a spot with no spots or items under it {id}
// POST {action:"spot.assign"}  put an item in a spot, or take it out {product_id, spot_id|null}
import { isAdmin, sameOrigin } from "@/lib/auth";
import { adminDb, json } from "@/lib/server";
import { codeTaken, moveProblem, normCode, normLevel, type Spot } from "@/lib/shelf";

export const dynamic = "force-dynamic";

const TABLE = "fittings_shelf_spots";
const SETUP = "Shelf spots are not set up yet: run supabase/add-shelf-spots.sql on the database.";
const bad = (message: string, status = 400) => json({ ok: false, message }, status);
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
// The table or column is missing until the setup file has run.
const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || e.code === "42703" || /does not exist|schema cache/i.test(e.message ?? ""));

async function loadSpots(): Promise<{ spots: Spot[]; placed: Array<{ id: string; spot_id: string }> } | Response> {
  const db = adminDb();
  const [s, p] = await Promise.all([
    db.from(TABLE).select("id, parent_id, level, code, label, sort").limit(20000),
    db.from("fittings_products").select("id, spot_id").not("spot_id", "is", null).limit(20000),
  ]);
  if (missing(s.error) || missing(p.error)) return bad(SETUP, 503);
  if (s.error || p.error) throw new Error((s.error ?? p.error)!.message);
  return { spots: (s.data ?? []) as Spot[], placed: (p.data ?? []) as Array<{ id: string; spot_id: string }> };
}

export async function GET() {
  if (!(await isAdmin())) return bad("Please sign in again.", 401);
  try {
    const got = await loadSpots();
    if (got instanceof Response) return got;
    return json({ ok: true, ...got });
  } catch (e) {
    console.error("shelf spots load failed", e);
    return bad("The shelf spots could not be loaded.", 500);
  }
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return bad("That request came from somewhere else.", 403);
  if (!(await isAdmin())) return bad("Please sign in again.", 401);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("That request was not readable.");
  }
  const db = adminDb();
  try {
    const got = await loadSpots();
    if (got instanceof Response) return got;
    const { spots, placed } = got;

    if (body.action === "spot.save") {
      const id = body.id == null || body.id === "" ? null : body.id;
      if (id !== null && !isId(id)) return bad("That spot no longer exists.");
      if (id && !spots.some((s) => s.id === id)) return bad("That spot no longer exists.");
      const parent = body.parent_id == null || body.parent_id === "" ? null : body.parent_id;
      if (parent !== null && !isId(parent)) return bad("Pick the spot this one sits in.");
      const level = normLevel(String(body.level ?? ""));
      if (!level) return bad("Name the level in 1 to 24 characters, like Aisle or Bin.");
      const code = normCode(String(body.code ?? ""));
      if (!code) return bad("A code is 1 to 6 letters or digits, like 07 or B.");
      const label = String(body.label ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      const sort = Math.trunc(Number(body.sort ?? 0)) || 0;
      const problem = moveProblem(spots, id, parent);
      if (problem) return bad(problem);
      if (codeTaken(spots, parent, code, id)) return bad(`Code ${code} is already used at this level. Pick another.`);
      const row = { parent_id: parent, level, code, label, sort };
      const { error } = id ? await db.from(TABLE).update(row).eq("id", id) : await db.from(TABLE).insert(row);
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    if (body.action === "spot.delete") {
      const id = body.id;
      if (!isId(id) || !spots.some((s) => s.id === id)) return bad("That spot no longer exists.");
      if (spots.some((s) => s.parent_id === id)) return bad("Remove or move the spots inside it first.");
      const items = placed.filter((p) => p.spot_id === id).length;
      if (items) return bad(`${items} item${items === 1 ? " sits" : "s sit"} here. Move ${items === 1 ? "it" : "them"} first.`);
      const { error } = await db.from(TABLE).delete().eq("id", id);
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    if (body.action === "spot.assign") {
      const productId = typeof body.product_id === "string" ? body.product_id.slice(0, 80) : "";
      if (!productId) return bad("Pick an item.");
      const spotId = body.spot_id == null || body.spot_id === "" ? null : body.spot_id;
      if (spotId !== null && (!isId(spotId) || !spots.some((s) => s.id === spotId))) return bad("That spot no longer exists.");
      const { data, error } = await db.from("fittings_products").update({ spot_id: spotId }).eq("id", productId).select("id");
      if (error) throw new Error(error.message);
      if (!data?.length) return bad("That item no longer exists.");
      return json({ ok: true });
    }

    return bad("Unknown action.");
  } catch (e) {
    console.error("shelf spot change failed", e);
    return bad("That did not save. Try again.", 500);
  }
}
