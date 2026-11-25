// What a photo of an old hose assembly can tell us, and how it is cleaned.
// Shared by the server (which asks) and the page (which shows the answer).
import { END_FAMILIES, HOSE_DASHES, HOSE_TYPES, SHAPES, familyOf, parseLayline } from "./hose.ts";

export const HOSE_READ_SCHEMA = {
  type: "object",
  properties: {
    layline: {
      type: "string",
      description: "Every character printed along the hose, exactly as printed, in order. Empty if none is visible.",
    },
    brand: { type: "string", description: "Hose maker as printed, e.g. Gates, Parker, Eaton. Empty if not printed." },
    hose_type: {
      type: "string",
      enum: HOSE_TYPES.map((h) => h.id),
      description: "SAE or EN type printed on the hose, mapped to the SAE name. 'other' if not printed.",
    },
    hose_dash: { type: ["integer", "null"], description: "Dash size of the hose (sixteenths of an inch ID) if printed or certain." },
    working_psi: { type: ["integer", "null"], description: "Working pressure printed on the hose, converted to psi. Null if not printed." },
    ends: {
      type: "array",
      description: "Each fitting visible in the photos, one entry per end of the hose.",
      items: {
        type: "object",
        properties: {
          family: { type: "string", enum: [...END_FAMILIES.map((f) => f.id), "unknown"] },
          gender: { type: "string", enum: ["male", "female_swivel", "unknown"] },
          shape: { type: "string", enum: [...SHAPES.map((s) => s.id), "unknown"] },
          dash: { type: ["integer", "null"], description: "Thread size as a dash number, only if a scale or marking makes it clear." },
          stamped: { type: "string", description: "Anything stamped on the fitting (maker, part number), exactly as shown." },
          why: { type: "string", description: "What in the photo shows this: cone angle, O-ring face, flats, thread taper." },
        },
        required: ["family", "gender", "shape", "dash", "stamped", "why"],
      },
    },
    length_in: { type: ["number", "null"], description: "Overall length in inches, only if a tape measure is readable in the photo." },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    ask: {
      type: "string",
      description: "The one thing the customer should check or measure to be sure, in plain words. Empty if nothing.",
    },
  },
  required: ["layline", "brand", "hose_type", "hose_dash", "working_psi", "ends", "length_in", "confidence", "ask"],
} as const;

export const HOSE_READ_PROMPT = `You identify hydraulic hose assemblies from photos so a replacement can be built.

Read the layline (the text printed along the hose) character for character. Do not guess characters you cannot see.

For each fitting, decide the connection type from what is visible:
- JIC 37° flare: a cone-shaped seat at about 37°, threads on a swivel nut (female) or on the body (male).
- O-ring face seal (ORFS): a flat face with an O-ring groove.
- O-ring boss (ORB): male only; straight threads with an O-ring under a flat shoulder, made to screw into a port.
- NPT: tapered threads that narrow toward the end, no seat or O-ring.
- BSPP: parallel threads with a 60° cone or a bonded seal; common on European machines.
- Metric DIN 24°: a 24° cone with a metric nut.
- SAE flange code 61 or 62: a flat flange head held by split clamps, no threads.
If you cannot tell, say "unknown" and use "ask" to tell the customer what to check.

Only give a dash size or length when a printed marking or a readable scale makes it certain. Never invent a pressure: give working_psi only if it is printed.`;

export type HoseReading = {
  layline: string;
  brand: string;
  hose_type: string;
  hose_dash: number | null;
  working_psi: number | null;
  ends: Array<{ family: string; gender: string; shape: string; dash: number | null; stamped: string; why: string }>;
  length_in: number | null;
  confidence: "high" | "medium" | "low";
  ask: string;
};

const s = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Cleans what came back and cross-checks it against our own reading of the
 * layline text: where the printed text says something plainly, the text wins.
 */
export function cleanHoseReading(raw: unknown): HoseReading {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const layline = s(r.layline, 300);
  const parsed = parseLayline(layline);
  const dash = n(r.hose_dash);
  const psi = n(r.working_psi);
  const ends = (Array.isArray(r.ends) ? r.ends : []).slice(0, 2).map((x) => {
    const e = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const family = familyOf(s(e.family, 20)) ? s(e.family, 20) : "unknown";
    const d = n(e.dash);
    return {
      family,
      gender: e.gender === "male" || e.gender === "female_swivel" ? (e.gender as string) : "unknown",
      shape: SHAPES.some((x) => x.id === e.shape) ? (e.shape as string) : "unknown",
      dash: d != null && familyOf(family)?.sizes.some((z) => z.dash === d) ? d : null,
      stamped: s(e.stamped, 60),
      why: s(e.why, 200),
    };
  });
  const type = s(r.hose_type, 12);
  return {
    layline,
    brand: parsed.brand || s(r.brand, 40),
    hose_type: parsed.hose_type || (HOSE_TYPES.some((h) => h.id === type) ? type : "other"),
    hose_dash: parsed.dash ?? (dash != null && HOSE_DASHES.some((h) => h.dash === dash) ? dash : null),
    working_psi: parsed.psi ?? (psi != null && psi > 0 && psi <= 15000 ? Math.round(psi) : null),
    ends,
    length_in: (() => {
      const l = n(r.length_in);
      return l != null && l > 0 && l < 1200 ? Math.round(l * 8) / 8 : null;
    })(),
    confidence: r.confidence === "high" || r.confidence === "medium" ? r.confidence : "low",
    ask: s(r.ask, 240),
  };
}
