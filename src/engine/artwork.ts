import type { Artwork, Rect, Side, StuntMode } from './types.js';

/** Card grid of ONE overlay (1920×1080 at 40 px per card). */
export const SIDE_COLS = 48;
export const GRID_ROWS = 27;

/**
 * Fixed 8-color, color-blind-friendly palette (Okabe–Ito inspired) plus ink/paper.
 * Index order is part of the public protocol: never reorder, only append.
 */
export const PALETTE: readonly string[] = Object.freeze([
  '#101820', // 0 ink
  '#f5f5f0', // 1 paper
  '#e69f00', // 2 orange
  '#56b4e9', // 3 sky
  '#009e73', // 4 green
  '#f0e442', // 5 yellow
  '#0072b2', // 6 blue
  '#d55e00', // 7 vermillion
]);

export const PALETTE_RGB: readonly (readonly [number, number, number])[] = Object.freeze(
  PALETTE.map((hex) => {
    const value = Number.parseInt(hex.slice(1), 16);
    return Object.freeze([(value >> 16) & 255, (value >> 8) & 255, value & 255] as const);
  }),
);

/** Full-image columns for a mode: crossover spans both overlays (A = left, B = right). */
export function fullCols(mode: StuntMode): number {
  return mode === 'crossover' ? SIDE_COLS * 2 : SIDE_COLS;
}

/** Region of the full image owned by a side. Single mode: side A owns the whole picture. */
export function sideRegion(mode: StuntMode, side: Side): Rect {
  if (mode === 'single') return { x: 0, y: 0, w: SIDE_COLS, h: GRID_ROWS };
  return { x: side === 'A' ? 0 : SIDE_COLS, y: 0, w: SIDE_COLS, h: GRID_ROWS };
}

/** Sides whose quorum gates the reveal in a mode. */
export function requiredSides(mode: StuntMode): readonly Side[] {
  return mode === 'crossover' ? ['A', 'B'] : ['A'];
}

/**
 * Runtime validation at the API boundary. Returns null when `value` is not an artwork of the
 * exact grid size for `mode` with integer palette indices.
 */
export function parseArtwork(value: unknown, mode: StuntMode): Artwork | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const { cols, rows, pixels } = candidate;
  if (cols !== fullCols(mode) || rows !== GRID_ROWS) return null;
  if (!Array.isArray(pixels) || pixels.length !== cols * rows) return null;
  for (const pixel of pixels) {
    if (
      typeof pixel !== 'number' ||
      !Number.isInteger(pixel) ||
      pixel < 0 ||
      pixel >= PALETTE.length
    )
      return null;
  }
  return { cols, rows, pixels: Object.freeze([...(pixels as number[])]) };
}
