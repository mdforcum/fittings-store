// The hydraulic hose build engine: sizes, end connections, how a build is
// checked, and the build sheet a crimping shop works from. Pure functions only.
//
// Pressure ratings are never invented here. They come from the hose maker's
// catalog or from the layline printed on the hose being replaced.

export type Dash = { dash: number; id: string; inches: number };

/** Hose inside diameter by dash size: dash = sixteenths of an inch. */
export const HOSE_DASHES: Dash[] = [
  { dash: 3, id: "3/16", inches: 0.1875 },
  { dash: 4, id: "1/4", inches: 0.25 },
  { dash: 5, id: "5/16", inches: 0.3125 },
  { dash: 6, id: "3/8", inches: 0.375 },
  { dash: 8, id: "1/2", inches: 0.5 },
  { dash: 10, id: "5/8", inches: 0.625 },
  { dash: 12, id: "3/4", inches: 0.75 },
  { dash: 16, id: "1", inches: 1 },
  { dash: 20, id: "1-1/4", inches: 1.25 },
  { dash: 24, id: "1-1/2", inches: 1.5 },
  { dash: 32, id: "2", inches: 2 },
];

export const dashLabel = (d: number) => `-${String(d).padStart(2, "0")}`;
export const hoseId = (d: number) => HOSE_DASHES.find((x) => x.dash === d)?.id ?? "";

/** A thread size an end connection comes in. Major diameter in inches for measuring with calipers. */
export type ThreadSize = { dash: number; thread: string; major: number; tpi: number | null; pitch_mm?: number };

export type EndFamily = {
  id: string;
  label: string;
  standard: string;
  seal: string;
  /** How overall length is measured to this end when it is straight. */
  measure: "end" | "seal_face";
  genders: Array<"male" | "female_swivel">;
  sizes: ThreadSize[];
  note?: string;
};

const un = (dash: number, thread: string, major: number, tpi: number): ThreadSize => ({ dash, thread, major, tpi });
const mm = (dash: number, thread: string, pitch: number): ThreadSize => {
  const d = Number(thread.replace(/^M/, "").split("x")[0]);
  return { dash, thread, major: Math.round((d / 25.4) * 1000) / 1000, tpi: null, pitch_mm: pitch };
};

// SAE J514 37° flare and SAE J1926 O-ring boss share the same UN/UNF threads.
const UNF_37 = [
  un(2, "5/16-24", 0.3125, 24),
  un(3, "3/8-24", 0.375, 24),
  un(4, "7/16-20", 0.4375, 20),
  un(5, "1/2-20", 0.5, 20),
  un(6, "9/16-18", 0.5625, 18),
  un(8, "3/4-16", 0.75, 16),
  un(10, "7/8-14", 0.875, 14),
  un(12, "1-1/16-12", 1.0625, 12),
  un(14, "1-3/16-12", 1.1875, 12),
  un(16, "1-5/16-12", 1.3125, 12),
  un(20, "1-5/8-12", 1.625, 12),
  un(24, "1-7/8-12", 1.875, 12),
  un(32, "2-1/2-12", 2.5, 12),
];

