/**
 * 5×7 bitmap pixel font for host-entered artwork text. Plain ES module: no DOM access, so the
 * browser control panel and Vitest import the same code.
 *
 * Measurements are in *font units*; the artwork renderer draws one unit as `scale × scale` cards.
 * Glyphs are proportional: blank columns on both sides of a bitmap are trimmed when the font is
 * compiled (so `I`, `1`, `.` and `:` are narrow), a space is SPACE_WIDTH units wide and
 * LETTER_SPACING units separate neighbouring glyphs on a line.
 */

export const GLYPH_HEIGHT = 7;
export const LETTER_SPACING = 1;
export const LINE_SPACING = 2;
export const SPACE_WIDTH = 3;

/**
 * Zero-width break opportunity inside a word (e.g. between the humps of "PixelPilot"). It has no
 * glyph and no width; normalizeText keeps it and wrapText prefers it over breaking mid-word.
 */
export const BREAK_HINT = '​';

/**
 * Every character the font draws. Lowercase `x` is the "×" of collab titles such as "A x B";
 * see normalizeText() for when typed text maps to it.
 */
export const SUPPORTED_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?:-+x/&\'#_()%@=*;"';

/** Bitmaps: 7 rows × 5 columns, `#` = lit card, `.` = background. */
const SOURCE = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  ';': ['.....', '.##..', '.##..', '.....', '.##..', '..#..', '.#...'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  '/': ['.....', '....#', '...#.', '..#..', '.#...', '#....', '.....'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  "'": ['.##..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
  '"': ['.#.#.', '.#.#.', '.#.#.', '.....', '.....', '.....', '.....'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  _: ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  '%': ['##...', '##..#', '...#.', '..#..', '.#...', '#..##', '...##'],
  '@': ['.###.', '#...#', '....#', '.##.#', '#.#.#', '#.#.#', '.###.'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  '*': ['.....', '..#..', '#.#.#', '.###.', '#.#.#', '..#..', '.....'],
};

/**
 * @param {readonly string[]} rows
 * @returns {{ width: number, rows: readonly string[] }}
 */
function compileGlyph(rows) {
  let first = Infinity;
  let last = -Infinity;
  for (const row of rows) {
    const lit = row.indexOf('#');
    if (lit >= 0) {
      first = Math.min(first, lit);
      last = Math.max(last, row.lastIndexOf('#'));
    }
  }
  return Object.freeze({
    width: last - first + 1,
    rows: Object.freeze(rows.map((row) => row.slice(first, last + 1))),
  });
}

/** Compiled glyphs: `rows[y][x] === '#'` for lit units, `width` = trimmed width in units. */
export const GLYPHS = Object.freeze({
  ...Object.fromEntries(Object.entries(SOURCE).map(([char, rows]) => [char, compileGlyph(rows)])),
  ' ': Object.freeze({
    width: SPACE_WIDTH,
    rows: Object.freeze(Array.from({ length: GLYPH_HEIGHT }, () => '.'.repeat(SPACE_WIDTH))),
  }),
});

/** Typographic look-alikes that people paste from chat titles or schedules. */
const LOOKALIKES = new Map([
  ['×', 'x'], // multiplication sign
  ['‘', "'"],
  ['’', "'"],
  ['“', '"'],
  ['”', '"'],
  ['–', '-'],
  ['—', '-'],
  ['…', '...'],
]);

/**
 * Maps free-form host input onto the font: strips accents (É → E), uppercases letters, keeps a
 * standalone lowercase `x` as the collab "×" (`shroud x poki` → `SHROUD x POKI`), collapses
 * whitespace and drops characters the font cannot draw (reported once each in `unsupported`).
 *
 * @param {string} input
 * @returns {{ text: string, unsupported: string[] }}
 */
export function normalizeText(input) {
  const folded = Array.from(input.normalize('NFD').replace(/[̀-ͯ]/g, ''), (char) =>
    LOOKALIKES.has(char) ? LOOKALIKES.get(char) : char,
  )
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  // Code points, not UTF-16 units, so an emoji is reported once instead of as two halves.
  const chars = Array.from(folded);
  const unsupported = new Set();
  let text = '';
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === BREAK_HINT) {
      text += char;
      continue;
    }
    const standalone =
      (index === 0 || chars[index - 1] === ' ') &&
      (index === chars.length - 1 || chars[index + 1] === ' ');
    // toUpperCase may expand (ß → SS); every resulting character needs a glyph.
    const mapped = char === 'x' && standalone ? 'x' : char.toUpperCase();
    if (Array.from(mapped).every((part) => Object.hasOwn(GLYPHS, part))) text += mapped;
    else unsupported.add(char);
  }
  // Removing characters can leave double or edge spaces behind.
  return { text: text.replace(/ {2,}/g, ' ').trim(), unsupported: [...unsupported] };
}

/**
 * Width of one line in font units (0 for an empty line). Characters without a glyph count as
 * zero width; callers normalize first.
 *
 * @param {string} text
 */
export function measureLine(text) {
  let width = 0;
  let glyphs = 0;
  for (const char of text) {
    const glyph = GLYPHS[char];
    if (!glyph) continue;
    width += glyph.width;
    glyphs += 1;
  }
  return glyphs === 0 ? 0 : width + (glyphs - 1) * LETTER_SPACING;
}

/**
 * Bounding box of stacked lines in font units.
 *
 * @param {readonly string[]} lines
 */
export function measureBlock(lines) {
  if (lines.length === 0) return { width: 0, height: 0 };
  return {
    width: Math.max(...lines.map(measureLine)),
    height: lines.length * GLYPH_HEIGHT + (lines.length - 1) * LINE_SPACING,
  };
}

/**
 * Calls `plot(x, y)` for every lit unit of a line, with (0, 0) at its top-left corner.
 *
 * @param {string} text
 * @param {(x: number, y: number) => void} plot
 */
export function forEachLitUnit(text, plot) {
  let cursor = 0;
  for (const char of text) {
    const glyph = GLYPHS[char];
    if (!glyph) continue;
    for (let y = 0; y < GLYPH_HEIGHT; y += 1) {
      const row = glyph.rows[y];
      for (let x = 0; x < glyph.width; x += 1) if (row[x] === '#') plot(cursor + x, y);
    }
    cursor += glyph.width + LETTER_SPACING;
  }
}

/**
 * Greedy word wrap so every line measures at most `maxWidth` units. Words wider than a line are
 * broken at BREAK_HINT positions first and between characters only when a piece still does not
 * fit. When more than `maxLines` lines would be needed, the overflow is cut and `truncated` is
 * true. Expects normalized text.
 *
 * @param {string} text
 * @param {number} maxWidth
 * @param {number} maxLines
 * @returns {{ lines: string[], truncated: boolean }}
 */
export function wrapText(text, maxWidth, maxLines) {
  const lines = [];
  let current = '';
  const flush = () => {
    if (current) lines.push(current);
    current = '';
  };
  for (const word of text.split(' ').filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureLine(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    flush();
    if (measureLine(word) <= maxWidth) {
      current = word;
      continue;
    }
    for (const piece of word.split(BREAK_HINT).filter(Boolean)) {
      if (measureLine(current + piece) <= maxWidth) {
        current += piece;
        continue;
      }
      flush();
      if (measureLine(piece) <= maxWidth) {
        current = piece;
        continue;
      }
      // Hard break: fill each line with as many characters as fit.
      for (const char of piece) {
        if (measureLine(current + char) <= maxWidth) current += char;
        else {
          flush();
          // A single glyph wider than the line can never be drawn; skip it.
          if (measureLine(char) <= maxWidth) current = char;
        }
      }
    }
  }
  flush();
  return lines.length > maxLines
    ? { lines: lines.slice(0, Math.max(0, maxLines)), truncated: true }
    : { lines, truncated: false };
}
