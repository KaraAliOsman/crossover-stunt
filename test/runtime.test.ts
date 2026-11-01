import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRID_ROWS, PALETTE } from '../src/engine/artwork.js';
import type { NormalizedChatEvent, Side, Snapshot, StuntPhase } from '../src/engine/types.js';
import {
  MIN_PUSH_INTERVAL_MS,
  DEFAULT_IGNORED_LOGINS,
  RoundConflictError,
  TICK_INTERVAL_MS,
  createStuntRuntime,
  type RuntimeUpdate,
  type StuntRuntime,
} from '../src/server/runtime.js';
import { showcaseArtwork } from '../src/sim/showcase.js';
import type { CallRequest } from '../src/shared/protocol.js';

const START_MS = 1_800_000_000_000;
const runtimes: StuntRuntime[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: START_MS });
});
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  vi.useRealTimers();
});

function chat(side: Side, person: string, extra: Partial<NormalizedChatEvent> = {}) {
  return {
    messageKey: `key-${side}-${person}`,
    chatterId: person,
    originBroadcasterId: `broadcaster-${side}`,
    side,
    receivedAtMs: Date.now(),
    simulated: false,
    ...extra,
  } satisfies NormalizedChatEvent;
}

function crossoverCall(quorum: number, durationMs = 30_000): CallRequest {
  return {
    artwork: showcaseArtwork('crossover'),
    mode: 'crossover',
    durationMs,
    quorumOverride: { A: quorum, B: quorum },
  };
}

function setup(
  options: { simulated?: boolean; selfUserId?: string; ignoredChatters?: readonly string[] } = {},
) {
  const updates: RuntimeUpdate[] = [];
  const transitions: [StuntPhase, StuntPhase][] = [];
  let nextId = 0;
  const runtime = createStuntRuntime({
    now: () => Date.now(),
    simulated: options.simulated ?? false,
    labels: { A: 'Alpha', B: 'Beta' },
    onTransition: (from, to) => transitions.push([from, to]),
    selfUserId: () => options.selfUserId ?? null,
    ignoredChatters: options.ignoredChatters ?? [],
    createRoundId: () => `round-${(nextId += 1)}`,
  });
  runtime.subscribe((update) => updates.push(update));
  runtimes.push(runtime);
  const snapshots = (): Snapshot[] =>
    updates.flatMap((update) => (update.type === 'snapshot' ? [update.snapshot] : []));
  return { runtime, updates, transitions, snapshots };
}