export const END_FAMILIES: EndFamily[] = [
  {
    id: "jic",
    label: "JIC 37° flare",
    standard: "SAE J514",
    seal: "37° flare seat, metal to metal",
    measure: "end",
    genders: ["female_swivel", "male"],
    sizes: UNF_37,
    note: "The most common end on farm equipment. Same threads as O-ring boss; tell them apart by the 37° cone.",
  },
  {
    id: "orfs",
    label: "O-ring face seal (ORFS)",
    standard: "SAE J1453",
    seal: "O-ring in a flat face",
    measure: "seal_face",
    genders: ["female_swivel", "male"],
    sizes: [
      un(4, "9/16-18", 0.5625, 18),
      un(6, "11/16-16", 0.6875, 16),
      un(8, "13/16-16", 0.8125, 16),
      un(10, "1-14", 1, 14),
      un(12, "1-3/16-12", 1.1875, 12),
      un(16, "1-7/16-12", 1.4375, 12),
      un(20, "1-11/16-12", 1.6875, 12),
      un(24, "2-12", 2, 12),
    ],
    note: "Flat face with an O-ring in a groove. Common on newer tractors and loaders.",
  },
  {
    id: "orb",
    label: "O-ring boss (ORB) male",
    standard: "SAE J1926",
    seal: "O-ring under the hex, into a port",
    measure: "end",
    genders: ["male"],
    sizes: UNF_37.filter((s) => s.dash >= 3),
    note: "Screws straight into a port. Same threads as JIC, but a flat shoulder with an O-ring instead of a cone.",
  },
  {
    id: "npt",
    label: "NPT / NPTF pipe",
    standard: "SAE J476 / ANSI B1.20.3",
    seal: "Tapered thread",
    measure: "end",
    genders: ["male", "female_swivel"],
    sizes: [
      un(2, "1/8-27", 0.405, 27),
      un(4, "1/4-18", 0.54, 18),
      un(6, "3/8-18", 0.675, 18),
      un(8, "1/2-14", 0.84, 14),
      un(12, "3/4-14", 1.05, 14),
      un(16, "1-11.5", 1.315, 11.5),
      un(20, "1-1/4-11.5", 1.66, 11.5),
      un(24, "1-1/2-11.5", 1.9, 11.5),
      un(32, "2-11.5", 2.375, 11.5),
    ],
    note: "Tapered: the thread gets narrower toward the end.",
  },
  {
    id: "bspp",
    label: "BSPP (British parallel)",
    standard: "ISO 228-1",
    seal: "60° cone or bonded seal",
    measure: "end",
    genders: ["female_swivel", "male"],
    sizes: [
      un(2, "1/8-28", 0.383, 28),
      un(4, "1/4-19", 0.518, 19),
      un(6, "3/8-19", 0.656, 19),
      un(8, "1/2-14", 0.825, 14),
      un(10, "5/8-14", 0.902, 14),
      un(12, "3/4-14", 1.041, 14),
      un(16, "1-11", 1.309, 11),
      un(20, "1-1/4-11", 1.65, 11),
      un(24, "1-1/2-11", 1.882, 11),
      un(32, "2-11", 2.347, 11),
    ],
    note: "Common on European-built machines.",
  },
  {
    id: "metric-l",
    label: "Metric DIN 24° cone, light (L)",
    standard: "ISO 8434-1",
    seal: "24° cone",
    measure: "end",
    genders: ["female_swivel", "male"],
    sizes: [
      mm(6, "M12x1.5", 1.5),
      mm(8, "M14x1.5", 1.5),
      mm(10, "M16x1.5", 1.5),
      mm(12, "M18x1.5", 1.5),
      mm(15, "M22x1.5", 1.5),
      mm(18, "M26x1.5", 1.5),
      mm(22, "M30x2", 2),
      mm(28, "M36x2", 2),
      mm(35, "M45x2", 2),
      mm(42, "M52x2", 2),
    ],
    note: "Sized by the tube's outside diameter in mm, shown here in place of a dash size.",
  },
  {
    id: "metric-s",
    label: "Metric DIN 24° cone, heavy (S)",
    standard: "ISO 8434-1",
    seal: "24° cone",
    measure: "end",
    genders: ["female_swivel", "male"],
    sizes: [
      mm(6, "M14x1.5", 1.5),
      mm(8, "M16x1.5", 1.5),
      mm(10, "M18x1.5", 1.5),
      mm(12, "M20x1.5", 1.5),
      mm(14, "M22x1.5", 1.5),
      mm(16, "M24x1.5", 1.5),
      mm(20, "M30x2", 2),
      mm(25, "M36x2", 2),
      mm(30, "M42x2", 2),
      mm(38, "M52x2", 2),
    ],
    note: "Sized by the tube's outside diameter in mm, shown here in place of a dash size.",
  },
  {
    id: "flange-61",
    label: "SAE flange, code 61",
    standard: "SAE J518 / ISO 6162-1",
    seal: "O-ring in the flange face, held by split clamps",
    measure: "seal_face",
    genders: ["male"],
    sizes: [8, 12, 16, 20, 24, 32].map((d) => ({ dash: d, thread: `${hoseId(d)} in flange`, major: 0, tpi: null })),
    note: "No threads. Measure the flange head and the bolt spacing; code 62 is the thicker, higher-pressure version.",
  },
  {
    id: "flange-62",
    label: "SAE flange, code 62",
    standard: "SAE J518 / ISO 6162-2",
    seal: "O-ring in the flange face, held by split clamps",
    measure: "seal_face",
    genders: ["male"],
    sizes: [8, 12, 16, 20, 24, 32].map((d) => ({ dash: d, thread: `${hoseId(d)} in flange`, major: 0, tpi: null })),
  },
];

