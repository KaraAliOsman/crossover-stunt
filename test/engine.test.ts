import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { requiredSides } from '../src/engine/artwork.js';
import {
  DEFAULT_CONFIG,
  createInitialState,
  resolveConfig,
  step,
  toSnapshot,
} from '../src/engine/engine.js';
import type {
  EngineEvent,
  Side,
  StuntConfig,
  StuntMode,
  StuntPhase,
  StuntState,
} from '../src/engine/types.js';

const T0 = 1_790_000_000_000;
const DURATION = DEFAULT_CONFIG.durationMs;
const LEAD = DEFAULT_CONFIG.revealLeadMs;
const REVEAL = DEFAULT_CONFIG.revealDurationMs;
const WINDOW = DEFAULT_CONFIG.recentWindowMs;

interface Timed {
  readonly event: EngineEvent;
  readonly now: number;
}

function chat(side: Side, chatterId: string, messageKey: string): EngineEvent {
  return {
    type: 'CHAT',
    chat: {
      messageKey,
      chatterId,
      originBroadcasterId: side === 'A' ? 'broadcaster-a' : 'broadcaster-b',
      side,
      receivedAtMs: 0,
      simulated: true,
    },
  };
}

function call(config?: Partial<StuntConfig>, roundId = 'round-1'): EngineEvent {
  return config === undefined ? { type: 'CALL', roundId } : { type: 'CALL', roundId, config };
}

const TICK: EngineEvent = { type: 'TICK' };
const RESET: EngineEvent = { type: 'RESET' };

function run(state: StuntState, timeline: readonly Timed[]): StuntState {
  return timeline.reduce((current, { event, now }) => step(current, event, now), state);
}

/** Fresh state with an active round started at T0. */
function started(config?: Partial<StuntConfig>, initial = createInitialState()): StuntState {
  return step(initial, call(config), T0);
}

/** Distinct new chatters `prefix-0..count-1` on `side`, 10 ms apart starting at `from`. */
function crowd(side: Side, count: number, from: number, prefix = side): Timed[] {
  return Array.from({ length: count }, (_, index) => ({
    event: chat(side, `${prefix}-${index}`, `${prefix}-${side}-msg-${index}`),
    now: from + index * 10,
  }));
}

function participants(state: StuntState, side: Side): number {
  return state.sides[side].participantIds.size;
}

describe('engine config', () => {
  it('validates the merged config and keeps absent fields', () => {
    const merged = resolveConfig(DEFAULT_CONFIG, { durationMs: 30_000, mode: 'single' });
    expect(merged).toEqual({ ...DEFAULT_CONFIG, durationMs: 30_000, mode: 'single' });
    expect(resolveConfig(DEFAULT_CONFIG, { durationMs: 10_000 }).durationMs).toBe(10_000);
    expect(resolveConfig(DEFAULT_CONFIG, { durationMs: 180_000 }).durationMs).toBe(180_000);
    expect(resolveConfig(DEFAULT_CONFIG, { quorumRatio: 1 }).quorumRatio).toBe(1);
    expect(
      resolveConfig(DEFAULT_CONFIG, { quorumOverride: { A: 1, B: 1_000 } }).quorumOverride,
    ).toEqual({ A: 1, B: 1_000 });
  });

  it.each<[string, Partial<StuntConfig>]>([
    ['duration below 10 s', { durationMs: 9_999 }],
    ['duration above 180 s', { durationMs: 180_001 }],
    ['fractional duration', { durationMs: 30_000.5 }],
    ['zero minimum quorum', { minQuorum: 0 }],
    ['minimum quorum above 1000', { minQuorum: 1_001 }],
    ['fractional minimum quorum', { minQuorum: 2.5 }],
    ['zero ratio', { quorumRatio: 0 }],
    ['ratio above 1', { quorumRatio: 1.01 }],
    ['NaN ratio', { quorumRatio: Number.NaN }],
    ['override below 1', { quorumOverride: { A: 0 } }],
    ['override above 1000', { quorumOverride: { B: 1_001 } }],
    ['fractional override', { quorumOverride: { A: 1.5 } }],
    ['unknown mode', { mode: 'duo' as StuntMode }],
    ['negative reveal lead', { revealLeadMs: -1 }],
  ])('rejects %s with RangeError on CALL', (_label, config) => {
    const idle = createInitialState();
    expect(() => step(idle, call(config), T0)).toThrow(RangeError);
  });

  it('treats a null per-side override as absent (CallRequest clears a side with null)', () => {
    const patch = { quorumOverride: { A: null, B: 4 } } as unknown as Partial<StuntConfig>;
    expect(resolveConfig(DEFAULT_CONFIG, patch).quorumOverride).toEqual({ B: 4 });
  });

  it('rejects an empty round id, a non-finite clock and an invalid initial config', () => {
    expect(() => step(createInitialState(), call(undefined, ''), T0)).toThrow(RangeError);
    expect(() => step(createInitialState(), TICK, Number.NaN)).toThrow(RangeError);
    expect(() => createInitialState({ ...DEFAULT_CONFIG, minQuorum: 0 })).toThrow(RangeError);
  });
});

