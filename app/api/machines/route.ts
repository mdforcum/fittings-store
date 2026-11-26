// Public: which machine a serial number belongs to.
// GET ?serial=<serial or 17-character PIN>[&machine=<machine id>]
// GET ?list=1 gives the lineup for the shop's machine picker.
// Answers machines and build years only; the serial tables themselves stay private.
import { SchemaMissing, loadMachines, lookupSerial } from "@/lib/foundation-server";
import { matchSentence } from "@/lib/serials";
import { adminDb, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  if (params.get("list")) {
    try {
      const machines = await loadMachines(adminDb());
      return Response.json(
        {
          ok: true,
          machines: machines.map((m) => ({ id: m.id, make: m.make, kind: m.kind, series: m.series, model: m.model, year_from: m.year_from, year_to: m.year_to })),
        },
        { headers: { "Cache-Control": "public, max-age=300" } },
      );
    } catch (e) {
      console.error("machine list failed", e);
      return json({ ok: false, message: "The machine list could not be loaded." }, 500);
    }
  }
  const serial = (params.get("serial") ?? "").slice(0, 40);
  const machine = (params.get("machine") ?? "").slice(0, 40);
  if (!serial.trim()) return json({ ok: false, message: "Type the serial number from the machine's plate." }, 400);
  if (machine && !/^[0-9a-f-]{36}$/i.test(machine)) return json({ ok: false, message: "That machine is not on our list." }, 400);
  try {
    const matches = await lookupSerial(adminDb(), serial, machine || undefined);
    return json({
      ok: true,
      matches: matches.map((m) => ({
        machine_id: m.machine_id,
        make: m.make,
        model: m.model,
        kind: m.kind,
        series: m.series,
        year: m.year,
        note: m.note,
        confirmed: m.confidence === "oem" || m.confidence === "observed",
        sentence: matchSentence(m, `${m.make} ${m.model}`),
      })),
    });
  } catch (e) {
    if (e instanceof SchemaMissing) return json({ ok: false, message: "Serial lookup is not set up yet." }, 503);
    console.error("serial lookup failed", e);
    return json({ ok: false, message: "That did not work. Try again." }, 500);
  }
}