export const familyOf = (id: string) => END_FAMILIES.find((f) => f.id === id);

export const SHAPES = [
  { id: "straight", label: "Straight" },
  { id: "45", label: "45° elbow" },
  { id: "90", label: "90° elbow" },
] as const;
export type Shape = (typeof SHAPES)[number]["id"];

export const GENDER_LABEL = { male: "Male", female_swivel: "Female swivel" } as const;

export type HoseEnd = { family: string; gender: "male" | "female_swivel"; shape: Shape; dash: number };

/** Common hose constructions. Ratings vary by size and maker, so none are stored here. */
export const HOSE_TYPES = [
  { id: "100R1AT", label: "SAE 100R1AT / EN 853 1SN", build: "One wire braid" },
  { id: "100R2AT", label: "SAE 100R2AT / EN 853 2SN", build: "Two wire braids" },
  { id: "100R16", label: "SAE 100R16 / EN 857 2SC", build: "Compact two wire braids" },
  { id: "100R17", label: "SAE 100R17 / EN 857 1SC", build: "Compact braid, constant pressure" },
  { id: "100R12", label: "SAE 100R12 / EN 856 4SP", build: "Four wire spirals" },
  { id: "100R13", label: "SAE 100R13 / EN 856 4SH", build: "Four or six wire spirals" },
  { id: "100R15", label: "SAE 100R15", build: "Six wire spirals, highest pressure" },
  { id: "100R4", label: "SAE 100R4", build: "Suction and return, wire helix" },
  { id: "100R7", label: "SAE 100R7", build: "Thermoplastic, non-conductive" },
  { id: "other", label: "Other or not printed", build: "" },
] as const;

/** A finished assembly, as the build sheet describes it. */
export type Build = {
  hose_type: string;
  hose_dash: number;
  brand: string;
  hose_line: string;
  rated_psi: number | null;
  system_psi: number | null;
  end_a: HoseEnd;
  end_b: HoseEnd;
  /** Overall length in inches, measured the standard way (see measurementNote). */
  length_in: number;
  /** Offset between two elbows, clockwise from the close end to the far end, 0 to 359. */
  angle: number | null;
  sleeve: "none" | "nylon" | "spring_guard" | "fire";
  qty: number;
  notes: string;
};

export const EMPTY_END: HoseEnd = { family: "jic", gender: "female_swivel", shape: "straight", dash: 8 };

export const EMPTY_BUILD: Build = {
  hose_type: "100R2AT",
  hose_dash: 8,
  brand: "",
  hose_line: "",
  rated_psi: null,
  system_psi: null,
  end_a: EMPTY_END,
  end_b: EMPTY_END,
  length_in: 0,
  angle: null,
  sleeve: "none",
  qty: 1,
  notes: "",
};

const isElbow = (e: HoseEnd) => e.shape !== "straight";

/**
 * How the overall length is measured: from the outer end of each fitting,
 * to the sealing face on face-seal and flange ends, and to the centerline of
 * the sealing surface on an elbow.
 */
export function measurePoint(e: HoseEnd): string {
  const fam = familyOf(e.family);
  if (isElbow(e)) return "centerline of the sealing surface";
  return fam?.measure === "seal_face" ? "sealing face" : "end of the fitting";
}

/** Length tolerance, in inches, for an assembly of this length. */
export function lengthTolerance(lengthIn: number): number {
  if (lengthIn <= 18) return 0.125;
  if (lengthIn <= 36) return 0.25;
  if (lengthIn <= 50) return 0.5;
  return Math.round(lengthIn * 0.01 * 100) / 100;
}

/** Offset angle tolerance between two elbows: ±3° up to 24 in, ±5° beyond. */
export const angleTolerance = (lengthIn: number) => (lengthIn < 24 ? 3 : 5);

export type Problem = { field: string; text: string; blocking: boolean };

