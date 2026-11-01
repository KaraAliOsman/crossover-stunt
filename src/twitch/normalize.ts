import type { NormalizedChatEvent, Side } from '../engine/types.js';

/** Minimal allowlist after runtime validation; deliberately excludes message text/fragments. */
export interface TwitchChatIdentity {
  readonly broadcaster_user_id: string;
  readonly chatter_user_id: string;
  /** Server-only bot filtering; never part of the overlay protocol. */
  readonly chatter_user_login?: string;
  readonly message_id: string;
  readonly source_broadcaster_user_id?: string | null;
  readonly source_message_id?: string | null;
}

export function normalizeChat(
  event: TwitchChatIdentity,
  channels: Readonly<Record<Side, string>>,
  receivedAtMs: number,
): (NormalizedChatEvent & { readonly chatterLogin?: string }) | null {
  const origin = event.source_broadcaster_user_id ?? event.broadcaster_user_id;
  const side = origin === channels.A ? 'A' : origin === channels.B ? 'B' : null;
  if (side === null) return null;
  return {
    messageKey: event.source_message_id ?? event.message_id,
    chatterId: event.chatter_user_id,
    originBroadcasterId: origin,
    side,
    receivedAtMs,
    simulated: false,
    ...(event.chatter_user_login === undefined
      ? {}
      : { chatterLogin: event.chatter_user_login.trim().toLowerCase() }),
  };
}
