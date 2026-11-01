import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  GRID_ROWS as ENGINE_GRID_ROWS,
  PALETTE as ENGINE_PALETTE,
  SIDE_COLS as ENGINE_SIDE_COLS,
  parseArtwork,
} from '../src/engine/artwork.js';
import type { StuntMode } from '../src/engine/types.js';
import {
  GRID_ROWS,
  PALETTE,
  PALETTE_NAMES,
  PALETTE_RGB,
  PRESET_IDS,
  SIDE_COLS,
  boxDownsample,
  colorDistance,
  coverFitRect,
  fullCols,
  hintLabelBreaks,
  imageDataToArtwork,
  isValidArtwork,
  layoutAtScale,
  lettersPerLine,
  nearestPaletteIndex,
  presetArtwork,
  presetTitle,
  textArtwork,
  type Grid,
} from '../public/control/artwork.js';
import {
  BREAK_HINT,
  GLYPHS,
  GLYPH_HEIGHT,
  SPACE_WIDTH,
  SUPPORTED_CHARACTERS,
  forEachLitUnit,
  measureLine,
  normalizeText,
  wrapText,
} from '../public/control/pixelfont.js';

/*
 * The control panel's browser modules (public/control/*.js) build the hidden picture that
 * POST /api/call validates with parseArtwork. These tests pin font coverage, text fitting,
 * presets and image quantization against the engine's own contract.
 */

const MODES: readonly StuntMode[] = ['crossover', 'single'];
/** Characters docs/DESIGN.md requires the pixel font to draw. */
const REQUIRED_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?:-+x/&'#";
const LABEL_SETS = [
  { A: 'LEFT STAND', B: 'RIGHT STAND' },
  { A: 'PixelPilot', B: 'NeonNomad' },
  { A: 'xQc', B: 'the_streamer_with_a_long_name' },
  { A: 'averyveryverylongtwitchname', B: 'B' },
  { A: '配信者', B: '' },
];

function strip(text: string): string {
  return text.replaceAll(BREAK_HINT, '');
}

function count(grid: Grid, color: number): number {
  return grid.pixels.filter((pixel) => pixel === color).length;
}

/** Columns and rows that contain `color`. */
function bounds(grid: Grid, color: number) {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  grid.pixels.forEach((pixel, index) => {
    if (pixel !== color) return;
    const x = index % grid.cols;
    const y = Math.floor(index / grid.cols);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  });
  return { left, right, top, bottom };
}

function litUnits(text: string): number {
  let lit = 0;
  forEachLitUnit(text, () => {
    lit += 1;
  });
  return lit;
}

describe('control artwork mirrors the engine contract', () => {
  it('duplicates the engine palette and grid exactly (source of truth: src/engine/artwork.ts)', () => {
    expect([...PALETTE]).toEqual([...ENGINE_PALETTE]);
    expect(PALETTE_NAMES).toHaveLength(PALETTE.length);
    expect(SIDE_COLS).toBe(ENGINE_SIDE_COLS);
    expect(GRID_ROWS).toBe(ENGINE_GRID_ROWS);
    expect(fullCols('crossover')).toBe(96);
    expect(fullCols('single')).toBe(48);
  });

  it('isValidArtwork agrees with parseArtwork on arbitrary candidates', () => {
    const pixel = fc.oneof(
      fc.integer({ min: 0, max: 7 }),
      fc.constantFrom(-1, 8, 1.5, Number.NaN, '3', null),
    );
    const candidate = fc
      .record({
        cols: fc.constantFrom(48, 96, 47, 0),
        rows: fc.constantFrom(27, 26),
        delta: fc.constantFrom(0, 0, 0, 1, -1),
        bad: fc.option(fc.tuple(fc.nat(), pixel)),
      })
      .map(({ cols, rows, delta, bad }) => {
        const pixels: unknown[] = Array.from(
          { length: Math.max(0, cols * rows + delta) },
          (_, i) => i % 8,
        );
        if (bad && pixels.length > 0) pixels[bad[0] % pixels.length] = bad[1];
        return { cols, rows, pixels };
      });
    fc.assert(
      fc.property(candidate, fc.constantFrom(...MODES), (value, mode) => {
        expect(isValidArtwork(value, mode)).toBe(parseArtwork(value, mode) !== null);
      }),
      { seed: 31, numRuns: 300 },
    );
    expect(isValidArtwork(null, 'single')).toBe(false);
    expect(isValidArtwork({ cols: 48, rows: 27 }, 'single')).toBe(false);
  });
});

