// The hose builder's API.
//   POST multipart (photos)           read an old hose from photos
//   POST json { action: "request" }   save a build and the customer's request
//   GET ?tag=BH-XXXX-XXXX             a saved build, for an identical replacement
//   GET ?number=<OEM part number>     a stored build for that OEM hose
//   GET ?admin=1                      requests and build points (back office)
//   POST json { action: "admin.*" }   back office changes
import { isAdmin, sameOrigin } from "@/lib/auth";
import { numberNorm } from "@/lib/foundation";
import { SchemaMissing } from "@/lib/foundation-server";
import { TAG_RE, buildSheet, canBuild, checkBuild, cleanBuild, makeTag, type Build } from "@/lib/hose";
import { HOSE_READ_PROMPT, HOSE_READ_SCHEMA, cleanHoseReading } from "@/lib/hose-read";
import { T, adminDb, json } from "@/lib/server";
import { VisionError, askVision, visionReady } from "@/lib/vision";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const H = { builds: "fittings_hose_builds", requests: "fittings_hose_requests" } as const;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const bad = (message: string, status = 400) => json({ ok: false, message }, status);

// Photo reading costs money per call, so each visitor gets a handful an hour.
// Per server instance; good enough to stop a loop, not a determined abuser.
const reads = new Map<string, number[]>();
function allowRead(req: Request): boolean {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const recent = (reads.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 12) return false;
  recent.push(now);
  reads.set(ip, recent);
  if (reads.size > 5000) reads.clear();
  return true;
}

function missing(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return e instanceof SchemaMissing || /could not find the table|relation .* does not exist/i.test(m);
}

const SETUP = "Hose orders are not switched on yet. Call us and we will build it from your details.";

type Builder = { id: string; name: string; phone: string; hours: string; one_hour: boolean; hose_lines: string };

async function builders(oneHourOnly: boolean): Promise<Builder[]> {
  const db = adminDb();
  let q = db.from(T.locations).select("id, name, phone, hours, one_hour, hose_lines").eq("builds_hoses", true);
  if (oneHourOnly) q = q.eq("one_hour", true);
  const { data, error } = await q.order("name");
  if (error) return [];
  return (data ?? []) as Builder[];
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const db = adminDb();
  try {
    if (params.get("admin")) {
      if (!(await isAdmin())) return bad("Please sign in again.", 401);
      const [r, l] = await Promise.all([
        db.from(H.requests).select("*, build:fittings_hose_builds(tag, spec)").order("created_at", { ascending: false }).limit(200),
        db.from(T.locations).select("id, name, phone, hours, builds_hoses, one_hour, hose_lines").order("name"),
      ]);
      if (r.error) throw new Error(r.error.message);
      return json({ ok: true, requests: r.data ?? [], places: l.data ?? [] });
    }
    const tag = str(params.get("tag"), 20).toUpperCase();
    if (tag) {
      if (!TAG_RE.test(tag)) return bad("Tag numbers look like BH-7K2M-Q9TX.");
      const { data, error } = await db.from(H.builds).select("tag, spec").eq("tag", tag).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return bad("We have no build with that tag number.", 404);
      return json({ ok: true, tag: data.tag, build: cleanBuild(data.spec) });
    }
    const number = numberNorm(str(params.get("number"), 40));
    if (number) {
      const { data, error } = await db.from(H.builds).select("tag, spec, make, model").contains("oem_numbers", [number]).limit(1);
      if (error) throw new Error(error.message);
      if (!data?.length) return bad("We do not have that part number's build yet. Snap the old hose or build it by hand.", 404);
      return json({ ok: true, tag: data[0].tag, build: cleanBuild(data[0].spec), make: data[0].make, model: data[0].model });
    }
    return bad("Nothing to look up.");
  } catch (e) {
    if (missing(e)) return bad(SETUP, 503);
    console.error("hose lookup failed", e);
    return bad("That lookup did not work. Try again.", 500);
  }
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return bad("That request came from somewhere else.", 403);
  const type = req.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) return readPhotos(req);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("That request could not be read.");
  }
  if (body.action === "request") return saveRequest(body);
  if (typeof body.action === "string" && body.action.startsWith("admin.")) return adminAction(body);
  return bad("Unknown action.");
}

async function readPhotos(req: Request): Promise<Response> {
  if (!visionReady()) return bad("Photo reading is not switched on yet. Build it by hand below, or call us.", 503);
  if (!allowRead(req)) return bad("That is a lot of photos in an hour. Build it by hand below, or call us.", 429);
  const images: Array<{ bytes: Buffer; mediaType: string; caption: string }> = [];
  try {
    const form = await req.formData();
    const captions: Record<string, string> = {
      layline: "Photo of the printing along the hose:",
      end_a: "Photo of one end of the hose:",
      end_b: "Photo of the other end of the hose:",
    };
    for (const key of Object.keys(captions)) {
      const f = form.get(key);
      if (!(f instanceof Blob) || f.size === 0) continue;
      if (!PHOTO_TYPES.has(f.type)) return bad("Photos must be JPEG, PNG or WebP.");
      if (f.size > 4_500_000) return bad("One of the photos is too large. Try again; the page shrinks them first.");
      images.push({ bytes: Buffer.from(await f.arrayBuffer()), mediaType: f.type, caption: captions[key] });
    }
  } catch {
    return bad("Those photos could not be read.");
  }
  if (images.length === 0) return bad("Add at least one photo.");
  try {
    const raw = await askVision({
      system: HOSE_READ_PROMPT,
      tool: "record_hose",
      description: "Record what these photos show about the hose assembly.",
      schema: HOSE_READ_SCHEMA as unknown as Record<string, unknown>,
      images,
      text: "Identify this hose assembly so an identical replacement can be built.",
      maxTokens: 1500,
    });
    return json({ ok: true, reading: cleanHoseReading(raw) });
  } catch (e) {
    if (e instanceof VisionError) return bad(e.message, 502);
    console.error("hose read failed", e);
    return bad("The photos could not be read. Build it by hand below, or call us.", 500);
  }
}

