// Survey matching: turns a pile of captures (cards, bins, scanned codes, typed
// entries) into parts. Safe to import from both server and browser code.
//
// The rule that makes "snap now, match later" work: captures are the only
// facts that are stored. Parts are worked out fresh from the whole pile every
// time, so the order the photos were taken in, and how many days apart, can
// never change the answer.

export type CaptureKind = "card" | "bin" | "code" | "manual";
export type Confidence = "high" | "medium" | "low";

export type Capture = {
  id: string;
  location_id: string;
  kind: CaptureKind;
  captured_at: string;
  status: "pending" | "read" | "failed";
  read_error: string;
  photo: string | null;
  photo_url?: string | null;
  part_number: string;
  upc: string;
  description: string;
  part_type: string;
  aisle: string;
  bin: string;
  qty_on_card: number | null;
  count_seen: number | null;
  count_confidence: Confidence | null;
  count_note: string;
  codes: string[];
  notes: string;
  /** False once someone says "this bin label does not tie it to that part". */
  use_location: boolean;
  /** True once someone confirms a match that rested on location alone. */
  confirmed: boolean;
  edited: boolean;
};

export type Flag = "conflict" | "confirm" | "mismatch" | "rough_count" | "lookalike";

export type SurveyPart = {
  /** Stable for a given pile: the strongest identifier the part has. */
  key: string;
  part_number: string;
  /** Other part numbers that landed in the same group. More than zero means a conflict. */
  other_numbers: string[];
  upc: string;
  description: string;
  part_type: string;
  aisle: string;
  bin: string;
  card_qty: number | null;
  card_at: string | null;
  counted: number | null;
  counted_confidence: Confidence | null;
  counted_note: string;
  counted_at: string | null;
  has_card: boolean;
  has_bin: boolean;
  /** Capture ids, newest first. */
  captures: string[];
  /** Captures tied to this part by aisle and bin only, not yet confirmed. */
  by_location: string[];
  /** Part numbers elsewhere in the pile that differ only by look-alike characters (0/O, 1/I). */
  lookalikes: string[];
  flags: Flag[];
};

export type Survey = {
  parts: SurveyPart[];
  /** Read, but carrying nothing to match on yet. */
  waiting: Capture[];
  /** Uploaded but not read yet, and nothing typed in to match on. */
  unread: Capture[];
};

export const normPart = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Digits only; a 13-digit code with a leading zero is the same item as its 12-digit form. */
export function normUpc(s: string): string {
  const d = s.replace(/\D/g, "");
  return d.length === 13 && d.startsWith("0") ? d.slice(1) : d;
}

const UPC_LENGTHS = new Set([8, 12, 13, 14]);
export const looksLikeUpc = (s: string): boolean => /^\d+$/.test(s.trim()) && UPC_LENGTHS.has(s.trim().length);

/** Folds characters that handwriting and cameras confuse, to spot near-duplicates. */
export const lookalikeKey = (norm: string): string =>
  norm.replace(/O/g, "0").replace(/[IL]/g, "1").replace(/S/g, "5").replace(/B/g, "8").replace(/Z/g, "2");

function locationKey(c: Capture): string {
  const bin = normPart(c.bin);
  if (!c.use_location || !bin) return "";
  return `${normPart(c.aisle)}|${bin}`;
}

type Keys = { strong: string[]; loc: string };

/** Everything a capture can be matched on. Part numbers and codes are strong; a bin location is not. */
export function keysOf(c: Capture): Keys {
  const strong = new Set<string>();
  const pn = normPart(c.part_number);
  if (pn) strong.add(`pn:${pn}`);
  const upc = normUpc(c.upc);
  if (upc.length >= 8) strong.add(`upc:${upc}`);
  for (const code of c.codes) {
    const text = code.trim();
    if (!text || text.length > 60) continue;
    if (looksLikeUpc(text)) strong.add(`upc:${normUpc(text)}`);
    else if (normPart(text)) strong.add(`pn:${normPart(text)}`);
  }
  return { strong: [...strong], loc: locationKey(c) };
}

