/**
 * EventSub WebSocket lifecycle: ONE steady-state socket, one `channel.chat.message` v1 Helix
 * subscription per configured channel. See docs/TWITCH_NOTES.md and .agents/skills/twitch-eventsub.
 *
 * - `session_welcome` on a fresh socket → create the subscriptions over Helix immediately (Twitch
 *   closes sockets with no subscription after 10 s). Never send anything into the socket.
 * - Keepalive watchdog: welcome's `keepalive_timeout_seconds` + grace, reset by every message on
 *   the active socket. Expiry or an unexpected close → bounded backoff, new socket, resubscribe.
 * - `session_reconnect` → open `reconnect_url` unchanged, keep the old socket until the new welcome,
 *   then close the old one. Subscriptions migrate, so nothing is recreated.
 * - `revocation` of a chat subscription halts the client with a recoverable control status.
 * - Envelopes are deduplicated by `metadata.message_id` and chat by `source_message_id ??
 *   message_id` (bounded LRUs that the caller can share across clients and reconnects).
 * - Payloads are validated, stripped to IDs and normalized before `onChat`; text, names, badges and
 *   fragments never leave this module. Nothing here logs payloads, URLs or tokens.
 */
import { WebSocket, type RawData } from 'ws';
import type { NormalizedChatEvent, Side } from '../engine/types.js';
import { createLruSet, type LruSet } from './dedupe.js';
import type { HelixClient } from './helix.js';
import { rateLimitRetryAtMs, type JsonResponse } from './http.js';
import {
  INVALID,
  isRecord,
  readDataArray,
  readNullableString,
  readNumber,
  readString,
  type JsonRecord,
} from './json.js';
import { normalizeChat, type TwitchChatIdentity } from './normalize.js';
import {
  SHARED_CHAT_SUBSCRIPTION_TYPES,
  isSharedChatSubscriptionType,
  parseSharedChatEvent,
  type SharedChatChange,
  type SharedChatSubscriptionType,
} from './sharedChat.js';
import { ReauthorizationRequiredError } from './tokenStore.js';

export const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
export const CHAT_SUBSCRIPTION_TYPE = 'channel.chat.message';

/** Added to welcome's keepalive timeout before declaring the socket dead. */
export const KEEPALIVE_GRACE_MS = 3_000;
/** Used only if a welcome omits its keepalive timeout (Twitch's default is 10 s). */
const DEFAULT_KEEPALIVE_SECONDS = 10;
/** A fresh socket that sends no welcome within this window is replaced. */
const WELCOME_TIMEOUT_MS = 10_000;
/** Twitch keeps the old socket for 30 s after `session_reconnect`. */
const HANDOVER_TIMEOUT_MS = 30_000;
/** Per Helix subscription request; keeps all creations inside Twitch's 10 s welcome window. */
const SUBSCRIBE_TIMEOUT_MS = 8_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** EventSub frames are small; bound memory for a misbehaving peer. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface ChatSubscriptionRequest {
  readonly type: 'channel.chat.message';
  readonly version: '1';
  readonly condition: { readonly broadcaster_user_id: string; readonly user_id: string };
  readonly transport: { readonly method: 'websocket'; readonly session_id: string };
}

export interface SharedChatSubscriptionRequest {
  readonly type: SharedChatSubscriptionType;
  readonly version: '1';
  readonly condition: { readonly broadcaster_user_id: string };
  readonly transport: { readonly method: 'websocket'; readonly session_id: string };
}

export type EventSubStatusEvent =
  | { readonly status: 'connecting' | 'connected' | 'reconnecting' }
  /**
   * Halted: retrying cannot help (auth, permissions, limits, removed version). `side` is the
   * channel whose subscription failed (null when not channel-specific), so the owner can drop
   * just a failing partner channel and keep reading channel A.
   */
  | {
      readonly status: 'failed';
      readonly message: string;
      readonly authRequired: boolean;
      readonly side: Side | null;
    }
  /** Halted: Twitch revoked a chat subscription (`payload.subscription.status` in `reason`). */
  | {
      readonly status: 'revoked';
      readonly message: string;
      readonly reason: string;
      readonly side: Side | null;
    };

export interface EventSubDedupe {
  /** `metadata.message_id` of notification/revocation envelopes. */
  readonly envelopes: LruSet;
  /** Chat delivery keys (`source_message_id ?? message_id`). */
  readonly messages: LruSet;
}

