// The measuring guide: step-by-step walkthroughs for the ways a customer
// measures a hose, written from the ends actually picked. Pure functions only.
import { familyOf, fmtInches, measurePoint, type HoseEnd } from "./hose.ts";

export type Step = { title: string; body: string; warn?: string };
export type Path = "off" | "on" | "angle";

/** Where to put the tape on one end, in words a first-timer can follow. */
export function measureHow(e: HoseEnd, label: "A" | "B"): string {
  const point = measurePoint(e);
  const fam = familyOf(e.family);
  if (point === "centerline of the sealing surface") {
    return `End ${label} is an elbow. Measure to the middle of its sealing end: picture a line straight through the center of the opening, and measure to where that line crosses the hose's path.`;
  }
  if (point === "sealing face") {
    return `End ${label} is ${fam?.label ?? "a face seal"}. Measure to the flat sealing face, the surface with the O-ring, not to the back of the nut.`;
  }
  return `End ${label} is ${fam?.label ?? "a straight fitting"}. Measure to the very end of the fitting${e.gender === "female_swivel" ? ", the outer edge of the swivel nut" : ", the tip of the threads"}.`;
}

const SAFETY =
  "Lower everything to the ground, shut the engine off, and work the controls back and forth to bleed off pressure. Never feel along a hose for a leak: oil under pressure can go through skin, and that needs a doctor the same day.";

export function steps(path: Path, a: HoseEnd, b: HoseEnd): Step[] {
  if (path === "off") {
    return [
      {
        title: "Lay it out straight",
        body: "Put the old hose on a flat floor and pull it straight, end to end. Any curve left in it hides length.",
      },
      { title: "Find end A's measuring point", body: measureHow(a, "A") },
      { title: "Find end B's measuring point", body: measureHow(b, "B") },
      {
        title: "Measure",
        body: "Hook the tape at end A's point and run it along the hose to end B's point. Read it to the nearest 1/8 inch.",
      },
      {
        title: "Or let us read the tape",
        body: "Leave the tape in place and take one close photo of the tape at each end, so the numbers at each measuring point are sharp. We read both and work out the length.",
      },
    ];
  }
  if (path === "on") {
    return [
      { title: "Make it safe first", body: SAFETY, warn: "Do this before you touch the hose." },
      {
        title: "Follow the route with a string",
        body: "Run a string, a strip of wire, or a soft tape along the path the hose takes from port to port: through the same clamps, around the same bends. Do not cut corners.",
      },
      { title: "Mark end A's point", body: `${measureHow(a, "A")} Mark the string there.` },
      { title: "Mark end B's point", body: `${measureHow(b, "B")} Mark the string there.` },
      {
        title: "Measure the string",
        body: "Pull the string straight beside a tape and measure between the two marks. If the old hose was rubbing, kinked, or pulled tight, note that so the builder can adjust.",
      },
    ];
  }
  return [
    {
      title: "Hold the hose straight",
      body: "With both elbows on, lay the hose out straight without twisting it.",
    },
    {
      title: "Look down the hose from end A",
      body: "Hold end A close to you so you are looking along the hose toward end B. Turn the hose until end A's elbow points straight up, at 12 o'clock.",
    },
    {
      title: "Where does end B point?",
      body: "Read end B's elbow like a clock hand, going clockwise: 12 o'clock is 0°, 3 o'clock is 90°, 6 o'clock is 180°, 9 o'clock is 270°. Tap where it points.",
    },
  ];
}

/** Clock positions for the angle step: label and degrees, clockwise from 12. */
export const CLOCK = [
  { deg: 0, label: "12" },
  { deg: 45, label: "1:30" },
  { deg: 90, label: "3" },
  { deg: 135, label: "4:30" },
  { deg: 180, label: "6" },
  { deg: 225, label: "7:30" },
  { deg: 270, label: "9" },
  { deg: 315, label: "10:30" },
];

/**
 * Length from two readings on a tape that was not hooked at zero: the
 * distance between them, to the nearest 1/8 inch. Null when the readings
 * are missing or make no sense.
 */
export function lengthFromTape(a: number | null, b: number | null): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = Math.abs(b - a);
  if (d < 1 || d > 1200) return null;
  return Math.round(d * 8) / 8;
}

export const describeLength = (inches: number) => fmtInches(inches);

export const TAPE_READ_SCHEMA = {
  type: "object",
  properties: {
    a_inches: {
      type: ["number", "null"],
      description: "Tape reading at the fitting in the first photo, in inches (convert cm). Null if the number is not readable.",
    },
    b_inches: {
      type: ["number", "null"],
      description: "Tape reading at the fitting in the second photo, in inches (convert cm). Null if the number is not readable.",
    },
    note: { type: "string", description: "Anything that makes a reading doubtful, in plain words. Empty if both are clear." },
  },
  required: ["a_inches", "b_inches", "note"],
} as const;

export const TAPE_READ_PROMPT = `You read tape measures in photos of hydraulic hoses.

Each photo shows one end of a hose lying straight beside a tape measure. Find where the fitting's measuring point lines up on the tape: the end of a straight fitting, or the flat sealing face of an O-ring face seal fitting. Read the tape at that point to the nearest 1/16 inch, counting the small marks after the last whole-inch number. If the tape is metric, convert to inches.

If the numbers are blurred, cut off, or you cannot see where the fitting lines up, give null for that reading and say why in the note. Never guess a number.`;

export function cleanTapeReading(raw: unknown): { a: number | null; b: number | null; length: number | null; note: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1300 ? Math.round(v * 16) / 16 : null);
  const a = n(r.a_inches);
  const b = n(r.b_inches);
  return { a, b, length: lengthFromTape(a, b), note: typeof r.note === "string" ? r.note.trim().slice(0, 240) : "" };
}