class Sets {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    while (this.parent.get(x) !== root) {
      const next = this.parent.get(x) as string;
      this.parent.set(x, root);
      x = next;
    }
    return root;
  }
  join(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    // Smaller string wins so the outcome never depends on arrival order.
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

const newestFirst = (a: Capture, b: Capture) =>
  b.captured_at.localeCompare(a.captured_at) || a.id.localeCompare(b.id);

/** The value most captures agree on; ties go to the newest capture. */
function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  let best = "";
  for (const v of values) {
    if (!v) continue;
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (!best || n > (counts.get(best) ?? 0)) best = v;
  }
  return best;
}

function firstWith<T>(list: Capture[], pick: (c: Capture) => T | null | undefined | ""): T | null {
  for (const c of list) {
    const v = pick(c);
    if (v !== null && v !== undefined && v !== "") return v;
  }
  return null;
}

export function groupCaptures(all: Capture[]): Survey {
  const waiting: Capture[] = [];
  const unread: Capture[] = [];
  const keyed: Array<{ c: Capture; keys: Keys }> = [];

  for (const c of all) {
    const keys = keysOf(c);
    if (keys.strong.length === 0 && !keys.loc) {
      (c.status === "read" ? waiting : unread).push(c);
    } else {
      keyed.push({ c, keys });
    }
  }

  // Pass 1: join on part numbers and codes only.
  const strong = new Sets();
  // Pass 2: the same, plus aisle-and-bin.
  const full = new Sets();
  for (const { c, keys } of keyed) {
    const node = `c:${c.id}`;
    strong.find(node);
    full.find(node);
    // Keys are scoped to the location, so the same part number in two shops stays two parts.
    for (const k of keys.strong) {
      strong.join(node, `${c.location_id}|${k}`);
      full.join(node, `${c.location_id}|${k}`);
    }
    if (keys.loc) full.join(node, `${c.location_id}|loc:${keys.loc}`);
  }

  const groups = new Map<string, Array<{ c: Capture; keys: Keys }>>();
  for (const entry of keyed) {
    const root = full.find(`c:${entry.c.id}`);
    const list = groups.get(root);
    if (list) list.push(entry);
    else groups.set(root, [entry]);
  }

  const parts: SurveyPart[] = [];
  for (const members of groups.values()) {
    const list = members.map((m) => m.c).sort(newestFirst);
    // People's entries outrank what the camera read; cards outrank bins.
    const rank = (c: Capture) => (c.edited || c.kind === "manual" ? 0 : c.kind === "card" ? 1 : c.kind === "code" ? 2 : 3);
    const trusted = [...list].sort((a, b) => rank(a) - rank(b) || newestFirst(a, b));

    const numbers = new Map<string, string>(); // norm -> as written
    for (const c of trusted) {
      const n = normPart(c.part_number);
      if (n && !numbers.has(n)) numbers.set(n, c.part_number.trim());
    }
    const primaryNorm = normPart(mostCommon(trusted.map((c) => normPart(c.part_number))));
    const partNumber = primaryNorm ? (numbers.get(primaryNorm) ?? "") : "";
    const otherNumbers = [...numbers].filter(([n]) => n !== primaryNorm).map(([, shown]) => shown);

    // Which captures hang on by location alone? Everything outside the main strong group.
    const strongRoots = new Map<string, string[]>();
    for (const m of members) {
      const r = m.keys.strong.length ? strong.find(`c:${m.c.id}`) : `alone:${m.c.id}`;
      strongRoots.set(r, [...(strongRoots.get(r) ?? []), m.c.id]);
    }
    let byLocation: string[] = [];
    if (strongRoots.size > 1) {
      const holder = primaryNorm ? strong.find(`${list[0].location_id}|pn:${primaryNorm}`) : "";
      let main = holder && strongRoots.has(holder) ? holder : "";
      if (!main) {
        // No part number yet: the largest group is the anchor, ties broken by name for stability.
        main = [...strongRoots].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0][0];
      }
      const unconfirmed = new Set(list.filter((c) => !c.confirmed).map((c) => c.id));
      byLocation = [...strongRoots]
        .filter(([root]) => root !== main)
        .flatMap(([, ids]) => ids)
        .filter((id) => unconfirmed.has(id))
        .sort();
    }

    const cards = list.filter((c) => c.kind === "card" || (c.kind === "manual" && c.qty_on_card != null));
    const bins = list.filter((c) => c.kind === "bin" || (c.kind === "manual" && c.count_seen != null));
    const card = cards.find((c) => c.qty_on_card != null) ?? null;
    const count = bins.find((c) => c.count_seen != null) ?? null;
    const located = firstWith(trusted, (c) => (c.bin ? c : null));

    const upc = firstWith(trusted, (c) => {
      const direct = normUpc(c.upc);
      if (direct.length >= 8) return direct;
      const scanned = c.codes.find(looksLikeUpc);
      return scanned ? normUpc(scanned) : "";
    });

    const flags: Flag[] = [];
    if (otherNumbers.length) flags.push("conflict");
    if (byLocation.length) flags.push("confirm");
    if (card?.qty_on_card != null && count?.count_seen != null && card.qty_on_card !== count.count_seen) {
      flags.push(count.count_confidence === "low" ? "rough_count" : "mismatch");
    } else if (count?.count_seen != null && count.count_confidence === "low") {
      flags.push("rough_count");
    }

    parts.push({
      key: primaryNorm ? `pn:${primaryNorm}` : upc ? `upc:${upc}` : `at:${list[list.length - 1].id}`,
      part_number: partNumber,
      other_numbers: otherNumbers,
      upc: upc ?? "",
      description: firstWith(trusted, (c) => c.description) ?? "",
      part_type: firstWith(trusted, (c) => c.part_type) ?? "",
      aisle: located?.aisle ?? "",
      bin: located?.bin ?? "",
      card_qty: card?.qty_on_card ?? null,
      card_at: card?.captured_at ?? null,
      counted: count?.count_seen ?? null,
      counted_confidence: count?.count_confidence ?? null,
      counted_note: count?.count_note ?? "",
      counted_at: count?.captured_at ?? null,
      has_card: cards.length > 0,
      has_bin: bins.length > 0,
      captures: list.map((c) => c.id),
      by_location: byLocation,
      lookalikes: [],
      flags,
    });
  }

  // Near-duplicates: 830-FS-O8 next to 830-FS-08 is almost certainly one part read two ways.
  const byFold = new Map<string, SurveyPart[]>();
  for (const p of parts) {
    const n = normPart(p.part_number);
    if (!n) continue;
    const fold = lookalikeKey(n);
    byFold.set(fold, [...(byFold.get(fold) ?? []), p]);
  }
  for (const twins of byFold.values()) {
    if (twins.length < 2) continue;
    for (const p of twins) {
      p.lookalikes = twins.filter((q) => q !== p).map((q) => q.part_number).sort();
      p.flags.push("lookalike");
    }
  }

  // Walk order: aisle, then bin. Parts with no known location go last.
  const place = (p: SurveyPart) =>
    p.bin || p.aisle ? `${normPart(p.aisle).padStart(8, "0")}|${normPart(p.bin).padStart(8, "0")}` : "~";
  parts.sort(
    (a, b) =>
      place(a).localeCompare(place(b)) ||
      normPart(a.part_number).localeCompare(normPart(b.part_number)) ||
      a.key.localeCompare(b.key),
  );
  waiting.sort(newestFirst);
  unread.sort(newestFirst);
  return { parts, waiting, unread };
}

export const FLAG_TEXT: Record<Flag, string> = {
  conflict: "Two part numbers in one group",
  confirm: "Matched by bin location only",
  mismatch: "Card and bin disagree",
  rough_count: "Count is a rough estimate",
  lookalike: "Looks like another part number",
};
