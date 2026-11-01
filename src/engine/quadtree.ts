import { PALETTE_RGB } from './artwork.js';
import type { Artwork, Rect, RefinementPlan, RefinementStep, Side } from './types.js';

/** Share of the split sequence shown before the joint reveal (the rest is the final layer). */
export const PRE_REVEAL_RATIO = 0.8;

export interface PlanInput {
  readonly artwork: Artwork;
  readonly side: Side;
  /** Region of the full image owned by this side (see sideRegion in artwork.ts). */
  readonly region: Rect;
}

/** A leaf waiting in the split queue; coordinates are full-image card units. */
interface Leaf {
  readonly rect: Rect;
  readonly color: number;
  /** Exact integer: sum of squared RGB distances from each pixel to `color`. */
  readonly error: number;
}

/**
 * Summed-area tables over the region (one extra leading row/column of zeros) so any
 * sub-rectangle's channel sums are O(1). All values are integers far below 2^53, so every
 * error/colour comparison below is exact and therefore deterministic.
 */
interface RegionSums {
  readonly region: Rect;
  /** Row stride of the tables = region.w + 1. */
  readonly stride: number;
  readonly r: Float64Array;
  readonly g: Float64Array;
  readonly b: Float64Array;
  /** Per-pixel r² + g² + b². */
  readonly sq: Float64Array;
}

interface RectSums {
  readonly n: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly sq: number;
}

function assertInput(input: PlanInput): void {
  const { artwork, region, side } = input;
  if (side !== 'A' && side !== 'B') throw new RangeError('side must be "A" or "B"');
  const { cols, rows, pixels } = artwork;
  if (!Number.isSafeInteger(cols) || cols < 1 || !Number.isSafeInteger(rows) || rows < 1) {
    throw new RangeError('artwork cols and rows must be positive integers');
  }
  if (!Array.isArray(pixels) || pixels.length !== cols * rows) {
    throw new RangeError('artwork pixels must have length cols × rows');
  }
  const { x, y, w, h } = region;
  if (
    ![x, y, w, h].every(Number.isSafeInteger) ||
    x < 0 ||
    y < 0 ||
    w < 1 ||
    h < 1 ||
    x + w > cols ||
    y + h > rows
  ) {
    throw new RangeError('region must be a non-empty integer rectangle inside the artwork');
  }
}

function buildSums(artwork: Artwork, region: Rect): RegionSums {
  const stride = region.w + 1;
  const size = stride * (region.h + 1);
  const r = new Float64Array(size);
  const g = new Float64Array(size);
  const b = new Float64Array(size);
  const sq = new Float64Array(size);
  for (let ly = 0; ly < region.h; ly += 1) {
    for (let lx = 0; lx < region.w; lx += 1) {
      const pixel = artwork.pixels[(region.y + ly) * artwork.cols + region.x + lx];
      const rgb = pixel === undefined || !Number.isInteger(pixel) ? undefined : PALETTE_RGB[pixel];
      if (rgb === undefined) {
        throw new RangeError(`artwork pixel at (${region.x + lx}, ${region.y + ly}) is invalid`);
      }
      const [pr, pg, pb] = rgb;
      const at = (ly + 1) * stride + lx + 1;
      const up = at - stride;
      // Standard 2D prefix recurrence: S(x,y) = v + S(x-1,y) + S(x,y-1) - S(x-1,y-1).
      r[at] = pr + r[at - 1]! + r[up]! - r[up - 1]!;
      g[at] = pg + g[at - 1]! + g[up]! - g[up - 1]!;
      b[at] = pb + b[at - 1]! + b[up]! - b[up - 1]!;
      sq[at] = pr * pr + pg * pg + pb * pb + sq[at - 1]! + sq[up]! - sq[up - 1]!;
    }
  }
  return { region, stride, r, g, b, sq };
}

function rectSums(sums: RegionSums, rect: Rect): RectSums {
  const { stride, region } = sums;
  const x0 = rect.x - region.x;
  const y0 = rect.y - region.y;
  const topLeft = y0 * stride + x0;
  const topRight = topLeft + rect.w;
  const bottomLeft = topLeft + rect.h * stride;
  const bottomRight = bottomLeft + rect.w;
  const area = (table: Float64Array): number =>
    table[bottomRight]! - table[bottomLeft]! - table[topRight]! + table[topLeft]!;
  return {
    n: rect.w * rect.h,
    r: area(sums.r),
    g: area(sums.g),
    b: area(sums.b),
    sq: area(sums.sq),
  };
}

/**
 * Palette index nearest to the mean RGB (ties → lower index). Distances are compared scaled
 * by n² — (Σr − n·pr)² + … — which keeps them integral and exact.
 */