/** Everything wrong with a build. Blocking problems stop the build sheet. */
export function checkBuild(b: Build): Problem[] {
  const out: Problem[] = [];
  const add = (field: string, text: string, blocking = true) => out.push({ field, text, blocking });

  if (!HOSE_DASHES.some((d) => d.dash === b.hose_dash)) add("hose_dash", "Pick the hose size.");
  for (const [key, label, e] of [
    ["end_a", "First end", b.end_a],
    ["end_b", "Second end", b.end_b],
  ] as const) {
    const fam = familyOf(e.family);
    if (!fam) {
      add(key, `${label}: pick the connection type.`);
      continue;
    }
    if (!fam.genders.includes(e.gender)) add(key, `${label}: ${fam.label} does not come as ${GENDER_LABEL[e.gender].toLowerCase()}.`);
    if (!fam.sizes.some((s) => s.dash === e.dash)) add(key, `${label}: pick a ${fam.label} size.`);
    if (fam.id.startsWith("flange") && e.shape === "45" && e.dash > 16) {
      add(key, `${label}: check that a 45° ${fam.label} comes in this size before ordering.`, false);
    }
  }

  if (!(b.length_in > 0)) add("length_in", "Enter the overall length.");
  else if (b.length_in < 4) add("length_in", "Assemblies shorter than 4 inches need a shop to confirm they can be built.", false);
  else if (b.length_in > 1200) add("length_in", "That is longer than 100 feet. Check the length.");

  if (isElbow(b.end_a) && isElbow(b.end_b)) {
    if (b.angle == null || !(b.angle >= 0 && b.angle < 360)) add("angle", "Both ends are elbows: enter the angle between them (0 if they point the same way).");
  }

  if (b.rated_psi == null) add("rated_psi", "Enter the hose's working pressure, from the layline printed on the old hose or the maker's catalog.");
  else if (!(b.rated_psi > 0 && b.rated_psi <= 15000)) add("rated_psi", "That working pressure does not look right. Check the number on the hose.");
  if (b.system_psi != null && b.rated_psi != null && b.system_psi > b.rated_psi) {
    add("rated_psi", `This hose is rated ${fmtPsi(b.rated_psi)}, below the system's ${fmtPsi(b.system_psi)}. Pick a stronger hose.`);
  }
  if (!(b.qty >= 1 && b.qty <= 500 && Number.isInteger(b.qty))) add("qty", "Quantity must be a whole number from 1 to 500.");
  if (b.hose_type === "100R4" || b.hose_type === "100R7") {
    add("hose_type", "Suction and thermoplastic hose have their own fittings. A shop will confirm the build.", false);
  }
  return out;
}

export const canBuild = (b: Build) => !checkBuild(b).some((p) => p.blocking);

export const fmtPsi = (psi: number) => `${Math.round(psi).toLocaleString("en-US")} psi`;

export function fmtInches(v: number): string {
  const whole = Math.floor(v);
  const eighths = Math.round((v - whole) * 8);
  if (eighths === 8) return `${whole + 1} in`;
  if (eighths === 0) return `${whole} in`;
  const [n, d] = eighths % 4 === 0 ? [eighths / 4, 2] : eighths % 2 === 0 ? [eighths / 2, 4] : [eighths, 8];
  return whole ? `${whole}-${n}/${d} in` : `${n}/${d} in`;
}

export function endLine(e: HoseEnd): string {
  const fam = familyOf(e.family);
  const size = fam?.sizes.find((s) => s.dash === e.dash);
  const shape = SHAPES.find((s) => s.id === e.shape)?.label ?? e.shape;
  const sizeText = fam?.id.startsWith("metric") ? `${e.dash} mm tube` : dashLabel(e.dash);
  return `${GENDER_LABEL[e.gender]} ${fam?.label ?? e.family}, ${shape.toLowerCase()}, ${sizeText}${size ? ` (${size.thread})` : ""}`;
}

export type SheetLine = { label: string; value: string };

