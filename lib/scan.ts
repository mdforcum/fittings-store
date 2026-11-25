// Browser-side photo handling for the capture page: shrinking, previews, and
// finding barcodes without a network connection.
import type { Pixels } from "./decode";

type Detector = { detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>> };
declare const BarcodeDetector: (new () => Detector) | undefined;

function draw(bmp: ImageBitmap, longEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, longEdge / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext("2d", { willReadFrequently: true })?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));

export type Prepared = { bytes: ArrayBuffer; type: string; thumb: string; codes: string[] };

/**
 * Turns a camera photo into what the outbox stores: a JPEG small enough to
 * upload on a weak signal but sharp enough to read handwriting, a tiny
 * preview, and any barcodes found in it.
 */
export async function prepare(file: Blob, lookForCodes: boolean): Promise<Prepared> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    // A format the browser cannot draw: keep the original and let the server read it.
    return { bytes: await file.arrayBuffer(), type: file.type || "image/jpeg", thumb: "", codes: [] };
  }
  try {
    const full = draw(bmp, 2000);
    const blob = (await toBlob(full, 0.85)) ?? file;
    const thumb = draw(bmp, 160).toDataURL("image/jpeg", 0.6);
    const codes = lookForCodes ? await findCodes(bmp) : [];
    return { bytes: await blob.arrayBuffer(), type: blob.type || "image/jpeg", thumb, codes };
  } finally {
    bmp.close();
  }
}

/** Barcodes and QR codes in the photo. Uses the phone's own reader where there is one. */
export async function findCodes(bmp: ImageBitmap): Promise<string[]> {
  if (typeof BarcodeDetector !== "undefined") {
    try {
      const found = await new BarcodeDetector().detect(bmp);
      const values = [...new Set(found.map((f) => f.rawValue.trim()).filter(Boolean))];
      if (values.length) return values.slice(0, 6);
    } catch {
      /* fall through to the built-in decoder */
    }
  }
  try {
    const { decodePixels } = await import("./decode");
    // Two sizes: fine detail for small labels, then a coarser pass that shrugs off camera noise.
    for (const edge of [1400, 800]) {
      const canvas = draw(bmp, edge);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) continue;
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const pixels: Pixels = { data: image.data, width: image.width, height: image.height };
      const text = decodePixels(pixels);
      if (text) return [text.trim()];
    }
  } catch {
    /* the decoder could not load; the server will still read the photo */
  }
  return [];
}

/** Loads the barcode decoder ahead of time so it is on the phone before the signal goes. */
export const warmDecoder = () => import("./decode").then(() => undefined).catch(() => undefined);
