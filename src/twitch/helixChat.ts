/**
 * Helix Send Chat Message plus a bounded, rate-limited send queue for the few CALL/summary messages
 * the stunt posts. See docs/TWITCH_NOTES.md §Send Chat Message and §Scopes and limits.
 *
 * - Conservative pacing: ≤ 20 sends per rolling 30 s for the user, ≥ 1 s between sends to the same
 *   channel (ordinary-account limits; elevated limits are never assumed).
 * - HTTP 200 does not mean delivered: `is_sent: false` + `drop_reason` is a drop.
 * - Only HTTP 429 (request provably not processed) is retried, a bounded number of times. Ambiguous
 *   failures (5xx, network) are reported, not blindly re-posted, to avoid duplicate announcements.
 * - User-token sends propagate across a Shared Chat session and `for_source_only` is not allowed
 *   with user tokens, so it is never set; the service decides whether to send once (sharedChat.ts).
 */
import type { HelixClient } from './helix.js';
import {
  TwitchNetworkError,
  defaultSleep,
  isAbortError,
  rateLimitRetryAtMs,
  type SleepFn,
} from './http.js';
import { isRecord, readDataArray, readString } from './json.js';
import { ReauthorizationRequiredError } from './tokenStore.js';

export const MAX_CHAT_MESSAGE_LENGTH = 500;

export interface SendChatRequest {
  readonly broadcaster_id: string;
  /** Must equal the validated token user for a user access token. */
  readonly sender_id: string;
  readonly message: string;
}

export interface SendChatResult {
  readonly message_id: string;
  readonly is_sent: boolean;
  readonly drop_reason?: { readonly code: string; readonly message: string } | null;
}

/** One Helix attempt, classified for the queue. Reasons are safe, token-free text. */
export type SendAttempt =
  | { readonly kind: 'sent'; readonly messageId: string }
  | { readonly kind: 'dropped'; readonly reason: string }
  | { readonly kind: 'rate-limited'; readonly retryAtMs: number | null }
  | { readonly kind: 'failed'; readonly reason: string };

export interface ChatOutcome {
  readonly ok: boolean;
  /** Null on success; otherwise a short operator-facing reason (no chatter data, no tokens). */
  readonly reason: string | null;
}

export function parseSendChatResult(body: unknown): SendChatResult | null {
  const first = readDataArray(body)?.[0];
  if (!isRecord(first) || typeof first.is_sent !== 'boolean') return null;
  let dropReason: SendChatResult['drop_reason'] = null;
  if (isRecord(first.drop_reason)) {
    dropReason = {
      code: readString(first.drop_reason.code) ?? 'unknown',
      message: readString(first.drop_reason.message) ?? '',
    };
  }
  return {
    message_id: readString(first.message_id) ?? '',
    is_sent: first.is_sent,
    drop_reason: dropReason,
  };
}

/** POST /helix/chat/messages once and classify the outcome. Never throws. */
export async function sendChatMessage(
  helix: HelixClient,
  request: SendChatRequest,
  nowMs: number,
): Promise<SendAttempt> {
  let response;
  try {
    response = await helix.request('POST', '/chat/messages', { body: request });
  } catch (error) {
    if (error instanceof ReauthorizationRequiredError) {
      return { kind: 'failed', reason: 'Twitch authorization expired; connect Twitch again' };
    }
    if (error instanceof TwitchNetworkError || isAbortError(error)) {
      return { kind: 'failed', reason: 'Network error contacting Twitch; message not retried' };
    }
    return { kind: 'failed', reason: 'Unexpected error while sending the chat message' };
  }
  const { status } = response;
  if (status === 200) {
    const result = parseSendChatResult(response.body);
    if (!result) return { kind: 'failed', reason: 'Twitch returned an unexpected send response' };
    if (result.is_sent) return { kind: 'sent', messageId: result.message_id };
    const drop = result.drop_reason;
    const detail = drop
      ? `${drop.code}${drop.message ? `: ${drop.message}` : ''}`
      : 'no reason given';
    return { kind: 'dropped', reason: `Twitch dropped the message (${truncate(detail, 200)})` };
  }
  if (status === 429) {
    return { kind: 'rate-limited', retryAtMs: rateLimitRetryAtMs(response.headers, nowMs) };
  }
  return { kind: 'failed', reason: describeSendFailure(status) };
}