export interface EventSubOptions {
  readonly helix: HelixClient;
  /** Validated token user: subscription condition `user_id`; its own messages are ignored. */
  readonly tokenUserId: string;
  /** Broadcaster user IDs. `B` is null in single-channel mode. */
  readonly channels: { readonly A: string; readonly B: string | null };
  readonly onChat: (chat: NormalizedChatEvent) => void;
  readonly onStatus: (event: EventSubStatusEvent) => void;
  /** Receives Shared Chat begin/update/end for channel A when both channels are configured. */
  readonly onSharedChat?: (change: SharedChatChange) => void;
  /** Injectable for tests (local `ws` server). Defaults to Twitch's production endpoint. */
  readonly url?: string;
  readonly now?: () => number;
  /** Share across clients so channel changes and restarts keep dedupe state. */
  readonly dedupe?: EventSubDedupe;
  readonly keepaliveGraceMs?: number;
  /** Delay before reconnect attempt `attempt` (1-based). Default: capped exponential + jitter. */
  readonly reconnectDelayMs?: (attempt: number) => number;
  readonly welcomeTimeoutMs?: number;
  readonly handoverTimeoutMs?: number;
}

export interface EventSubClient {
  /** Opens the socket; progress is reported through `onStatus`. Idempotent. */
  start(): Promise<void>;
  /** Closes every socket and cancels timers; the client cannot be restarted. */
  stop(): Promise<void>;
}

export function defaultReconnectDelayMs(attempt: number): number {
  const base = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * 500);
}

export function chatSubscriptionBody(
  broadcasterUserId: string,
  tokenUserId: string,
  sessionId: string,
): ChatSubscriptionRequest {
  return {
    type: CHAT_SUBSCRIPTION_TYPE,
    version: '1',
    condition: { broadcaster_user_id: broadcasterUserId, user_id: tokenUserId },
    transport: { method: 'websocket', session_id: sessionId },
  };
}

interface Envelope {
  readonly messageId: string;
  readonly messageType: string;
  readonly subscriptionType: string | null;
  readonly subscriptionVersion: string | null;
  readonly payload: JsonRecord;
}

/** Validates the EventSub envelope (`metadata` + `payload`); null for anything else. */
export function parseEnvelope(value: unknown): Envelope | null {
  if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.payload)) return null;
  const messageId = readString(value.metadata.message_id);
  const messageType = readString(value.metadata.message_type);
  if (!messageId || !messageType) return null;
  return {
    messageId,
    messageType,
    subscriptionType: readString(value.metadata.subscription_type),
    subscriptionVersion: readString(value.metadata.subscription_version),
    payload: value.payload,
  };
}

interface SessionInfo {
  readonly id: string;
  readonly keepaliveTimeoutSeconds: number | null;
  readonly reconnectUrl: string | null;
}

function parseSession(payload: JsonRecord): SessionInfo | null {
  const session = payload.session;
  if (!isRecord(session)) return null;
  const id = readString(session.id);
  if (!id) return null;
  const keepalive = readNumber(session.keepalive_timeout_seconds);
  return {
    id,
    keepaliveTimeoutSeconds: keepalive !== null && keepalive > 0 ? keepalive : null,
    reconnectUrl: readString(session.reconnect_url),
  };
}

/**
 * Validates a `channel.chat.message` v1 notification payload and copies ONLY the identity fields
 * normalizeChat needs. Message text, fragments, display names, badges and colors are dropped here. Login stays server-only for bot filtering.
 */
