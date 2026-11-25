// Finds barcodes and QR codes in a photo's pixels. Runs on the phone itself,
// so scanning works with no signal. Used when the browser has no built-in
// barcode reader (iPhones do not).
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  GlobalHistogramBinarizer,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from "@zxing/library";

export type Pixels = { data: Uint8ClampedArray | Uint8Array; width: number; height: number };

const FORMATS = [
  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.CODABAR,
  BarcodeFormat.ITF,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
];

/** RGBA to one brightness value per pixel. Transparent counts as white paper. */
function luminance({ data, width, height }: Pixels): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = data[p + 3] / 255;
    const y = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    out[i] = y * a + 255 * (1 - a);
  }
  return out;
}

/** The same picture turned a quarter turn, for barcodes photographed sideways. */
function quarterTurn(lum: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(lum.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[x * height + (height - 1 - y)] = lum[y * width + x];
  }
  return out;
}

function attempt(lum: Uint8ClampedArray, width: number, height: number): string | null {
  const hints = new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, FORMATS],
    [DecodeHintType.TRY_HARDER, true],
  ]);
  for (const Binarizer of [HybridBinarizer, GlobalHistogramBinarizer]) {
    try {
      const reader = new MultiFormatReader();
      const source = new RGBLuminanceSource(lum, width, height);
      const text = reader.decode(new BinaryBitmap(new Binarizer(source)), hints).getText();
      if (text) return text;
    } catch {
      /* nothing found this way; try the next */
    }
  }
  return null;
}

/** Returns the text of a code found in the picture, or null. */
export function decodePixels(pixels: Pixels): string | null {
  const lum = luminance(pixels);
  return (
    attempt(lum, pixels.width, pixels.height) ??
    attempt(quarterTurn(lum, pixels.width, pixels.height), pixels.height, pixels.width)
  );
}
