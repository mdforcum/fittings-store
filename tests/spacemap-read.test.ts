import assert from "node:assert/strict";
import { test } from "node:test";
import { LAYOUT_PROMPT, LAYOUT_SCHEMA, answerQuestions, cleanLayout, layoutRequest, mergeQuestions, photoCaption, type Question } from "../lib/spacemap-read.ts";
import { parseSpaceMap } from "../lib/spacemap.ts";
import { strictSchema } from "../lib/strict-schema.ts";

test("whatever the reader sends back is tidied to the shape we keep", () => {
  const got = cleanLayout({
    markup: "spacemap 1\r\nLocation MCD\r\n",
    summary: "  One   room. ",
    seen: ["Aisle 1", 7, "Tags"],
    guessed: ["", "Made up code 1"],
    questions: [
      { question: "Where do picks start?", why: "Sets the start.", choices: ["Counter", "Counter", "Bench"] },
      { question: "where do picks start?", why: "asked twice", choices: [] },
      { question: "How many bins?", why: "", choices: ["12"] },
      { question: "", why: "no question", choices: [] },
      "nonsense",
      ...Array.from({ length: 9 }, (_, i) => ({ question: `Extra ${i}?`, why: "", choices: [] })),
    ],
  });
  assert.equal(got.markup, "spacemap 1\nLocation MCD");
  assert.equal(got.summary, "One room.");
  assert.deepEqual(got.seen, ["Aisle 1", "", "Tags"], "one line per photo, in order, even when one is unusable");
  assert.deepEqual(got.guessed, ["Made up code 1"]);
  assert.equal(got.questions.length, 6);
  assert.deepEqual(got.questions[0], { question: "Where do picks start?", why: "Sets the start.", choices: ["Counter", "Bench"] });
  assert.deepEqual(got.questions[1], { question: "How many bins?", why: "", choices: [] }, "one choice is no choice");
  assert.deepEqual(cleanLayout(null), { markup: "", summary: "", seen: [], guessed: [], questions: [] });
});

test("answers are recorded, skips are kept as skips, and untouched questions drop out at the next read", () => {
  const asked: Question[] = mergeQuestions([], [
    { question: "Where do picks start?", why: "", choices: ["Counter", "Bench"] },
    { question: "How many bins in aisle 3?", why: "", choices: [] },
    { question: "Is aisle 5 open at both ends?", why: "", choices: ["Yes", "No"] },
  ]);
  assert.deepEqual(asked.map((q) => [q.id, q.answer]), [["q1", null], ["q2", null], ["q3", null]]);
  const answered = answerQuestions(asked, { q1: "  Counter ", q2: "", q9: "stray", q3: 5 });
  assert.deepEqual(answered.map((q) => q.answer), ["Counter", "", null]);
  const next = mergeQuestions(answered, [
    { question: "Where do picks start?", why: "", choices: [] }, // already answered: not asked again
    { question: "What is the rack by the door called?", why: "", choices: [] },
  ]);
  assert.deepEqual(next.map((q) => [q.id, q.question, q.answer]), [
    ["q1", "Where do picks start?", "Counter"],
    ["q2", "How many bins in aisle 3?", ""],
    ["q4", "What is the rack by the door called?", null],
  ]);
});

test("the request carries the notes, the file so far, the shelf map, the answers and any problems", () => {
  const asked: Question[] = [
    { id: "q1", question: "Where do picks start?", why: "", choices: [], answer: "Counter" },
    { id: "q2", question: "How many bins?", why: "", choices: [], answer: "" },
    { id: "q3", question: "Still open?", why: "", choices: [], answer: null },
  ];
  const text = layoutRequest({ name: "McCormick", code: "MCD", notes: "Loft is up the stairs.", markup: "spacemap 1\nLocation MCD\n", shelf: "spacemap 1\n\nLocation MCD\n  Aisle 01\n", asked, problems: [{ line: 4, text: "Indent with two spaces for each level." }], photoCount: 2 });
  for (const part of ["Shop: McCormick", "one top line, Location MCD", "There are 2 photos above", "Loft is up the stairs.", "keep their changes", "Parts are already placed in these", "Q: Where do picks start?\nA: Counter", "A: (skipped: do not ask again; use your best reading)", "Line 4: Indent with two spaces"]) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(!text.includes("Still open?"));
  const first = layoutRequest({ name: "McCormick", code: "MCD", notes: "", markup: "", shelf: "", asked: [], photoCount: 0 });
  assert.ok(first.includes("There are no photos yet") && first.includes("There is no layout file yet."));
  assert.equal(photoCaption(3, '  aisle 3\nfrom the "counter" end '), 'Photo 3. The person\'s note: "aisle 3 from the "counter" end"');
  assert.equal(photoCaption(1, " "), "Photo 1. No note.");
});

test("the example in the prompt is a file we can read, and the schema is closed for strict use", () => {
  const example = LAYOUT_PROMPT.slice(LAYOUT_PROMPT.indexOf("spacemap 1\nname:"), LAYOUT_PROMPT.indexOf("- The first line is always"));
  const { problems, count, map } = parseSpaceMap(example);
  assert.deepEqual(problems, []);
  assert.equal(count, 177);
  assert.equal(map.links.length, 1);
  assert.match(LAYOUT_PROMPT, /Never estimate a measurement/);
  const strict = strictSchema(LAYOUT_SCHEMA) as { additionalProperties: boolean; properties: { questions: { items: { additionalProperties: boolean } } } };
  assert.equal(strict.additionalProperties, false);
  assert.equal(strict.properties.questions.items.additionalProperties, false);
});