export function parseChatNotification(payload: unknown): TwitchChatIdentity | null {
  if (!isRecord(payload) || !isRecord(payload.subscription) || !isRecord(payload.event)) {
    return null;
  }
  const { subscription, event } = payload;
  if (subscription.type !== CHAT_SUBSCRIPTION_TYPE || subscription.version !== '1') return null;
  const broadcasterUserId = readString(event.broadcaster_user_id);
  const chatterUserId = readString(event.chatter_user_id);
  const messageId = readString(event.message_id);
  const login = event.chatter_user_login;
  if (
    login !== undefined &&
    (typeof login !== 'string' || !/^[A-Za-z0-9_]{1,25}$/.test(login.trim()))
  )
    return null;
  const sourceBroadcasterUserId = readNullableString(event.source_broadcaster_user_id);
  const sourceMessageId = readNullableString(event.source_message_id);
  if (!broadcasterUserId || !chatterUserId || !messageId) return null;
  if (sourceBroadcasterUserId === INVALID || sourceMessageId === INVALID) return null;
  return {
    broadcaster_user_id: broadcasterUserId,
    chatter_user_id: chatterUserId,
    ...(typeof login === 'string' ? { chatter_user_login: login.trim().toLowerCase() } : {}),
    message_id: messageId,
    source_broadcaster_user_id: sourceBroadcasterUserId,
    source_message_id: sourceMessageId,
  };
}

type SubscribeResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'transient'; readonly retryAtMs: number | null }
  | { readonly kind: 'fatal'; readonly message: string; readonly authRequired: boolean };

/** Maps a Create EventSub Subscription response onto retry policy (TWITCH_NOTES §Welcome). */
function classifySubscriptionResponse(
  response: JsonResponse,
  label: string,
  nowMs: number,
): SubscribeResult {
  const fatal = (message: string, authRequired = false): SubscribeResult => ({
    kind: 'fatal',
    message,
    authRequired,
  });
  switch (response.status) {
    case 202: {
      const created = readDataArray(response.body)?.[0];
      const status = isRecord(created) ? readString(created.status) : null;
      if (status !== 'enabled') {
        return fatal(
          `Twitch did not enable the ${label} subscription (${safeToken(status ?? 'unknown')})`,
        );
      }
      const cost = isRecord(created) ? readNumber(created.cost) : null;
      const totalCost = isRecord(response.body) ? readNumber(response.body.total_cost) : null;
      const maxCost = isRecord(response.body) ? readNumber(response.body.max_total_cost) : null;
      if (
        cost === null ||
        totalCost === null ||
        maxCost === null ||
        ![cost, totalCost, maxCost].every((value) => Number.isSafeInteger(value) && value >= 0)
      ) {
        return fatal(`Twitch returned invalid cost accounting for the ${label} subscription`);
      }
      if (cost > totalCost || totalCost > maxCost) {
        return fatal(
          `Twitch reported an exceeded EventSub cost limit for the ${label} subscription`,
        );
      }
      return { kind: 'ok' };
    }
    case 409:
      // A conflict proves only type/condition uniqueness, not delivery to THIS socket. Never
      // claim Connected when the existing subscription may belong to another app instance.
      return fatal(
        `A ${label} subscription already exists (HTTP 409). Close other copies of this app, then save channels again.`,
      );
    case 401:
      return fatal(`Twitch rejected the token while subscribing to ${label} (HTTP 401)`, true);
    case 403:
      // Also what a ban in that chat looks like: do not always blame the token's scopes.
      return fatal(
        `Twitch refused to read ${label} (HTTP 403): check this account is not banned there, or reconnect Twitch to grant user:read:chat`,
      );
    case 410:
      return fatal(
        `Twitch removed ${CHAT_SUBSCRIPTION_TYPE} v1 (HTTP 410); this app needs an update`,
      );
    case 429:
      // Waiting only helps for request-rate exhaustion, not for subscription/cost limits.
      if (response.headers.get('ratelimit-remaining') === '0') {
        return { kind: 'transient', retryAtMs: rateLimitRetryAtMs(response.headers, nowMs) };
      }
      return fatal(`EventSub subscription limit reached while subscribing to ${label} (HTTP 429)`);
    default:
      if (response.status >= 500) return { kind: 'transient', retryAtMs: null };
      return fatal(`Twitch rejected the ${label} subscription (HTTP ${response.status})`);
  }
}

/** Twitch status enums are short snake_case words; anything else is not echoed back. */
function safeToken(value: string): string {
  return /^[a-z_]{1,40}$/.test(value) ? value : 'unknown';
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function parseJsonFrame(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isWebSocketUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'wss:' || protocol === 'ws:';
  } catch {
    return false;
  }
}

