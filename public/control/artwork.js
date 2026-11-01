/**
 * Hidden-picture builder for the control panel: presets, bitmap text and image quantization.
 * Plain ES module without DOM access (the canvas decoding step lives in control.js), so Vitest
 * imports it directly.
 *
 * An artwork is `{ cols, rows, pixels }`: palette indices, row-major, on the FULL card grid
 * (crossover 96×27 where side A = columns 0–47 and B = 48–95; single 48×27). It must pass
 * `parseArtwork` in src/engine/artwork.ts, which is what POST /api/call validates.
 */
import {
  BREAK_HINT,
  GLYPHS,
  GLYPH_HEIGHT,
  LINE_SPACING,
  forEachLitUnit,
  measureBlock,
  measureLine,
  normalizeText,
  wrapText,
} from './pixelfont.js';

/**
 * Copy of PALETTE in src/engine/artwork.ts — that file is the source of truth and index order is
 * part of the public protocol. test/control-artwork.test.ts fails if the two lists drift apart.
 */
export const PALETTE = Object.freeze([
  '#101820', // 0 ink
  '#f5f5f0', // 1 paper
  '#e69f00', // 2 orange
  '#56b4e9', // 3 sky
  '#009e73', // 4 green
  '#f0e442', // 5 yellow
  '#0072b2', // 6 blue
  '#d55e00', // 7 vermillion
]);

/** Human names for the palette pickers (same order as PALETTE). */
export const PALETTE_NAMES = Object.freeze([
  'Ink',
  'Paper',
  'Orange',
  'Sky',
  'Green',
  'Yellow',
  'Blue',
  'Vermillion',
]);

export const PALETTE_RGB = Object.freeze(
  PALETTE.map((hex) => {
    const value = Number.parseInt(hex.slice(1), 16);
    return Object.freeze([(value >> 16) & 255, (value >> 8) & 255, value & 255]);
  }),
);

const INK = 0;
const PAPER = 1;
const ORANGE = 2;
const SKY = 3;
const YELLOW = 5;
const BLUE = 6;
const VERMILLION = 7;

/** Card grid of one overlay; mirrors SIDE_COLS / GRID_ROWS in src/engine/artwork.ts. */
export const SIDE_COLS = 48;
export const GRID_ROWS = 27;

/** Cards kept free between text and the edge of the picture. */
const TEXT_MARGIN = 1;

/** @param {'crossover' | 'single'} mode */
export function fullCols(mode) {
  return mode === 'crossover' ? SIDE_COLS * 2 : SIDE_COLS;
}

/**
 * Client-side mirror of `parseArtwork(value, mode) !== null`, used as a last guard before CALL.
 *
 * @param {unknown} value
 * @param {'crossover' | 'single'} mode
 */
export function isValidArtwork(value, mode) {
  if (typeof value !== 'object' || value === null) return false;
  const { cols, rows, pixels } = /** @type {Record<string, unknown>} */ (value);
  if (cols !== fullCols(mode) || rows !== GRID_ROWS) return false;
  if (!Array.isArray(pixels) || pixels.length !== cols * rows) return false;
  return pixels.every((pixel) => Number.isInteger(pixel) && pixel >= 0 && pixel < PALETTE.length);
}

// ---------------------------------------------------------------------------------------------
// Grid drawing

/**
 * @param {number} cols
 * @param {number} rows
 * @param {number} fill palette index
 */
export function createGrid(cols, rows, fill) {
  return { cols, rows, pixels: new Array(cols * rows).fill(fill) };
}

/** Fills a rectangle, clipped to the grid. */
function fillRect(grid, x, y, w, h, color) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(grid.cols, x + w);
  const y1 = Math.min(grid.rows, y + h);
  for (let row = y0; row < y1; row += 1) {
    grid.pixels.fill(color, row * grid.cols + x0, row * grid.cols + x1);
  }
}

/** Box available for text on a full grid of `cols` columns. */
function textBox(cols) {
  return {
    x: TEXT_MARGIN,
    y: TEXT_MARGIN,
    w: cols - 2 * TEXT_MARGIN,
    h: GRID_ROWS - 2 * TEXT_MARGIN,
  };
}

// ---------------------------------------------------------------------------------------------
// Text layout

/**
 * @typedef {{ text: string, color: number }} TextItem
 * @typedef {{ x: number, y: number, w: number, h: number }} Box
 * @typedef {{ items: TextItem[], scale: number, truncated: boolean }} TextLayout
 */

