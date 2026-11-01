import { presetArtwork } from '../public/control/artwork.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRID_ROWS, parseArtwork } from '../src/engine/artwork.js';
import type { Side, StuntMode, StuntPhase } from '../src/engine/types.js';
import {
  RoundConflictError,
  createStuntRuntime,
  type StuntRuntime,
} from '../src/server/runtime.js';
import { createShowcaseRunner, type ShowcaseRunner } from '../src/server/showcaseRunner.js';
import {
  DEFAULT_CROSSOVER_PRESET,
  SHOWCASE_SCENARIOS,
  buildShowcase,
  showcaseArtwork,
  showcaseChatEvent,
  type ShowcaseScript,
} from '../src/sim/showcase.js';

const START_MS = 1_800_000_000_000;

function people(script: ShowcaseScript, side: Side): Set<string> {
  return new Set(
    script.arrivals.filter((arrival) => arrival.side === side).map((arrival) => arrival.chatterId),
  );
}

describe('showcase schedules (pure)', () => {
  it.each(['crossover', 'single'] as const satisfies readonly StuntMode[])(
    'shares the control preset generator for %s mode',
    (mode) => {
      const artwork = showcaseArtwork(mode);
      expect(parseArtwork(artwork, mode)).not.toBeNull();
      expect(artwork).toEqual(
        presetArtwork(mode === 'single' ? 'gg' : DEFAULT_CROSSOVER_PRESET, mode, {
          A: 'A',
          B: 'B',
        }),
      );
      expect(artwork.rows).toBe(GRID_ROWS);
    },
  );

  it.each([
    ['crossover', 'hype', 'crossover'],
    ['so-close', 'gg', 'crossover'],
    ['single', 'gg', 'single'],
  ] as const)('%s showcases the requested %s preset', (scenario, preset, mode) => {
    const art = buildShowcase(scenario).call.artwork;
    expect(art).toEqual(presetArtwork(preset, mode, { A: 'A', B: 'B' }));
    expect(Object.isFrozen(art)).toBe(true);
    expect(Object.isFrozen(art.pixels)).toBe(true);
  });

  it('uses HYPE for the default crossover artwork', () => {
    expect(DEFAULT_CROSSOVER_PRESET).toBe('hype');
  });

  it('crossover: A finishes first, B lags from 6 s and finishes in a burst, 2 crossovers', () => {
    const script = buildShowcase('crossover');
    expect(script.call).toMatchObject({
      mode: 'crossover',
      durationMs: 30_000,
      quorumOverride: { A: 12, B: 12 },
    });
    const a = script.arrivals.filter((arrival) => arrival.side === 'A');
    const b = script.arrivals.filter((arrival) => arrival.side === 'B');
    expect(a).toHaveLength(12);
    expect(b).toHaveLength(12);
    expect(a[1]!.atMs - a[0]!.atMs).toBe(900);
    expect(b[0]!.atMs).toBe(6_000);
    expect(b[1]!.atMs - b[0]!.atMs).toBe(1_300);
    expect(b.at(-1)!.atMs - b.at(-3)!.atMs).toBeLessThan(500);
    // WAITING FOR is visible: A is ready several seconds before B.
    expect(b.at(-1)!.atMs - a.at(-1)!.atMs).toBeGreaterThan(5_000);
    expect(script.arrivals.every((arrival) => arrival.atMs < script.call.durationMs)).toBe(true);
    const shared = [...people(script, 'A')].filter((id) => people(script, 'B').has(id));
    expect(shared).toHaveLength(2);
  });

  it('so-close stalls B at 9/12 and single uses 10 people on A only', () => {
    const soClose = buildShowcase('so-close');
    expect(people(soClose, 'A').size).toBe(12);
    expect(people(soClose, 'B').size).toBe(9);
    const single = buildShowcase('single');
    expect(single.call).toMatchObject({ mode: 'single', quorumOverride: { A: 10 } });
    expect(single.arrivals.every((arrival) => arrival.side === 'A')).toBe(true);
    expect(people(single, 'A').size).toBe(10);
  });

  it('is deterministic, sorted, SIMULATED and leaves room for the result before the next slot', () => {
    for (const scenario of SHOWCASE_SCENARIOS) {
      const script = buildShowcase(scenario);
      expect(buildShowcase(scenario)).toEqual(script);
      const times = script.arrivals.map((arrival) => arrival.atMs);
      expect(times).toEqual([...times].sort((x, y) => x - y));
      expect(script.arrivals.every((arrival) => arrival.chatterId.startsWith('sim:'))).toBe(true);
      // Reveal lead (1.5 s) + animation (6 s) after the last arrival, or the deadline.
      const end = Math.min(script.call.durationMs, times.at(-1)! + 7_500);
      expect(script.slotMs).toBeGreaterThan(end);
      const event = showcaseChatEvent(script.arrivals[0]!, 5);
      expect(event).toMatchObject({ simulated: true, receivedAtMs: 5 });
      expect(event.originBroadcasterId.startsWith('sim:')).toBe(true);
    }
  });
});