/** The build sheet: what a crimping shop needs to build it right the first time. */
export function buildSheet(b: Build, tag: string): { title: string; lines: SheetLine[]; text: string } {
  const type = HOSE_TYPES.find((t) => t.id === b.hose_type);
  const elbows = isElbow(b.end_a) && isElbow(b.end_b);
  const lines: SheetLine[] = [
    { label: "Tag", value: tag },
    { label: "Quantity", value: String(b.qty) },
    {
      label: "Hose",
      value: [`${dashLabel(b.hose_dash)} (${hoseId(b.hose_dash)} in ID)`, type?.label, b.brand, b.hose_line].filter(Boolean).join(", "),
    },
    { label: "Working pressure", value: b.rated_psi ? `${fmtPsi(b.rated_psi)} rated${b.system_psi ? `, system ${fmtPsi(b.system_psi)}` : ""}` : "Not given" },
    { label: "End A", value: endLine(b.end_a) },
    { label: "End B", value: endLine(b.end_b) },
    {
      label: "Overall length",
      value: `${fmtInches(b.length_in)} ±${fmtInches(lengthTolerance(b.length_in)).replace(" in", "")} in, measured from the ${measurePoint(b.end_a)} at A to the ${measurePoint(b.end_b)} at B`,
    },
  ];
  if (elbows) {
    lines.push({
      label: "Offset angle",
      value: `${b.angle ?? 0}° ±${angleTolerance(b.length_in)}°, clockwise from A (close end) to B (far end), looking down the hose from A`,
    });
  }
  if (b.sleeve !== "none") lines.push({ label: "Cover", value: { nylon: "Nylon sleeve", spring_guard: "Spring guard", fire: "Fire sleeve" }[b.sleeve] });
  if (b.notes.trim()) lines.push({ label: "Notes", value: b.notes.trim() });
  lines.push({
    label: "Build rule",
    value: "Hose and both fittings from one maker's system, crimped to that maker's published crimp specification. Tag the assembly with the tag number.",
  });
  const title = `${dashLabel(b.hose_dash)} hose assembly, ${fmtInches(b.length_in)}`;
  return { title, lines, text: [title, ...lines.map((l) => `${l.label}: ${l.value}`)].join("\n") };
}

// ---------------------------------------------------------------------------
// Reading what is printed on a hose, and measured threads
// ---------------------------------------------------------------------------

const BRANDS = ["Gates", "Parker", "Eaton", "Weatherhead", "Aeroquip", "Danfoss", "Continental", "Manuli", "Alfagomma", "Dayco", "Goodyear", "Kurt", "Ryco", "Semperit", "Bridgestone", "Yokohama", "Pirtek"];

export type Layline = {
  brand: string;
  hose_type: string;
  dash: number | null;
  psi: number | null;
  line: string;
};

/**
 * Pulls the facts out of the printed line along a hose, as read off a photo:
 * "PARKER 451TC-8 1/2 IN (12.7MM) SAE 100R16 WP 350 BAR / 5075 PSI".
 */