/**
 * Lines for `items` at a fixed integer scale inside `box`, or null when they do not fit. Lines
 * are kept as typed when possible, otherwise word-wrapped; overflow lines are only dropped when
 * `allowTruncate` is set. `pad` reserves room for a 1-card drop shadow.
 *
 * @param {readonly TextItem[]} items normalized text
 * @param {Box} box
 * @param {number} scale
 * @param {{ pad?: number, allowTruncate?: boolean }} [options]
 * @returns {TextLayout | null}
 */
export function layoutAtScale(items, box, scale, { pad = 0, allowTruncate = false } = {}) {
  const maxWidth = Math.floor((box.w - pad) / scale);
  const maxHeight = Math.floor((box.h - pad) / scale);
  const maxLines = Math.floor((maxHeight + LINE_SPACING) / (GLYPH_HEIGHT + LINE_SPACING));
  const given = items.filter((item) => item.text.length > 0);
  if (maxLines < 1 || given.length === 0) return null;
  if (given.length <= maxLines && given.every((item) => measureLine(item.text) <= maxWidth)) {
    return { items: given, scale, truncated: false };
  }
  const wrapped = given.flatMap((item) =>
    wrapText(item.text, maxWidth, Infinity).lines.map((text) => ({ text, color: item.color })),
  );
  if (wrapped.length <= maxLines) return { items: wrapped, scale, truncated: false };
  return allowTruncate ? { items: wrapped.slice(0, maxLines), scale, truncated: true } : null;
}

/**
 * Largest integer scale at which `items` fit `box` (wrapping if needed). Returns a layout with
 * no items for empty text, and null when nothing fits even at scale 1 (unless truncating).
 *
 * @param {readonly TextItem[]} items normalized text
 * @param {Box} box
 * @param {{ pad?: number, allowTruncate?: boolean }} [options]
 * @returns {TextLayout | null}
 */
export function layoutText(items, box, { pad = 0, allowTruncate = false } = {}) {
  if (items.every((item) => item.text.length === 0))
    return { items: [], scale: 0, truncated: false };
  for (let scale = Math.floor((box.h - pad) / GLYPH_HEIGHT); scale >= 1; scale -= 1) {
    const layout = layoutAtScale(items, box, scale, { pad });
    if (layout) return layout;
  }
  return allowTruncate ? layoutAtScale(items, box, 1, { pad, allowTruncate }) : null;
}

/**
 * Draws a layout centred in `box` (each line centred horizontally). With `shadowColor`, every lit
 * unit also casts a 1-card shadow down-right, drawn first so text always sits on top.
 *
 * @param {{ cols: number, rows: number, pixels: number[] }} grid
 * @param {TextLayout} layout
 * @param {Box} box
 * @param {number | null} [shadowColor]
 */
export function paintText(grid, layout, box, shadowColor = null) {
  const { items, scale } = layout;
  if (items.length === 0) return;
  const pad = shadowColor === null ? 0 : 1;
  const { height } = measureBlock(items.map((item) => item.text));
  const top = box.y + Math.floor((box.h - pad - height * scale) / 2);
  const passes = shadowColor === null ? [0] : [1, 0];
  for (const offset of passes) {
    items.forEach((item, index) => {
      const left = box.x + Math.floor((box.w - pad - measureLine(item.text) * scale) / 2);
      const lineTop = top + index * (GLYPH_HEIGHT + LINE_SPACING) * scale;
      const color = offset === 0 ? item.color : /** @type {number} */ (shadowColor);
      forEachLitUnit(item.text, (x, y) =>
        fillRect(
          grid,
          left + x * scale + offset,
          lineTop + y * scale + offset,
          scale,
          scale,
          color,
        ),
      );
    });
  }
}

/** Approximate letters per line at scale 1 (5-unit letters + 1 spacing), for hints. */
export function lettersPerLine(mode) {
  return Math.floor((textBox(fullCols(mode)).w + 1) / 6);
}

/**
 * Host text (1–2 lines) in one colour on a plain background, auto-scaled to the grid.
 *
 * @param {{ mode: 'crossover' | 'single', lines: readonly string[], fg: number, bg: number }} input
 * @returns {{
 *   artwork: { cols: number, rows: number, pixels: number[] } | null,
 *   layout: TextLayout | null,
 *   unsupported: string[],
 *   error: string | null,
 * }}
 */
