import assert from "node:assert/strict";
import { test } from "node:test";
import { BarcodeFormat, MultiFormatWriter } from "@zxing/library";
import bwipjs from "bwip-js/node";
import { decodePixels, type Pixels } from "../lib/decode.ts";

/** Paints a light page with dark pixels wherever `dark` says so. */
function paint(mw: number, mh: number, dark: (x: number, y: number) => boolean, sideways = false): Pixels {
  const pad = 30;
  const width = (sideways ? mh : mw) + pad * 2;
  const height = (sideways ? mw : mh) + pad * 2;
  const data = new Uint8ClampedArray(width * height * 4).fill(235);
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      if (!dark(x, y)) continue;
      const px = sideways ? y + pad : x + pad;
      const py = sideways ? x + pad : y + pad;
      const i = (py * width + px) * 4;
      data[i] = data[i + 1] = data[i + 2] = 25;
    }
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width, height };
}

function qr(text: string): Pixels {
  const matrix = new MultiFormatWriter().encode(text, BarcodeFormat.QR_CODE, 220, 220, new Map());
  return paint(matrix.getWidth(), matrix.getHeight(), (x, y) => matrix.get(x, y));
}

/** A printed bar code: bar and space widths from the generator, drawn 3 pixels per unit. */
function bars(kind: string, text: string, sideways = false): Pixels {
  const widths = (bwipjs.raw(kind, text, {}) as Array<{ sbs: number[] }>)[0].sbs;
  const unit = 3;
  const columns: boolean[] = [];
  widths.forEach((w, i) => {
    for (let n = 0; n < w * unit; n++) columns.push(i % 2 === 0);
  });
  return paint(columns.length, 90, (x) => columns[x], sideways);
}

test("reads a QR code", () => {
  assert.equal(decodePixels(qr("830-FS-08|A3|B12")), "830-FS-08|A3|B12");
});

test("reads a Code 128 bin label", () => {
  assert.equal(decodePixels(bars("code128", "721-FSO-10")), "721-FSO-10");
});

test("reads a retail UPC", () => {
  assert.equal(decodePixels(bars("upca", "012345678905")), "012345678905");
});

test("reads a barcode photographed sideways", () => {
  assert.equal(decodePixels(bars("code128", "BF7633", true)), "BF7633");
});

test("returns null when there is no code in the picture", () => {
  const blank: Pixels = { data: new Uint8ClampedArray(200 * 200 * 4).fill(200), width: 200, height: 200 };
  assert.equal(decodePixels(blank), null);
});
