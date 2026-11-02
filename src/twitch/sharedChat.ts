/**
 * Shared Chat session tracking for local partner suggestions and announcement deduplication: user-token
 * sends propagate to every channel of a Shared Chat session, so when A and B share one, `say` sends
 * once. Identity routing for chat messages lives in normalize.ts and does not depend on this.
 *
 * Sources: `channel.shared_chat.begin|update|end` v1 EventSub notifications (no authorization
 * required) for channel A, seeded by Helix Get Shared Chat Session when the socket connects.
 * When unsure, the tracker reports "not shared" so both chats still get their message.
 */
import type { HelixClient } from './helix.js';
import { isRecord, readDataArray, readString } from './json.js';

export const SHARED_CHAT_SUBSCRIPTION_TYPES = [
  'channel.shared_chat.begin',
  'channel.shared_chat.update',
  'channel.shared_chat.end',
] as const;
export type SharedChatSubscriptionType = (typeof SHARED_CHAT_SUBSCRIPTION_TYPES)[number];

/** Normalized session change; only broadcaster IDs, never chatter data. */
export type SharedChatChange =
  | {
      readonly kind: 'session';
      readonly sessionId: string;
      readonly participantIds: readonly string[];
    }
  | { readonly kind: 'end'; readonly sessionId: string }
  /** Helix reports that `broadcasterId` is currently not in any Shared Chat session. */
  | { readonly kind: 'none'; readonly broadcasterId: string };

export function isSharedChatSubscriptionType(type: string): type is SharedChatSubscriptionType {
  return (SHARED_CHAT_SUBSCRIPTION_TYPES as readonly string[]).includes(type);
}

/** Validates a `channel.shared_chat.*` notification `event` object. */
export function parseSharedChatEvent(
  type: SharedChatSubscriptionType,
  event: unknown,
): SharedChatChange | null {
  if (!isRecord(event)) return null;
  const sessionId = readString(event.session_id);
  if (!sessionId) return null;
  if (type === 'channel.shared_chat.end') return { kind: 'end', sessionId };
  const participantIds = readParticipants(event.participants, 'broadcaster_user_id');
  return participantIds ? { kind: 'session', sessionId, participantIds } : null;
}

function readParticipants(value: unknown, idField: string): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const item of value as readonly unknown[]) {
    const id = isRecord(item) ? readString(item[idField]) : null;
    if (!id) return null;
    ids.push(id);
  }
  return ids;
}

/** GET /helix/shared_chat/session?broadcaster_id=…; null when the lookup itself failed. */
export async function fetchSharedChatSession(
  helix: HelixClient,
  broadcasterId: string,
): Promise<SharedChatChange | null> {
  let response;
  try {
    response = await helix.request('GET', '/shared_chat/session', {
      query: { broadcaster_id: broadcasterId },
    });
  } catch {
    return null;
  }
  if (response.status !== 200) return null;
  const data = readDataArray(response.body);
  if (!data) return null;
  const session = data[0];
  if (session === undefined) return { kind: 'none', broadcasterId };
  if (!isRecord(session)) return null;
  const sessionId = readString(session.session_id);
  const participantIds = readParticipants(session.participants, 'broadcaster_id');
  return sessionId && participantIds ? { kind: 'session', sessionId, participantIds } : null;
}

export interface SharedChatTracker {
  apply(change: SharedChatChange): void;
  clear(): void;
  /** True when both broadcasters are known to be in the same active Shared Chat session. */
  sharesSession(a: string, b: string): boolean;
  /** Current broadcaster membership, for local-only partner discovery. */
  participants(broadcasterId: string): readonly string[];
}

/** Small bound: a channel is in at most one session; this only guards against junk input. */
const MAX_TRACKED_SESSIONS = 8;

export function createSharedChatTracker(): SharedChatTracker {
  const sessions = new Map<string, ReadonlySet<string>>();
  return {
    apply(change) {
      switch (change.kind) {
        case 'session':
          sessions.delete(change.sessionId);
          // A broadcaster belongs to one session at a time: drop stale sessions that listed them.
          for (const [id, members] of sessions) {
            if (change.participantIds.some((p) => members.has(p))) sessions.delete(id);
          }
          sessions.set(change.sessionId, new Set(change.participantIds));
          while (sessions.size > MAX_TRACKED_SESSIONS) {
            const oldest = sessions.keys().next().value;
            if (oldest === undefined) break;
            sessions.delete(oldest);
          }
          break;
        case 'end':
          sessions.delete(change.sessionId);
          break;
        case 'none':
          for (const [id, members] of sessions) {
            if (members.has(change.broadcasterId)) sessions.delete(id);
          }
          break;
      }
    },
    clear: () => sessions.clear(),
    sharesSession(a, b) {
      for (const members of sessions.values()) {
        if (members.has(a) && members.has(b)) return true;
      }
      return false;
    },
    participants(broadcasterId) {
      for (const members of sessions.values()) {
        if (members.has(broadcasterId)) return [...members];
      }
      return [];
    },
  };
}
