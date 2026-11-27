// What the Space mapper asks the photo reader, and the tidy-up applied to what
// comes back. No network calls here, so the rules can be tested.
//
// The reader gets the shop's photos with their notes, whatever is already
// known (the layout file so far, the shelf map, earlier answers), and returns
// the layout file (lib/spacemap.ts) plus the questions it still needs answered.
import type { Problem } from "./spacemap.ts";

/** One question to the person mapping the shop. `answer` is null until they reply; "" means they skipped it. */
export type Question = { id: string; question: string; why: string; choices: string[]; answer: string | null };

export type Layout = {
  markup: string;
  summary: string;
  /** What each photo shows, in the order the photos were sent. */
  seen: string[];
  /** What the reader assumed without a photo, note or answer to back it. */
  guessed: string[];
  questions: Array<Pick<Question, "question" | "why" | "choices">>;
};

export const MAX_PHOTOS = 16;
export const MAX_QUESTIONS = 6;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const list = (v: unknown, max: number, each: number) =>
  (Array.isArray(v) ? v : [])
    .map((x) => str(x, each))
    .filter(Boolean)
    .slice(0, max);

/** Accepts whatever came back and returns only well-formed values. */
export function cleanLayout(raw: unknown): Layout {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const seenQuestions = new Set<string>();
  const questions = (Array.isArray(r.questions) ? r.questions : [])
    .map((q) => (q && typeof q === "object" ? (q as Record<string, unknown>) : {}))
    .map((q) => ({ question: str(q.question, 300), why: str(q.why, 200), choices: [...new Set(list(q.choices, 5, 60))] }))
    .filter((q) => q.question && !seenQuestions.has(q.question.toLowerCase()) && seenQuestions.add(q.question.toLowerCase()))
    .map((q) => ({ ...q, choices: q.choices.length >= 2 ? q.choices : [] }))
    .slice(0, MAX_QUESTIONS);
  return {
    markup: typeof r.markup === "string" ? r.markup.replace(/\r\n?/g, "\n").trim().slice(0, 200_000) : "",
    summary: str(r.summary, 600),
    seen: (Array.isArray(r.seen) ? r.seen : []).map((x) => str(x, 200)).slice(0, MAX_PHOTOS),
    guessed: list(r.guessed, 10, 200),
    questions,
  };
}

/** New questions join the ones already asked, each with an id of its own. */
export function mergeQuestions(asked: Question[], fresh: Layout["questions"]): Question[] {
  // Anything still open from an earlier round was not asked again, so it is settled.
  const kept = asked.filter((q) => q.answer !== null);
  let n = asked.reduce((max, q) => Math.max(max, Number(/^q(\d+)$/.exec(q.id)?.[1] ?? 0)), 0);
  const known = new Set(kept.map((q) => q.question.toLowerCase()));
  const added = fresh.filter((q) => !known.has(q.question.toLowerCase())).map((q) => ({ ...q, id: `q${++n}`, answer: null }));
  return [...kept, ...added].slice(-60);
}

/**
 * Records the answers the person gave. "" means they skipped the question on
 * purpose. A question they did not touch stays open, and is dropped when the
 * next reading brings its own questions.
 */
export function answerQuestions(asked: Question[], answers: Record<string, unknown>): Question[] {
  return asked.map((q) => (q.answer === null && typeof answers[q.id] === "string" ? { ...q, answer: str(answers[q.id], 400) } : q));
}

