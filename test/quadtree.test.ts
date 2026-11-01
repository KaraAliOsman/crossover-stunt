import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { GRID_ROWS, PALETTE_RGB, SIDE_COLS, sideRegion } from '../src/engine/artwork.js';
import {
  PRE_REVEAL_RATIO,
  buildRefinementPlan,
  splitRect,
  stepsToShow,
} from '../src/engine/quadtree.js';
import type { Artwork, Rect, RefinementPlan } from '../src/engine/types.js';

/** Independent brute-force reference implementations (no prefix sums, no heap). */
function regionPixels(artwork: Artwork, rect: Rect): number[] {
  const values: number[] = [];
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1)
      values.push(artwork.pixels[y * artwork.cols + x]!);
  }
  return values;
}

function bruteNearest(artwork: Artwork, rect: Rect): number {
  const pixels = regionPixels(artwork, rect);
  const mean = [0, 1, 2].map(
    (channel) => pixels.reduce((sum, p) => sum + PALETTE_RGB[p]![channel]!, 0) / pixels.length,
  );
  let best = 0;
  let bestDistance = Infinity;
  PALETTE_RGB.forEach((rgb, index) => {
    const distance = rgb.reduce((sum, value, channel) => sum + (value - mean[channel]!) ** 2, 0);
    // Tolerance only guards float noise in the reference; the implementation is exact.
    if (distance < bestDistance - 1e-9) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

function bruteError(artwork: Artwork, rect: Rect, color: number): number {
  const target = PALETTE_RGB[color]!;
  return regionPixels(artwork, rect).reduce(
    (sum, p) => sum + PALETTE_RGB[p]!.reduce((s, v, c) => s + (v - target[c]!) ** 2, 0),
    0,
  );
}

const keyOf = (rect: Rect): string => `${rect.x},${rect.y},${rect.w},${rect.h}`;

interface LeafState {
  readonly rect: Rect;
  readonly color: number;
}

/**
 * Replays `count` steps the way an overlay does, asserting every split targets a current leaf.
 * Returns the leaves and the rendered full-image grid (-1 = outside the region).
 */
function replay(plan: RefinementPlan, cols: number, rows: number, count = plan.steps.length) {
  const leaves = new Map<string, LeafState>([
    [keyOf(plan.region), { rect: plan.region, color: plan.rootColor }],
  ]);
  for (const stepItem of plan.steps.slice(0, count)) {
    expect(leaves.has(keyOf(stepItem.parent))).toBe(true);
    leaves.delete(keyOf(stepItem.parent));
    for (const child of stepItem.children) leaves.set(keyOf(child.rect), child);
  }
  const grid = new Int16Array(cols * rows).fill(-1);
  const coverage = new Uint16Array(cols * rows);
  for (const { rect, color } of leaves.values()) {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        grid[y * cols + x] = color;
        coverage[y * cols + x]! += 1;
      }
    }
  }
  return { leaves: [...leaves.values()], grid, coverage };
}

function inside(rect: Rect, region: Rect): boolean {
  return (
    rect.x >= region.x &&
    rect.y >= region.y &&
    rect.x + rect.w <= region.x + region.w &&
    rect.y + rect.h <= region.y + region.h
  );
}

/** Split priority used by the contract: error desc, then y asc, x asc, area desc. */
function priorityKey(artwork: Artwork, leaf: LeafState): [number, number, number, number] {
  const { rect } = leaf;
  return [-bruteError(artwork, rect, leaf.color), rect.y, rect.x, -(rect.w * rect.h)];
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

/** Small artworks (few colors → real uniform areas) with a random region inside. */
const caseArb = fc
  .record({
    cols: fc.integer({ min: 1, max: 12 }),
    rows: fc.integer({ min: 1, max: 9 }),
    colors: fc.integer({ min: 1, max: PALETTE_RGB.length }),
  })
  .chain(({ cols, rows, colors }) =>
    fc.record({
      artwork: fc
        .array(fc.integer({ min: 0, max: colors - 1 }), {
          minLength: cols * rows,
          maxLength: cols * rows,
        })
        .map((pixels): Artwork => ({ cols, rows, pixels })),
      region: fc
        .record({
          x: fc.integer({ min: 0, max: cols - 1 }),
          y: fc.integer({ min: 0, max: rows - 1 }),
        })
        .chain(({ x, y }) =>
          fc.record({
            x: fc.constant(x),
            y: fc.constant(y),
            w: fc.integer({ min: 1, max: cols - x }),
            h: fc.integer({ min: 1, max: rows - y }),
          }),
        ),
      side: fc.constantFrom('A' as const, 'B' as const),
    }),
  );

function randomArtwork(cols: number, rows: number, seed: number): Artwork {
  let state = seed >>> 0;
  const pixels = Array.from({ length: cols * rows }, () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state % PALETTE_RGB.length;
  });
  return { cols, rows, pixels };
}

describe('splitRect', () => {
  it('halves into 4 row-major children with floor on the top/left halves', () => {
    expect(splitRect({ x: 10, y: 4, w: 5, h: 3 })).toEqual([
      { x: 10, y: 4, w: 2, h: 1 },
      { x: 12, y: 4, w: 3, h: 1 },
      { x: 10, y: 5, w: 2, h: 2 },
      { x: 12, y: 5, w: 3, h: 2 },
    ]);
  });

  it('splits 1-wide and 1-tall cells into 2 children along the other axis', () => {
    expect(splitRect({ x: 3, y: 0, w: 1, h: 5 })).toEqual([
      { x: 3, y: 0, w: 1, h: 2 },
      { x: 3, y: 2, w: 1, h: 3 },
    ]);
    expect(splitRect({ x: 0, y: 7, w: 3, h: 1 })).toEqual([
      { x: 0, y: 7, w: 1, h: 1 },
      { x: 1, y: 7, w: 2, h: 1 },
    ]);
  });
});

describe('buildRefinementPlan examples', () => {
  it('reserves a final split even for simple artwork while a completed side waits', () => {
    const artwork: Artwork = {
      cols: SIDE_COLS * 2,
      rows: GRID_ROWS,
      pixels: Array.from({ length: SIDE_COLS * 2 * GRID_ROWS }, (_, i) =>
        i % SIDE_COLS < SIDE_COLS / 2 ? 2 : 7,
      ),
    };
    for (const side of ['A', 'B'] as const) {
      const plan = buildRefinementPlan({ artwork, side, region: sideRegion('crossover', side) });
      expect(plan.steps).toHaveLength(1);
      const waiting = replay(plan, artwork.cols, artwork.rows, stepsToShow(plan, 1, false));
      const revealed = replay(plan, artwork.cols, artwork.rows, stepsToShow(plan, 1, true));
      expect(waiting.grid).not.toEqual(revealed.grid);
      expect(plan.preRevealCount).toBeLessThan(plan.steps.length);
    }
  });

  it.each(PALETTE_RGB.map((_, color) => color))(
    'uniform artwork of color %i needs 0 steps',
    (color) => {
      const artwork: Artwork = {
        cols: SIDE_COLS * 2,
        rows: GRID_ROWS,
        pixels: new Array<number>(SIDE_COLS * 2 * GRID_ROWS).fill(color),
      };
      const plan = buildRefinementPlan({
        artwork,
        side: 'B',
        region: sideRegion('crossover', 'B'),
      });
      expect(plan).toEqual({
        side: 'B',
        region: { x: SIDE_COLS, y: 0, w: SIDE_COLS, h: GRID_ROWS },
        rootColor: color,
        steps: [],
        preRevealCount: 0,
      });
    },
  );

  it('picks the palette color nearest to the mean, ties → lower index', () => {
    // Orange (2) and vermillion (7) are equidistant from their mean and nothing is closer.
    for (const pixels of [
      [7, 2],
      [2, 7],
    ]) {
      const plan = buildRefinementPlan({
        artwork: { cols: 2, rows: 1, pixels },
        side: 'A',
        region: { x: 0, y: 0, w: 2, h: 1 },
      });
      expect(plan.rootColor).toBe(2);
      expect(plan.steps).toEqual([
        {
          parent: { x: 0, y: 0, w: 2, h: 1 },
          children: [
            { rect: { x: 0, y: 0, w: 1, h: 1 }, color: pixels[0] },
            { rect: { x: 1, y: 0, w: 1, h: 1 }, color: pixels[1] },
          ],
        },
      ]);
      expect(plan.preRevealCount).toBe(0);
    }
  });

  it('uses 2-child splits on 1-wide columns', () => {
    const plan = buildRefinementPlan({
      artwork: { cols: 1, rows: 4, pixels: [0, 0, 1, 1] },
      side: 'A',
      region: { x: 0, y: 0, w: 1, h: 4 },
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.children).toEqual([
      { rect: { x: 0, y: 0, w: 1, h: 2 }, color: 0 },
      { rect: { x: 0, y: 2, w: 1, h: 2 }, color: 1 },
    ]);
  });

  it('breaks equal-error ties by smaller y, then smaller x', () => {
    // 4×4 ink/paper checkerboard (rows 0101 / 1010 / 0101 / 1010): its four 2×2 quadrants are
    // identical, so every quadrant has the same error after the root split.
    const pixels = [0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0];
    const plan = buildRefinementPlan({
      artwork: { cols: 4, rows: 4, pixels },
      side: 'A',
      region: { x: 0, y: 0, w: 4, h: 4 },
    });
    expect(plan.steps.map((s) => keyOf(s.parent))).toEqual([
      '0,0,4,4',
      '0,0,2,2',
      '2,0,2,2',
      '0,2,2,2',
      '2,2,2,2',
    ]);
  });

  it('keeps each side inside its own half of the full-image coordinates', () => {
    const artwork = randomArtwork(SIDE_COLS * 2, GRID_ROWS, 99);
    for (const side of ['A', 'B'] as const) {
      const region = sideRegion('crossover', side);
      const plan = buildRefinementPlan({ artwork, side, region });
      expect(plan.side).toBe(side);
      for (const s of plan.steps) {
        for (const child of s.children) expect(inside(child.rect, region)).toBe(true);
      }
      const { grid } = replay(plan, artwork.cols, artwork.rows);
      for (let y = 0; y < GRID_ROWS; y += 1) {
        for (let x = 0; x < artwork.cols; x += 1) {
          const expected = inside({ x, y, w: 1, h: 1 }, region)
            ? artwork.pixels[y * artwork.cols + x]
            : -1;
          expect(grid[y * artwork.cols + x]).toBe(expected);
        }
      }
    }
  });

  it('builds a 48×27 worst-case (random) plan well under 50 ms within the step bound', () => {
    const artwork = randomArtwork(SIDE_COLS, GRID_ROWS, 2026);
    const input = { artwork, side: 'A' as const, region: sideRegion('single', 'A') };
    buildRefinementPlan(input); // warm-up (JIT)
    const started = performance.now();
    const plan = buildRefinementPlan(input);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(50);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps.length).toBeLessThanOrEqual(SIDE_COLS * GRID_ROWS - 1);
    // Plans travel as JSON in RoundPayload: plain data only.
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it.each<[string, Artwork, Rect]>([
    [
      'region outside the artwork',
      { cols: 2, rows: 2, pixels: [0, 0, 0, 0] },
      { x: 1, y: 0, w: 2, h: 2 },
    ],
    ['empty region', { cols: 2, rows: 2, pixels: [0, 0, 0, 0] }, { x: 0, y: 0, w: 0, h: 2 }],
    ['fractional region', { cols: 2, rows: 2, pixels: [0, 0, 0, 0] }, { x: 0.5, y: 0, w: 1, h: 1 }],
    ['wrong pixel count', { cols: 2, rows: 2, pixels: [0, 0, 0] }, { x: 0, y: 0, w: 2, h: 2 }],
    [
      'palette index out of range',
      { cols: 2, rows: 1, pixels: [0, 8] },
      { x: 0, y: 0, w: 2, h: 1 },
    ],
    ['non-integer pixel', { cols: 2, rows: 1, pixels: [0, 1.5] }, { x: 0, y: 0, w: 2, h: 1 }],
  ])('rejects %s with RangeError', (_label, artwork, region) => {
    expect(() => buildRefinementPlan({ artwork, side: 'A', region })).toThrow(RangeError);
  });
});

describe('buildRefinementPlan properties', () => {
  it('leaves tile the region exactly after every step and all steps reproduce the artwork', () => {
    fc.assert(
      fc.property(caseArb, ({ artwork, region, side }) => {
        const plan = buildRefinementPlan({ artwork, side, region });
        const area = region.w * region.h;
        expect(plan.steps.length).toBeLessThanOrEqual(area - 1);
        for (let count = 0; count <= plan.steps.length; count += 1) {
          const { leaves, coverage } = replay(plan, artwork.cols, artwork.rows, count);
          expect(leaves.reduce((sum, leaf) => sum + leaf.rect.w * leaf.rect.h, 0)).toBe(area);
          for (const leaf of leaves) expect(inside(leaf.rect, region)).toBe(true);
          for (let y = 0; y < artwork.rows; y += 1) {
            for (let x = 0; x < artwork.cols; x += 1) {
              const expected = inside({ x, y, w: 1, h: 1 }, region) ? 1 : 0;
              expect(coverage[y * artwork.cols + x]).toBe(expected); // no gap, no overlap
            }
          }
        }
        const { grid } = replay(plan, artwork.cols, artwork.rows);
        for (const leafCell of regionCells(region)) {
          expect(grid[leafCell.y * artwork.cols + leafCell.x]).toBe(
            artwork.pixels[leafCell.y * artwork.cols + leafCell.x],
          );
        }
      }),
      { seed: 20261031, numRuns: 200 },
    );
  });

  it('follows the greedy contract: max-priority split, exact colors, valid split shapes', () => {
    fc.assert(
      fc.property(caseArb, ({ artwork, region, side }) => {
        const plan = buildRefinementPlan({ artwork, side, region });
        expect(plan.rootColor).toBe(bruteNearest(artwork, region));
        const leaves = new Map<string, LeafState>([
          [keyOf(region), { rect: region, color: plan.rootColor }],
        ]);
        for (const s of plan.steps) {
          const parent = leaves.get(keyOf(s.parent))!;
          // Never split a zero-error or single-card leaf.
          expect(s.parent.w * s.parent.h).toBeGreaterThan(1);
          expect(bruteError(artwork, s.parent, parent.color)).toBeGreaterThan(0);
          // The chosen leaf has the highest priority among all current leaves.
          const best = [...leaves.values()]
            .filter((leaf) => bruteError(artwork, leaf.rect, leaf.color) > 0)
            .map((leaf) => priorityKey(artwork, leaf))
            .sort(compareKeys)[0]!;
          expect(priorityKey(artwork, parent)).toEqual(best);
          // Split shape and row-major children order.
          expect(s.children.map((child) => child.rect)).toEqual(splitRect(s.parent));
          expect(s.children).toHaveLength(s.parent.w === 1 || s.parent.h === 1 ? 2 : 4);
          leaves.delete(keyOf(s.parent));
          for (const child of s.children) {
            expect(child.color).toBe(bruteNearest(artwork, child.rect));
            leaves.set(keyOf(child.rect), child);
          }
        }
        // Stops exactly when every leaf is exact.
        for (const leaf of leaves.values()) {
          expect(bruteError(artwork, leaf.rect, leaf.color)).toBe(0);
        }
      }),
      { seed: 4242, numRuns: 150 },
    );
  });

  it('is deterministic and keeps preRevealCount within bounds', () => {
    fc.assert(
      fc.property(caseArb, ({ artwork, region, side }) => {
        const plan = buildRefinementPlan({ artwork, side, region });
        const copy: Artwork = { ...artwork, pixels: [...artwork.pixels] };
        expect(buildRefinementPlan({ artwork: copy, side, region: { ...region } })).toEqual(plan);
        const total = plan.steps.length;
        if (total === 0) {
          expect(plan.preRevealCount).toBe(0);
        } else {
          expect(plan.preRevealCount).toBeLessThanOrEqual(Math.ceil(total * PRE_REVEAL_RATIO));
          expect(plan.preRevealCount).toBeGreaterThanOrEqual(0);
          expect(plan.preRevealCount).toBeLessThan(total);
          // Every non-uniform picture must retain actual hidden detail at full pre-reveal progress.
          expect(replay(plan, artwork.cols, artwork.rows, plan.preRevealCount).grid).not.toEqual(
            replay(plan, artwork.cols, artwork.rows).grid,
          );
        }
      }),
      { seed: 31, numRuns: 200 },
    );
  });

  it('does not mutate its input', () => {
    fc.assert(
      fc.property(caseArb, ({ artwork, region, side }) => {
        const before = structuredClone({ artwork, region });
        buildRefinementPlan({ artwork, side, region });
        expect({ artwork, region }).toEqual(before);
      }),
      { seed: 5, numRuns: 50 },
    );
  });
});

function regionCells(region: Rect): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  for (let y = region.y; y < region.y + region.h; y += 1) {
    for (let x = region.x; x < region.x + region.w; x += 1) cells.push({ x, y });
  }
  return cells;
}

describe('stepsToShow', () => {
  const plan = { steps: new Array(10).fill(null), preRevealCount: 8 } as unknown as Pick<
    RefinementPlan,
    'steps' | 'preRevealCount'
  >;

  it('maps progress onto the pre-reveal layer and gates the final layer on reveal', () => {
    expect(stepsToShow(plan, 0, false)).toBe(0);
    expect(stepsToShow(plan, 0.5, false)).toBe(4);
    expect(stepsToShow(plan, 1, false)).toBe(8);
    expect(stepsToShow(plan, 7, false)).toBe(8);
    expect(stepsToShow(plan, -1, false)).toBe(0);
    expect(stepsToShow(plan, 0, true)).toBe(10);
  });
});
