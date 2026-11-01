// Type declarations for the plain-JS browser module pixelfont.js (used by Vitest and tsc; the
// static server only serves .js, so this file never reaches the browser).

export interface Glyph {
  /** Width in font units after trimming blank columns. */
  readonly width: number;
  /** GLYPH_HEIGHT rows of `width` characters: `#` lit, `.` background. */
  readonly rows: readonly string[];
}

export declare const GLYPH_HEIGHT: number;
export declare const LETTER_SPACING: number;
export declare const LINE_SPACING: number;
export declare const SPACE_WIDTH: number;
export declare const BREAK_HINT: string;
export declare const SUPPORTED_CHARACTERS: string;
export declare const GLYPHS: Readonly<Record<string, Glyph>>;

export declare function normalizeText(input: string): { text: string; unsupported: string[] };
export declare function measureLine(text: string): number;
export declare function measureBlock(lines: readonly string[]): { width: number; height: number };
export declare function forEachLitUnit(text: string, plot: (x: number, y: number) => void): void;
export declare function wrapText(
  text: string,
  maxWidth: number,
  maxLines: number,
): { lines: string[]; truncated: boolean };