describe('showcase runner (server timers)', () => {
  let runtime: StuntRuntime;
  let runner: ShowcaseRunner;
  let transitions: [StuntPhase, StuntPhase][];

  beforeEach(() => {
    vi.useFakeTimers({ now: START_MS });
    transitions = [];
    runtime = createStuntRuntime({
      now: () => Date.now(),
      simulated: true,
      labels: { A: 'LEFT STAND', B: 'RIGHT STAND' },
      onTransition: (from, to) => transitions.push([from, to]),
    });
    runner = createShowcaseRunner({ runtime, now: () => Date.now() });
  });
  afterEach(() => {
    runner.dispose();
    runtime.dispose();
    vi.useRealTimers();
  });

  it('crossover shows WAITING (A ready, B not) and ends in a joint reveal', () => {
    runner.play('crossover');
    vi.advanceTimersByTime(12_000);
    expect(runtime.snapshot()).toMatchObject({
      phase: 'active',
      simulated: true,
      sides: { A: { ready: true }, B: { ready: false } },
    });
    vi.advanceTimersByTime(18_400 - 12_000);
    expect(runtime.snapshot()).toMatchObject({
      phase: 'revealing',
      crossovers: 2,
      sides: { A: { participants: 12 }, B: { participants: 12 } },
    });
    vi.advanceTimersByTime(8_000);
    expect(runtime.phase()).toBe('complete');
  });

  it('so-close times out with B at 9/12; single completes on its own', () => {
    runner.play('so-close');
    vi.advanceTimersByTime(20_250);
    expect(runtime.snapshot()).toMatchObject({
      phase: 'timed-out',
      sides: { A: { participants: 12, quorum: 12 }, B: { participants: 9, quorum: 12 } },
    });
    runner.play('single');
    vi.advanceTimersByTime(16_000);
    expect(runtime.snapshot()).toMatchObject({
      mode: 'single',
      phase: 'complete',
      sides: { A: { participants: 10, quorum: 10 } },
    });
  });

  it('autoplay loops crossover → so-close → single', () => {
    const modes: string[] = [];
    runtime.subscribe((update) => {
      if (update.type === 'round' && update.round !== null) modes.push(update.round.mode);
    });
    runner.startAutoplay();
    const loopMs = SHOWCASE_SCENARIOS.reduce((sum, name) => sum + buildShowcase(name).slotMs, 0);
    vi.advanceTimersByTime(loopMs + 1_000);
    expect(modes).toEqual(['crossover', 'crossover', 'single', 'crossover']);
    expect(transitions.filter(([, to]) => to === 'timed-out')).toHaveLength(1);
    expect(transitions.filter(([, to]) => to === 'complete')).toHaveLength(2);
    runner.stopAutoplay();
    expect(runner.isAutoplaying()).toBe(false);
  });

  it('never overrides an operator round, and an operator RESET stops the script', () => {
    runtime.call({ artwork: showcaseArtwork('single'), mode: 'single' });
    expect(() => runner.play('crossover')).toThrow(RoundConflictError);
    runtime.reset();

    runner.play('crossover');
    vi.advanceTimersByTime(2_000);
    runtime.reset();
    vi.advanceTimersByTime(30_000);
    expect(runtime.snapshot()).toMatchObject({ phase: 'idle', sides: { A: { participants: 0 } } });
    expect(vi.getTimerCount()).toBe(0);
    // Scripted overrides never become the operator's remembered config.
    expect(runtime.config().quorumOverride).toEqual({});
  });

  it('replaying a showcase while its own round runs restarts it cleanly', () => {
    const first = runner.play('crossover');
    vi.advanceTimersByTime(5_000);
    const second = runner.play('single');
    expect(second.roundId).not.toBe(first.roundId);
    vi.advanceTimersByTime(16_000);
    expect(runtime.snapshot()).toMatchObject({ mode: 'single', phase: 'complete' });
  });

  it.each([
    ['single', 9_000, 'revealing'],
    ['so-close', 17_000, 'active'],
  ] as const)(
    'replaces its own %s round after the script delivered everyone (%i ms, %s)',
    (scenario, atMs, phase) => {
      const first = runner.play(scenario);
      vi.advanceTimersByTime(atMs);
      const last = buildShowcase(scenario).arrivals.at(-1);
      expect(last === undefined || last.atMs <= atMs).toBe(true);
      expect(runtime.snapshot().phase).toBe(phase);
      const second = runner.play('crossover');
      expect(second.roundId).not.toBe(first.roundId);
      vi.advanceTimersByTime(30_000);
      expect(runtime.snapshot()).toMatchObject({ mode: 'crossover', phase: 'complete' });
      // A later operator round is still protected from showcase buttons.
      runtime.reset();
      runtime.call({ artwork: showcaseArtwork('single'), mode: 'single' });
      expect(() => runner.play('single')).toThrow(RoundConflictError);
    },
  );
});
