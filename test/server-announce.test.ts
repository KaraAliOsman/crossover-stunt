import { describe, expect, it } from 'vitest';
import type { Snapshot, SnapshotSide, StuntMode } from '../src/engine/types.js';
import {
  DUPLICATE_WINDOW_MS,
  MAX_CHAT_MESSAGE_LENGTH,
  announcementFor,
  helpAnnouncementFor,
  createHelpAnnouncer,
  distinctAnnouncement,
} from '../src/server/announce.js';

const labels = { A: 'Alpha', B: 'Beta' };

function side(participants: number, quorum: number): SnapshotSide {
  return {
    participants,
    quorum,
    progress: Math.min(1, participants / quorum),
    ready: participants >= quorum,
  };
}

function snapshot(mode: StuntMode, a: SnapshotSide, b: SnapshotSide, crossovers = 0): Snapshot {
  return {
    revision: 3,
    mode,
    phase: 'active',
    roundId: 'r1',
    serverNowMs: 1_000,
    startedAtMs: 1_000,
    deadlineAtMs: 46_000,
    revealAtMs: null,
    revealDurationMs: 6_000,
    simulated: false,
    crossovers,
    sides: { A: a, B: b },
  };
}

describe('live chat announcements', () => {
  it('prompts both communities on a crossover CALL', () => {
    expect(
      announcementFor('idle', 'active', snapshot('crossover', side(0, 3), side(0, 3)), labels),
    ).toEqual({
      sides: ['A', 'B'],
      message:
        'STUNT! Type anything in chat — 45s. Alpha + Beta: one picture, neither chat can finish it alone.',
    });
  });

  it('prompts only side A in single mode', () => {
    expect(
      announcementFor('complete', 'active', snapshot('single', side(0, 3), side(0, 0)), labels),
    ).toEqual({
      sides: ['A'],
      message: 'STUNT! Type anything in chat — 45s. Every new person sharpens the picture.',
    });
  });

  it('summarizes the reveal with the union of people and the crossover count', () => {
    const reveal = snapshot('crossover', side(12, 12), side(12, 12), 2);
    expect(announcementFor('active', 'revealing', reveal, labels)).toEqual({
      sides: ['A', 'B'],
      message: '22 people across 2 streams made this · 2 crossed over',
    });
    expect(
      announcementFor('active', 'revealing', snapshot('single', side(1, 1), side(0, 0)), labels),
    ).toEqual({ sides: ['A'], message: '1 person made this' });
  });

  it('reports SO CLOSE with each side’s numbers on timeout', () => {
    const late = snapshot('crossover', side(12, 12), side(9, 12));
    expect(announcementFor('active', 'timed-out', late, labels)?.message).toBe(
      'SO CLOSE — Alpha 12/12 · Beta 9/12',
    );
    const single = snapshot('single', side(4, 10), side(0, 0));
    expect(announcementFor('active', 'timed-out', single, labels)?.message).toBe(
      'SO CLOSE — Alpha 4/10',
    );
  });

  it('stays silent for other transitions and never exceeds 500 characters', () => {
    const any = snapshot('crossover', side(1, 3), side(1, 3));
    expect(announcementFor('revealing', 'complete', any, labels)).toBeNull();
    expect(announcementFor('active', 'idle', any, labels)).toBeNull();
    const long = { A: 'A'.repeat(400), B: 'B'.repeat(400) };
    const message = announcementFor('idle', 'active', any, long)?.message ?? '';
    expect(message.length).toBeLessThanOrEqual(MAX_CHAT_MESSAGE_LENGTH);
  });
});