describe('engine CALL and adaptive quorum', () => {
  it('starts an active round with server-owned timing', () => {
    const state = started({ durationMs: 30_000 });
    expect(state.phase).toBe('active');
    expect(state.roundId).toBe('round-1');
    expect(state.startedAtMs).toBe(T0);
    expect(state.deadlineAtMs).toBe(T0 + 30_000);
    expect(state.revealAtMs).toBeNull();
    expect(state.config.durationMs).toBe(30_000);
    expect(state.sides.A.quorum).toBe(DEFAULT_CONFIG.minQuorum);
    expect(state.sides.B.quorum).toBe(DEFAULT_CONFIG.minQuorum);
  });

  it('freezes each side quorum from its own distinct recent chatters', () => {
    const before = run(createInitialState(), [
      ...crowd('A', 8, T0 - 60_000),
      // Spam from one B chatter is still one distinct recent person.
      ...Array.from({ length: 20 }, (_, index) => ({
        event: chat('B', 'b-regular', `b-spam-${index}`),
        now: T0 - 30_000 + index,
      })),
    ]);
    const state = step(before, call(), T0);
    expect(state.sides.A.quorum).toBe(4); // max(3, ceil(8 × 0.4))
    expect(state.sides.B.quorum).toBe(3); // max(3, ceil(1 × 0.4))
  });

  it('lets a manual override win over the adaptive quorum', () => {
    const before = run(createInitialState(), crowd('A', 50, T0 - 1_000));
    const state = step(before, call({ quorumOverride: { A: 7 } }), T0);
    expect(state.sides.A.quorum).toBe(7);
    expect(state.sides.B.quorum).toBe(3);
  });

  it('prunes recent chatters older than the window at CALL (boundary inclusive)', () => {
    const before = run(createInitialState(), [
      { event: chat('A', 'too-old', 'k1'), now: T0 - WINDOW - 1 },
      { event: chat('A', 'just-in', 'k2'), now: T0 - WINDOW },
    ]);
    const state = step(before, call({ minQuorum: 1, quorumRatio: 1 }), T0);
    expect([...state.sides.A.recentChatters.keys()]).toEqual(['just-in']);
    expect(state.sides.A.quorum).toBe(1);
  });

  it('quorum freeze: people chatting after CALL never move the frozen target', () => {
    const state = run(started({ minQuorum: 1, quorumRatio: 1, quorumOverride: { B: 500 } }), [
      ...crowd('A', 30, T0 + 100),
      ...crowd('B', 30, T0 + 1_000),
    ]);
    expect(state.sides.A.quorum).toBe(1);
    expect(state.sides.B.quorum).toBe(500);
    expect(state.sides.B.recentChatters.size).toBe(30);
    // The next round, however, does use them as its baseline.
    const next = step(step(state, RESET, T0 + 50_000), call({ quorumOverride: {} }), T0 + 50_000);
    expect(next.sides.B.quorum).toBe(30);
  });

  it('is ignored while a round is active or revealing', () => {
    const active = started({ quorumOverride: { A: 1, B: 1 } });
    expect(step(active, call({ durationMs: 60_000 }, 'other'), T0 + 1)).toBe(active);
    const revealing = run(active, [
      { event: chat('A', 'x', 'k1'), now: T0 + 10 },
      { event: chat('B', 'y', 'k2'), now: T0 + 20 },
    ]);
    expect(revealing.phase).toBe('revealing');
    expect(step(revealing, call(undefined, 'other'), T0 + 30)).toBe(revealing);
  });

  it('starts a fresh round from complete or timed-out, clearing participants and keys', () => {
    const timedOut = run(started(), [
      { event: chat('A', 'x', 'k1'), now: T0 + 10 },
      { event: TICK, now: T0 + DURATION },
    ]);
    expect(timedOut.phase).toBe('timed-out');
    const next = step(timedOut, call({ mode: 'single' }, 'round-2'), T0 + DURATION + 5);
    expect(next.phase).toBe('active');
    expect(next.roundId).toBe('round-2');
    expect(next.config.mode).toBe('single');
    expect(participants(next, 'A')).toBe(0);
    expect(next.seenMessageKeys.size).toBe(0);
    // The same message key may legitimately appear again in a new round.
    const credited = step(next, chat('A', 'x', 'k1'), T0 + DURATION + 10);
    expect(participants(credited, 'A')).toBe(1);
  });
});

