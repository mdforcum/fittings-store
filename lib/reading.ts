// What gets read off a survey photo, and the tidy-up applied to whatever the
// model returns. No network calls here, so the rules can be tested.
import type { CaptureKind, Confidence } from "./match.ts";

export type Reading = {
  part_number: string;
  other_numbers: string[];
  upc: string;
  description: string;
  part_type: string;
  aisle: string;
  bin: string;
  qty_on_card: number | null;
  count_seen: number | null;
  count_confidence: Confidence | null;
  count_note: string;
  notes: string;
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100000 ? Math.round(v) : null;

// Words a model reaches for when a field is blank. They are not part numbers.
const BLANKS = /^(n\/?a|none|unknown|not (visible|legible|shown|present|applicable)|illegible|unclear|null|-+|\?+)$/i;
const real = (s: string) => (BLANKS.test(s) ? "" : s);

/** Accepts whatever came back and returns only well-formed values. */
export function cleanReading(raw: unknown): Reading {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const seen = count(r.count_seen);
  const conf = r.count_confidence;
  return {
    part_number: real(str(r.part_number, 60)),
    other_numbers: (Array.isArray(r.other_numbers) ? r.other_numbers : [])
      .map((v) => real(str(v, 60)))
      .filter(Boolean)
      .slice(0, 12),
    upc: str(r.upc, 20).replace(/\D/g, ""),
    description: real(str(r.description, 200)),
    part_type: real(str(r.part_type, 60)),
    aisle: real(str(r.aisle, 20)),
    bin: real(str(r.bin, 20)),
    qty_on_card: count(r.qty_on_card),
    count_seen: seen,
    count_confidence: seen == null ? null : conf === "high" || conf === "medium" || conf === "low" ? conf : "low",
    count_note: str(r.count_note, 200),
    notes: str(r.notes, 300),
  };
}

/** The JSON shape the model must fill in. */
export const READING_SCHEMA = {
  type: "object",
  properties: {
    part_number: {
      type: "string",
      description:
        "The main part number or SKU exactly as written, keeping dashes and letters. Empty string if none is clearly legible. Never guess or complete a partly hidden number.",
    },
    other_numbers: {
      type: "array",
      items: { type: "string" },
      description: "Any other part numbers shown: cross-references, supersessions, vendor numbers.",
    },
    upc: { type: "string", description: "Digits printed under a retail barcode, if any. Empty string otherwise." },
    description: { type: "string", description: "The part description as written, or a plain description of what is in the photo." },
    part_type: { type: "string", description: "A short generic name for the kind of part, such as 'oil filter' or 'JIC cap'." },
    aisle: { type: "string", description: "Aisle, row, shelf or section label if shown. Empty string if not." },
    bin: { type: "string", description: "Bin, drawer or slot label if shown. Empty string if not." },
    qty_on_card: {
      type: ["integer", "null"],
      description:
        "On an inventory card: the current quantity on hand. If the card is a running ledger, this is the most recent balance, not a sum. Null if the photo is not a card or no quantity is legible.",
    },
    count_seen: {
      type: ["integer", "null"],
      description: "For a photo of parts: how many individual parts you can count. Null if the photo shows no countable parts.",
    },
    count_confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description:
        "high: every part is separately visible and counted. medium: a few may be hidden or overlapping. low: parts are piled, stacked or boxed so the true number cannot be seen.",
    },
    count_note: { type: "string", description: "One short sentence on what limits the count, if anything." },
    notes: { type: "string", description: "Anything else useful that is written in the photo, such as a supplier name, price, or reorder point." },
  },
  required: [
    "part_number",
    "other_numbers",
    "upc",
    "description",
    "part_type",
    "aisle",
    "bin",
    "qty_on_card",
    "count_seen",
    "count_confidence",
    "count_note",
    "notes",
  ],
} as const;

const SUBJECT: Record<CaptureKind, string> = {
  card: "This photo should be an inventory card, tag or ledger page for one part.",
  bin: "This photo should be a parts bin, drawer or shelf holding one kind of part, possibly with a label.",
  code: "This photo should be a barcode or label on a part, package or bin.",
  manual: "This photo was added to a typed entry.",
};

export function readingPrompt(kind: CaptureKind): string {
  return [
    "You are helping take a physical inventory of a parts room. Someone is walking the aisles photographing inventory cards and parts bins, and your reading of each photo will be matched against the others later.",
    SUBJECT[kind],
    "Record only what you can actually see. Copy part numbers character for character. If a character could be either a letter or a digit, choose the one that fits the pattern of the rest of the number, and mention the doubt in notes. Leave a field empty rather than guessing: a wrong part number is worse than a missing one.",
    "If parts are visible, count individual pieces. Say plainly when a pile, a box or stacking hides the real number.",
  ].join("\n\n");
}

export type Typed = {
  part_number?: string;
  upc?: string;
  description?: string;
  aisle?: string;
  bin?: string;
  qty_on_card?: number | null;
  count_seen?: number | null;
  notes?: string;
};

/** Joins what was typed on the phone with what the camera read. Typed values win. */
export function mergeTyped(typed: Typed, read: Reading | null) {
  const pick = (a: string | undefined, b: string | undefined) => a || b || "";
  const extra = read?.other_numbers.length ? `Also on it: ${read.other_numbers.join(", ")}.` : "";
  const typedCount = typed.count_seen ?? null;
  const confidence: Confidence | null = typedCount != null ? "high" : (read?.count_confidence ?? null);
  return {
    part_number: pick(typed.part_number, read?.part_number),
    upc: pick(typed.upc, read?.upc),
    description: pick(typed.description, read?.description),
    part_type: read?.part_type ?? "",
    aisle: pick(typed.aisle, read?.aisle),
    bin: pick(typed.bin, read?.bin),
    qty_on_card: typed.qty_on_card ?? read?.qty_on_card ?? null,
    count_seen: typedCount ?? read?.count_seen ?? null,
    count_confidence: confidence,
    count_note: typedCount != null ? "Counted by hand." : (read?.count_note ?? ""),
    notes: [typed.notes, read?.notes, extra].filter(Boolean).join(" ").slice(0, 600),
  };
}
