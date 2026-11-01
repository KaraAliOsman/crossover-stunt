import type { NormalizedChatEvent, Side } from '../engine/types.js';
import type { ChannelInfo, TwitchStatus } from '../shared/protocol.js';
import { createLruSet } from './dedupe.js';
import {
  DeviceAuthError,
  TokenRejectedError,
  awaitDeviceTokens,
  missingScopes,
  requestDeviceCode,
  revokeToken,
  validateToken,
  type AuthDeps,
  type DeviceAuthorization,
  type ValidatedToken,
} from './deviceAuth.js';
import {
  createEventSubClient,
  type EventSubClient,
  type EventSubStatusEvent,
} from './eventsubWs.js';
import { createHelixClient } from './helix.js';
import { createChatQueue, sendChatMessage, type ChatOutcome } from './helixChat.js';
import { ChannelLookupError, getUsers, normalizeLogin } from './helixUsers.js';
import { TwitchHttpError, TwitchNetworkError, defaultSleep, type SleepFn } from './http.js';
import { createSharedChatTracker, fetchSharedChatSession } from './sharedChat.js';
import { ReauthorizationRequiredError, createTokenManager } from './tokenStore.js';

export { ChannelLookupError, normalizeLogin } from './helixUsers.js';

/**
 * Facade the server uses for everything Twitch. Owns tokens (data/tokens.json, gitignored),
 * Device Code auth, hourly validation, serialized refresh, user lookup, the single EventSub
 * WebSocket with one channel.chat.message subscription per configured channel, and a
 * rate-limited Helix Send Chat Message queue. See docs/DESIGN.md §Twitch.
 */
export interface TwitchServiceOptions {
  readonly clientId: string;
  /** Directory for the token file; created if missing. */
  readonly dataDir: string;
  readonly onChat: (chat: NormalizedChatEvent) => void;
  readonly onStateChange: () => void;
  /** Injectable for tests. */
  readonly fetch?: typeof fetch;
  readonly eventSubUrl?: string;
  readonly now?: () => number;
}

export interface TwitchServiceState {
  readonly status: TwitchStatus;
  readonly login: string | null;
  readonly userId: string | null;
  readonly userCode: string | null;
  readonly verificationUri: string | null;
  readonly error: string | null;
  readonly channels: Readonly<Record<Side, ChannelInfo | null>>;
}

export interface TwitchService {
  /** Loads stored tokens (if any), validates them and connects EventSub when channels are set. */
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): TwitchServiceState;
  /** Starts Device Code flow; resolves once the code is available (polling continues). */
  beginAuth(): Promise<{ readonly userCode: string; readonly verificationUri: string }>;
  signOut(): Promise<void>;
  /**
   * Resolves logins with Helix Get Users and (re)subscribes. Side A defaults to the signed-in
   * user when `a` is omitted. `b: null` removes side B.
   */
  setChannels(logins: { readonly a?: string; readonly b?: string | null }): Promise<void>;
  /**
   * Sends one message to each listed side's chat (deduplicated when both sides are in the same
   * Shared Chat session). Never throws for drops: returns per-side outcome.
   */
  say(
    sides: readonly Side[],
    message: string,
  ): Promise<
    Readonly<Partial<Record<Side, { readonly ok: boolean; readonly reason: string | null }>>>
  >;
}

/**
 * Optional timing knobs, mainly for tests. Production callers pass only TwitchServiceOptions and
 * get Twitch's documented defaults.
 */
export interface TwitchServiceTuning {
  /** Token validation period (default: hourly, as Twitch requires). */
  readonly validateIntervalMs?: number;
  /** Added to EventSub's keepalive timeout before reconnecting (default 3 000 ms). */
  readonly keepaliveGraceMs?: number;
  /** EventSub reconnect backoff for attempt n (1-based). */
  readonly reconnectDelayMs?: (attempt: number) => number;
  /** Abortable sleep used by Device Code polling and chat pacing. */
  readonly sleep?: SleepFn;
}

const VALIDATE_INTERVAL_MS = 60 * 60_000;
/** Retry period when Twitch could not be reached to validate the session. */
const VALIDATE_RETRY_MS = 60_000;
const MISSING_CLIENT_ID =
  'TWITCH_CLIENT_ID is not set. Register a Public app at dev.twitch.tv and add its Client ID to .env.';