describe('5×7 pixel font', () => {
  it('defines a well-formed glyph for every supported character', () => {
    for (const char of REQUIRED_CHARACTERS) expect(SUPPORTED_CHARACTERS).toContain(char);
    expect(Object.keys(GLYPHS).sort()).toEqual([...SUPPORTED_CHARACTERS].sort());
    for (const char of SUPPORTED_CHARACTERS) {
      const glyph = GLYPHS[char];
      expect(glyph, `glyph for ${JSON.stringify(char)}`).toBeDefined();
      if (!glyph) continue;
      expect(glyph.rows).toHaveLength(GLYPH_HEIGHT);
      expect(glyph.width).toBeGreaterThanOrEqual(1);
      expect(glyph.width).toBeLessThanOrEqual(5);
      for (const row of glyph.rows) expect(row).toMatch(new RegExp(`^[#.]{${glyph.width}}$`));
      if (char === ' ') {
        expect(glyph.width).toBe(SPACE_WIDTH);
        expect(litUnits(char)).toBe(0);
        continue;
      }
      // Trimmed: the first and last columns both carry ink.
      expect(glyph.rows.some((row) => row.startsWith('#'))).toBe(true);
      expect(glyph.rows.some((row) => row.endsWith('#'))).toBe(true);
    }
  });

  it('never draws two characters identically (O vs 0, I vs 1, x vs X)', () => {
    const seen = new Map<string, string>();
    for (const char of SUPPORTED_CHARACTERS) {
      const key = GLYPHS[char]?.rows.join('/') ?? '';
      expect(seen.get(key), `${char} duplicates ${seen.get(key)}`).toBeUndefined();
      seen.set(key, char);
    }
  });

  it('normalizes host input onto the font and reports what it drops', () => {
    expect(normalizeText('Shroud x Poki')).toEqual({ text: 'SHROUD x POKI', unsupported: [] });
    expect(normalizeText('max xqc')).toEqual({ text: 'MAX XQC', unsupported: [] });
    expect(normalizeText('  Équipe   Ñandú  ')).toEqual({ text: 'EQUIPE NANDU', unsupported: [] });
    expect(normalizeText('it’s 5×5 — go')).toEqual({ text: "IT'S 5X5 - GO", unsupported: [] });
    expect(normalizeText('a × b')).toEqual({ text: 'A x B', unsupported: [] });
    expect(normalizeText('Straße')).toEqual({ text: 'STRASSE', unsupported: [] });
    expect(normalizeText('gg 🎉🎉 ~')).toEqual({ text: 'GG', unsupported: ['🎉', '~'] });
  });

  it('measures proportional glyphs with one unit of letter spacing', () => {
    expect(measureLine('')).toBe(0);
    expect(measureLine('I')).toBe(3);
    expect(measureLine('GG')).toBe(11);
    expect(measureLine('A B')).toBe(5 + 1 + SPACE_WIDTH + 1 + 5);
    expect(measureLine(`PIXEL${BREAK_HINT}PILOT`)).toBe(measureLine('PIXELPILOT'));
  });

  it('wraps every line within the width without losing characters', () => {
    const text = fc
      .array(fc.constantFrom(...SUPPORTED_CHARACTERS.replace(' ', '')), { maxLength: 40 })
      .chain((chars) =>
        fc.array(fc.nat({ max: chars.length }), { maxLength: 6 }).map((spaces) => {
          const out = [...chars];
          for (const at of spaces) out.splice(at, 0, ' ');
          return normalizeText(out.join('')).text;
        }),
      );
    fc.assert(
      fc.property(text, fc.integer({ min: 5, max: 94 }), (input, maxWidth) => {
        const { lines, truncated } = wrapText(input, maxWidth, Infinity);
        expect(truncated).toBe(false);
        for (const line of lines) expect(measureLine(line)).toBeLessThanOrEqual(maxWidth);
        expect(lines.join('').replaceAll(' ', '')).toBe(input.replaceAll(' ', ''));
      }),
      { seed: 2026, numRuns: 400 },
    );
  });

  it('prefers break hints over splitting a word mid-letter, and truncates to maxLines', () => {
    expect(hintLabelBreaks('PixelPilot')).toBe(`Pixel${BREAK_HINT}Pilot`);
    expect(hintLabelBreaks('neon_nomad99')).toBe(`neon_${BREAK_HINT}nomad${BREAK_HINT}99`);
    const hinted = normalizeText(hintLabelBreaks('PixelPilot')).text;
    expect(wrapText(hinted, 41, 3).lines.map(strip)).toEqual(['PIXEL', 'PILOT']);
    expect(wrapText('PIXELPILOT', 41, 3).lines).toEqual(['PIXELPI', 'LOT']);
    expect(wrapText('ONE TWO THREE FOUR', 23, 2)).toEqual({
      lines: ['ONE', 'TWO'],
      truncated: true,
    });
  });
});