function describeSendFailure(status: number): string {
  switch (status) {
    case 400:
      return 'Twitch rejected the message (HTTP 400)';
    case 401:
      return 'Twitch rejected the authorization (HTTP 401); connect Twitch again';
    case 403:
      return 'Not allowed to chat in this channel (HTTP 403): banned, restricted or missing user:write:chat';
    case 422:
      return 'Twitch did not accept the message content (HTTP 422)';
    default:
      return status >= 500
        ? `Twitch chat service error (HTTP ${status}); message not retried`
        : `Twitch chat send failed (HTTP ${status})`;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface ChatQueueOptions {
  readonly send: (request: SendChatRequest) => Promise<SendAttempt>;
  readonly now?: () => number;
  readonly sleep?: SleepFn;
  /** Sends allowed per rolling window for the user (default 20). */
  readonly maxPerWindow?: number;
  readonly windowMs?: number;
  /** Minimum gap between two sends to the same channel (default 1 000 ms). */
  readonly perChannelIntervalMs?: number;
  /** Queued messages beyond this are rejected immediately (default 20). */
  readonly maxPending?: number;
  /** Retries after HTTP 429 (default 2), each waiting at most `maxRetryWaitMs`. */
  readonly maxRateLimitRetries?: number;
  readonly maxRetryWaitMs?: number;
}

export interface ChatQueue {
  /** Resolves when the message was sent, dropped or failed. Never rejects. */
  enqueue(request: SendChatRequest): Promise<ChatOutcome>;
  /** Resolves every waiting message with `reason`; the queue stays usable afterwards. */
  cancelAll(reason: string): void;
  pending(): number;
}

interface QueueItem {
  readonly request: SendChatRequest;
  readonly resolve: (outcome: ChatOutcome) => void;
}

/** Fallback wait after a 429 without usable rate-limit headers. */
const DEFAULT_RETRY_WAIT_MS = 2_000;

export function createChatQueue(options: ChatQueueOptions): ChatQueue {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const maxPerWindow = options.maxPerWindow ?? 20;
  const windowMs = options.windowMs ?? 30_000;
  const perChannelIntervalMs = options.perChannelIntervalMs ?? 1_000;
  const maxPending = options.maxPending ?? 20;
  const maxRetries = options.maxRateLimitRetries ?? 2;
  const maxRetryWaitMs = options.maxRetryWaitMs ?? 30_000;

  const queue: QueueItem[] = [];
  /** Timestamps of every attempt in the current window (attempts, not successes: conservative). */
  const attempts: number[] = [];
  const lastByChannel = new Map<string, number>();
  let running = false;
  let cancel = new AbortController();
  /** Send Chat Message has one HTTP bucket for the sender, shared across target channels. */
  let rateLimitedUntilMs = 0;

  function resetTooFar(): ChatOutcome {
    return { ok: false, reason: 'Twitch chat rate limit reset is too far away; try again later' };
  }

  function waitForSlotMs(channel: string): number {
    const t = now();
    while (attempts.length > 0 && (attempts[0] ?? 0) <= t - windowMs) attempts.shift();
    let wait = Math.max(0, rateLimitedUntilMs - t);
    if (attempts.length >= maxPerWindow) wait = Math.max(wait, (attempts[0] ?? t) + windowMs - t);
    const last = lastByChannel.get(channel);
    if (last !== undefined) wait = Math.max(wait, last + perChannelIntervalMs - t);
    return Math.max(0, wait);
  }

  async function attempt(request: SendChatRequest, signal: AbortSignal): Promise<ChatOutcome> {
    for (let retries = 0; ; retries += 1) {
      signal.throwIfAborted();
      if (rateLimitedUntilMs - now() > maxRetryWaitMs) return resetTooFar();
      for (let wait = waitForSlotMs(request.broadcaster_id); wait > 0;) {
        await sleep(wait, signal);
        wait = waitForSlotMs(request.broadcaster_id);
      }
      const t = now();
      attempts.push(t);
      lastByChannel.set(request.broadcaster_id, t);
      const result = await options.send(request).catch((): SendAttempt => ({
        kind: 'failed',
        reason: 'Unexpected error while sending the chat message',
      }));
      switch (result.kind) {
        case 'sent':
          return { ok: true, reason: null };
        case 'dropped':
        case 'failed':
          return { ok: false, reason: result.reason };
        case 'rate-limited': {
          const until = result.retryAtMs ?? now() + DEFAULT_RETRY_WAIT_MS;
          // Honor this reset for every queued channel, including after this item gives up.
          rateLimitedUntilMs = Math.max(rateLimitedUntilMs, until + 250);
          if (retries >= maxRetries) {
            return {
              ok: false,
              reason: 'Twitch chat rate limit reached (HTTP 429); try again later',
            };
          }
          // Small jitter so a burst of retries does not hit the reset instant together.
          const waitMs = Math.max(0, rateLimitedUntilMs - now());
          if (waitMs > maxRetryWaitMs) return resetTooFar();
          await sleep(waitMs, signal);
        }
      }
    }
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const signal = cancel.signal;
        try {
          item.resolve(await attempt(item.request, signal));
        } catch {
          // Only the abortable sleeps can throw here: the queue was cancelled while waiting.
          item.resolve({ ok: false, reason: cancelReason(signal) });
        }
      }
    } finally {
      running = false;
    }
  }

  function cancelReason(signal: AbortSignal): string {
    return typeof signal.reason === 'string' ? signal.reason : 'Chat send cancelled';
  }

  return {
    enqueue(request) {
      if (request.message.trim().length === 0) {
        return Promise.resolve({ ok: false, reason: 'Empty chat message' });
      }
      if (request.message.length > MAX_CHAT_MESSAGE_LENGTH) {
        return Promise.resolve({
          ok: false,
          reason: `Chat message exceeds ${MAX_CHAT_MESSAGE_LENGTH} characters`,
        });
      }
      if (queue.length >= maxPending) {
        return Promise.resolve({ ok: false, reason: 'Chat send queue is full; message skipped' });
      }
      return new Promise<ChatOutcome>((resolve) => {
        queue.push({ request, resolve });
        void pump();
      });
    },
    cancelAll(reason) {
      for (const item of queue.splice(0)) item.resolve({ ok: false, reason });
      cancel.abort(reason);
      cancel = new AbortController();
    },
    pending: () => queue.length,
  };
}