/** Same hose, ends, length and angle: quantity and notes do not change what gets built. */
function sameAssembly(a: Build, b: Build): boolean {
  const key = (x: Build) => JSON.stringify({ ...x, qty: 0, notes: "" });
  return key(a) === key(b);
}

async function saveRequest(body: Record<string, unknown>): Promise<Response> {
  const build: Build = cleanBuild(body.build);
  if (!canBuild(build)) {
    const first = checkBuild(build).find((p) => p.blocking);
    return bad(first?.text ?? "The build is not complete.");
  }
  const mode = body.mode === "now" ? "now" : "shop";
  const c = (body.contact && typeof body.contact === "object" ? body.contact : {}) as Record<string, unknown>;
  const contact = {
    name: str(c.name, 80),
    phone: str(c.phone, 30),
    email: str(c.email, 120),
    zip: str(c.zip, 10),
    machine: str(c.machine, 120),
    notes: str(c.notes, 600),
  };
  if (!contact.phone && !contact.email) return bad("Add a phone number or email so the builder can reach you.");
  if (mode === "now" && !contact.phone) return bad("For a machine-down build, add a phone number. That is how the builder reaches you.");
  if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) return bad("Check the email address.");

  const db = adminDb();
  try {
    let tag = str(body.tag, 20).toUpperCase();
    // A replacement of a saved build keeps its tag only when nothing about the build changed.
    if (tag && TAG_RE.test(tag)) {
      const prev = await db.from(H.builds).select("spec").eq("tag", tag).maybeSingle();
      if (prev.error) throw new Error(prev.error.message);
      if (!prev.data || !sameAssembly(cleanBuild(prev.data.spec), build)) tag = "";
    } else tag = "";
    for (let i = 0; !tag && i < 5; i++) {
      const t = makeTag();
      const { error } = await db.from(H.builds).insert({ tag: t, spec: build, source: "customer" });
      if (!error) tag = t;
      else if (!/duplicate|23505/.test(`${error.code} ${error.message}`)) throw new Error(error.message);
    }
    if (!tag) throw new Error("could not make a tag");
    const ins = await db
      .from(H.requests)
      .insert({ tag, mode, ...contact })
      .select("number")
      .single();
    if (ins.error) throw new Error(ins.error.message);
    const [list, settings] = await Promise.all([
      builders(mode === "now"),
      db.from(T.settings).select("phone, email").eq("id", 1).maybeSingle(),
    ]);
    return json({
      ok: true,
      number: ins.data.number,
      tag,
      sheet: buildSheet(build, tag),
      builders: list,
      store: { phone: (settings.data?.phone as string) ?? "", email: (settings.data?.email as string) ?? "" },
    });
  } catch (e) {
    if (missing(e)) return bad(SETUP, 503);
    console.error("hose request failed", e);
    return bad("That request did not save. Try again, or call us.", 500);
  }
}

async function adminAction(body: Record<string, unknown>): Promise<Response> {
  if (!(await isAdmin())) return bad("Please sign in again.", 401);
  const db = adminDb();
  try {
    if (body.action === "admin.status") {
      const status = str(body.status, 12);
      if (!["new", "sent", "building", "ready", "done", "cancelled"].includes(status)) return bad("Unknown status.");
      const patch: Record<string, unknown> = { status };
      if (typeof body.builder_id === "string") patch.builder_id = body.builder_id || null;
      const { error } = await db.from(H.requests).update(patch).eq("id", str(body.id, 60));
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }
    if (body.action === "admin.place") {
      const p = (body.place && typeof body.place === "object" ? body.place : {}) as Record<string, unknown>;
      const { error } = await db
        .from(T.locations)
        .update({
          builds_hoses: p.builds_hoses === true,
          one_hour: p.builds_hoses === true && p.one_hour === true,
          hours: str(p.hours, 120),
          phone: str(p.phone, 30),
          hose_lines: str(p.hose_lines, 120),
        })
        .eq("id", str(p.id, 60));
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }
    if (body.action === "admin.oem") {
      // Store a build against one or more OEM part numbers, so the part number alone finds it.
      const tag = str(body.tag, 20).toUpperCase();
      const numbers = (Array.isArray(body.numbers) ? body.numbers : [])
        .map((x) => numberNorm(String(x)))
        .filter(Boolean)
        .slice(0, 20);
      if (!TAG_RE.test(tag)) return bad("That is not a tag number.");
      const { error } = await db
        .from(H.builds)
        .update({ oem_numbers: numbers, make: str(body.make, 40), model: str(body.model, 60) })
        .eq("tag", tag);
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }
    return bad("Unknown action.");
  } catch (e) {
    if (missing(e)) return bad("Run the hose builder section of supabase/schema.sql in Supabase first.", 503);
    console.error("hose admin failed", e);
    return bad("That did not save. Try again.", 500);
  }
}
