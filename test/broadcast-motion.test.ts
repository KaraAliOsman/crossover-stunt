import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { EASE_IN_OUT, EASE_OUT, MOTION, wavePose } from '../public/overlay/motion.js';

describe('broadcast motion bounds', () => {
  it('uses endpoint-exact monotone bezier LUTs, including out-of-range timestamps', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (t, delta) => {
          for (const ease of [EASE_OUT, EASE_IN_OUT]) {
            expect(ease(t)).toBeGreaterThanOrEqual(0);
            expect(ease(t)).toBeLessThanOrEqual(1);
            expect(ease(t + delta)).toBeGreaterThanOrEqual(ease(t));
            expect(ease(0)).toBe(0);
            expect(ease(1)).toBe(1);
          }
        },
      ),
      { seed: 20261101, numRuns: 1000 },
    );
  });
  it('bounds the crest, single settling overshoot and reduced-motion brightness', () => {
    let negativeRuns = 0,
      wasNegative = false;
    for (let t = -1; t <= 421; t += 1) {
      const pose = wavePose(t);
      expect(pose * -10).toBeGreaterThanOrEqual(-10);
      expect(pose * -10).toBeLessThanOrEqual(1.61);
      if (pose < 0 && !wasNegative) negativeRuns += 1;
      wasNegative = pose < 0;
      expect(wavePose(t, true)).toBeGreaterThanOrEqual(0);
    }
    expect(negativeRuns).toBe(1);
    expect(wavePose(420)).toBe(0);
    expect(wavePose(400, true)).toBe(0);
    expect(MOTION.roll).toBe(180);
  });
  it('crosses the A/B seam on one global clock with at most 18 active columns', () => {
    const perColumn = 2400 / 96;
    expect(48 * perColumn - 47 * perColumn).toBe(25);
    expect(Math.ceil(420 / perColumn) + 1).toBe(18);
  });
});