describe('duplicate-safe announcements (Twitch msg_duplicate)', () => {
  it('varies a repeat inside 30 s and keeps the plain text otherwise', () => {
    const base = 'STUNT! Type anything in chat — 45s. Alpha + Beta: one picture.';
    const first = distinctAnnouncement(base, null, 1_000);
    expect(first.message).toBe(base);
    const retake = distinctAnnouncement(base, first, 1_000 + 12_000);
    expect(retake.message).toBe(`${base} (take 2)`);
    const third = distinctAnnouncement(base, retake, 1_000 + 20_000);
    expect(third.message).toBe(`${base} (take 3)`);
    // Measured from the previous send, not the first one.
    expect(distinctAnnouncement(base, third, 21_000 + DUPLICATE_WINDOW_MS).message).toBe(base);
    expect(distinctAnnouncement('SO CLOSE — Alpha 1/3', third, 22_000).message).toBe(
      'SO CLOSE — Alpha 1/3',
    );
  });

  it('keeps the suffix within the Helix length limit', () => {
    const long = 'x'.repeat(MAX_CHAT_MESSAGE_LENGTH);
    const first = distinctAnnouncement(long, null, 0);
    const retake = distinctAnnouncement(long, first, 1);
    expect(retake.message).toHaveLength(MAX_CHAT_MESSAGE_LENGTH);
    expect(retake.message.endsWith('… (take 2)')).toBe(true);
  });
});

describe('one-time help invitation', () => {
  it('directs Shared Chat viewers to the other stream page and still invites once', () => {
    for (const readySide of ['A', 'B'] as const) {
      const next = createHelpAnnouncer();
      const waiting = snapshot(
        'crossover',
        side(readySide === 'A' ? 1 : 0, 1),
        side(readySide === 'B' ? 1 : 0, 1),
      );
      const names = { A: 'efaoangssm', B: 'efaoangsam' };
      const other = readySide === 'A' ? 'B' : 'A';
      expect(next(waiting, names, true)).toEqual({
        sides: [readySide],
        message: `${names[readySide]} is done! ${names[other]} still needs 1 more. Shared Chat counts the stream you type from: open ${names[other]}'s stream and type there (you count for both sides).`,
      });
      expect(next(waiting, names, true)).toBeNull();
      expect(next(waiting, names, false)).toBeNull();
    }
  });
  it('targets the ready side exactly once per round and remains silent outside active crossover', () => {
    const next = createHelpAnnouncer();
    const readyA = snapshot('crossover', side(3, 3), side(1, 3));
    expect(next(readyA, labels)).toEqual({
      sides: ['A'],
      message:
        "Alpha is done! Beta still needs 2 more. Hop into Beta's chat and type anything (you count for both sides).",
    });
    expect(next(readyA, labels)).toBeNull();
    expect(next({ ...readyA, sides: { A: side(3, 3), B: side(2, 3) } }, labels)).toBeNull();
    for (const phase of ['idle', 'timed-out', 'revealing', 'complete'] as const)
      expect(next({ ...readyA, roundId: 'r2', phase }, labels)).toBeNull();
    expect(next({ ...readyA, mode: 'single', roundId: 'r2' }, labels)).toBeNull();
    expect(
      next({ ...readyA, roundId: 'r2', sides: { A: side(1, 3), B: side(3, 3) } }, labels)?.sides,
    ).toEqual(['B']);
    expect(helpAnnouncementFor(snapshot('crossover', side(3, 3), side(3, 3)), labels)).toBeNull();
    expect(helpAnnouncementFor(snapshot('crossover', side(1, 3), side(1, 3)), labels)).toBeNull();
  });
  it('clamps long labels, supports duplicate-send suffixes and bounds round history', () => {
    const next = createHelpAnnouncer();
    const ready = snapshot('crossover', side(3, 3), side(1, 3));
    for (const sharedChat of [false, true]) {
      const long = helpAnnouncementFor(
        ready,
        { A: 'a'.repeat(400), B: 'b'.repeat(400) },
        sharedChat,
      )!.message;
      expect(long.length).toBeLessThanOrEqual(500);
      const first = distinctAnnouncement(long, null, 0);
      const repeat = distinctAnnouncement(long, first, 1).message;
      expect(repeat).toMatch(/\(take 2\)$/);
      expect(repeat.length).toBeLessThanOrEqual(500);
    }
    for (let i = 0; i < 17; i += 1)
      expect(next({ ...ready, roundId: `r${i}` }, labels)).not.toBeNull();
    expect(next({ ...ready, roundId: 'r16' }, labels)).toBeNull();
    expect(next({ ...ready, roundId: 'r0' }, labels)).not.toBeNull();
  });
});
