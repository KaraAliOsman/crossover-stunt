import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { NormalizedChatEvent } from '../src/engine/types.js';
import { REQUIRED_SCOPES } from '../src/twitch/deviceAuth.js';
import {
  ChannelLookupError,
  TwitchAuthConflictError,
  createTwitchService,
  type TwitchService,
} from '../src/twitch/service.js';
import { loadTokens, saveTokens, tokenFilePath } from '../src/twitch/tokenStore.js';

const CLIENT_ID = 'client-id';
const TS = '2026-10-31T20:00:00Z';
const SELF = { id: 'uid-a', login: 'streamer_a', display_name: 'Streamer_A' };
const PARTNER = { id: 'uid-b', login: 'partner_b', display_name: 'PartnerB' };

interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
  readonly signal: AbortSignal | null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor<T>(
  check: () => T | null | undefined | false,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Fake Twitch: id.twitch.tv + Helix over an injected fetch, EventSub over a local `ws` server that
 * welcomes every new socket with a fresh session.
 */
async function fakeTwitch(initialAccessToken = 'access-1') {
  const calls: RecordedRequest[] = [];
  const state = {
    validAccessToken: initialAccessToken,
    scopes: [...REQUIRED_SCOPES] as string[],
    sharedSession: null as null | readonly string[],
    sharedResponseGate: null as Promise<void> | null,
    deviceResponseGate: null as Promise<void> | null,
    deviceTokenGate: null as Promise<void> | null,
    validateResponseGate: null as Promise<void> | null,
    deviceFailure: null as string | null,
    deviceStartStatus: 200,
    devicePolls: 0,
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      url: new URL(href),
      headers: new Headers(init?.headers),
      body: init?.body === undefined || init.body === null ? '' : String(init.body),
      signal: init?.signal ?? null,
    };
    calls.push(request);
    const response = route(request);
    if (request.url.pathname === '/helix/shared_chat/session') await state.sharedResponseGate;
    if (request.url.pathname === '/oauth2/device') await state.deviceResponseGate;
    if (request.url.pathname === '/oauth2/token') await state.deviceTokenGate;
    if (request.url.pathname === '/oauth2/validate') await state.validateResponseGate;
    return response;
  };

  function route(request: RecordedRequest): Response {
    const { url } = request;
    const auth = request.headers.get('authorization') ?? '';
    if (url.host === 'id.twitch.tv') {
      const form = new URLSearchParams(request.body);
      switch (url.pathname) {
        case '/oauth2/validate':
          return auth === `OAuth ${state.validAccessToken}`
            ? json(200, {
                client_id: CLIENT_ID,
                login: SELF.login,
                user_id: SELF.id,
                scopes: state.scopes,
                expires_in: 14_000,
              })
            : json(401, { status: 401, message: 'invalid access token' });
        case '/oauth2/token':
          if (form.get('grant_type') === 'refresh_token') {
            if (form.get('refresh_token') !== 'refresh-1') {
              return json(400, { status: 400, message: 'Invalid refresh token' });
            }
            state.validAccessToken = 'access-2';
            return json(200, {
              access_token: 'access-2',
              refresh_token: 'refresh-2',
              expires_in: 14_400,
              scope: [...REQUIRED_SCOPES],
              token_type: 'bearer',
            });
          }
          state.devicePolls += 1;
          if (state.deviceFailure) return json(400, { message: state.deviceFailure });
          if (state.devicePolls === 1) {
            return json(400, { status: 400, message: 'authorization_pending' });
          }
          state.validAccessToken = 'access-device';
          return json(200, {
            access_token: 'access-device',
            refresh_token: 'refresh-device',
            expires_in: 14_400,
            scope: [...REQUIRED_SCOPES],
            token_type: 'bearer',
          });
        case '/oauth2/device':
          return json(state.deviceStartStatus, {
            device_code: 'device-1',
            user_code: 'WXYZ-1234',
            verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=WXYZ-1234',
            expires_in: 1800,
            interval: 5,
          });
        case '/oauth2/revoke':
          return new Response(null, { status: 200 });
      }
    }
    if (auth !== `Bearer ${state.validAccessToken}`) {
      return json(401, { status: 401, message: 'Invalid OAuth token' });
    }
    switch (`${request.method} ${url.pathname}`) {
      case 'GET /helix/users': {
        const ids = url.searchParams.getAll('id');
        const logins = url.searchParams.getAll('login');
        const data = [SELF, PARTNER].filter(
          (user) => ids.includes(user.id) || logins.includes(user.login),
        );
        return json(200, { data });
      }
      case 'POST /helix/eventsub/subscriptions':
        return json(202, {
          data: [
            { id: 'sub', status: 'enabled', cost: 0, ...(JSON.parse(request.body) as object) },
          ],
          total: 1,
          total_cost: 0,
          max_total_cost: 10,
        });
      case 'GET /helix/shared_chat/session':
        return json(200, {
          data: state.sharedSession
            ? [
                {
                  session_id: 'shared-1',
                  host_broadcaster_id: SELF.id,
                  participants: state.sharedSession.map((id) => ({ broadcaster_id: id })),
                  created_at: TS,
                  updated_at: TS,
                },
              ]
            : [],
        });
      case 'POST /helix/chat/messages':
        return json(200, { data: [{ message_id: 'sent-1', is_sent: true, drop_reason: null }] });
    }
    return json(404, { status: 404, message: 'Not Found' });
  }

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const sockets: WebSocket[] = [];
  wss.on('connection', (socket) => {
    sockets.push(socket);
    socket.send(
      JSON.stringify({
        metadata: {
          message_id: `welcome-${sockets.length}`,
          message_type: 'session_welcome',
          message_timestamp: TS,
        },
        payload: {
          session: {
            id: `session-${sockets.length}`,
            status: 'connected',
            connected_at: TS,
            keepalive_timeout_seconds: 10,
            reconnect_url: null,
          },
        },
      }),
    );
  });
  const { port } = wss.address() as AddressInfo;

  return {
    fetch: fetchFn,
    calls,
    state,
    sockets,
    eventSubUrl: `ws://127.0.0.1:${port}/ws`,
    posts: (path: string) =>
      calls.filter((call) => call.method === 'POST' && call.url.pathname === path),
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function notification(type: string, event: Record<string, unknown>, id: string): string {
  return JSON.stringify({
    metadata: {
      message_id: id,
      message_type: 'notification',
      message_timestamp: TS,
      subscription_type: type,
      subscription_version: '1',
    },
    payload: { subscription: { id: 'sub', type, version: '1', status: 'enabled' }, event },
  });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(options: { storedAccessToken?: string | null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'crossover twitch service '));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const storedAccessToken =
    options.storedAccessToken === undefined ? 'access-1' : options.storedAccessToken;
  if (storedAccessToken) {
    await saveTokens(dataDir, {
      accessToken: storedAccessToken,
      refreshToken: 'refresh-1',
      scopes: [...REQUIRED_SCOPES],
      expiresAtMs: 10_000_000_000,
    });
  }
  const twitch = await fakeTwitch();
  cleanups.push(twitch.close);
  let clock = 1_000_000;
  const chats: NormalizedChatEvent[] = [];
  let stateChanges = 0;
  const service: TwitchService = createTwitchService({
    clientId: CLIENT_ID,
    dataDir,
    onChat: (event) => chats.push(event),
    onStateChange: () => {
      stateChanges += 1;
    },
    fetch: twitch.fetch,
    eventSubUrl: twitch.eventSubUrl,
    now: () => clock,
    // Virtual time for Device Code polling and chat pacing.
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      clock += ms;
    },
    reconnectDelayMs: () => 10,
  });
  cleanups.push(() => service.stop());
  return {
    service,
    twitch,
    dataDir,
    chats,
    stateChanges: () => stateChanges,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function expectNoSecrets(value: unknown): void {
  expect(JSON.stringify(value)).not.toMatch(/access-|refresh-/);
}

describe('TwitchService', () => {
  it('starts from stored tokens, defaults A to the signed-in user and connects EventSub', async () => {
    const t = await setup();
    await t.service.start();
    await waitFor(() => t.service.getState().status === 'connected');
    const state = t.service.getState();
    expect(state).toEqual({
      status: 'connected',
      login: SELF.login,
      userId: SELF.id,
      userCode: null,
      verificationUri: null,
      error: null,
      channels: {
        A: { login: SELF.login, displayName: SELF.display_name, userId: SELF.id },
        B: null,
      },
    });
    expectNoSecrets(state);
    expect(t.stateChanges()).toBeGreaterThan(0);
    const validate = t.twitch.calls.find((call) => call.url.pathname === '/oauth2/validate');
    expect(validate?.headers.get('authorization')).toBe('OAuth access-1');
    expect(
      t.twitch
        .posts('/helix/eventsub/subscriptions')
        .map((call) => JSON.parse(call.body) as unknown),
    ).toEqual([
      {
        type: 'channel.chat.message',
        version: '1',
        condition: { broadcaster_user_id: SELF.id, user_id: SELF.id },
        transport: { method: 'websocket', session_id: 'session-1' },
      },
    ]);
  });

  it('refreshes an expired stored token once and persists the rotated pair', async () => {
    const t = await setup();
    t.twitch.state.validAccessToken = 'stale-on-server';
    await t.service.start();
    await waitFor(() => t.service.getState().status === 'connected');
    expect(t.twitch.posts('/oauth2/token')).toHaveLength(1);
    await expect(loadTokens(t.dataDir)).resolves.toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    });
  });

  it('signs out cleanly when the stored authorization cannot be refreshed', async () => {
    const t = await setup({ storedAccessToken: 'access-old' });
    t.twitch.state.validAccessToken = 'nothing-valid';
    // The fake only accepts refresh-1 once; break it so refresh is rejected.
    await saveTokens(t.dataDir, {
      accessToken: 'access-old',
      refreshToken: 'refresh-revoked',
      scopes: [...REQUIRED_SCOPES],
      expiresAtMs: 10_000_000_000,
    });
    await t.service.start();
    const state = t.service.getState();
    expect(state.status).toBe('signed-out');
    expect(state.error).toMatch(/Connect Twitch again/);
    expectNoSecrets(state);
    await expect(readFile(tokenFilePath(t.dataDir), 'utf8')).rejects.toThrow();
  });

  it('ends the session when a chat send hits a rejected refresh token', async () => {
    const t = await setup();
    // The fake only accepts refresh-1: this pair validates now but cannot be refreshed later
    // (password change, or a second server instance that already consumed the refresh token).
    await saveTokens(t.dataDir, {
      accessToken: 'access-1',
      refreshToken: 'refresh-consumed',
      scopes: [...REQUIRED_SCOPES],
      expiresAtMs: 10_000_000_000,
    });
    await t.service.start();
    await waitFor(() => t.service.getState().status === 'connected');
    // Validate reported 14 000 s of life: move to one minute before expiry so the send refreshes.
    t.advance(14_000_000 - 60_000);
    const outcome = await t.service.say(['A'], 'STUNT!');
    expect(outcome.A).toMatchObject({ ok: false });
    await waitFor(() => t.service.getState().status === 'signed-out');
    expect(t.service.getState()).toMatchObject({
      login: null,
      userId: null,
      error: 'Twitch authorization expired or was revoked. Connect Twitch again.',
      channels: { A: null },
    });
    await expect(readFile(tokenFilePath(t.dataDir), 'utf8')).rejects.toThrow();
  });

  it('rejects tokens missing a required scope', async () => {
    const t = await setup();
    t.twitch.state.scopes = ['user:read:chat'];
    await t.service.start();
    expect(t.service.getState()).toMatchObject({ status: 'signed-out', login: null });
    expect(t.service.getState().error).toMatch(/user:write:chat/);
  });

  it('refuses authorization while connecting or connected without requesting a device code', async () => {
    const t = await setup();
    await t.service.start();
    await expect(t.service.beginAuth()).rejects.toThrow(
      `Already connected as ${SELF.login}. Sign out first to switch accounts.`,
    );
    await waitFor(() => t.service.getState().status === 'connected');
    const before = t.service.getState();
    await expect(t.service.beginAuth()).rejects.toBeInstanceOf(TwitchAuthConflictError);
    expect(t.service.getState()).toEqual(before);
    expect(t.twitch.posts('/oauth2/device')).toHaveLength(0);
    expect(t.twitch.sockets).toHaveLength(1);
  });

  it('shares concurrent and pending beginAuth calls, then clears the code on success', async () => {
    const t = await setup({ storedAccessToken: null });
    const request = gate();
    const poll = gate();
    t.twitch.state.deviceResponseGate = request.promise;
    t.twitch.state.deviceTokenGate = poll.promise;
    await t.service.start();
    const first = t.service.beginAuth();
    const second = t.service.beginAuth();
    expect(t.twitch.posts('/oauth2/device')).toHaveLength(1);
    request.resolve();
    const [code, duplicate] = await Promise.all([first, second]);
    expect(duplicate).toEqual(code);
    expect(t.service.getState()).toMatchObject({ status: 'authorizing', userCode: code.userCode });
    await expect(t.service.beginAuth()).resolves.toEqual(code);
    expect(t.twitch.posts('/oauth2/device')).toHaveLength(1);
    poll.resolve();
    await waitFor(() => t.service.getState().status === 'connected');
    expect(t.service.getState()).toMatchObject({
      login: SELF.login,
      userCode: null,
      verificationUri: null,
    });
    expect(t.twitch.state.devicePolls).toBe(2);
    expect(t.twitch.sockets).toHaveLength(1);
  });

  it.each(['access_denied', 'expired_token', 'invalid device code'])(
    'clears the code after %s and permits a fresh flow',
    async (failure) => {
      const t = await setup({ storedAccessToken: null });
      t.twitch.state.deviceFailure = failure;
      await t.service.beginAuth();
      await waitFor(() => t.service.getState().error);
      expect(t.service.getState()).toMatchObject({
        status: 'signed-out',
        userCode: null,
        verificationUri: null,
      });
      t.twitch.state.deviceFailure = null;
      await t.service.beginAuth();
      await waitFor(() => t.service.getState().status === 'connected');
      expect(t.twitch.posts('/oauth2/device')).toHaveLength(2);
    },
  );

  it('clears an expired code when the local polling deadline passes', async () => {
    const t = await setup({ storedAccessToken: null });
    const poll = gate();
    t.twitch.state.deviceTokenGate = poll.promise;
    await t.service.beginAuth();
    await waitFor(() => t.twitch.state.devicePolls === 1);
    t.advance(1_800_000);
    poll.resolve();
    await waitFor(() => t.service.getState().error);
    expect(t.service.getState()).toMatchObject({
      status: 'signed-out',
      userCode: null,
      verificationUri: null,
    });
    expect(t.service.getState().error).toMatch(/expired/);
  });

  it('releases a failed initial request so Connect can be retried', async () => {
    const t = await setup({ storedAccessToken: null });
    t.twitch.state.deviceStartStatus = 503;
    await expect(t.service.beginAuth()).rejects.toThrow(/refused to start/);
    expect(t.service.getState()).toMatchObject({ status: 'signed-out', userCode: null });
    t.twitch.state.deviceStartStatus = 200;
    await t.service.beginAuth();
    await waitFor(() => t.service.getState().status === 'connected');
  });

  it('aborts a pending request without letting its late completion clear a new flow', async () => {
    const t = await setup({ storedAccessToken: null });
    const oldRequest = gate();
    const newPoll = gate();
    t.twitch.state.deviceResponseGate = oldRequest.promise;
    const first = t.service.beginAuth();
    const cancelled = expect(first).rejects.toThrow(/cancelled/);
    await t.service.signOut();
    expect(t.twitch.posts('/oauth2/device')[0]?.signal?.aborted).toBe(true);
    t.twitch.state.deviceResponseGate = null;
    t.twitch.state.deviceTokenGate = newPoll.promise;
    const nextCode = await t.service.beginAuth();
    oldRequest.resolve();
    await cancelled;
    expect(t.service.getState()).toMatchObject({
      status: 'authorizing',
      userCode: nextCode.userCode,
    });
    await expect(t.service.beginAuth()).resolves.toEqual(nextCode);
    expect(t.twitch.posts('/oauth2/device')).toHaveLength(2);
    await t.service.stop();
    newPoll.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.service.getState()).toMatchObject({ userCode: null, verificationUri: null });
    expect(t.twitch.state.devicePolls).toBe(1);
  });

  it('runs the Device Code flow from beginAuth to a connected session', async () => {
    const t = await setup({ storedAccessToken: null });
    await t.service.start();
    expect(t.service.getState().status).toBe('signed-out');
    const code = await t.service.beginAuth();
    expect(code).toEqual({
      userCode: 'WXYZ-1234',
      verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=WXYZ-1234',
    });
    await waitFor(() => t.service.getState().status === 'connected');
    expect(t.service.getState()).toMatchObject({ login: SELF.login, userCode: null });
    await expect(loadTokens(t.dataDir)).resolves.toMatchObject({ accessToken: 'access-device' });
    expect(t.twitch.state.devicePolls).toBe(2);
  });

  it('keeps the token persistence warning visible after connecting successfully', async () => {
    const t = await setup({ storedAccessToken: null });
    // A directory at the file path causes a deterministic cross-platform persistence failure.
    await mkdir(tokenFilePath(t.dataDir), { recursive: true });
    await t.service.start();
    await t.service.beginAuth();
    await waitFor(() => t.service.getState().status === 'connected');
    expect(t.service.getState().error).toMatch(/Could not save Twitch tokens/);
    await rm(tokenFilePath(t.dataDir), { recursive: true });
    await t.service.signOut();
    await t.service.beginAuth();
    await waitFor(
      () => t.service.getState().status === 'connected' && t.service.getState().error === null,
    );
    await expect(loadTokens(t.dataDir)).resolves.toMatchObject({ accessToken: 'access-device' });
  });

  it('sign-out cancels approved Device Code tokens while validation is in flight', async () => {
    const t = await setup({ storedAccessToken: null });
    const validation = gate();
    t.twitch.state.validateResponseGate = validation.promise;
    await t.service.beginAuth();
    await waitFor(() => t.twitch.calls.some((call) => call.url.pathname === '/oauth2/validate'));
    expect(t.service.getState()).toMatchObject({ status: 'connecting', userCode: null });
    await expect(t.service.beginAuth()).rejects.toBeInstanceOf(TwitchAuthConflictError);
    expect(t.twitch.posts('/oauth2/device')).toHaveLength(1);
    await t.service.signOut();
    validation.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.service.getState()).toMatchObject({ status: 'signed-out', login: null });
    await expect(loadTokens(t.dataDir)).resolves.toBeNull();
  });

  it('resolves channel B, resubscribes both channels and routes chat by origin', async () => {
    const t = await setup();
    await t.service.start();
    await waitFor(() => t.service.getState().status === 'connected');
    await expect(t.service.setChannels({ b: 'not a login!' })).rejects.toBeInstanceOf(
      ChannelLookupError,
    );
    await expect(t.service.setChannels({ b: 'nobody_here' })).rejects.toMatchObject({
      code: 'not-found',
    });
    await t.service.setChannels({ b: '@Partner_B' });
    expect(t.service.getState().channels.B).toEqual({
      login: PARTNER.login,
      displayName: PARTNER.display_name,
      userId: PARTNER.id,
    });
    await waitFor(
      () => t.twitch.sockets.length === 2 && t.service.getState().status === 'connected',
    );
    await waitFor(() => t.twitch.sockets[0]?.readyState === WebSocket.CLOSED);
    const chatSubs = t.twitch
      .posts('/helix/eventsub/subscriptions')
      .map(
        (call) =>
          JSON.parse(call.body) as {
            type: string;
            condition: Record<string, string>;
            transport: { session_id: string };
          },
      )
      .filter((body) => body.transport.session_id === 'session-2');
    expect(
      chatSubs.filter((body) => body.type === 'channel.chat.message').map((body) => body.condition),
    ).toEqual([
      { broadcaster_user_id: SELF.id, user_id: SELF.id },
      { broadcaster_user_id: PARTNER.id, user_id: SELF.id },
    ]);

    const socket = t.twitch.sockets[1];
    socket?.send(
      notification(
        'channel.chat.message',
        {
          broadcaster_user_id: PARTNER.id,
          chatter_user_id: 'viewer-1',
          message_id: 'msg-1',
          message: { text: 'hi' },
        },
        'env-1',
      ),
    );
    // The streamer's own account (our sender) never counts.
    socket?.send(
      notification(
        'channel.chat.message',
        { broadcaster_user_id: SELF.id, chatter_user_id: SELF.id, message_id: 'msg-2' },
        'env-2',
      ),
    );
    await waitFor(() => t.chats.length === 1);
    expect(t.chats[0]).toMatchObject({ side: 'B', chatterId: 'viewer-1', messageKey: 'msg-1' });

    await expect(t.service.setChannels({ b: SELF.login })).rejects.toMatchObject({
      code: 'invalid-login',
    });
  });

  it('keeps one EventSub socket when channel saves overlap', async () => {
    const t = await setup();
    await t.service.start();
    await waitFor(() => t.service.getState().status === 'connected');
    await Promise.all([
      t.service.setChannels({ b: PARTNER.login }),
      t.service.setChannels({ b: PARTNER.login }),
    ]);
    await waitFor(() => t.service.getState().status === 'connected');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(t.twitch.sockets.filter((socket) => socket.readyState === WebSocket.OPEN)).toHaveLength(
      1,
    );
  });

  it('keeps reading channel A when only channel B is revoked (banned in the partner chat)', async () => {
    const t = await setup();
    await t.service.start();
    await waitFor(() => t.service.getState().status === 'connected');
    await t.service.setChannels({ b: PARTNER.login });
    await waitFor(
      () => t.twitch.sockets.length === 2 && t.service.getState().status === 'connected',
    );
    t.twitch.sockets[1]?.send(
      JSON.stringify({
        metadata: {
          message_id: 'revoke-1',
          message_type: 'revocation',
          message_timestamp: TS,
          subscription_type: 'channel.chat.message',
          subscription_version: '1',
        },
        payload: {
          subscription: {
            id: 'sub',
            status: 'chat_user_banned',
            type: 'channel.chat.message',
            version: '1',
            condition: { broadcaster_user_id: PARTNER.id, user_id: SELF.id },
            transport: { method: 'websocket', session_id: 'session-2' },
            created_at: TS,
          },
        },
      }),
    );
    await waitFor(
      () => t.twitch.sockets.length === 3 && t.service.getState().status === 'connected',
    );
    const state = t.service.getState();
    expect(state.channels).toMatchObject({ A: { userId: SELF.id }, B: null });
    expect(state.error).toMatch(/banned from channel B's chat/);
    expect(state.error).toMatch(/channel A keeps counting/);
    const session3 = t.twitch
      .posts('/helix/eventsub/subscriptions')
      .map((call) => JSON.parse(call.body) as { transport: { session_id: string } })
      .filter((body) => body.transport.session_id === 'session-3');
    expect(session3).toEqual([
      expect.objectContaining({ condition: { broadcaster_user_id: SELF.id, user_id: SELF.id } }),
    ]);
    t.twitch.sockets[2]?.send(
      notification(
        'channel.chat.message',
        { broadcaster_user_id: SELF.id, chatter_user_id: 'viewer-a2', message_id: 'msg-a2' },
        'env-a2',
      ),
    );
    await waitFor(() => t.chats.some((chat) => chat.chatterId === 'viewer-a2'));
    // Saving channels again clears the notice (and retries B).
    await t.service.setChannels({ b: null });
    expect(t.service.getState().error).toBeNull();
  });

  it('says once per Shared Chat session and once per channel otherwise', async () => {
    const t = await setup();
    await t.service.start();
    await waitFor(() => t.service.getState().status === 'connected');
    await t.service.setChannels({ b: PARTNER.login });
    await waitFor(
      () => t.twitch.sockets.length === 2 && t.service.getState().status === 'connected',
    );
    const chatPosts = () =>
      t.twitch
        .posts('/helix/chat/messages')
        .map((call) => JSON.parse(call.body) as Record<string, unknown>);

    await expect(t.service.say(['A', 'B'], 'STUNT! Type anything in chat — 45s.')).resolves.toEqual(
      {
        A: { ok: true, reason: null },
        B: { ok: true, reason: null },
      },
    );
    expect(chatPosts().map((body) => body.broadcaster_id)).toEqual([SELF.id, PARTNER.id]);
    expect(chatPosts()[0]).toEqual({
      broadcaster_id: SELF.id,
      sender_id: SELF.id,
      message: 'STUNT! Type anything in chat — 45s.',
    });

    const socket = t.twitch.sockets[1];
    socket?.send(
      notification(
        'channel.shared_chat.begin',
        {
          session_id: 'shared-1',
          broadcaster_user_id: SELF.id,
          host_broadcaster_user_id: SELF.id,
          participants: [{ broadcaster_user_id: SELF.id }, { broadcaster_user_id: PARTNER.id }],
        },
        'env-begin',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(t.service.say(['A', 'B'], '12 people made this')).resolves.toEqual({
      A: { ok: true, reason: null },
      B: { ok: true, reason: null },
    });
    expect(
      chatPosts()
        .slice(2)
        .map((body) => body.broadcaster_id),
    ).toEqual([SELF.id]);

    socket?.send(
      notification(
        'channel.shared_chat.end',
        { session_id: 'shared-1', broadcaster_user_id: SELF.id, host_broadcaster_user_id: SELF.id },
        'env-end',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await t.service.say(['A', 'B'], 'SO CLOSE');
    expect(
      chatPosts()
        .slice(3)
        .map((body) => body.broadcaster_id),
    ).toEqual([SELF.id, PARTNER.id]);
  });

  it('seeds Shared Chat state from Helix when the session already exists', async () => {
    const t = await setup();
    t.twitch.state.sharedSession = [SELF.id, PARTNER.id];
    await t.service.start();
    await waitFor(() => t.service.getState().status === 'connected');
    await t.service.setChannels({ b: PARTNER.login });
    await waitFor(() =>
      t.twitch.calls.some((call) => call.url.pathname === '/helix/shared_chat/session'),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await t.service.say(['A', 'B'], 'STUNT!');
    expect(t.twitch.posts('/helix/chat/messages')).toHaveLength(1);
  });

  it('does not restore an ended Shared Chat session from a delayed Helix seed', async () => {
    const t = await setup();
    await t.service.start();
    await waitFor(() => t.service.getState().status === 'connected');
    let release: () => void = () => undefined;
    t.twitch.state.sharedResponseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.twitch.state.sharedSession = [SELF.id, PARTNER.id];
    await t.service.setChannels({ b: PARTNER.login });
    await waitFor(() =>
      t.twitch.calls.some((call) => call.url.pathname === '/helix/shared_chat/session'),
    );
    t.twitch.sockets[1]?.send(
      notification(
        'channel.shared_chat.end',
        {
          session_id: 'shared-1',
          broadcaster_user_id: SELF.id,
          host_broadcaster_user_id: SELF.id,
        },
        'ended-while-seeding',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await t.service.say(['A', 'B'], 'STUNT! Separate chats');
    expect(t.twitch.posts('/helix/chat/messages')).toHaveLength(2);
  });

  it('reports per-side failures from say without throwing', async () => {
    const t = await setup({ storedAccessToken: null });
    await t.service.start();
    await expect(t.service.say(['A', 'B'], 'hello')).resolves.toEqual({
      A: { ok: false, reason: 'Not signed in to Twitch' },
      B: { ok: false, reason: 'Not signed in to Twitch' },
    });
    const live = await setup();
    await live.service.start();
    await waitFor(() => live.service.getState().status === 'connected');
    await expect(live.service.say(['B'], 'hello')).resolves.toEqual({
      B: { ok: false, reason: 'No Twitch channel configured for side B' },
    });
  });

  it('signs out: revokes, deletes tokens.json and closes EventSub', async () => {
    const t = await setup();
    await t.service.start();
    await waitFor(() => t.service.getState().status === 'connected');
    await t.service.signOut();
    expect(t.service.getState()).toMatchObject({
      status: 'signed-out',
      login: null,
      error: null,
      channels: { A: null, B: null },
    });
    const revoke = t.twitch.posts('/oauth2/revoke')[0];
    expect(Object.fromEntries(new URLSearchParams(revoke?.body))).toEqual({
      client_id: CLIENT_ID,
      token: 'access-1',
    });
    await expect(readFile(tokenFilePath(t.dataDir), 'utf8')).rejects.toThrow();
    await waitFor(() => t.twitch.sockets[0]?.readyState === WebSocket.CLOSED);
  });

  it('explains a missing client ID instead of failing silently', async () => {
    const service = createTwitchService({
      clientId: '',
      dataDir: join(tmpdir(), 'unused crossover data'),
      onChat: () => undefined,
      onStateChange: () => undefined,
    });
    await service.start();
    expect(service.getState()).toMatchObject({ status: 'signed-out' });
    expect(service.getState().error).toMatch(/TWITCH_CLIENT_ID/);
    await expect(service.beginAuth()).rejects.toThrow(/TWITCH_CLIENT_ID/);
  });
});