describe('text artwork', () => {
  const line = fc
    .array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?#&'), { maxLength: 12 })
    .chain((chars) =>
      fc.array(fc.nat({ max: chars.length }), { maxLength: 3 }).map((spaces) => {
        const out = [...chars];
        for (const at of spaces) out.splice(at, 0, ' ');
        return out.join('');
      }),
    );

  it('fits the grid at the largest integer scale, unclipped, and passes parseArtwork', () => {
    fc.assert(
      fc.property(fc.constantFrom(...MODES), line, line, (mode, first, second) => {
        const result = textArtwork({ mode, lines: [first, second], fg: 5, bg: 6 });
        if (result.error !== null) {
          expect(result.artwork).toBeNull();
          return;
        }
        const { artwork, layout } = result;
        expect(artwork).not.toBeNull();
        expect(layout).not.toBeNull();
        if (!artwork || !layout) return;
        expect(parseArtwork(artwork, mode)).not.toBeNull();
        if (layout.items.length === 0) return;
        // Every lit font unit became scale² cards: nothing was clipped at the edges…
        const expected = layout.items.reduce((sum, item) => sum + litUnits(item.text), 0);
        expect(count(artwork, 5)).toBe(expected * layout.scale * layout.scale);
        // …and the 1-card margin stays clear.
        const box = bounds(artwork, 5);
        expect(box.left).toBeGreaterThanOrEqual(1);
        expect(box.top).toBeGreaterThanOrEqual(1);
        expect(box.right).toBeLessThanOrEqual(artwork.cols - 2);
        expect(box.bottom).toBeLessThanOrEqual(GRID_ROWS - 2);
        // Maximal: one size up no longer fits.
        const textBox = { x: 1, y: 1, w: artwork.cols - 2, h: GRID_ROWS - 2 };
        expect(layoutAtScale(layout.items, textBox, layout.scale + 1)).toBeNull();
      }),
      { seed: 1031, numRuns: 250 },
    );
  });

  it('always fits lines up to the advertised letters-per-line hint', () => {
    for (const mode of MODES) {
      const full = 'W'.repeat(lettersPerLine(mode));
      const result = textArtwork({ mode, lines: [full, full], fg: 1, bg: 0 });
      expect(result.error).toBeNull();
      expect(result.layout?.scale).toBe(1);
    }
  });

  it('scales a short word up and centres it', () => {
    for (const mode of MODES) {
      const { artwork, layout } = textArtwork({ mode, lines: ['GG', ''], fg: 5, bg: 6 });
      expect(layout?.scale).toBe(3);
      if (!artwork) throw new Error('expected artwork');
      const box = bounds(artwork, 5);
      const centre = (box.left + box.right + 1) / 2;
      expect(Math.abs(centre - artwork.cols / 2)).toBeLessThanOrEqual(1);
    }
  });

  it('rejects text that cannot fit and reports dropped characters', () => {
    const tooLong = textArtwork({
      mode: 'single',
      lines: ['SUPERCALIFRAGILISTIC EXPIALIDOCIOUS', 'AND MORE WORDS'],
      fg: 1,
      bg: 0,
    });
    expect(tooLong.artwork).toBeNull();
    expect(tooLong.error).toMatch(/Too long for single mode/);
    const dropped = textArtwork({ mode: 'crossover', lines: ['hi 🎉'], fg: 1, bg: 0 });
    expect(dropped.error).toBeNull();
    expect(dropped.unsupported).toEqual(['🎉']);
  });
});