describe('engine CHAT credit', () => {
  it('repeated chatter: one person earns one credit per side no matter how often they type', () => {
    const state = run(
      started(),
      Array.from({ length: 50 }, (_, index) => ({
        event: chat('A', 'loud', `loud-${index}`),
        now: T0 + index,
      })),
    );
    expect(participants(state, 'A')).toBe(1);
    expect(state.seenMessageKeys.size).toBe(50);
  });

  it('duplicate delivery is a complete no-op (same object)', () => {
    const once = step(started(), chat('A', 'x', 'dup'), T0 + 5);
    expect(step(once, chat('A', 'x', 'dup'), T0 + 5)).toBe(once);
    expect(step(once, chat('A', 'x', 'dup'), T0 + 900)).toBe(once);
    // A Shared Chat copy carries the same messageKey and therefore never credits twice.
    expect(step(once, chat('A', 'someone-else', 'dup'), T0 + 950)).toBe(once);
  });

  it('crossover credits sides independently and counts one crossover per shared person', () => {
    const state = run(started(), [
      { event: chat('A', 'both', 'k1'), now: T0 + 1 },
      { event: chat('B', 'both', 'k2'), now: T0 + 2 },
      { event: chat('B', 'only-b', 'k3'), now: T0 + 3 },
    ]);
    expect(participants(state, 'A')).toBe(1);
    expect(participants(state, 'B')).toBe(2);
    expect(toSnapshot(state, T0 + 3, 1, false).crossovers).toBe(1);
  });

  it('deadline boundary: credit at deadline − 1 ms, none at the deadline even without TICK', () => {
    const base = started({ quorumOverride: { A: 10, B: 10 } });
    const deadline = T0 + DURATION;
    const before = step(base, chat('A', 'early', 'k1'), deadline - 1);
    expect(participants(before, 'A')).toBe(1);
    expect(before.phase).toBe('active');

    const at = step(before, chat('A', 'late', 'k2'), deadline);
    expect(participants(at, 'A')).toBe(1);
    expect(at.phase).toBe('timed-out');
    expect(at.sides.A.recentChatters.get('late')).toBe(deadline);
  });

  it('a success latched before the deadline survives the deadline and completes on time', () => {
    const base = started({ quorumOverride: { A: 1, B: 1 } });
    const deadline = T0 + DURATION;
    const revealing = run(base, [
      { event: chat('A', 'a', 'k1'), now: deadline - 2 },
      { event: chat('B', 'b', 'k2'), now: deadline - 1 },
    ]);
    expect(revealing.phase).toBe('revealing');
    expect(revealing.revealAtMs).toBe(deadline - 1 + LEAD);

    const atDeadline = step(revealing, TICK, deadline);
    expect(atDeadline).toBe(revealing);
    const end = deadline - 1 + LEAD + REVEAL;
    expect(step(revealing, TICK, end - 1)).toBe(revealing);
    const complete = step(revealing, TICK, end);
    expect(complete.phase).toBe('complete');
    expect(complete.revealAtMs).toBe(revealing.revealAtMs);
    expect(step(complete, TICK, end + 60_000)).toBe(complete);
  });

  it('crossover gating: a ready side waits for the other; both ready → joint reveal', () => {
    const base = started({ quorumOverride: { A: 3, B: 2 } });
    const aReady = run(base, crowd('A', 5, T0 + 100));
    expect(aReady.phase).toBe('active');
    const waiting = toSnapshot(aReady, T0 + 200, 7, false);
    expect(waiting.sides.A).toEqual({ participants: 5, quorum: 3, progress: 1, ready: true });
    expect(waiting.sides.B).toEqual({ participants: 0, quorum: 2, progress: 0, ready: false });

    const oneB = step(aReady, chat('B', 'b-0', 'b0'), T0 + 300);
    expect(oneB.phase).toBe('active');
    const joint = step(oneB, chat('B', 'b-1', 'b1'), T0 + 400);
    expect(joint.phase).toBe('revealing');
    expect(joint.revealAtMs).toBe(T0 + 400 + LEAD);
    // After success no more credit is given: the reveal picture is latched.
    const after = step(joint, chat('B', 'b-2', 'b2'), T0 + 500);
    expect(participants(after, 'B')).toBe(2);
  });

  it('single mode: only side A credits and gates; side B reports zeros', () => {
    const base = started({ mode: 'single', quorumOverride: { A: 2, B: 1 } });
    const bOnly = run(base, crowd('B', 10, T0 + 10));
    expect(bOnly.phase).toBe('active');
    expect(participants(bOnly, 'B')).toBe(0);
    expect(bOnly.sides.B.recentChatters.size).toBe(10);

    const revealed = run(bOnly, crowd('A', 2, T0 + 500, 'B'));
    expect(revealed.phase).toBe('revealing');
    const snapshot = toSnapshot(revealed, T0 + 600, 3, true);
    expect(snapshot.mode).toBe('single');
    expect(snapshot.sides.A).toEqual({ participants: 2, quorum: 2, progress: 1, ready: true });
    expect(snapshot.sides.B).toEqual({ participants: 0, quorum: 0, progress: 0, ready: false });
    // The same people typed on B too, but single mode never reports crossovers.
    expect(snapshot.crossovers).toBe(0);
  });

  it('chat outside a round only refreshes recency', () => {
    const idle = createInitialState();
    const state = run(idle, [
      { event: chat('A', 'x', 'k1'), now: T0 },
      { event: chat('A', 'x', 'k2'), now: T0 + 50 },
    ]);
    expect(state.phase).toBe('idle');
    expect(participants(state, 'A')).toBe(0);
    expect(state.seenMessageKeys.size).toBe(0);
    expect(state.sides.A.recentChatters.get('x')).toBe(T0 + 50);
    expect(step(state, chat('A', 'x', 'k3'), T0 + 50)).toBe(state);
  });
});

