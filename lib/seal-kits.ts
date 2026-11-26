// Hydraulic seal kits: one kit per cylinder, and packages that cover a whole
// machine. Kept pure so the back office, the shop and the tests agree.
//
// A cylinder kit fits a machine at a position (Boom, Dipper, Loader lift...)
// and often only on one side of a serial break: the 580L changed parts at
// JJG0239360, the 580C ran split and one-piece pistons. The position names
// below are the ones the fitment rows use, so "every kit for my 580L" can be
// laid out cylinder by cylinder.
import type { MachineKind } from "./foundation.ts";

export type Cylinder = { position: string; count: number };

/** The cylinders a typical machine of each kind carries, in the order a parts book lists them. */
export const CYLINDERS: Partial<Record<MachineKind, Cylinder[]>> = {
  backhoe: [
    { position: "Boom", count: 1 },
    { position: "Dipper", count: 1 },
    { position: "Bucket", count: 1 },
    { position: "Stabilizer", count: 2 },
    { position: "Swing", count: 2 },
    { position: "Loader lift", count: 2 },
    { position: "Loader bucket (tilt)", count: 2 },
    { position: "Extendahoe", count: 1 },
    { position: "Loader clam (4-in-1)", count: 2 },
    { position: "Steering", count: 1 },
  ],
  excavator: [
    { position: "Boom", count: 2 },
    { position: "Stick", count: 1 },
    { position: "Bucket", count: 1 },
    { position: "Blade", count: 1 },
    { position: "Thumb", count: 1 },
    { position: "Boom swing (offset)", count: 1 },
  ],
  dozer: [
    { position: "Blade lift", count: 2 },
    { position: "Blade tilt", count: 1 },
    { position: "Blade angle", count: 2 },
    { position: "Ripper lift", count: 2 },
    { position: "Ripper tip", count: 1 },
  ],
  tractor: [
    { position: "Loader lift", count: 2 },
    { position: "Loader bucket (tilt)", count: 2 },
    { position: "Power steering", count: 1 },
    { position: "Remote (rear)", count: 1 },
    { position: "Grapple", count: 2 },
  ],
  "wheel-loader": [
    { position: "Lift", count: 2 },
    { position: "Bucket (tilt)", count: 1 },
    { position: "Steering", count: 2 },
  ],
  "skid-steer": [
    { position: "Lift", count: 2 },
    { position: "Bucket (tilt)", count: 2 },
  ],
  "track-loader": [
    { position: "Lift", count: 2 },
    { position: "Bucket (tilt)", count: 2 },
  ],
};

/**
 * Which cylinders make up a "full machine" package. Optional cylinders (an
 * Extendahoe, a 4-in-1 clam, a thumb, a ripper, a grapple) are left out: a
 * package covers what every machine of the kind has.
 */
const OPTIONAL = new Set(["Extendahoe", "Loader clam (4-in-1)", "Thumb", "Blade", "Boom swing (offset)", "Ripper lift", "Ripper tip", "Grapple", "Remote (rear)"]);
export function fullMachine(kind: MachineKind): Cylinder[] {
  return (CYLINDERS[kind] ?? []).filter((c) => !OPTIONAL.has(c.position) && c.position !== "Steering" && c.position !== "Power steering");
}

/** Every position name, for the back office's suggestions and the seal kit filter. */
export function positionsFor(kind: MachineKind | null | undefined): string[] {
  if (kind && CYLINDERS[kind]) return CYLINDERS[kind]!.map((c) => c.position);
  return [...new Set(Object.values(CYLINDERS).flatMap((list) => list!.map((c) => c.position)))];
}

export type PackageLine = { product_id: string; qty: number; price_cents: number | null; position?: string };

/**
 * What a package is worth next to buying its kits one by one. Savings only show
 * when every kit in it has a price, so a missing price never inflates them.
 */
export function packageValue(
  packageCents: number | null,
  lines: PackageLine[],
): { separate: number | null; saves: number | null; kits: number } {
  const kits = lines.reduce((n, l) => n + l.qty, 0);
  if (lines.some((l) => !(l.price_cents && l.price_cents > 0))) return { separate: null, saves: null, kits };
  const separate = lines.reduce((sum, l) => sum + l.qty * (l.price_cents ?? 0), 0);
  const saves = packageCents && packageCents > 0 && separate > packageCents ? separate - packageCents : null;
  return { separate, saves, kits };
}

/**
 * Which of a kind's full-machine cylinders a package covers, and which it is
 * missing, by the positions of the kits in it.
 */
export function packageCoverage(kind: MachineKind, lines: Array<{ position?: string; qty: number }>): { covered: Cylinder[]; missing: Cylinder[] } {
  const have = new Map<string, number>();
  for (const l of lines) if (l.position) have.set(l.position, (have.get(l.position) ?? 0) + l.qty);
  const covered: Cylinder[] = [];
  const missing: Cylinder[] = [];
  for (const c of fullMachine(kind)) {
    const n = have.get(c.position) ?? 0;
    if (n >= c.count) covered.push(c);
    else missing.push({ position: c.position, count: c.count - n });
  }
  return { covered, missing };
}