function describeRevocation(reason: string, side: Side | null): string {
  switch (reason) {
    case 'authorization_revoked':
      return 'Twitch revoked chat access for this app. Connect Twitch again.';
    case 'user_removed':
      return `Twitch ${side ? `channel ${side}` : 'a channel'} is no longer available (user_removed). Choose the channel again.`;
    case 'version_removed':
      return `Twitch removed ${CHAT_SUBSCRIPTION_TYPE} v1 (version_removed); this app needs an update.`;
    case 'chat_user_banned':
      return `This Twitch account is banned from ${side ? `channel ${side}` : 'a channel'}'s chat (chat_user_banned). Ask that channel to unban it, or remove it.`;
    default:
      return side === 'B'
        ? `Twitch revoked the channel B chat subscription (${safeToken(reason)}).`
        : `Twitch revoked the chat subscription (${safeToken(reason)}). Reconnect Twitch.`;
  }
}

type Timer = ReturnType<typeof setTimeout>;

interface Connection {
  readonly ws: WebSocket;
  /** `fresh`: needs subscriptions after welcome; `handover`: target of session_reconnect. */
  readonly purpose: 'fresh' | 'handover';
  keepaliveMs: number | null;
}

export function createEventSubClient(options: EventSubOptions): EventSubClient {
  const baseUrl = options.url ?? EVENTSUB_WS_URL;
  const now = options.now ?? Date.now;
  const graceMs = options.keepaliveGraceMs ?? KEEPALIVE_GRACE_MS;
  const reconnectDelay = options.reconnectDelayMs ?? defaultReconnectDelayMs;
  const welcomeTimeoutMs = options.welcomeTimeoutMs ?? WELCOME_TIMEOUT_MS;
  const handoverTimeoutMs = options.handoverTimeoutMs ?? HANDOVER_TIMEOUT_MS;
  const envelopes = options.dedupe?.envelopes ?? createLruSet();
  const messages = options.dedupe?.messages ?? createLruSet();
  const { A, B } = options.channels;
  const hasB = B !== null && B !== A;
  const chatChannels: readonly (readonly [Side, string])[] = hasB
    ? [
        ['A', A],
        ['B', B],
      ]
    : [['A', A]];
  // normalizeChat wants both sides; '' never equals a validated (non-empty) origin ID.
  const normalizeChannels: Readonly<Record<Side, string>> = { A, B: hasB ? B : '' };

  let state: 'idle' | 'running' | 'halted' = 'idle';
  /** Socket whose session owns the subscriptions. */
  let active: Connection | null = null;
  /** Socket waiting for its welcome: a fresh connection or a session_reconnect target. */
  let candidate: Connection | null = null;
  /** Every socket not yet closed, including retired ones still finishing their close. */
  const sockets = new Set<Connection>();
  let attempt = 0;
  let watchdog: Timer | null = null;
  let candidateTimer: Timer | null = null;
  let reconnectTimer: Timer | null = null;

  function emit(event: EventSubStatusEvent): void {
    options.onStatus(event);
  }

  function clearTimers(): void {
    for (const timer of [watchdog, candidateTimer, reconnectTimer]) {
      if (timer) clearTimeout(timer);
    }
    watchdog = candidateTimer = reconnectTimer = null;
  }

  function open(target: string, purpose: Connection['purpose']): Connection {
    const ws = new WebSocket(target, {
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: MAX_PAYLOAD_BYTES,
    });
    const conn: Connection = { ws, purpose, keepaliveMs: null };
    sockets.add(conn);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) handleFrame(conn, data);
    });
    ws.on('close', () => {
      sockets.delete(conn);
      handleClose(conn);
    });
    // 'close' always follows 'error'. Nothing is logged: URLs and payloads stay private.
    ws.on('error', () => undefined);
    return conn;
  }

  function dispose(conn: Connection | null): void {
    if (!conn) return;
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.close(1000);
    else conn.ws.terminate();
  }

  function armWatchdog(): void {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    const conn = active;
    if (!conn?.keepaliveMs) return;
    watchdog = setTimeout(() => {
      watchdog = null;
      if (active === conn) restart(null);
    }, conn.keepaliveMs + graceMs);
  }

  function armCandidateTimer(conn: Connection, ms: number): void {
    if (candidateTimer) clearTimeout(candidateTimer);
    candidateTimer = setTimeout(() => {
      candidateTimer = null;
      if (candidate === conn) restart(null);
    }, ms);
  }

  function connectFresh(): void {
    if (state !== 'running') return;
    const conn = open(baseUrl, 'fresh');
    candidate = conn;
    armCandidateTimer(conn, welcomeTimeoutMs);
  }

  /** Connection lost (or unusable): drop every socket and reconnect to the base URL with backoff. */
  function restart(retryAtMs: number | null): void {
    if (state !== 'running') return;
    const stale = [active, candidate];
    active = candidate = null;
    if (watchdog) clearTimeout(watchdog);
    if (candidateTimer) clearTimeout(candidateTimer);
    watchdog = candidateTimer = null;
    for (const conn of stale) dispose(conn);
    if (reconnectTimer) return;
    attempt += 1;
    let delayMs = reconnectDelay(attempt);
    if (retryAtMs !== null) delayMs = Math.max(delayMs, Math.min(retryAtMs - now(), 60_000));
    emit({ status: 'reconnecting' });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectFresh();
    }, delayMs);
  }

  /** Stop for good and report why; recovery needs the streamer (reauthorize/choose channels). */
  function halt(event: EventSubStatusEvent): void {
    if (state !== 'running') return;
    state = 'halted';
    clearTimers();
    active = candidate = null;
    for (const conn of sockets) dispose(conn);
    emit(event);
  }

  function handleClose(conn: Connection): void {
    if (state !== 'running') return;
    if (conn === candidate) {
      // A fresh socket died before its welcome, or the handover target failed: new session.
      restart(null);
      return;
    }
    if (conn === active) {
      active = null;
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
      // During a handover Twitch may close the old socket first; the candidate takes over.
      if (candidate?.purpose === 'handover') return;
      restart(null);
    }
    // Retired sockets closing after a handover is expected.
  }

  function handleFrame(conn: Connection, data: RawData): void {
    if (state !== 'running') return;
    const envelope = parseEnvelope(parseJsonFrame(rawToString(data)));
    if (!envelope) return;
    switch (envelope.messageType) {
      case 'session_welcome':
        handleWelcome(conn, envelope.payload);
        return;
      case 'session_keepalive':
        if (conn === active) armWatchdog();
        return;
      case 'notification':
        if (conn === active) armWatchdog();
        // Overlapping sockets during a handover may both deliver: the envelope ID dedupes them.
        if (envelopes.add(envelope.messageId)) handleNotification(envelope);
        return;
      case 'session_reconnect':
        if (conn === active) handleReconnect(envelope.payload);
        return;
      case 'revocation':
        if (envelopes.add(envelope.messageId)) handleRevocation(envelope.payload);
        return;
      default:
        return;
    }
  }

  function handleWelcome(conn: Connection, payload: JsonRecord): void {
    if (conn !== candidate) return;
    const session = parseSession(payload);
    if (!session) {
      restart(null);
      return;
    }
    if (candidateTimer) clearTimeout(candidateTimer);
    candidateTimer = null;
    candidate = null;
    conn.keepaliveMs = (session.keepaliveTimeoutSeconds ?? DEFAULT_KEEPALIVE_SECONDS) * 1000;
    const previous = active;
    active = conn;
    armWatchdog();
    if (conn.purpose === 'handover') {
      // Subscriptions migrated with the session: retire the old socket, do not resubscribe.
      dispose(previous);
      attempt = 0;
      emit({ status: 'connected' });
      return;
    }
    void subscribe(conn, session.id);
  }

  async function createSubscription(body: unknown, label: string): Promise<SubscribeResult> {
    let response: JsonResponse;
    try {
      response = await options.helix.request('POST', '/eventsub/subscriptions', {
        body,
        timeoutMs: SUBSCRIBE_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof ReauthorizationRequiredError) {
        return { kind: 'fatal', message: error.message, authRequired: true };
      }
      // Network errors, timeouts and transient refresh failures: a new session may succeed.
      return { kind: 'transient', retryAtMs: null };
    }
    return classifySubscriptionResponse(response, label, now());
  }

  async function subscribe(conn: Connection, sessionId: string): Promise<void> {
    const results = await Promise.all(
      chatChannels.map(([side, broadcasterId]) =>
        createSubscription(
          chatSubscriptionBody(broadcasterId, options.tokenUserId, sessionId),
          `channel ${side} chat`,
        ),
      ),
    );
    if (state !== 'running' || active !== conn) return;
    // A failure on channel A (or of the token) stops everything; a B-only failure is reported
    // with its side so the owner can keep channel A running without the partner.
    let fatalIndex = -1;
    for (const [index, result] of results.entries()) {
      if (result.kind !== 'fatal') continue;
      if (fatalIndex < 0 || chatChannels[fatalIndex]?.[0] === 'B') fatalIndex = index;
    }
    const fatal = results[fatalIndex];
    if (fatal !== undefined && fatal.kind === 'fatal') {
      const side = fatal.authRequired ? null : (chatChannels[fatalIndex]?.[0] ?? null);
      halt({ status: 'failed', message: fatal.message, authRequired: fatal.authRequired, side });
      return;
    }
    for (const result of results) {
      if (result.kind === 'transient') {
        restart(result.retryAtMs);
        return;
      }
    }
    attempt = 0;
    emit({ status: 'connected' });
    if (hasB && options.onSharedChat) {
      // Best effort (DESIGN §Twitch "when cheap"): failures only mean `say` posts to both chats.
      await Promise.all(
        SHARED_CHAT_SUBSCRIPTION_TYPES.map((type) =>
          createSubscription(
            {
              type,
              version: '1',
              condition: { broadcaster_user_id: A },
              transport: { method: 'websocket', session_id: sessionId },
            } satisfies SharedChatSubscriptionRequest,
            type,
          ),
        ),
      );
    }
  }

  function handleNotification(envelope: Envelope): void {
    const type = envelope.subscriptionType;
    if (type === CHAT_SUBSCRIPTION_TYPE) {
      if (envelope.subscriptionVersion !== '1') return;
      const identity = parseChatNotification(envelope.payload);
      // Our own account (prompts/summaries echo back) never counts as a participant.
      if (!identity || identity.chatter_user_id === options.tokenUserId) return;
      const chat = normalizeChat(identity, normalizeChannels, now());
      // Unknown third-channel origins are dropped; Shared Chat copies share one delivery key.
      if (!chat || !messages.add(chat.messageKey)) return;
      deliver(() => options.onChat(chat));
      return;
    }
    if (type !== null && isSharedChatSubscriptionType(type)) {
      const change = parseSharedChatEvent(type, envelope.payload.event);
      const onSharedChat = options.onSharedChat;
      if (change && onSharedChat) deliver(() => onSharedChat(change));
    }
  }

  /** A consumer bug must not tear down the socket handler (it would crash the process). */
  function deliver(callback: () => void): void {
    try {
      callback();
    } catch {
      // Intentionally ignored: the event is dropped, the connection stays healthy.
    }
  }

  function handleReconnect(payload: JsonRecord): void {
    if (candidate) return; // A handover is already in progress.
    const url = parseSession(payload)?.reconnectUrl;
    if (!url || !isWebSocketUrl(url)) {
      restart(null);
      return;
    }
    // The old socket may go quiet now; the handover timer guards the switch instead.
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    const conn = open(url, 'handover');
    candidate = conn;
    armCandidateTimer(conn, handoverTimeoutMs);
  }

  function handleRevocation(payload: JsonRecord): void {
    const subscription = payload.subscription;
    if (!isRecord(subscription) || subscription.type !== CHAT_SUBSCRIPTION_TYPE) return;
    const reason = readString(subscription.status) ?? 'unknown';
    const broadcaster = isRecord(subscription.condition)
      ? readString(subscription.condition.broadcaster_user_id)
      : null;
    const side: Side | null = broadcaster === A ? 'A' : hasB && broadcaster === B ? 'B' : null;
    halt({
      status: 'revoked',
      reason: safeToken(reason),
      message: describeRevocation(reason, side),
      side,
    });
  }

  function closeAndWait(conn: Connection): Promise<void> {
    return new Promise((resolve) => {
      if (conn.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const fallback = setTimeout(() => conn.ws.terminate(), 1_000);
      conn.ws.once('close', () => {
        clearTimeout(fallback);
        resolve();
      });
      dispose(conn);
    });
  }

  return {
    async start() {
      if (state !== 'idle') return;
      state = 'running';
      emit({ status: 'connecting' });
      connectFresh();
    },
    async stop() {
      state = 'halted';
      clearTimers();
      active = candidate = null;
      await Promise.all([...sockets].map(closeAndWait));
    },
  };
}
