import assert from "node:assert/strict";
import { test } from "node:test";
import bwipjs from "bwip-js/node";
import { QUIET, canEncode, code128Modules, code128Svg, code128Widths } from "../lib/code128.ts";
import { decodePixels, type Pixels } from "../lib/decode.ts";

const reference = (text: string) => (bwipjs.raw("code128", text, { parse: false }) as Array<{ sbs: number[] }>)[0].sbs;

/** Draws the widths as a picture, 3 pixels a module, the way a label prints. */
function picture(widths: number[]): Pixels {
  const unit = 3;
  const pad = QUIET * unit;
  const columns: boolean[] = [];
  widths.forEach((w, i) => {
    for (let n = 0; n < w * unit; n++) columns.push(i % 2 === 0);
  });
  const width = columns.length + pad * 2;
  const height = 90;
  const data = new Uint8ClampedArray(width * height * 4).fill(240);
  for (let y = 10; y < height - 10; y++) {
    for (let x = 0; x < columns.length; x++) {
      if (!columns[x]) continue;
      const i = (y * width + x + pad) * 4;
      data[i] = data[i + 1] = data[i + 2] = 20;
    }
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width, height };
}

test("bin codes come out as the same bars a reference encoder makes", () => {
  // Texts with letters force set B in the reference too, so the two can be compared bar for bar.
  for (const text of ["MCD-A-03-2", "EFF-1-105-07-3-B12", "MAIN-A-3", "A", "Bin ~ {x} | 7", "ZZ-99-zz"]) {
    assert.deepEqual(code128Widths(text), reference(text), text);
  }
});

test("every check symbol is right: all 103 turn up and match the reference", () => {
  const seen = new Set<number>();
  for (let a = 33; a <= 126 && seen.size < 103; a++) {
    for (let b = 65; b <= 122 && seen.size < 103; b++) {
      const text = `${String.fromCharCode(a)}${String.fromCharCode(b)}x`;
      const check = ([...text].reduce((s, c, i) => s + (c.charCodeAt(0) - 32) * (i + 1), 104)) % 103;
      if (seen.has(check)) continue;
      const ref = reference(text);
      // Only compare when the reference stayed in set B (it starts the same way).
      if (ref.slice(0, 6).join("") !== "211214" || ref.length !== 37) continue;
      assert.deepEqual(code128Widths(text), ref, JSON.stringify(text));
      seen.add(check);
    }
  }
  assert.equal(seen.size, 103);
});

test("a printed bin label reads back as the bin code", () => {
  for (const text of ["MCD-A-03-2", "EFF-1-105-07-3-12", "MAIN-B-12", "830-FS-08"]) {
    assert.equal(decodePixels(picture(code128Widths(text)!)), text);
  }
});

test("what can't be printed is refused, and the SVG is well formed", () => {
  assert.equal(canEncode("MCD-A-03-2"), true);
  assert.equal(canEncode(""), false);
  assert.equal(canEncode("Ünïcode"), false);
  assert.equal(canEncode("x".repeat(41)), false);
  assert.equal(code128Widths("tab\there"), null);
  assert.equal(code128Svg("é"), "");
  const svg = code128Svg("MCD-A-03-2", 30);
  const modules = code128Modules("MCD-A-03-2");
  assert.equal(modules, 11 * (10 + 2) + 13, "start, ten characters and the check at 11 modules each, plus the 13-module stop");
  assert.ok(svg.startsWith("<svg ") && svg.endsWith("</svg>"));
  assert.ok(svg.includes(`viewBox="0 0 ${modules + QUIET * 2} 30"`), "quiet zones on both sides");
  assert.equal((svg.match(/<rect x=/g) ?? []).length, (code128Widths("MCD-A-03-2")!.length + 1) / 2, "one rectangle per bar");
  assert.ok(!code128Svg('A<b>"&').includes("<b>"), "the label text can't break out of the SVG");
});