describe('presets', () => {
  it('produce valid, multi-colour artwork for every preset, mode and label set', () => {
    for (const labels of LABEL_SETS) {
      for (const mode of MODES) {
        for (const id of PRESET_IDS) {
          const artwork = presetArtwork(id, mode, labels);
          expect(parseArtwork(artwork, mode), `${id} ${mode} ${labels.A}`).not.toBeNull();
          expect(new Set(artwork.pixels).size).toBeGreaterThanOrEqual(3);
        }
      }
    }
    expect(presetTitle('versus', { A: 'LEFT STAND', B: 'RIGHT STAND' })).toBe(
      'LEFT STAND + RIGHT STAND',
    );
    expect(() => presetArtwork('nope', 'single', LABEL_SETS[0] ?? { A: 'A', B: 'B' })).toThrow(
      RangeError,
    );
  });

  it('A + B (crossover) keeps each name on its own half and puts "+" on the seam', () => {
    for (const labels of LABEL_SETS) {
      const artwork = presetArtwork('versus', 'crossover', labels);
      const orange = bounds(artwork, 2);
      const sky = bounds(artwork, 3);
      expect(orange.right).toBeLessThan(SIDE_COLS);
      expect(sky.left).toBeGreaterThanOrEqual(SIDE_COLS);
      const plus = bounds(artwork, 1);
      expect(plus.left).toBeLessThan(SIDE_COLS);
      expect(plus.right).toBeGreaterThanOrEqual(SIDE_COLS);
    }
  });
});