/** The JSON shape the model must fill in. */
export const LAYOUT_SCHEMA = {
  type: "object",
  properties: {
    markup: {
      type: "string",
      description: "The whole layout file, from the line \"spacemap 1\" to the last link line. Plain text with real line breaks, no code fences.",
    },
    summary: {
      type: "string",
      description: "Two or three plain sentences for shop staff: what the shop looks like as you now understand it, and how a picker walks it.",
    },
    seen: {
      type: "array",
      items: { type: "string" },
      description: "One short line per photo, in the order given: what the photo shows and what you took from it. Say so when a photo was no help.",
    },
    guessed: {
      type: "array",
      items: { type: "string" },
      description: "Anything in the file that no photo, note or answer backs up: a code you made up, a count you assumed, a link you guessed. Empty when there is nothing.",
    },
    questions: {
      type: "array",
      description: `What you still need to know, most important first, at most ${MAX_QUESTIONS}. Empty when the file is complete.`,
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "One question about one thing, in plain words a counter person would use." },
          why: { type: "string", description: "A few words on what the answer changes: the file, or the order parts are pulled." },
          choices: {
            type: "array",
            items: { type: "string" },
            description: "Two to four short answers to tap when the answer is one of a few. Empty when it needs typing (a count, a code, a name).",
          },
        },
        required: ["question", "why", "choices"],
      },
    },
  },
  required: ["markup", "summary", "seen", "guessed", "questions"],
} as const;

export const LAYOUT_PROMPT = `You map the inside of a parts shop or warehouse so staff can pull parts for several orders in one short walk.

You are given photos taken in the shop, each with an optional note from the person who took it. A photo may show shelving, an aisle, bin tags, a sign, a door, a stairway, a hand sketch or a whiteboard drawing. You are also given what is already known: the layout file so far, the spots already on the shop's shelf map, anything the person wrote about the shop, and their answers to earlier questions.

Your job is to write the shop's layout as a layout file, and to ask the questions you still need answered.

WHAT MATTERS
- What is there: buildings, rooms and areas, aisles, sections, shelves, bins.
- The codes and names the shop already uses for them.
- The order you walk past them.
- What is next to what, and how you get from one room to another.
- Where a pick starts and ends.

WHAT DOES NOT MATTER
Sizes, distances, scale, floor plans, construction. Never estimate a measurement, never describe geometry, and never ask for one. This is about layout and proximity only.

THE LAYOUT FILE

spacemap 1
name: McCormick Diesel Service

Location MCD "McCormick Diesel"
  Building 1 "Main shop"
    Area 100 "Parts room"
      Aisle 01..04
        Section A..C
          Bin 01..12
      Aisle 05 (dead end)
        Bin 01..08
    Area 105 "Upstairs backstock"
      Shelf A..D

start: MCD-1-100 "Parts counter"
link: MCD-1-100-04 <> MCD-1-105 far "Stairs at the end of aisle 4"

- The first line is always: spacemap 1
- One spot per line: a level word, then a code, then an optional name in double quotes.
- Two spaces of indent put a spot inside the spot above it. At most 10 levels deep.
- A code is 1 to 6 letters or digits, no spaces or dashes. Spots under the same parent need different codes.
- The usual level words are Location, Building, Area, Aisle, Section, Bin, Sub-bin. Use the shop's own word where it has one (Row, Shelf, Rack, Cabinet, Drawer, Room).
- A range like 01..12 or A..D is that many spots in a row. Anything indented under a range is inside every one of them, so regular shelving takes a few lines. A range line has no name. Use ranges wherever the shop is regular.
- List spots in the order a person walks past them: aisles in the order you cross them from the start, sections and bins in the order you pass them walking down the aisle.
- Add (dead end) to an aisle that is closed at the far end, so you walk in and back out the same way.
- start: is the one place in a location where picks begin and end (parts counter, packing bench). Give the joined code of the spot it is in or beside, and its name in quotes.
- A joined code is the codes from the top down with dashes: MCD-1-100-04.
- link: joins two spots and says how far apart they are: near (a few steps), walk (across the room or through a door), far (stairs, another building, outside). Put what you go through in quotes.
- Without a link, spots listed one after another are taken to be next to each other, and you come into a room at the first spot listed inside it. Write a link wherever that is not true, and for every way between two rooms, areas or buildings that you know of. A link from a spot inside a room (the aisle the stairs are in) is better than a link from the room.
- A line starting with # is a note for people.

RULES
- Use the shop's own codes and names wherever a tag, sign, label, sketch or note shows them. Make up a code only when the shop has none; keep it short and list it under guessed.
- Keep every code that is already on the shelf map or in the layout file so far, unless the person says it is wrong. Add to what is there; do not rename it.
- Put in only what a photo, note or answer supports. If you can see an aisle has bins but not how many, put in the aisle, leave the bins out and ask.
- Never fill in a count or a code you cannot see or were not told. Never pad the file to look complete.
- Exactly one Location line at the top, with the name and location code you were given. Never add a second Location and never change its code.
- Send the whole file every time, including the parts that did not change.

QUESTIONS
- Ask only what would change the file or the order parts are pulled.
- At most ${MAX_QUESTIONS} at a time, most important first. One thing per question.
- Plain words. The person answering works the parts counter and is standing in the shop.
- Give two to four short choices when the answer is one of a few. Leave choices empty when it needs a count, a code or a name.
- Do not ask what a photo, note or earlier answer already tells you.
- Do not ask again about something the person skipped. Take your best reading and list it under guessed.
- Good questions: where picks start and end; which end of the room aisle 1 is at; whether an aisle is open at both ends; how you get to a room you can see a door to; how many sections or bins an aisle has when the photo cuts off; whether bin numbers start at the top or bottom, the near end or the far end; what the shop calls a rack you cannot see a tag on; a photo that would help ("a photo looking down aisle 3 from the counter end").
- When the file is complete, ask nothing.`;

