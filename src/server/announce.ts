import { requiredSides } from '../engine/artwork.js';
import type { Side, Snapshot, StuntPhase } from '../engine/types.js';
import type { Labels } from './runtime.js';

/** Helix Send Chat Message limit. */
export const MAX_CHAT_MESSAGE_LENGTH = 500;

export interface Announcement {
  readonly sides: readonly Side[];
  readonly message: string;
}

function people(count: number): string {
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

function clamp(message: string, suffix = ''): string {
  const room = MAX_CHAT_MESSAGE_LENGTH - suffix.length;
  return message.length <= room ? message + suffix : `${message.slice(0, room - 1)}…${suffix}`;
}

/**
 * Twitch drops a message identical to the sender's previous one in that channel less than 30 s
 * earlier (`msg_duplicate`). With one token the sender is a plain chatter in the partner's
 * channel, so CALL → RESET → CALL with the same duration would silently lose B's prompt.
 */
export const DUPLICATE_WINDOW_MS = 30_000;

export interface SentAnnouncement {
  /** Text as built by announcementFor (what duplicates are compared on). */
  readonly base: string;
  /** Text actually sent (base, or base + a "(take N)" suffix). */
  readonly message: string;
  readonly atMs: number;
  readonly take: number;
}

/** Varies a repeat of the previous announcement inside the duplicate window: `(take 2)`, … */
export function distinctAnnouncement(
  base: string,
  previous: SentAnnouncement | null,
  nowMs: number,
): SentAnnouncement {
  const repeat =
    previous !== null && previous.base === base && nowMs - previous.atMs < DUPLICATE_WINDOW_MS;
  if (!repeat) return { base, message: base, atMs: nowMs, take: 1 };
  const take = previous.take + 1;
  return { base, message: clamp(base, ` (take ${take})`), atMs: nowMs, take };
}

/**
 * Chat text for a phase change (live mode only; demo never sends anything to Twitch).
 * Aggregates and broadcaster labels only — never chatter names or message content.
 * Sent to every side that gates the round: A and B in crossover, A in single mode.
 */
export function announcementFor(
  from: StuntPhase,
  to: StuntPhase,
  snapshot: Snapshot,
  labels: Labels,
): Announcement | null {
  const sides = requiredSides(snapshot.mode);
  const crossover = snapshot.mode === 'crossover';
  const { A, B } = snapshot.sides;

  if (to === 'active' && from !== 'active') {
    const durationMs =
      snapshot.deadlineAtMs !== null && snapshot.startedAtMs !== null
        ? snapshot.deadlineAtMs - snapshot.startedAtMs
        : 0;
    const seconds = Math.round(durationMs / 1000);
    const tail = crossover
      ? `${labels.A} + ${labels.B}: one picture, neither chat can finish it alone.`
      : 'Every new person sharpens the picture.';
    return { sides, message: clamp(`STUNT! Type anything in chat — ${seconds}s. ${tail}`) };
  }

  if (to === 'revealing' && from === 'active') {
    if (!crossover) return { sides, message: clamp(`${people(A.participants)} made this`) };
    // Union of both communities: a person who chatted on both sides counts once.
    const total = A.participants + B.participants - snapshot.crossovers;
    return {
      sides,
      message: clamp(
        `${people(total)} across 2 streams made this · ${snapshot.crossovers} crossed over`,
      ),
    };
  }

  if (to === 'timed-out' && from === 'active') {
    const sideA = `${labels.A} ${A.participants}/${A.quorum}`;
    const message = crossover
      ? `SO CLOSE — ${sideA} · ${labels.B} ${B.participants}/${B.quorum}`
      : `SO CLOSE — ${sideA}`;
    return { sides, message: clamp(message) };
  }

  return null;
}

/** Only the ready chat gets the crossover invitation, while exactly one side is ready. */
export function helpAnnouncementFor(snapshot: Snapshot, labels: Labels): Announcement | null {
  if (
    snapshot.mode !== 'crossover' ||
    snapshot.phase !== 'active' ||
    snapshot.sides.A.ready === snapshot.sides.B.ready
  )
    return null;
  const ready = snapshot.sides.A.ready ? 'A' : 'B';
  const other = ready === 'A' ? 'B' : 'A';
  const remaining = Math.max(0, snapshot.sides[other].quorum - snapshot.sides[other].participants);
  return {
    sides: [ready],
    message: clamp(
      `${labels[ready]} is done! ${labels[other]} still needs ${remaining} more. Hop into ${labels[other]}'s chat and type anything (you count for both sides).`,
    ),
  };
}

/** At most once per round; keep only the last 16 eligible round IDs. */
export function createHelpAnnouncer(): (snapshot: Snapshot, labels: Labels) => Announcement | null {
  const seen = new Set<string>();
  return (snapshot, labels) => {
    const next = helpAnnouncementFor(snapshot, labels);
    if (!next || !snapshot.roundId || seen.has(snapshot.roundId)) return null;
    seen.add(snapshot.roundId);
    if (seen.size > 16) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return next;
  };
}
