import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseCutout, readLayout } from '../public/overlay/layout.js';

describe('overlay composition boundary', () => {
  it('ignores malformed holes and clips valid integer rectangles', () => {
    for (const raw of [
      null,
      '',
      'a,2,3,4',
      '1,2,3',
      '1.5,2,3,4',
      '1,2,-3,4',
      '1920,0,10,10',
      '0,1080,10,10',
      '9007199254740992,0,2,3',
    ])
      expect(parseCutout(raw)).toBeNull();
    expect(parseCutout('1440,700,440,340')).toEqual({ x: 1440, y: 700, w: 440, h: 340 });
    expect(parseCutout('-10,-20,100,100')).toEqual({ x: 0, y: 0, w: 90, h: 80 });
    expect(parseCutout('1900,1000,100,100')).toEqual({ x: 1900, y: 1000, w: 20, h: 80 });
  });
  it('property: every accepted rectangle stays inside the native canvas', () => {
    fc.assert(
      fc.property(
        fc.tuple(...Array.from({ length: 4 }, () => fc.integer({ min: -10000, max: 10000 }))),
        (parts) => {
          const hole = parseCutout(parts.join(','));
          if (!hole) return;
          expect(hole.x).toBeGreaterThanOrEqual(0);
          expect(hole.y).toBeGreaterThanOrEqual(0);
          expect(hole.w).toBeGreaterThan(0);
          expect(hole.h).toBeGreaterThan(0);
          expect(hole.x + hole.w).toBeLessThanOrEqual(1920);
          expect(hole.y + hole.h).toBeLessThanOrEqual(1080);
        },
      ),
      { seed: 1101, numRuns: 1000 },
    );
  });
  it('uses full layout by default and bounds seam scale, with invalid values defaulting to .62', () => {
    expect(readLayout(new URLSearchParams())).toEqual({ fit: 'full', scale: 1, cutout: null });
    for (const scale of ['', 'bad', 'Infinity', 'NaN'])
      expect(readLayout(new URLSearchParams({ fit: 'seam', scale })).scale).toBe(0.62);
    expect(readLayout(new URLSearchParams({ fit: 'seam', scale: '0.1' })).scale).toBe(0.4);
    expect(readLayout(new URLSearchParams({ fit: 'seam', scale: '2' })).scale).toBe(0.9);
    expect(readLayout(new URLSearchParams({ fit: 'other', scale: '.5' })).scale).toBe(1);
  });
});
