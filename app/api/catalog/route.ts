// The catalog foundation's API, back office only.
// GET ?id=<item> returns the categories, places, machines and that item's details.
// GET ?machines=1 returns the machine list with how many items list each one.
// POST { action: "details.save", id, details } saves an item's details and returns the fresh copy.
// POST { action: "machine.save", machine } adds or changes one machine.
// POST { action: "machines.add", text } adds a pasted lineup, one machine per line.
// POST { action: "machine.delete", id } removes a machine no item lists.
import { isAdmin, sameOrigin } from "@/lib/auth";
import { parseMachineLines } from "@/lib/foundation";
import {
  DetailsError,
  MachineProblem,
  SchemaMissing,
  addMachines,
  deleteMachine,
  loadDetails,
  loadMeta,
  machinesWithUse,
  saveDetails,
  saveMachine,
} from "@/lib/foundation-server";
import { adminDb, json } from "@/lib/server";

export const dynamic = "force-dynamic";

function problem(e: unknown, what: string): Response {
  if (e instanceof SchemaMissing) return json({ ok: false, message: e.message, setup: true }, 503);
  if (e instanceof DetailsError || e instanceof MachineProblem) return json({ ok: false, message: e.message }, 400);
  console.error(what, e);
  return json({ ok: false, message: "That did not work. Try again." }, 500);
}

export async function GET(req: Request) {
  if (!(await isAdmin())) return json({ ok: false, message: "Please sign in again." }, 401);
  const params = new URL(req.url).searchParams;
  try {
    const db = adminDb();
    if (params.get("machines")) return json({ ok: true, machines: await machinesWithUse(db) });
    const id = (params.get("id") ?? "").slice(0, 80);
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
  try {
    const db = adminDb();
    switch (body.action) {
      case "details.save": {
        const id = typeof body.id === "string" ? body.id.slice(0, 80) : "";
        const details = body.details && typeof body.details === "object" ? (body.details as Record<string, unknown>) : null;
        if (!id || !details) return json({ ok: false, message: "That request was missing the item." }, 400);
        return json({ ok: true, details: await saveDetails(db, id, details) });
      }
      case "machine.save": {
        const m = body.machine && typeof body.machine === "object" ? (body.machine as Record<string, unknown>) : null;
        if (!m) return json({ ok: false, message: "That request was missing the machine." }, 400);
        return json({ ok: true, machine: await saveMachine(db, m) });
      }
      case "machines.add": {
        const text = typeof body.text === "string" ? body.text.slice(0, 200_000) : "";
        const { machines, problems } = parseMachineLines(text);
        if (problems.length) return json({ ok: false, message: problems.slice(0, 5).join(" ") }, 400);
        if (!machines.length) return json({ ok: false, message: "Paste at least one machine, one per line." }, 400);
        return json({ ok: true, ...(await addMachines(db, machines)) });
      }
      case "machine.delete": {
        const id = typeof body.id === "string" ? body.id.slice(0, 40) : "";
        if (!id) return json({ ok: false, message: "That request was missing the machine." }, 400);
        await deleteMachine(db, id);
        return json({ ok: true });
      }
      default:
        return json({ ok: false, message: "Unknown action." }, 400);
    }
  } catch (e) {
    return problem(e, "catalog save failed");
  }
}