export function textArtwork({ mode, lines, fg, bg }) {
  const cols = fullCols(mode);
  const unsupported = new Set();
  const items = lines.slice(0, 2).map((line) => {
    const normalized = normalizeText(line);
    for (const char of normalized.unsupported) unsupported.add(char);
    return { text: normalized.text, color: fg };
  });
  const box = textBox(cols);
  const layout = layoutText(items, box);
  if (layout === null) {
    const where = mode === 'single' ? 'single mode' : 'the crossover picture';
    return {
      artwork: null,
      layout: null,
      unsupported: [...unsupported],
      error: `Too long for ${where}: about ${lettersPerLine(mode)} letters fit per line, 3 lines at most.`,
    };
  }
  const grid = createGrid(cols, GRID_ROWS, bg);
  paintText(grid, layout, box);
  return { artwork: grid, layout, unsupported: [...unsupported], error: null };
}

// ---------------------------------------------------------------------------------------------
// Presets

export const PRESET_IDS = Object.freeze(['heart', 'face', 'gg', 'hype', 'versus', 'boss']);

/**
 * Display name of a preset; `versus` uses the channel labels.
 *
 * @param {string} id
 * @param {{ A: string, B: string }} labels
 */
export function presetTitle(id, labels) {
  switch (id) {
    case 'heart':
      return 'HEART';
    case 'face':
      return 'FACE';
    case 'gg':
      return 'GG';
    case 'hype':
      return 'HYPE';
    case 'versus':
      return `${labels.A} + ${labels.B}`;
    case 'boss':
      return 'NEXT: BOSS FIGHT';
    default:
      throw new RangeError(`Unknown preset: ${id}`);
  }
}

/**
 * Marks where a channel name may wrap without a visible space: between camelCase humps
 * ("PixelPilot" → PIXEL / PILOT), before digit runs and after underscores. Must run before
 * normalizeText, which uppercases and so loses the humps.
 */
export function hintLabelBreaks(label) {
  return label
    .replace(/([a-z])([A-Z])/g, `$1${BREAK_HINT}$2`)
    .replace(/([A-Za-z])(\d)/g, `$1${BREAK_HINT}$2`)
    .replace(/_/g, `_${BREAK_HINT}`);
}

/** Normalized label text with break hints, or the side letter when nothing is drawable. */
function labelText(label, side) {
  const { text } = normalizeText(hintLabelBreaks(label));
  return text.replaceAll(BREAK_HINT, '').length > 0 ? text : side;
}

/** Big centred word with a drop shadow on a plain background, framed by two stripes. */
function bannerPreset(mode, word, { bg, fg, shadow, stripe }) {
  const cols = fullCols(mode);
  const grid = createGrid(cols, GRID_ROWS, bg);
  fillRect(grid, 0, 0, cols, 1, stripe);
  fillRect(grid, 0, GRID_ROWS - 1, cols, 1, stripe);
  const box = textBox(cols);
  const layout = layoutText([{ text: word, color: fg }], box, { pad: 1, allowTruncate: true });
  if (layout) paintText(grid, layout, box, shadow);
  return grid;
}

/**
 * Crossover "A + B": each community's name sits on its own half in its side colour, and the "+"
 * straddles the seam, so the phrase only reads once both halves are revealed. Both names use the
 * same (largest possible) scale for balance.
 */
function versusCrossover(labels) {
  const cols = fullCols('crossover');
  const grid = createGrid(cols, GRID_ROWS, ORANGE);
  fillRect(grid, SIDE_COLS, 0, SIDE_COLS, GRID_ROWS, SKY);
  const a = [{ text: labelText(labels.A, 'A'), color: INK }];
  const b = [{ text: labelText(labels.B, 'B'), color: INK }];
  const plusWidth = GLYPHS['+'].width;
  for (let scale = 3; scale >= 1; scale -= 1) {
    const plusLeft = SIDE_COLS - Math.ceil((plusWidth * scale) / 2);
    const plusBox = { x: plusLeft, y: TEXT_MARGIN, w: plusWidth * scale + 1, h: GRID_ROWS - 2 };
    const gap = scale + 1;
    const boxA = { x: TEXT_MARGIN, y: TEXT_MARGIN, w: plusLeft - gap - TEXT_MARGIN, h: plusBox.h };
    const bLeft = plusBox.x + plusBox.w + gap;
    const boxB = { x: bLeft, y: TEXT_MARGIN, w: cols - TEXT_MARGIN - bLeft, h: plusBox.h };
    const last = scale === 1;
    const layoutA = layoutAtScale(a, boxA, scale, { allowTruncate: last });
    const layoutB = layoutAtScale(b, boxB, scale, { allowTruncate: last });
    if (!layoutA || !layoutB) continue;
    paintText(grid, layoutA, boxA);
    paintText(grid, layoutB, boxB);
    paintText(
      grid,
      { items: [{ text: '+', color: PAPER }], scale, truncated: false },
      plusBox,
      INK,
    );
    return grid;
  }
  return grid;
}

