// Word matching that forgives how people really type: "oring", "o ring" and
// "o-ring" are one word; "plugs" finds "plug"; "hydrolic" finds "hydraulic";
// "orb" finds "O-ring boss". Sizes and numbers are never guessed at: a term
// with a digit in it must match exactly, so 3/4-16 never turns into 3/4-14.
// Shared by the shop's search box and the part finder.

const tokensOf = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A plural brought back to one: plugs → plug, boxes → box, bushes → bush. Short words are left alone. */
export function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (/(ch|sh|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

/**
 * How many typing slips apart two words are (a wrong, missing or extra letter,
 * or two letters swapped). Stops counting past `max` and returns max + 1.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

/**
 * Shop shorthand and the words it stands for. With `both`, the words also
 * stand for the shorthand (ORB is exactly "O-ring boss"); without it only the
 * shorthand implies the words (NPT is a pipe thread, but not every pipe thread is NPT).
 */
const SHORTHAND: Array<{ short: string; words: string; both: boolean }> = [
  { short: "orb", words: "o-ring boss", both: true },
  { short: "orfs", words: "o-ring face seal", both: true },
  { short: "jic", words: "flare", both: false },
  { short: "npt", words: "pipe", both: false },
  { short: "zerk", words: "grease fitting", both: false },
];

export type Words = {
  /** The main text, lower case, for a plain "is this in there" check. */
  text: string;
  /** Every word, and its singular. */
  tokens: Set<string>;
  /** Neighbouring words run together ("o" + "ring" → "oring"), so a missing space or hyphen still matches. */
  joins: Set<string>;
  /** Letter-only words of four letters or more, for forgiving a typing slip. */
  alpha: string[];
};

/** Gets text ready to be searched. `extra` is text that can match but ranks below the main text. */
export function prepareWords(main: string, extra = ""): Words {
  const tokens = new Set<string>();
  const joins = new Set<string>();
  const add = (segment: string) => {
    const t = tokensOf(segment);
    for (let i = 0; i < t.length; i++) {
      tokens.add(t[i]);
      tokens.add(stem(t[i]));
      let run = t[i];
      for (let n = 1; n <= 2 && i + n < t.length; n++) {
        run += t[i + n];
        joins.add(run);
        joins.add(run.slice(0, run.length - t[i + n].length) + stem(t[i + n]));
      }
    }
  };
  add(main);
  add(extra);
  for (const s of SHORTHAND) {
    if (tokens.has(s.short)) add(s.words);
    else if (s.both && joins.has(squash(s.words))) tokens.add(s.short);
  }
  const alpha = [...new Set([...tokens, ...joins])].filter((w) => w.length >= 4 && /^[a-z]+$/.test(w));
  return { text: main.toLowerCase(), tokens, joins, alpha };
}

/**
 * How well one search term matches: 3 it is in the text as typed; 2 the same
 * word in another form (no hyphen, plural, start of a word, shop shorthand);
 * 1 one typing slip away (two in a long word); 0 no match.
 */
export function termTier(w: Words, term: string): 0 | 1 | 2 | 3 {
  const t = term.toLowerCase().trim();
  if (!t) return 3;
  if (w.text.includes(t)) return 3;
  const ts = squash(t);
  if (!ts) return 0;
  if (w.tokens.has(ts) || w.joins.has(ts)) return 2;
  // A size, thread or part number has to be right: nothing looser for a term with a digit.
  if (/\d/.test(ts)) return 0;
  const st = stem(ts);
  if (w.tokens.has(st) || w.joins.has(st)) return 2;
  if (ts.length >= 3) for (const k of w.tokens) if (k.startsWith(ts)) return 2;
  if (ts.length >= 4) for (const k of w.joins) if (k.startsWith(ts)) return 2;
  if (st.length >= 4) {
    const max = st.length >= 8 ? 2 : 1;
    for (const k of w.alpha) if (Math.abs(k.length - st.length) <= max && editDistance(st, k, max) <= max) return 1;
  }
  return 0;
}