describe('engine TICK and RESET', () => {
  it('timeout: TICK expires a quiet round at the deadline', () => {
    const base = started();
    const deadline = T0 + DURATION;
    expect(step(base, TICK, deadline - 1)).toBe(base);
    const timedOut = step(base, TICK, deadline);
    expect(timedOut.phase).toBe('timed-out');
    expect(timedOut.revealAtMs).toBeNull();
    expect(step(timedOut, TICK, deadline + 10_000)).toBe(timedOut);
    // Late chat keeps feeding the recent baseline but never credits.
    const late = step(timedOut, chat('A', 'late', 'k1'), deadline + 20);
    expect(late.phase).toBe('timed-out');
    expect(participants(late, 'A')).toBe(0);
    expect(late.sides.A.recentChatters.has('late')).toBe(true);
  });

  it('RESET keeps recent chatters and config but clears every round field', () => {
    const before = run(createInitialState(), crowd('B', 12, T0 - 10_000));
    const round = run(step(before, call({ durationMs: 20_000, minQuorum: 2 }), T0), [
      ...crowd('A', 2, T0 + 10),
    ]);
    const reset = step(round, RESET, T0 + 1_000);
    expect(reset.phase).toBe('idle');
    expect(reset.roundId).toBeNull();
    expect(reset.startedAtMs).toBeNull();
    expect(reset.deadlineAtMs).toBeNull();
    expect(reset.revealAtMs).toBeNull();
    expect(reset.seenMessageKeys.size).toBe(0);
    expect(participants(reset, 'A')).toBe(0);
    expect(reset.config).toBe(round.config);
    expect(reset.sides.B.recentChatters).toBe(round.sides.B.recentChatters);
    expect(reset.sides.A.recentChatters.size).toBe(2);
    expect(step(reset, RESET, T0 + 2_000)).toBe(reset);
    // The retained baseline feeds the next CALL: max(2, ceil(12 × 0.4)) = 5.
    expect(step(reset, call(), T0 + 3_000).sides.B.quorum).toBe(5);
  });
});

