// Type declarations for the plain-JS browser module artwork.js (used by Vitest and tsc; the
// static server only serves .js, so this file never reaches the browser).

export type Mode = 'crossover' | 'single';

export interface Grid {
  readonly cols: number;
  readonly rows: number;
  readonly pixels: number[];
}

export interface TextItem {
  readonly text: string;
  readonly color: number;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface TextLayout {
  readonly items: TextItem[];
  readonly scale: number;
  readonly truncated: boolean;
}

export interface LayoutOptions {
  readonly pad?: number;
  readonly allowTruncate?: boolean;
}

export declare const PALETTE: readonly string[];
export declare const PALETTE_NAMES: readonly string[];
export declare const PALETTE_RGB: readonly (readonly [number, number, number])[];
export declare const SIDE_COLS: number;
export declare const GRID_ROWS: number;
export declare const PRESET_IDS: readonly ['heart', 'face', 'gg', 'hype', 'versus', 'boss'];

export declare function fullCols(mode: Mode): number;
export declare function isValidArtwork(value: unknown, mode: Mode): boolean;
export declare function createGrid(cols: number, rows: number, fill: number): Grid;
export declare function layoutAtScale(
  items: readonly TextItem[],
  box: Box,
  scale: number,
  options?: LayoutOptions,
): TextLayout | null;
export declare function layoutText(
  items: readonly TextItem[],
  box: Box,
  options?: LayoutOptions,
): TextLayout | null;
export declare function paintText(
  grid: Grid,
  layout: TextLayout,
  box: Box,
  shadowColor?: number | null,
): void;
export declare function lettersPerLine(mode: Mode): number;
export declare function textArtwork(input: {
  readonly mode: Mode;
  readonly lines: readonly string[];
  readonly fg: number;
  readonly bg: number;
}): {
  artwork: Grid | null;
  layout: TextLayout | null;
  unsupported: string[];
  error: string | null;
};
export declare function hintLabelBreaks(label: string): string;
export declare function presetTitle(
  id: string,
  labels: { readonly A: string; readonly B: string },
): string;
export declare function presetArtwork(
  id: string,
  mode: Mode,
  labels: { readonly A: string; readonly B: string },
): Grid;
export declare function coverFitRect(
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): { sx: number; sy: number; sw: number; sh: number };
export declare function boxDownsample(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  cols: number,
  rows: number,
): Uint8ClampedArray;
export declare function colorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number;
export declare function nearestPaletteIndex(r: number, g: number, b: number): number;
export declare function imageDataToArtwork(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  mode: Mode,
): Grid;