/** Single mode "A + B": one block; falls back to the first word of each label when long. */
function versusSingle(labels) {
  const cols = fullCols('single');
  const grid = createGrid(cols, GRID_ROWS, BLUE);
  const a = labelText(labels.A, 'A');
  const b = labelText(labels.B, 'B');
  const box = textBox(cols);
  const candidates = [`${a} + ${b}`, `${a.split(' ')[0]} + ${b.split(' ')[0]}`];
  let layout = null;
  for (const text of candidates) {
    layout = layoutText([{ text, color: YELLOW }], box, { pad: 1 });
    if (layout) break;
  }
  layout ??= layoutText([{ text: candidates[0], color: YELLOW }], box, {
    pad: 1,
    allowTruncate: true,
  });
  if (layout) paintText(grid, layout, box, INK);
  return grid;
}

/**
 * "NEXT:" over "BOSS FIGHT" on ink, above a boss health bar when there is room for it (single
 * mode needs all 27 rows for three wrapped lines and drops the bar).
 */
function bossPreset(mode) {
  const cols = fullCols(mode);
  const grid = createGrid(cols, GRID_ROWS, INK);
  const items = [
    { text: 'NEXT:', color: YELLOW },
    { text: 'BOSS FIGHT', color: VERMILLION },
  ];
  const barRows = 3;
  const aboveBar = { ...textBox(cols), h: GRID_ROWS - TEXT_MARGIN * 2 - barRows - 1 };
  const withBar = layoutText(items, aboveBar);
  if (withBar) {
    // Paper frame, vermillion health, ink notch of health already lost.
    const left = 3;
    const width = cols - 2 * left;
    const lost = Math.floor(width / 6);
    const top = GRID_ROWS - 1 - barRows;
    fillRect(grid, left, top, width, barRows, PAPER);
    fillRect(grid, left + 1, top + 1, width - 2, barRows - 2, VERMILLION);
    fillRect(grid, left + width - 1 - lost, top + 1, lost, barRows - 2, INK);
    paintText(grid, withBar, aboveBar);
    return grid;
  }
  const box = textBox(cols);
  const layout = layoutText(items, box, { allowTruncate: true });
  if (layout) paintText(grid, layout, box);
  return grid;
}

/** Seam-centred silhouettes: neither side contains a complete symbol or expression. */
function seamArtwork(id, mode) {
  const cols = fullCols(mode);
  const grid = createGrid(cols, GRID_ROWS, INK);
  const width = id === 'heart' ? (mode === 'crossover' ? 40 : 22) : 34;
  const height = id === 'heart' ? (mode === 'crossover' ? 22 : 20) : 24;
  const left = (cols - width) / 2;
  const top = id === 'heart' ? 2 : 1;
  const inside = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const px = ((x + 0.5) / width) * 2 - 1;
    const py = (y + 0.5) / height;
    if (id === 'face') return (px / 1) ** 2 + ((py - 0.5) / 0.5) ** 2 <= 1;
    // Two round lobes flow into one point exactly on the split axis.
    if (py < 0.38) {
      return ((Math.abs(px) - 0.48) / 0.52) ** 2 + ((py - 0.27) / 0.27) ** 2 <= 1;
    }
    return Math.abs(px) <= (1 - py) / 0.62;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!inside(x, y)) continue;
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      const color = id === 'face' ? YELLOW : edge ? PAPER : left + x < cols / 2 ? ORANGE : SKY;
      fillRect(grid, left + x, top + y, 1, 1, color);
    }
  }
  if (id === 'heart') {
    fillRect(grid, cols / 2 - 1, top + 7, 2, 2, YELLOW);
  } else {
    // An open eye and an offset wink; the off-centre smile only resolves across the seam.
    fillRect(grid, left + 9, top + 7, 3, 5, INK);
    fillRect(grid, left + 10, top + 7, 1, 1, PAPER);
    fillRect(grid, left + 22, top + 9, 5, 2, INK);
    fillRect(grid, left + 21, top + 10, 2, 2, INK);
    fillRect(grid, left + 12, top + 16, 2, 2, INK);
    fillRect(grid, left + 14, top + 18, 7, 2, INK);
    fillRect(grid, left + 21, top + 16, 3, 2, INK);
    fillRect(grid, left + 24, top + 14, 2, 3, INK);
  }
  return grid;
}