describe('engine snapshot projection', () => {
  it('projects only whitelisted aggregates', () => {
    const state = run(started({ quorumOverride: { A: 4, B: 8 } }), [
      { event: chat('A', 'secret-user-1', 'secret-key-1'), now: T0 + 1 },
      { event: chat('B', 'secret-user-1', 'secret-key-2'), now: T0 + 2 },
      { event: chat('B', 'secret-user-2', 'secret-key-3'), now: T0 + 3 },
    ]);
    const snapshot = toSnapshot(state, T0 + 4, 42, true);
    expect(snapshot).toEqual({
      revision: 42,
      mode: 'crossover',
      phase: 'active',
      roundId: 'round-1',
      serverNowMs: T0 + 4,
      startedAtMs: T0,
      deadlineAtMs: T0 + DURATION,
      revealAtMs: null,
      revealDurationMs: REVEAL,
      simulated: true,
      crossovers: 1,
      sides: {
        A: { participants: 1, quorum: 4, progress: 0.25, ready: false },
        B: { participants: 2, quorum: 8, progress: 0.25, ready: false },
      },
    });
    const json = JSON.stringify(snapshot);
    expect(json).not.toMatch(/secret|broadcaster/);
  });

  it('idle snapshot shows zero progress and the default quorum', () => {
    const snapshot = toSnapshot(createInitialState(), T0, 0, false);
    expect(snapshot.phase).toBe('idle');
    expect(snapshot.roundId).toBeNull();
    expect(snapshot.sides.A).toEqual({ participants: 0, quorum: 3, progress: 0, ready: false });
    expect(snapshot.crossovers).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Properties over random event scripts.

type Op =
  | { readonly kind: 'chat'; readonly side: Side; readonly chatter: number; readonly dt: number }
  | { readonly kind: 'redeliver'; readonly pick: number; readonly dt: number }
  | { readonly kind: 'tick'; readonly dt: number }
  | {
      readonly kind: 'call';
      readonly dt: number;
      readonly mode: StuntMode;
      readonly quorumA: number | null;
      readonly quorumB: number | null;
    }
  | { readonly kind: 'reset'; readonly dt: number };

const sideArb = fc.constantFrom<Side>('A', 'B');
const dtArb = fc.integer({ min: 0, max: 2_500 });
const quorumArb = fc.option(fc.integer({ min: 1, max: 5 }), { nil: null });

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 14,
    arbitrary: fc.record({
      kind: fc.constant('chat' as const),
      side: sideArb,
      chatter: fc.integer({ min: 0, max: 9 }),
      dt: dtArb,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('redeliver' as const),
      pick: fc.nat(),
      dt: dtArb,
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('tick' as const), dt: dtArb }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('call' as const),
      dt: dtArb,
      mode: fc.constantFrom<StuntMode>('crossover', 'single'),
      quorumA: quorumArb,
      quorumB: quorumArb,
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('reset' as const), dt: dtArb }) },
);

const scriptArb = fc.array(opArb, { maxLength: 60 });

/** Converts ops into a timeline with monotonic time and unique keys (except redeliveries). */
function toTimeline(ops: readonly Op[]): Timed[] {
  const timeline: Timed[] = [];
  const chats: EngineEvent[] = [];
  let now = T0;
  let rounds = 0;
  ops.forEach((op, index) => {
    now += op.dt;
    let event: EngineEvent;
    switch (op.kind) {
      case 'chat':
        event = chat(op.side, `viewer-${op.chatter}`, `msg-${index}`);
        chats.push(event);
        break;
      case 'redeliver':
        event = chats.length > 0 ? chats[op.pick % chats.length]! : TICK;
        break;
      case 'tick':
        event = TICK;
        break;
      case 'call': {
        rounds += 1;
        const quorumOverride: Partial<Record<Side, number>> = {};
        if (op.quorumA !== null) quorumOverride.A = op.quorumA;
        if (op.quorumB !== null) quorumOverride.B = op.quorumB;
        event = call({ mode: op.mode, durationMs: 10_000, quorumOverride }, `round-${rounds}`);
        break;
      }
      case 'reset':
        event = RESET;
        break;
    }
    timeline.push({ event, now });
  });
  return timeline;
}

const ALLOWED: Readonly<Record<StuntPhase, readonly StuntPhase[]>> = {
  idle: ['idle', 'active'],
  active: ['active', 'revealing', 'timed-out', 'idle'],
  revealing: ['revealing', 'complete', 'idle'],
  complete: ['complete', 'active', 'idle'],
  'timed-out': ['timed-out', 'active', 'idle'],
};

function checkTransition(prev: StuntState, { event, now }: Timed, next: StuntState): void {
  expect(ALLOWED[prev.phase]).toContain(next.phase);
  const { mode } = next.config;
  if (mode === 'single') expect(next.sides.B.participantIds.size).toBe(0);

  if (event.type === 'CHAT' || event.type === 'TICK') {
    expect(next.config).toBe(prev.config);
    for (const side of ['A', 'B'] as const) {
      expect(next.sides[side].quorum).toBe(prev.sides[side].quorum);
      // Credit is monotonic within a round and only for people who typed on that side.
      for (const id of prev.sides[side].participantIds) {
        expect(next.sides[side].participantIds.has(id)).toBe(true);
      }
      const gained = next.sides[side].participantIds.size - prev.sides[side].participantIds.size;
      expect(gained).toBeGreaterThanOrEqual(0);
      expect(gained).toBeLessThanOrEqual(event.type === 'CHAT' && event.chat.side === side ? 1 : 0);
    }
  }
  if (next.phase === 'revealing' && prev.phase !== 'revealing') {
    expect(event.type).toBe('CHAT');
    expect(now).toBeLessThan(next.deadlineAtMs!);
    expect(next.revealAtMs).toBe(now + next.config.revealLeadMs);
    for (const side of requiredSides(mode)) {
      expect(next.sides[side].participantIds.size).toBeGreaterThanOrEqual(next.sides[side].quorum);
    }
  }
  if (next.phase === 'timed-out' && prev.phase === 'active') {
    expect(now).toBeGreaterThanOrEqual(prev.deadlineAtMs!);
  }

  const snapshot = toSnapshot(next, now, 0, true);
  for (const side of ['A', 'B'] as const) {
    const projected = snapshot.sides[side];
    expect(projected.progress).toBeGreaterThanOrEqual(0);
    expect(projected.progress).toBeLessThanOrEqual(1);
    expect(projected.ready).toBe(
      projected.quorum > 0 && projected.participants >= projected.quorum,
    );
  }
  expect(snapshot.crossovers).toBeLessThanOrEqual(
    Math.min(snapshot.sides.A.participants, snapshot.sides.B.participants),
  );
  expect(JSON.stringify(snapshot)).not.toMatch(/viewer-|msg-|broadcaster/);
}

describe('engine properties', () => {
  it('deterministic replay, no input mutation and valid transitions for any script', () => {
    fc.assert(
      fc.property(scriptArb, (ops) => {
        const timeline = toTimeline(ops);
        let state = createInitialState();
        for (const timed of timeline) {
          const frozen = structuredClone(state);
          const next = step(state, timed.event, timed.now);
          expect(state).toEqual(frozen); // the previous state (incl. Sets/Maps) is untouched
          checkTransition(state, timed, next);
          state = next;
        }
        const replayed = run(createInitialState(), timeline);
        expect(replayed).toEqual(state);
        const end = timeline.at(-1)?.now ?? T0;
        expect(toSnapshot(replayed, end, 9, false)).toEqual(toSnapshot(state, end, 9, false));
      }),
      { seed: 20261031, numRuns: 250 },
    );
  });

  it('duplicate delivery is idempotent from any reachable state', () => {
    fc.assert(
      fc.property(
        scriptArb,
        sideArb,
        fc.integer({ min: 0, max: 9 }),
        dtArb,
        (ops, side, chatter, dt) => {
          const timeline = toTimeline(ops);
          const state = run(createInitialState(), timeline);
          const now = (timeline.at(-1)?.now ?? T0) + dt;
          const event = chat(side, `viewer-${chatter}`, 'redelivered-key');
          const once = step(state, event, now);
          expect(step(once, event, now)).toBe(once);
          const later = step(once, event, now + 1);
          expect(toSnapshot(later, now, 0, false).sides).toEqual(
            toSnapshot(once, now, 0, false).sides,
          );
        },
      ),
      { seed: 7, numRuns: 200 },
    );
  });

  it('spam invariance: repeated messages from credited people never change the outcome', () => {
    const chatArb = fc.record({
      side: sideArb,
      chatter: fc.integer({ min: 0, max: 7 }),
      dt: fc.integer({ min: 0, max: 1_500 }),
    });
    fc.assert(
      fc.property(
        fc.constantFrom<StuntMode>('crossover', 'single'),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        fc.array(chatArb, { maxLength: 40 }),
        (mode, quorumA, quorumB, chats) => {
          const base = started({
            mode,
            durationMs: 10_000,
            quorumOverride: { A: quorumA, B: quorumB },
          });
          let now = T0;
          const all: Timed[] = chats.map((entry, index) => {
            now += entry.dt;
            return {
              event: chat(entry.side, `viewer-${entry.chatter}`, `spam-${index}`),
              now,
            };
          });
          const seen = new Set<string>();
          const firstOnly = all.filter(({ event }) => {
            if (event.type !== 'CHAT') return true;
            const person = `${event.chat.side}:${event.chat.chatterId}`;
            if (seen.has(person)) return false;
            seen.add(person);
            return true;
          });
          const end = { event: TICK, now };
          const withSpam = run(base, [...all, end]);
          const withoutSpam = run(base, [...firstOnly, end]);
          expect(toSnapshot(withSpam, now, 1, false)).toEqual(
            toSnapshot(withoutSpam, now, 1, false),
          );
        },
      ),
      { seed: 1031, numRuns: 300 },
    );
  });

  it('deadline boundary: a new person credits iff now < deadlineAtMs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10_000, max: 180_000 }),
        fc.integer({ min: -3, max: 3 }),
        sideArb,
        (durationMs, offset, side) => {
          const base = started({ durationMs, quorumOverride: { A: 2, B: 2 } });
          const now = T0 + durationMs + offset;
          const next = step(base, chat(side, 'boundary', 'k'), now);
          expect(participants(next, side)).toBe(offset < 0 ? 1 : 0);
          expect(next.phase).toBe(offset < 0 ? 'active' : 'timed-out');
        },
      ),
      { seed: 45, numRuns: 200 },
    );
  });
});