function nearestColor(s: RectSums): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < PALETTE_RGB.length; index += 1) {
    const [pr, pg, pb] = PALETTE_RGB[index]!;
    const dr = s.r - s.n * pr;
    const dg = s.g - s.n * pg;
    const db = s.b - s.n * pb;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/** Σ|p − c|² expanded as Σ|p|² − 2·c·Σp + n·|c|². */
function squaredError(s: RectSums, color: number): number {
  const [pr, pg, pb] = PALETTE_RGB[color]!;
  return s.sq - 2 * (pr * s.r + pg * s.g + pb * s.b) + s.n * (pr * pr + pg * pg + pb * pb);
}

function makeLeaf(sums: RegionSums, rect: Rect): Leaf {
  const s = rectSums(sums, rect);
  const color = nearestColor(s);
  return { rect, color, error: squaredError(s, color) };
}

/** Split priority: larger error, then smaller y, smaller x, larger area. */
function splitsBefore(a: Leaf, b: Leaf): boolean {
  if (a.error !== b.error) return a.error > b.error;
  if (a.rect.y !== b.rect.y) return a.rect.y < b.rect.y;
  if (a.rect.x !== b.rect.x) return a.rect.x < b.rect.x;
  return a.rect.w * a.rect.h > b.rect.w * b.rect.h;
}

/** Minimal binary heap ordered by `splitsBefore` (root = next leaf to split). */
class LeafQueue {
  readonly #items: Leaf[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(leaf: Leaf): void {
    const items = this.#items;
    items.push(leaf);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!splitsBefore(items[index]!, items[parent]!)) break;
      [items[index], items[parent]] = [items[parent]!, items[index]!];
      index = parent;
    }
  }

  pop(): Leaf | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined || items.length === 0) return top;
    items[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let first = index;
      if (left < items.length && splitsBefore(items[left]!, items[first]!)) first = left;
      if (right < items.length && splitsBefore(items[right]!, items[first]!)) first = right;
      if (first === index) return top;
      [items[index], items[first]] = [items[first]!, items[index]!];
      index = first;
    }
  }
}

/**
 * Halves width (left = floor) and height (top = floor) into 4 children in row-major order.
 * A 1-wide or 1-tall rect splits only along its other axis into 2 children.
 */
export function splitRect(rect: Rect): Rect[] {
  const { x, y, w, h } = rect;
  const leftW = Math.floor(w / 2);
  const topH = Math.floor(h / 2);
  if (w === 1) {
    return [
      { x, y, w, h: topH },
      { x, y: y + topH, w, h: h - topH },
    ];
  }
  if (h === 1) {
    return [
      { x, y, w: leftW, h },
      { x: x + leftW, y, w: w - leftW, h },
    ];
  }
  return [
    { x, y, w: leftW, h: topH },
    { x: x + leftW, y, w: w - leftW, h: topH },
    { x, y: y + topH, w: leftW, h: h - topH },
    { x: x + leftW, y: y + topH, w: w - leftW, h: h - topH },
  ];
}

/**
 * Deterministic greedy quadtree refinement plan for one side's region.
 *
 * Contract (see docs/DESIGN.md §Engine):
 * - Root leaf = region, colored with the palette index nearest to the region's mean RGB.
 * - Repeatedly split the leaf with the largest squared color error (sum over its pixels of
 *   squared RGB distance to the leaf's displayed palette color). Ties break by smaller y, then
 *   smaller x, then larger area. Leaves with zero error or area 1 are never split.
 * - Split rule: halve width (floor/ceil) and height (floor/ceil) → 4 children; if w = 1 or
 *   h = 1 split only the other axis → 2 children. Children ordered row-major (top-left first).
 * - Each child's color = palette index nearest to the child's mean RGB (ties → lower index).
 * - Stops when every leaf has zero error. Applying all steps reproduces the region exactly.
 * - preRevealCount = ceil(steps.length × PRE_REVEAL_RATIO), capped below steps.length so
 *   even a one-split picture keeps a final detail layer. Zero when there are no steps.
 *
 * Cost: O(area) prefix sums + O(steps · log leaves) heap work; a split adds ≥ 1 leaf, so
 * steps ≤ area − 1 (≤ 1295 for a 48×27 side). Throws RangeError on an invalid artwork/region.
 */
export function buildRefinementPlan(input: PlanInput): RefinementPlan {
  assertInput(input);
  const region: Rect = {
    x: input.region.x,
    y: input.region.y,
    w: input.region.w,
    h: input.region.h,
  };
  const sums = buildSums(input.artwork, region);
  // Separate rect object so plan.region and steps[0].parent never alias each other.
  const root = makeLeaf(sums, { ...region });
  const queue = new LeafQueue();
  // A pixel is always exactly a palette color, so area-1 leaves have zero error and are never
  // queued; only leaves with positive error can still change the picture.
  if (root.error > 0) queue.push(root);

  const steps: RefinementStep[] = [];
  for (let leaf = queue.pop(); leaf !== undefined; leaf = queue.pop()) {
    const children = splitRect(leaf.rect).map((rect) => makeLeaf(sums, rect));
    steps.push({
      parent: leaf.rect,
      children: children.map((child) => ({ rect: child.rect, color: child.color })),
    });
    for (const child of children) if (child.error > 0) queue.push(child);
  }

  return {
    side: input.side,
    region,
    rootColor: root.color,
    steps,
    preRevealCount: Math.max(
      0,
      Math.min(steps.length - 1, Math.ceil(steps.length * PRE_REVEAL_RATIO)),
    ),
  };
}

/** Number of plan steps to display for a side given its public progress (0..1) and phase. */
export function stepsToShow(
  plan: Pick<RefinementPlan, 'steps' | 'preRevealCount'>,
  progress: number,
  revealed: boolean,
): number {
  if (revealed) return plan.steps.length;
  const clamped = Math.min(1, Math.max(0, progress));
  return Math.min(plan.preRevealCount, Math.floor(plan.preRevealCount * clamped));
}