describe('stunt runtime adapter', () => {
  it('builds one refinement plan per required side and pushes round before the snapshot', () => {
    const { runtime, updates, transitions } = setup();
    const round = runtime.call(crossoverCall(3));
    expect(round).toMatchObject({
      roundId: 'round-1',
      mode: 'crossover',
      cols: 96,
      rows: GRID_ROWS,
    });
    expect(round.palette).toEqual(PALETTE);
    expect(Object.keys(round.plans).sort()).toEqual(['A', 'B']);
    expect(round.plans.A?.region).toEqual({ x: 0, y: 0, w: 48, h: 27 });
    expect(round.plans.B?.region).toEqual({ x: 48, y: 0, w: 48, h: 27 });
    expect(updates.map((update) => update.type)).toEqual(['round', 'snapshot']);
    expect(updates[1]).toMatchObject({
      type: 'snapshot',
      snapshot: { phase: 'active', roundId: 'round-1', deadlineAtMs: START_MS + 30_000 },
    });
    expect(transitions).toEqual([['idle', 'active']]);
    expect(runtime.round()).toBe(round);

    runtime.reset();
    const single = runtime.call({ artwork: showcaseArtwork('single'), mode: 'single' });
    expect(single.cols).toBe(48);
    expect(Object.keys(single.plans)).toEqual(['A']);
    expect(single.plans.A?.region).toEqual({ x: 0, y: 0, w: 48, h: 27 });
  });

  it('rejects invalid or conflicting CALLs without committing anything', () => {
    const { runtime, updates } = setup();
    expect(() => runtime.call({ artwork: showcaseArtwork('single'), mode: 'crossover' })).toThrow(
      RangeError,
    );
    expect(() => runtime.call({ ...crossoverCall(3), durationMs: 5_000 })).toThrow(RangeError);
    expect(() => runtime.call({ ...crossoverCall(3), quorumOverride: { A: 0 } })).toThrow(
      RangeError,
    );
    expect(runtime.phase()).toBe('idle');
    expect(runtime.round()).toBeNull();
    expect(updates).toEqual([]);

    const { roundId } = runtime.call(crossoverCall(3));
    expect(() => runtime.call(crossoverCall(3))).toThrow(RoundConflictError);
    expect(runtime.round()?.roundId).toBe(roundId);
  });

  it('coalesces chat-driven snapshot pushes to at most 10 Hz with growing revisions', () => {
    const { runtime, snapshots } = setup();
    runtime.call(crossoverCall(500));
    const before = snapshots().length;
    for (let person = 0; person < 50; person += 1) {
      runtime.chat(chat('A', `person-${person}`));
      vi.advanceTimersByTime(5);
    }
    vi.advanceTimersByTime(MIN_PUSH_INTERVAL_MS * 2);
    const pushed = snapshots().slice(before);
    // 250 ms of chat → at most one push per 100 ms window (plus the trailing flush).
    expect(pushed.length).toBeGreaterThanOrEqual(2);
    expect(pushed.length).toBeLessThanOrEqual(4);
    for (let index = 1; index < pushed.length; index += 1) {
      const [previous, current] = [pushed[index - 1]!, pushed[index]!];
      expect(current.serverNowMs - previous.serverNowMs).toBeGreaterThanOrEqual(
        MIN_PUSH_INTERVAL_MS,
      );
      expect(current.revision).toBeGreaterThan(previous.revision);
    }
    expect(pushed.at(-1)?.sides.A.participants).toBe(50);
    expect(runtime.snapshot().revision).toBe(pushed.at(-1)?.revision);
  });

  it('pushes phase changes immediately and stops ticking once the round completes', () => {
    const { runtime, transitions, snapshots } = setup();
    runtime.call(crossoverCall(2));
    runtime.chat(chat('A', 'ann'));
    runtime.chat(chat('A', 'bob'));
    runtime.chat(chat('B', 'ann'));
    expect(snapshots().at(-1)?.phase).toBe('active');
    runtime.chat(chat('B', 'cat'));
    // No timer advanced: the reveal snapshot went out synchronously.
    expect(snapshots().at(-1)).toMatchObject({
      phase: 'revealing',
      crossovers: 1,
      revealAtMs: START_MS + 1_500,
      sides: { A: { participants: 2, ready: true }, B: { participants: 2, ready: true } },
    });
    expect(transitions).toEqual([
      ['idle', 'active'],
      ['active', 'revealing'],
    ]);
    vi.advanceTimersByTime(1_500 + 6_000 + TICK_INTERVAL_MS);
    expect(runtime.phase()).toBe('complete');
    expect(transitions.at(-1)).toEqual(['revealing', 'complete']);
    expect(vi.getTimerCount()).toBe(0);
    // The revealed picture stays available until RESET or a new CALL.
    expect(runtime.round()).not.toBeNull();
  });

  it('times out a quiet round from the 250 ms tick alone', () => {
    const { runtime, transitions, snapshots } = setup();
    expect(vi.getTimerCount()).toBe(0);
    runtime.call(crossoverCall(3, 10_000));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10_000 - TICK_INTERVAL_MS);
    expect(runtime.phase()).toBe('active');
    vi.advanceTimersByTime(TICK_INTERVAL_MS);
    expect(runtime.phase()).toBe('timed-out');
    expect(snapshots().at(-1)?.phase).toBe('timed-out');
    expect(transitions.at(-1)).toEqual(['active', 'timed-out']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('RESET pushes round:null and an idle snapshot immediately', () => {
    const { runtime, updates } = setup();
    runtime.call(crossoverCall(3));
    runtime.chat(chat('A', 'ann'));
    updates.length = 0;
    runtime.reset();
    expect(updates.map((update) => update.type)).toEqual(['round', 'snapshot']);
    expect(updates[0]).toEqual({ type: 'round', round: null });
    expect(updates[1]).toMatchObject({ snapshot: { phase: 'idle', roundId: null } });
    expect(runtime.round()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores our own sender and keeps demo and live chat apart', () => {
    const live = setup({ selfUserId: 'bot-account' });
    live.runtime.call(crossoverCall(3));
    expect(live.runtime.chat(chat('A', 'bot-account'))).toBe(false);
    expect(live.runtime.chat(chat('A', 'sim:1:0', { simulated: true }))).toBe(false);
    expect(live.runtime.snapshot().sides.A.participants).toBe(0);
    expect(live.runtime.chat(chat('A', 'viewer'))).toBe(true);
    expect(live.runtime.snapshot().sides.A.participants).toBe(1);

    const demo = setup({ simulated: true });
    demo.runtime.call(crossoverCall(3));
    expect(demo.runtime.chat(chat('A', 'real-viewer'))).toBe(false);
    expect(demo.runtime.chat(chat('A', 'sim:1:0', { simulated: true }))).toBe(true);
    expect(demo.runtime.snapshot()).toMatchObject({
      simulated: true,
      sides: { A: { participants: 1 } },
    });
  });

  it('never publishes chatter identifiers or delivery keys', () => {
    const { runtime, updates } = setup();
    runtime.call(crossoverCall(2));
    for (const side of ['A', 'B'] as const) {
      for (const person of ['secret-chatter-1', 'secret-chatter-2']) {
        runtime.chat(chat(side, person, { messageKey: `secret-key-${side}-${person}` }));
      }
    }
    vi.advanceTimersByTime(10_000);
    const published = JSON.stringify([updates, runtime.snapshot(), runtime.round()]);
    expect(published).not.toMatch(
      /secret|participantIds|recentChatters|seenMessageKeys|messageKey/,
    );
    expect(runtime.snapshot()).toMatchObject({ crossovers: 2, phase: 'complete' });
  });

  it('does not push or bump the revision for idle chat bookkeeping', () => {
    const { runtime, updates } = setup();
    const revision = runtime.snapshot().revision;
    runtime.chat(chat('A', 'lurker'));
    vi.advanceTimersByTime(MIN_PUSH_INTERVAL_MS * 3);
    expect(updates).toEqual([]);
    expect(runtime.snapshot().revision).toBe(revision);
  });

  it('remembers operator config but not scripted (showcase) overrides', () => {
    const { runtime } = setup();
    runtime.call({ ...crossoverCall(4), minQuorum: 5 });
    expect(runtime.config()).toMatchObject({ minQuorum: 5, quorumOverride: { A: 4, B: 4 } });
    runtime.reset();
    runtime.call({ ...crossoverCall(9), minQuorum: 7 }, { remember: false });
    expect(runtime.config()).toMatchObject({ minQuorum: 5, quorumOverride: { A: 4, B: 4 } });
    runtime.reset();
    runtime.call({ artwork: showcaseArtwork('crossover'), quorumOverride: { B: null } });
    expect(runtime.config().quorumOverride).toEqual({ A: 4 });
    expect(runtime.config().durationMs).toBe(30_000);
  });

  it('sanitizes labels and only announces real changes', () => {
    const { runtime, updates } = setup();
    runtime.setLabels({ A: '  Night   Owls ', B: '   ' });
    expect(runtime.labels()).toEqual({ A: 'Night Owls', B: 'Beta' });
    runtime.setLabels({ A: 'Night Owls', B: 'Beta' });
    runtime.setLabels({ A: 'x'.repeat(80), B: 'Beta' });
    expect(updates.filter((update) => update.type === 'labels')).toHaveLength(2);
    expect(runtime.labels().A).toHaveLength(40);
  });
});

it('filters default and configured bot logins before baseline observation or participation', () => {
  const { runtime } = setup({ ignoredChatters: [' Custom_Service ', ''] });
  for (const [i, login] of [...DEFAULT_IGNORED_LOGINS, 'CUSTOM_SERVICE'].entries()) {
    expect(runtime.chat({ ...chat('A', `bot-${i}`), chatterLogin: login.toUpperCase() })).toBe(
      false,
    );
  }
  runtime.call({
    artwork: showcaseArtwork('single'),
    mode: 'single',
    minQuorum: 1,
    quorumRatio: 1,
  });
  expect(runtime.snapshot().sides.A.quorum).toBe(1);
  expect(runtime.chat({ ...chat('A', 'bot'), chatterLogin: 'nightbot' })).toBe(false);
  expect(runtime.snapshot().sides.A.participants).toBe(0);
  expect(runtime.chat({ ...chat('A', 'person'), chatterLogin: 'ordinary_person' })).toBe(true);
  expect(runtime.snapshot().sides.A.participants).toBe(1);
  expect(JSON.stringify({ snapshot: runtime.snapshot(), round: runtime.round() })).not.toMatch(
    /chatterLogin|ordinary_person|nightbot|custom_service/i,
  );
});