const REAUTHORIZE = 'Twitch authorization expired or was revoked. Connect Twitch again.';

type ConnectionStatus = Exclude<TwitchStatus, 'demo' | 'authorizing'>;
type SayResult = Partial<Record<Side, ChatOutcome>>;

interface Identity {
  readonly login: string;
  readonly userId: string;
}

interface PendingDevice {
  readonly userCode: string;
  readonly verificationUri: string;
}

/** Safe for local controls; authorization must not replace a session implicitly. */
export class TwitchAuthConflictError extends Error {
  override readonly name = 'TwitchAuthConflictError';
}

/** Only errors created by this module family carry messages known to be token-free. */
function safeMessage(error: unknown): string {
  if (
    error instanceof TwitchHttpError ||
    error instanceof TwitchNetworkError ||
    error instanceof DeviceAuthError ||
    error instanceof TokenRejectedError ||
    error instanceof ReauthorizationRequiredError ||
    error instanceof ChannelLookupError
  ) {
    return error.message;
  }
  return 'Unexpected error while talking to Twitch';
}

export function createTwitchService(
  options: TwitchServiceOptions & TwitchServiceTuning,
): TwitchService {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deps: AuthDeps = { fetch: fetchFn, now, sleep };
  const validateIntervalMs = options.validateIntervalMs ?? VALIDATE_INTERVAL_MS;

  let connection: ConnectionStatus = 'signed-out';
  let identity: Identity | null = null;
  let device: PendingDevice | null = null;
  let error: string | null = null;
  /** Why channel B was dropped (ban, revocation, refused subscription) while A keeps working. */
  let partnerNotice: string | null = null;
  /** Keep storage failures visible when successful auth/connection clears a transient error. */
  let persistenceNotice: string | null = null;
  let channels: Readonly<Record<Side, ChannelInfo | null>> = { A: null, B: null };
  let authAbort: AbortController | null = null;
  /** Shares the initial request even before Twitch has returned a device code. */
  let authStart: ReturnType<TwitchService['beginAuth']> | null = null;
  let eventSub: EventSubClient | null = null;
  /** Invalidates connection work superseded by another channel save, sign-out or stop. */
  let eventSubGeneration = 0;
  let validateTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped whenever the signed-in session ends or is replaced; stale async work compares it. */
  let generation = 0;
  let lastEmitted = '';

  // Shared across EventSub clients so channel changes and reconnects never double-deliver.
  const dedupe = { envelopes: createLruSet(), messages: createLruSet() };
  const sharedChat = createSharedChatTracker();
  let sharedChatRevision = 0;
  const tokens = createTokenManager({
    clientId: options.clientId,
    dataDir: options.dataDir,
    deps,
    onPersistFailure: () => {
      persistenceNotice =
        'Could not save Twitch tokens to the data directory; reconnect after a restart.';
      emit();
    },
    onPersistSuccess: () => {
      persistenceNotice = null;
      emit();
    },
    // A rejected refresh (often inside say()) already deleted the tokens: end the session now
    // so the panel shows signed-out + Connect instead of a stale "Connected" for up to an hour.
    // Without an identity (startup validation) establishSession handles it itself.
    onReauthorizationRequired: () => {
      if (identity) void endSession(REAUTHORIZE);
    },
  });
  const helix = createHelixClient({ clientId: options.clientId, tokens, fetch: fetchFn });
  const chatQueue = createChatQueue({
    send: (request) => sendChatMessage(helix, request, now()),
    now,
    sleep,
  });

  function redact(message: string | null): string | null {
    if (message === null) return null;
    let out = message;
    for (const secret of tokens.secrets()) out = out.split(secret).join('[redacted]');
    return out;
  }

  function getState(): TwitchServiceState {
    const notices = [error ?? partnerNotice, persistenceNotice]
      .filter((value) => value !== null)
      .join(' ');
    return {
      status: device ? 'authorizing' : connection,
      login: identity?.login ?? null,
      userId: identity?.userId ?? null,
      userCode: device?.userCode ?? null,
      verificationUri: device?.verificationUri ?? null,
      error: redact(notices || null),
      channels: { A: channels.A, B: channels.B },
    };
  }

  /** Notifies the server only when the observable state actually changed. */
  function emit(): void {
    const key = JSON.stringify(getState());
    if (key === lastEmitted) return;
    lastEmitted = key;
    options.onStateChange();
  }

  function clearValidateTimer(): void {
    if (validateTimer) clearTimeout(validateTimer);
    validateTimer = null;
  }

  function scheduleValidation(delayMs: number): void {
    clearValidateTimer();
    const gen = generation;
    validateTimer = setTimeout(() => {
      validateTimer = null;
      if (gen === generation) void periodicValidation();
    }, delayMs);
    validateTimer.unref();
  }

  async function stopEventSub(): Promise<void> {
    eventSubGeneration += 1;
    const client = eventSub;
    eventSub = null;
    sharedChatRevision += 1;
    sharedChat.clear();
    if (client) await client.stop();
  }

  /** Ends the signed-in session in memory (tokens must already be cleared if invalid). */
  async function endSession(message: string | null): Promise<void> {
    generation += 1;
    clearValidateTimer();
    await stopEventSub();
    if (identity && channels.A?.userId === identity.userId) channels = { ...channels, A: null };
    identity = null;
    connection = 'signed-out';
    error = message;
    partnerNotice = null;
    persistenceNotice = null;
    emit();
  }

  async function validateWithRefresh(): Promise<ValidatedToken> {
    const token = await tokens.getAccessToken();
    try {
      return await validateToken(token, deps);
    } catch (failure) {
      if (!(failure instanceof TokenRejectedError)) throw failure;
      return validateToken(await tokens.refresh(token), deps);
    }
  }

  function tokenProblem(validated: ValidatedToken): string | null {
    if (validated.client_id !== options.clientId) {
      return 'The saved Twitch authorization belongs to a different Client ID. Connect Twitch again.';
    }
    const missing = missingScopes(validated.scopes);
    if (missing.length > 0) {
      return `Twitch authorization is missing ${missing.join(', ')}. Connect Twitch again.`;
    }
    return null;
  }

  async function dropInvalidSession(message: string): Promise<void> {
    await tokens.clear();
    await endSession(message);
  }

  async function establishSession(): Promise<void> {
    const gen = generation;
    connection = 'connecting';
    emit();
    let validated: ValidatedToken;
    try {
      validated = await validateWithRefresh();
    } catch (failure) {
      if (gen !== generation) return;
      if (
        failure instanceof ReauthorizationRequiredError ||
        failure instanceof TokenRejectedError
      ) {
        await dropInvalidSession(REAUTHORIZE);
        return;
      }
      connection = 'error';
      error = `Could not validate the Twitch session (${safeMessage(failure)}); retrying in a minute.`;
      emit();
      scheduleValidation(VALIDATE_RETRY_MS);
      return;
    }
    if (gen !== generation) return;
    const problem = tokenProblem(validated);
    if (problem) {
      await dropInvalidSession(problem);
      return;
    }
    if (
      identity &&
      identity.userId !== validated.user_id &&
      channels.A?.userId === identity.userId
    ) {
      channels = { ...channels, A: null };
    }
    identity = { login: validated.login, userId: validated.user_id };
    tokens.noteExpiresIn(validated.expires_in);
    error = null;
    scheduleValidation(validateIntervalMs);
    if (!channels.A) {
      const self = await resolveSelf(identity);
      if (gen !== generation) return;
      channels = { ...channels, A: self };
    }
    emit();
    await connectEventSub();
  }

  /** Hourly validation (Twitch requirement) and retry after a failed startup validation. */
  async function periodicValidation(): Promise<void> {
    if (!identity) {
      await establishSession();
      return;
    }
    const gen = generation;
    const current = identity;
    try {
      const validated = await validateWithRefresh();
      if (gen !== generation) return;
      const problem =
        tokenProblem(validated) ??
        (validated.user_id === current.userId
          ? null
          : 'The Twitch account changed. Connect again.');
      if (problem) {
        await dropInvalidSession(problem);
        return;
      }
      tokens.noteExpiresIn(validated.expires_in);
      scheduleValidation(validateIntervalMs);
    } catch (failure) {
      if (gen !== generation) return;
      if (
        failure instanceof ReauthorizationRequiredError ||
        failure instanceof TokenRejectedError
      ) {
        await dropInvalidSession(REAUTHORIZE);
        return;
      }
      scheduleValidation(VALIDATE_RETRY_MS);
    }
  }

  async function resolveSelf(self: Identity): Promise<ChannelInfo> {
    try {
      const [user] = await getUsers(helix, { ids: [self.userId] });
      if (user && user.userId === self.userId) return user;
    } catch {
      // Fall through: the validated login is enough to read chat; display name is cosmetic.
    }
    return { login: self.login, displayName: self.login, userId: self.userId };
  }

  async function connectEventSub(): Promise<void> {
    const stopping = stopEventSub();
    const gen = eventSubGeneration;
    await stopping;
    if (gen !== eventSubGeneration) return;
    const self = identity;
    const a = channels.A;
    if (!self || !a) return;
    const client: EventSubClient = createEventSubClient({
      helix,
      tokenUserId: self.userId,
      channels: { A: a.userId, B: channels.B?.userId ?? null },
      onChat: (chat) => {
        if (eventSub === client) options.onChat(chat);
      },
      onStatus: (event) => {
        if (eventSub === client) void handleEventSubStatus(event);
      },
      onSharedChat: (change) => {
        if (eventSub === client) {
          sharedChatRevision += 1;
          sharedChat.apply(change);
        }
      },
      now,
      dedupe,
      ...(options.eventSubUrl === undefined ? {} : { url: options.eventSubUrl }),
      ...(options.keepaliveGraceMs === undefined
        ? {}
        : { keepaliveGraceMs: options.keepaliveGraceMs }),
      ...(options.reconnectDelayMs === undefined
        ? {}
        : { reconnectDelayMs: options.reconnectDelayMs }),
    });
    eventSub = client;
    await client.start();
  }

  /**
   * A failure that only concerns the partner channel (banned there, revoked, refused) must not
   * stop channel A: drop B, keep reading A on a fresh session, and explain it on the panel.
   * Crossover CALLs are then refused (no B) while single mode keeps working.
   */
  async function dropPartner(event: EventSubStatusEvent): Promise<boolean> {
    if (event.status !== 'failed' && event.status !== 'revoked') return false;
    const partner = channels.B;
    if (event.side !== 'B' || partner === null || !channels.A) return false;
    if (event.status === 'failed' && event.authRequired) return false;
    if (event.status === 'revoked' && event.reason === 'authorization_revoked') return false;
    channels = { ...channels, B: null };
    partnerNotice =
      `${event.message} Channel B (${partner.login}) was removed so channel A keeps counting; ` +
      'single mode works. Save channel B again once that is fixed.';
    emit();
    await connectEventSub();
    return true;
  }

  async function handleEventSubStatus(event: EventSubStatusEvent): Promise<void> {
    if (await dropPartner(event)) return;
    switch (event.status) {
      case 'connecting':
      case 'reconnecting':
        connection = event.status;
        break;
      case 'connected':
        connection = 'connected';
        error = null;
        void seedSharedChat();
        break;
      case 'failed':
        if (event.authRequired) {
          await dropInvalidSession(event.message);
          return;
        }
        connection = 'error';
        error = event.message;
        break;
      case 'revoked':
        connection = 'error';
        error = event.message;
        // Revoked consent also invalidates the token: validate now so the panel offers Connect.
        if (event.reason === 'authorization_revoked') void periodicValidation();
        break;
    }
    emit();
  }

  /** Shared Chat sessions that began before we connected are only visible through Helix. */
  async function seedSharedChat(): Promise<void> {
    const client = eventSub;
    const a = channels.A;
    if (!a || !channels.B) return;
    const revision = sharedChatRevision;
    const change = await fetchSharedChatSession(helix, a.userId);
    // EventSub changes observed during the lookup are newer than its HTTP snapshot.
    if (change && eventSub === client && revision === sharedChatRevision) sharedChat.apply(change);
  }

  function cancelAuth(): void {
    authAbort?.abort();
    authAbort = null;
    authStart = null;
    device = null;
  }

  async function pollForTokens(code: DeviceAuthorization, controller: AbortController) {
    try {
      const set = await awaitDeviceTokens(options.clientId, code, controller.signal, deps);
      if (controller.signal.aborted || authAbort !== controller) return;
      // Consent is complete. Keep ownership until session setup finishes, but hide the code now.
      device = null;
      connection = 'connecting';
      emit();
      // The new authorization supersedes whatever session was running.
      const gen = ++generation;
      clearValidateTimer();
      await stopEventSub();
      if (controller.signal.aborted || gen !== generation) return;
      await tokens.replace(set);
      if (controller.signal.aborted || gen !== generation) return;
      await establishSession();
    } catch (failure) {
      if (controller.signal.aborted || authAbort !== controller) return;
      if (!device && connection === 'connecting') connection = 'error';
      error = safeMessage(failure);
    } finally {
      // A cancelled, older flow must never clear the next flow's controller/code.
      if (authAbort === controller) {
        authAbort = null;
        device = null;
        emit();
      }
    }
  }

  async function startAuth(controller: AbortController) {
    try {
      const code = await requestDeviceCode(options.clientId, deps, controller.signal);
      controller.signal.throwIfAborted();
      device = {
        userCode: code.user_code,
        verificationUri: code.verification_uri,
      };
      error = null;
      emit();
      void pollForTokens(code, controller);
      return { userCode: code.user_code, verificationUri: code.verification_uri };
    } catch (failure) {
      if (controller.signal.aborted || authAbort !== controller) {
        throw new Error('Twitch authorization was cancelled');
      }
      authAbort = null;
      device = null;
      error = safeMessage(failure);
      emit();
      throw new Error(error);
    } finally {
      if (authAbort === controller || authAbort === null) authStart = null;
    }
  }

  function lookupFailure(failure: unknown): ChannelLookupError {
    if (failure instanceof ChannelLookupError) return failure;
    return new ChannelLookupError(
      'failed',
      `Could not look up Twitch channels: ${safeMessage(failure)}`,
    );
  }

  return {
    async start() {
      if (!options.clientId) {
        connection = 'signed-out';
        error = MISSING_CLIENT_ID;
        emit();
        return;
      }
      const gen = generation;
      const loaded = await tokens.load();
      if (gen !== generation) return;
      if (!loaded) {
        connection = 'signed-out';
        emit();
        return;
      }
      await establishSession();
    },

    async stop() {
      generation += 1;
      cancelAuth();
      clearValidateTimer();
      await stopEventSub();
      chatQueue.cancelAll('Twitch service stopped');
    },

    getState,

    async beginAuth() {
      if (!options.clientId) throw new Error(MISSING_CLIENT_ID);
      if (identity && ['connected', 'connecting', 'reconnecting'].includes(connection)) {
        throw new TwitchAuthConflictError(
          `Already connected as ${identity.login}. Sign out first to switch accounts.`,
        );
      }
      if (authStart) return authStart;
      if (device && authAbort) {
        return { userCode: device.userCode, verificationUri: device.verificationUri };
      }
      if (authAbort) {
        throw new TwitchAuthConflictError('Twitch authorization is completing. Please wait.');
      }
      const controller = new AbortController();
      authAbort = controller;
      authStart = startAuth(controller);
      return authStart;
    },

    async signOut() {
      cancelAuth();
      chatQueue.cancelAll('Signed out of Twitch');
      await endSession(null);
      const { droppedAccessToken, fileRemoved } = await tokens.clear();
      if (droppedAccessToken && options.clientId) {
        // Best effort: a failed revoke only means the token lives until it expires.
        await revokeToken(options.clientId, droppedAccessToken, deps).catch(() => undefined);
      }
      if (!fileRemoved) {
        error =
          'Signed out, but the saved token file could not be deleted from the data directory.';
      }
      emit();
    },

    async setChannels(logins) {
      const self = identity;
      if (!self) {
        throw new ChannelLookupError('not-signed-in', 'Connect Twitch before choosing channels.');
      }
      const gen = generation;
      // `a`: omitted or blank → the signed-in user. `b`: omitted → keep, null/blank → remove.
      let aLogin: string | null = null;
      if (logins.a !== undefined && logins.a.trim() !== '') {
        aLogin = normalizeLogin(logins.a);
        if (!aLogin) {
          throw new ChannelLookupError('invalid-login', 'Channel A is not a valid Twitch login.');
        }
        if (aLogin === self.login.toLowerCase()) aLogin = null;
      }
      let bLogin: string | null | undefined;
      if (logins.b === null || (logins.b !== undefined && logins.b.trim() === '')) {
        bLogin = null;
      } else if (logins.b !== undefined) {
        bLogin = normalizeLogin(logins.b);
        if (!bLogin) {
          throw new ChannelLookupError('invalid-login', 'Channel B is not a valid Twitch login.');
        }
      }

      const lookupLogins = [aLogin, bLogin].filter((login): login is string => Boolean(login));
      const needSelf = aLogin === null && channels.A?.userId !== self.userId;
      let users: ChannelInfo[] = [];
      if (lookupLogins.length > 0 || needSelf) {
        try {
          users = await getUsers(helix, {
            logins: lookupLogins,
            ids: needSelf ? [self.userId] : [],
          });
        } catch (failure) {
          if (failure instanceof ReauthorizationRequiredError) await endSession(failure.message);
          throw lookupFailure(failure);
        }
      }
      if (gen !== generation) {
        throw new ChannelLookupError('not-signed-in', 'The Twitch session changed; try again.');
      }
      const byLogin = (login: string, side: Side): ChannelInfo => {
        const user = users.find((candidate) => candidate.login.toLowerCase() === login);
        if (!user) {
          throw new ChannelLookupError(
            'not-found',
            `Channel ${side}: Twitch user "${login}" not found.`,
          );
        }
        return user;
      };
      const nextA: ChannelInfo =
        aLogin !== null
          ? byLogin(aLogin, 'A')
          : channels.A?.userId === self.userId
            ? channels.A
            : (users.find((user) => user.userId === self.userId) ?? {
                login: self.login,
                displayName: self.login,
                userId: self.userId,
              });
      const nextB =
        bLogin === undefined ? channels.B : bLogin === null ? null : byLogin(bLogin, 'B');
      if (nextB && nextB.userId === nextA.userId) {
        throw new ChannelLookupError(
          'invalid-login',
          'Channel B must be a different channel than A.',
        );
      }
      const changed = nextA.userId !== channels.A?.userId || nextB?.userId !== channels.B?.userId;
      channels = { A: nextA, B: nextB };
      partnerNotice = null;
      emit();
      // Resubscribing means a new socket: simplest correct way to change the subscription set.
      if (changed || !eventSub || connection === 'error') await connectEventSub();
    },

    async say(sides, message) {
      const result: SayResult = {};
      const requested = [...new Set(sides)];
      const self = identity;
      if (!self) {
        for (const side of requested) {
          result[side] = { ok: false, reason: 'Not signed in to Twitch' };
        }
        return result;
      }
      const a = channels.A;
      const targets = new Map<string, Side[]>();
      for (const side of requested) {
        const channel = channels[side];
        if (!channel) {
          result[side] = { ok: false, reason: `No Twitch channel configured for side ${side}` };
          continue;
        }
        let broadcasterId = channel.userId;
        // A user-token send propagates to every channel of a Shared Chat session (and
        // for_source_only is not allowed), so one message to A already reaches B's chat.
        if (
          side === 'B' &&
          a &&
          requested.includes('A') &&
          sharedChat.sharesSession(a.userId, broadcasterId)
        ) {
          broadcasterId = a.userId;
        }
        targets.set(broadcasterId, [...(targets.get(broadcasterId) ?? []), side]);
      }
      await Promise.all(
        [...targets].map(async ([broadcasterId, targetSides]) => {
          const outcome = await chatQueue.enqueue({
            broadcaster_id: broadcasterId,
            sender_id: self.userId,
            message,
          });
          for (const side of targetSides) result[side] = outcome;
        }),
      );
      return result;
    },
  };
}
