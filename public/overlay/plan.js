// Refinement-plan replay. Plans arrive validated (see protocol.js); everything here is pure
// array work on typed arrays sized to one side's region, so it never allocates per frame.

/**
 * Number of plan steps to display for a side given its public progress (0..1) and phase.
 * Exact copy of `stepsToShow` in src/engine/quadtree.ts — keep both in sync.
 */
export function stepsToShow(plan, progress, revealed) {
  if (revealed) return plan.steps.length;
  const clamped = Math.min(1, Math.max(0, progress));
  return Math.min(plan.preRevealCount, Math.floor(plan.preRevealCount * clamped));
}

export const SEEK_NONE = 0;
export const SEEK_FORWARD = 1;
export const SEEK_REBUILT = 2;

/**
 * Per-card color map of one side after applying `applied` steps of its plan.
 *
 * Every step replaces a leaf by 2–4 children that tile it, so painting the children over the
 * parent in step order yields exactly the leaf colors after k splits. Moving forward only
 * paints the new steps; moving backward (never expected inside a round) rebuilds from the root.
 */
export class PlanReplay {
  constructor(plan) {
    this.plan = plan;
    this.region = plan.region;
    const size = plan.region.w * plan.region.h;
    /** Palette index per card, row-major inside the region. */
    this.colors = new Uint8Array(size).fill(plan.rootColor);
    /** Last step index of the latest seek whose split covered each card; -1 if untouched. */
    this.touchedBy = new Int32Array(size).fill(-1);
    this.applied = 0;
    /** First step index applied by the latest forward seek (for batch stagger offsets). */
    this.batchStart = 0;
  }

  /** Applies or rewinds to `count` steps; returns SEEK_NONE, SEEK_FORWARD or SEEK_REBUILT. */
  seek(count) {
    const steps = this.plan.steps;
    const target = Math.max(0, Math.min(steps.length, Math.floor(count)));
    if (target === this.applied) return SEEK_NONE;
    this.touchedBy.fill(-1);
    let result = SEEK_FORWARD;
    if (target < this.applied) {
      this.colors.fill(this.plan.rootColor);
      this.applied = 0;
      result = SEEK_REBUILT;
    }
    this.batchStart = this.applied;
    for (let index = this.applied; index < target; index += 1) {
      const children = steps[index].children;
      for (let c = 0; c < children.length; c += 1) {
        this.#paint(children[c].rect, children[c].color, index);
      }
    }
    this.applied = target;
    return result;
  }

  /** Color of the card at full-image coordinates (gx, gy); caller guarantees containment. */
  colorAt(gx, gy) {
    return this.colors[(gy - this.region.y) * this.region.w + (gx - this.region.x)];
  }

  #paint(rect, color, stepIndex) {
    const { x: rx, y: ry, w: rw } = this.region;
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      const row = (y - ry) * rw - rx;
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        this.colors[row + x] = color;
        this.touchedBy[row + x] = stepIndex;
      }
    }
  }
}

/** Final (fully revealed) colors of a plan's region. Computed once per round. */
export function finalColors(plan) {
  const replay = new PlanReplay(plan);
  replay.seek(plan.steps.length);
  return replay.colors;
}