describe('image quantization', () => {
  it('maps every palette colour to itself and obvious colours sensibly', () => {
    PALETTE_RGB.forEach(([r, g, b], index) => expect(nearestPaletteIndex(r, g, b)).toBe(index));
    expect(nearestPaletteIndex(0, 0, 0)).toBe(0);
    expect(nearestPaletteIndex(255, 255, 255)).toBe(1);
    expect(nearestPaletteIndex(255, 0, 0)).toBe(7);
    expect(nearestPaletteIndex(0, 0, 255)).toBe(6);
  });

  it('picks the nearest palette entry for any colour', () => {
    const channel = fc.integer({ min: 0, max: 255 });
    fc.assert(
      fc.property(channel, channel, channel, (r, g, b) => {
        const chosen = nearestPaletteIndex(r, g, b);
        const [cr, cg, cb] = PALETTE_RGB[chosen] ?? [0, 0, 0];
        const best = colorDistance(r, g, b, cr, cg, cb);
        for (const [pr, pg, pb] of PALETTE_RGB) {
          expect(best).toBeLessThanOrEqual(colorDistance(r, g, b, pr, pg, pb));
        }
      }),
      { seed: 8, numRuns: 500 },
    );
  });

  it('cover-fits: same aspect as the grid, centred, maximal and inside the source', () => {
    const size = fc.integer({ min: 1, max: 5000 });
    fc.assert(
      fc.property(size, size, fc.constantFrom(...MODES), (width, height, mode) => {
        const cols = fullCols(mode);
        const crop = coverFitRect(width, height, cols, GRID_ROWS);
        const epsilon = 1e-6;
        expect(crop.sx).toBeGreaterThanOrEqual(-epsilon);
        expect(crop.sy).toBeGreaterThanOrEqual(-epsilon);
        expect(crop.sx + crop.sw).toBeLessThanOrEqual(width + epsilon);
        expect(crop.sy + crop.sh).toBeLessThanOrEqual(height + epsilon);
        expect(crop.sw / crop.sh).toBeCloseTo(cols / GRID_ROWS, 6);
        expect(crop.sx * 2 + crop.sw).toBeCloseTo(width, 6);
        expect(crop.sy * 2 + crop.sh).toBeCloseTo(height, 6);
        expect(crop.sw === width || crop.sh === height).toBe(true);
      }),
      { seed: 96, numRuns: 300 },
    );
  });

  it('box-filters to the grid, averaging each cell', () => {
    const width = 8;
    const height = 4;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        rgba.set(x < width / 2 ? [200, 0, 0, 255] : [0, 0, 100, 255], offset);
      }
    }
    expect([...boxDownsample(rgba, width, height, 2, 1)]).toEqual([200, 0, 0, 0, 0, 100]);
    // A cell straddling both halves averages them.
    expect([...boxDownsample(rgba, width, height, 1, 1)]).toEqual([100, 0, 50]);
  });

  it('turns any image into an artwork parseArtwork accepts', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MODES),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (mode, factor, seed) => {
          const width = fullCols(mode) * factor;
          const height = GRID_ROWS * factor;
          // Deterministic noise (LCG) instead of Math.random keeps failures replayable.
          let state = seed;
          const rgba = Uint8ClampedArray.from({ length: width * height * 4 }, () => {
            state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
            return state & 255;
          });
          const artwork = imageDataToArtwork(rgba, width, height, mode);
          expect(parseArtwork(artwork, mode)).not.toBeNull();
          expect(Array.isArray(artwork.pixels)).toBe(true);
        },
      ),
      { seed: 27, numRuns: 30 },
    );
  });

  it('keeps the halves of a two-colour image on their sides', () => {
    const width = 192;
    const height = 54;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      const left = index % width < width / 2;
      rgba.set(left ? [230, 159, 0, 255] : [86, 180, 233, 255], index * 4);
    }
    const artwork = imageDataToArtwork(rgba, width, height, 'crossover');
    expect(count(artwork, 2)).toBe(SIDE_COLS * GRID_ROWS);
    expect(count(artwork, 3)).toBe(SIDE_COLS * GRID_ROWS);
    expect(bounds(artwork, 2).right).toBe(SIDE_COLS - 1);
  });
});

describe('seam presets', () => {
  it('puts heart and face first and keeps both modes within the palette', () => {
    expect(PRESET_IDS.slice(0, 2)).toEqual(['heart', 'face']);
    for (const mode of MODES)
      for (const id of ['heart', 'face']) {
        const art = presetArtwork(id, mode, LABEL_SETS[0]!);
        expect(parseArtwork(art, mode)).not.toBeNull();
        expect(presetTitle(id, LABEL_SETS[0]!)).toBe(id.toUpperCase());
      }
  });
  it('splits the heart colours at the axis, with a highlight crossing the seam', () => {
    for (const mode of MODES) {
      const art = presetArtwork('heart', mode, LABEL_SETS[0]!);
      const a = art.pixels.filter((_, i) => i % art.cols < art.cols / 2);
      const b = art.pixels.filter((_, i) => i % art.cols >= art.cols / 2);
      expect(a).toContain(2);
      expect(a).not.toContain(3);
      expect(b).toContain(3);
      expect(b).not.toContain(2);
      for (const col of [art.cols / 2 - 1, art.cols / 2])
        expect(art.pixels[9 * art.cols + col]).toBe(5);
    }
  });
  it('keeps the face expression asymmetric across the axis', () => {
    const art = presetArtwork('face', 'crossover', LABEL_SETS[0]!);
    expect(
      art.pixels.some(
        (p, i) =>
          p !== art.pixels[Math.floor(i / art.cols) * art.cols + art.cols - 1 - (i % art.cols)],
      ),
    ).toBe(true);
    expect(bounds(art, 5)).toEqual({ left: 31, right: 64, top: 1, bottom: 24 });
  });
});