export type ReadContext = {
  name: string;
  /** The location's short code: the code on the file's one top line. */
  code: string;
  /** What the person wrote about the shop as a whole. */
  notes: string;
  /** The layout file so far ("" on the first read). */
  markup: string;
  /** The shelf map as it stands, in layout-file form ("" when it is empty). */
  shelf: string;
  asked: Question[];
  /** Problems found in the file the reader sent a moment ago (a second try). */
  problems?: Problem[];
  photoCount: number;
};

/** The words that go with the photos. */
export function layoutRequest(c: ReadContext): string {
  const parts: string[] = [];
  parts.push(`Shop: ${c.name}\nIts location code: ${c.code}. The file has one top line, Location ${c.code}, and everything else sits inside it.`);
  parts.push(c.photoCount ? `There ${c.photoCount === 1 ? "is 1 photo" : `are ${c.photoCount} photos`} above, numbered in the order taken.` : "There are no photos yet. Work from the notes and answers.");
  if (c.notes.trim()) parts.push(`What the person wrote about the shop:\n${c.notes.trim()}`);
  parts.push(c.markup.trim() ? `The layout file so far (the person may have edited it by hand; keep their changes):\n${c.markup.trim()}` : "There is no layout file yet.");
  if (c.shelf.trim()) parts.push(`Spots already on the shop's shelf map, in layout-file form. Parts are already placed in these, so keep their codes:\n${c.shelf.trim()}`);
  const answered = c.asked.filter((q) => q.answer !== null);
  if (answered.length) {
    parts.push(
      "Your earlier questions and the person's answers:\n" +
        answered.map((q) => `Q: ${q.question}\nA: ${q.answer ? q.answer : "(skipped: do not ask again; use your best reading)"}`).join("\n"),
    );
  }
  if (c.problems?.length) {
    parts.push(
      "The file you just sent could not be read in these places. Send the whole file again with them fixed:\n" +
        c.problems.map((p) => `Line ${p.line}: ${p.text}`).join("\n"),
    );
  }
  parts.push("Write the layout file and ask what you still need to know.");
  return parts.join("\n\n");
}

/** The words above one photo. */
export function photoCaption(n: number, note: string): string {
  const said = note.replace(/\s+/g, " ").trim().slice(0, 400);
  return said ? `Photo ${n}. The person's note: "${said}"` : `Photo ${n}. No note.`;
}