/**
 * @param {string} id one of PRESET_IDS
 * @param {'crossover' | 'single'} mode
 * @param {{ A: string, B: string }} labels channel labels for `versus`
 */
export function presetArtwork(id, mode, labels) {
  switch (id) {
    case 'heart':
    case 'face':
      return seamArtwork(id, mode);
    case 'gg':
      return bannerPreset(mode, 'GG', { bg: BLUE, fg: YELLOW, shadow: INK, stripe: SKY });
    case 'hype':
      return bannerPreset(mode, 'HYPE', {
        bg: VERMILLION,
        fg: PAPER,
        shadow: INK,
        stripe: YELLOW,
      });
    case 'versus':
      return mode === 'crossover' ? versusCrossover(labels) : versusSingle(labels);
    case 'boss':
      return bossPreset(mode);
    default:
      throw new RangeError(`Unknown preset: ${id}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Image upload: cover-fit + box filter + nearest-palette quantization

/**
 * Centred source rectangle with the destination's aspect ratio (CSS `object-fit: cover`).
 *
 * @returns {{ sx: number, sy: number, sw: number, sh: number }}
 */
export function coverFitRect(srcWidth, srcHeight, dstWidth, dstHeight) {
  const target = dstWidth / dstHeight;
  if (srcWidth / srcHeight > target) {
    const sw = srcHeight * target;
    return { sx: (srcWidth - sw) / 2, sy: 0, sw, sh: srcHeight };
  }
  const sh = srcWidth / target;
  return { sx: 0, sy: (srcHeight - sh) / 2, sw: srcWidth, sh };
}

/**
 * Averages an RGBA image (alpha ignored: composite onto a background first) into `cols × rows`
 * cells. Each cell averages every source pixel whose index maps into it, so detail is not
 * aliased away the way single-sample nearest-neighbour scaling would.
 *
 * @param {ArrayLike<number>} rgba
 * @returns {Uint8ClampedArray} RGB triplets, row-major
 */
export function boxDownsample(rgba, width, height, cols, rows) {
  const out = new Uint8ClampedArray(cols * rows * 3);
  for (let row = 0; row < rows; row += 1) {
    const y0 = Math.floor((row * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * height) / rows));
    for (let col = 0; col < cols; col += 1) {
      const x0 = Math.floor((col * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((col + 1) * width) / cols));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const offset = (y * width + x) * 4;
          r += rgba[offset];
          g += rgba[offset + 1];
          b += rgba[offset + 2];
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const target = (row * cols + col) * 3;
      out[target] = Math.round(r / count);
      out[target + 1] = Math.round(g / count);
      out[target + 2] = Math.round(b / count);
    }
  }
  return out;
}

/**
 * Squared "redmean" colour distance: a cheap perceptual weighting of RGB that matches human
 * judgement of nearest colours much better than plain Euclidean RGB.
 */
export function colorDistance(r1, g1, b1, r2, g2, b2) {
  const mean = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return (2 + mean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - mean) / 256) * db * db;
}

/** Index of the palette colour closest to (r, g, b); ties go to the lower index. */
export function nearestPaletteIndex(r, g, b) {
  let best = 0;
  let bestDistance = Infinity;
  PALETTE_RGB.forEach(([pr, pg, pb], index) => {
    const distance = colorDistance(r, g, b, pr, pg, pb);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * Artwork from decoded RGBA pixels that already have the grid's aspect ratio (the caller crops
 * with coverFitRect while drawing to a canvas).
 *
 * @param {ArrayLike<number>} rgba
 * @param {number} width
 * @param {number} height
 * @param {'crossover' | 'single'} mode
 */
export function imageDataToArtwork(rgba, width, height, mode) {
  const cols = fullCols(mode);
  const rgb = boxDownsample(rgba, width, height, cols, GRID_ROWS);
  const pixels = new Array(cols * GRID_ROWS);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = nearestPaletteIndex(rgb[index * 3], rgb[index * 3 + 1], rgb[index * 3 + 2]);
  }
  return { cols, rows: GRID_ROWS, pixels };
}
