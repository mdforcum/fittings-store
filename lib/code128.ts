// Code 128 bar codes, set B (letters, digits and punctuation), drawn as SVG.
// Used for bin labels: a bin's code printed as bars that a plug-in scanner or
// a phone camera reads back as the same text the part finder already
// understands. No package needed in the browser or on the server.

// Each symbol is six widths: bar, space, bar, space, bar, space. Values 0 to
// 94 are the characters from space to "~"; 95 to 102 only ever appear as the
// check symbol. The table was worked out from a reference encoder and is
// checked against it, and against a decoder, in tests/code128.test.ts.
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131",
];
const START_B = "211214";
const STOP = "2331112";
const START_B_VALUE = 104;

/** What a label can carry: 1 to 40 printable ASCII characters. */
export function canEncode(text: string): boolean {
  return text.length >= 1 && text.length <= 40 && /^[\x20-\x7e]+$/.test(text);
}

/**
 * The bars and spaces for `text`, as widths in modules, starting with a bar:
 * start, each character, the check symbol, stop. Null when the text can't be
 * encoded.
 */
export function code128Widths(text: string): number[] | null {
  if (!canEncode(text)) return null;
  const values = [...text].map((c) => c.charCodeAt(0) - 32);
  const check = values.reduce((sum, v, i) => sum + v * (i + 1), START_B_VALUE) % 103;
  const symbols = [START_B, ...values.map((v) => PATTERNS[v]), PATTERNS[check], STOP];
  return symbols.join("").split("").map(Number);
}

/** How many modules wide the bars are, without the quiet zones. */
export function code128Modules(text: string): number {
  return (code128Widths(text) ?? []).reduce((a, b) => a + b, 0);
}

/** The quiet zone a scanner needs on each side, in modules. */
export const QUIET = 10;

/**
 * The bar code as an SVG string that stretches to the width it is given.
 * `height` is in the same units as the modules. Empty when the text can't be encoded.
 */
export function code128Svg(text: string, height = 40): string {
  const widths = code128Widths(text);
  if (!widths) return "";
  const total = widths.reduce((a, b) => a + b, 0) + QUIET * 2;
  let x = QUIET;
  let rects = "";
  widths.forEach((w, i) => {
    if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${w}" height="${height}"/>`;
    x += w;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}" preserveAspectRatio="none" role="img" aria-label="Bar code ${text.replace(/[<>&"]/g, "")}" shape-rendering="crispEdges"><rect width="${total}" height="${height}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
