import type { NormalizedChatEvent } from '../engine/types.js';
import type { DemoChatRequest } from '../shared/protocol.js';

export const CROWD_SIZES = [5, 25, 300, 3000] as const;

/** Pure virtual events only. Never sends messages to Twitch. Explicit seed enables replay. */
export function makeSimulatedCrowd(
  request: DemoChatRequest,
  now: number,
): readonly NormalizedChatEvent[] {
  if (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > 3000) {
    throw new RangeError('SIMULATED crowd count must be 1..3000');
  }
  return Array.from({ length: request.count }, (_, index) => ({
    messageKey: `sim:${request.seed}:${request.side}:${index}`,
    chatterId: `sim:${request.seed}:${index}`,
    originBroadcasterId: `sim:channel:${request.side}`,
    side: request.side,
    receivedAtMs: now,
    simulated: true,
  }));
}