export function parseLayline(text: string): Layline {
  const t = ` ${text.toUpperCase().replace(/\s+/g, " ")} `;
  const out: Layline = { brand: "", hose_type: "", dash: null, psi: null, line: "" };
  out.brand = BRANDS.find((b) => t.includes(` ${b.toUpperCase()}`)) ?? "";

  const sae = t.match(/100\s?R\s?(\d{1,2})\s?(AT|A|S)?\b/);
  if (sae) {
    const id = `100R${sae[1]}${sae[2] === "AT" ? "AT" : ""}`;
    out.hose_type = HOSE_TYPES.some((h) => h.id === id) ? id : HOSE_TYPES.some((h) => h.id === `${id}AT`) ? `${id}AT` : id;
  } else {
    const en: Record<string, string> = { "1SN": "100R1AT", "2SN": "100R2AT", "2SC": "100R16", "1SC": "100R17", "4SP": "100R12", "4SH": "100R13" };
    const m = t.match(/\b(1SN|2SN|2SC|1SC|4SP|4SH)\b/);
    if (m) out.hose_type = en[m[1]];
  }

  const psi = t.match(/(\d{1,2}[,.]?\d{3})\s?PSI/);
  const bar = t.match(/(\d{2,4})\s?BAR/);
  const mpa = t.match(/(\d{1,2}(?:\.\d{1,2})?)\s?MPA/);
  if (psi) out.psi = Number(psi[1].replace(/[,.]/g, ""));
  else if (bar) out.psi = Math.round(Number(bar[1]) * 14.5038);
  else if (mpa) out.psi = Math.round(Number(mpa[1]) * 145.038);

  const dashMatch = t.match(/(?:^|[\s-])-?(\d{1,2})\s?(?:DASH)?\b(?=[^\d])/);
  const frac = t.match(/\b(\d-\d\/\d|\d\/\d{1,2}|\d)\s?(?:IN\b|"|”|INCH)/);
  if (frac) {
    const found = HOSE_DASHES.find((d) => d.id === frac[1] || (frac[1] === "1" && d.dash === 16) || (frac[1] === "2" && d.dash === 32));
    if (found) out.dash = found.dash;
  }
  if (out.dash == null) {
    const product = t.match(/[A-Z0-9]{2,8}-(\d{1,2})\b/);
    const n = product ? Number(product[1]) : dashMatch ? Number(dashMatch[1]) : NaN;
    if (HOSE_DASHES.some((d) => d.dash === n)) out.dash = n;
  }
  if (out.brand) {
    const after = t.slice(t.indexOf(out.brand.toUpperCase()) + out.brand.length).trim().split(" ")[0] ?? "";
    if (/[A-Z0-9]/.test(after) && !/^(SAE|EN|WP|MADE)/.test(after)) out.line = after.replace(/-\d{1,2}$/, "");
  }
  return out;
}

export type ThreadMatch = { family: EndFamily; size: ThreadSize; off: number };

/**
 * Candidate end connections from a caliper reading of the thread's outside
 * diameter, with threads per inch (or metric pitch) when the customer has a
 * gauge. Closest first.
 */
export function identifyThread(majorIn: number, tpi?: number | null, pitchMm?: number | null): ThreadMatch[] {
  if (!(majorIn > 0)) return [];
  const out: ThreadMatch[] = [];
  for (const family of END_FAMILIES) {
    for (const size of family.sizes) {
      if (!size.major) continue;
      const off = Math.abs(size.major - majorIn);
      // Calipers read a little under the true major diameter on worn threads.
      if (off > Math.max(0.03, size.major * 0.04)) continue;
      if (tpi && size.tpi && Math.abs(size.tpi - tpi) > 0.6) continue;
      if (tpi && !size.tpi) continue;
      if (pitchMm && size.pitch_mm && Math.abs(size.pitch_mm - pitchMm) > 0.1) continue;
      if (pitchMm && !size.pitch_mm) continue;
      out.push({ family, size, off });
    }
  }
  return out.sort((a, b) => a.off - b.off);
}

/** Our own tag for every assembly we build: short, unambiguous, read over a phone. */
export function makeTag(random: () => number = Math.random): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += abc[Math.floor(random() * abc.length)];
  return `BH-${s.slice(0, 4)}-${s.slice(4)}`;
}

export const TAG_RE = /^BH-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

/** Cleans a build that came from a browser. Unknown values fall back to safe defaults. */
export function cleanBuild(raw: unknown): Build {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const end = (v: unknown): HoseEnd => {
    const e = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    return {
      family: familyOf(s(e.family, 20)) ? s(e.family, 20) : "jic",
      gender: e.gender === "male" ? "male" : "female_swivel",
      shape: SHAPES.some((x) => x.id === e.shape) ? (e.shape as Shape) : "straight",
      dash: Math.round(n(e.dash) ?? 0),
    };
  };
  const angle = n(r.angle);
  return {
    hose_type: HOSE_TYPES.some((h) => h.id === r.hose_type) ? (r.hose_type as string) : "other",
    hose_dash: Math.round(n(r.hose_dash) ?? 0),
    brand: s(r.brand, 40),
    hose_line: s(r.hose_line, 40),
    rated_psi: n(r.rated_psi),
    system_psi: n(r.system_psi),
    end_a: end(r.end_a),
    end_b: end(r.end_b),
    length_in: Math.round((n(r.length_in) ?? 0) * 100) / 100,
    angle: angle == null ? null : Math.round(angle),
    sleeve: (["nylon", "spring_guard", "fire"] as const).find((x) => x === r.sleeve) ?? "none",
    qty: Math.round(n(r.qty) ?? 1),
    notes: s(r.notes, 500),
  };
}
