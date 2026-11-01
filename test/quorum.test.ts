import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeQuorum, observeChatter, pruneRecentChatters } from '../src/engine/quorum.js';

describe('pure quorum helper', () => {
  it('rounds up and preserves the minimum for quiet channels', () => {
    expect(computeQuorum(0, 3, 0.4)).toBe(3);
    expect(computeQuorum(8, 3, 0.4)).toBe(4);
    expect(computeQuorum(800, 3, 0.4)).toBe(320);
    expect(() => computeQuorum(-1, 3, 0.4)).toThrow(RangeError);
  });

  it('rejects invalid minimums and ratios', () => {
    expect(() => computeQuorum(1, 0, 0.4)).toThrow(RangeError);
    expect(() => computeQuorum(1, 2.5, 0.4)).toThrow(RangeError);
    expect(() => computeQuorum(1, 3, 0)).toThrow(RangeError);
    expect(() => computeQuorum(1, 3, 1.5)).toThrow(RangeError);
    expect(computeQuorum(10, 1, 1)).toBe(10);
  });

  it('never decreases when the recent distinct population grows', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 100 }),
        (population, growth, minimum) => {
          const before = computeQuorum(population, minimum, 0.4);
          const after = computeQuorum(population + growth, minimum, 0.4);
          expect(Number.isInteger(before)).toBe(true);
          expect(before).toBeGreaterThanOrEqual(minimum);
          expect(after).toBeGreaterThanOrEqual(before);
        },
      ),
      { seed: 20261031, numRuns: 300 },
    );
  });
});

describe('recent chatter window', () => {
  const WINDOW = 300_000;
  const NOW = 1_790_000_000_000;

  it('prunes only entries strictly older than the window and never mutates', () => {
    const recent = new Map([
      ['old', NOW - WINDOW - 1],
      ['edge', NOW - WINDOW],
      ['fresh', NOW - 1],
    ]);
    const pruned = pruneRecentChatters(recent, NOW, WINDOW);
    expect([...pruned]).toEqual([
      ['edge', NOW - WINDOW],
      ['fresh', NOW - 1],
    ]);
    expect(recent.size).toBe(3);
    // Nothing expired → the same Map instance (cheap equality for the reducer).
    expect(pruneRecentChatters(pruned, NOW, WINDOW)).toBe(pruned);
  });

  it('records a sighting by moving the chatter to the most-recent end', () => {
    const recent = new Map([
      ['a', NOW - 20],
      ['b', NOW - 10],
    ]);
    const next = observeChatter(recent, 'a', NOW, WINDOW);
    expect([...next]).toEqual([
      ['b', NOW - 10],
      ['a', NOW],
    ]);
    expect([...recent]).toEqual([
      ['a', NOW - 20],
      ['b', NOW - 10],
    ]);
    // Already recorded at (or after) `now` → unchanged instance.
    expect(observeChatter(next, 'a', NOW, WINDOW)).toBe(next);
    expect(observeChatter(next, 'a', NOW - 5, WINDOW)).toBe(next);
  });

  it('evicts expired chatters so idle observation stays bounded by the window', () => {
    const recent = new Map([
      ['gone-1', NOW - WINDOW - 5_000],
      ['gone-2', NOW - WINDOW - 1],
      ['kept', NOW - WINDOW],
    ]);
    expect([...observeChatter(recent, 'new', NOW, WINDOW).keys()]).toEqual(['kept', 'new']);
  });

  it('matches a last-seen model exactly for monotonic clocks', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            chatter: fc.integer({ min: 0, max: 15 }),
            dt: fc.integer({ min: 0, max: 90_000 }),
          }),
          { maxLength: 80 },
        ),
        (sightings) => {
          let now = NOW;
          let recent: ReadonlyMap<string, number> = new Map();
          const model = new Map<string, number>();
          for (const { chatter, dt } of sightings) {
            now += dt;
            recent = observeChatter(recent, `c${chatter}`, now, WINDOW);
            model.set(`c${chatter}`, now);
          }
          const expected = [...model].filter(([, lastSeen]) => lastSeen >= now - WINDOW);
          expect(new Map(recent)).toEqual(new Map(expected));
          // Recency order: last-seen timestamps are non-decreasing front to back.
          const times = [...recent.values()];
          expect(times).toEqual([...times].sort((a, b) => a - b));
          expect(pruneRecentChatters(recent, now, WINDOW)).toBe(recent);
        },
      ),
      { seed: 300, numRuns: 300 },
    );
  });
});
