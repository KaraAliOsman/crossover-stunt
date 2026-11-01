import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { NormalizedChatEvent } from '../src/engine/types.js';
import {
  createEventSubClient,
  parseChatNotification,
  type EventSubClient,
  type EventSubOptions,
  type EventSubStatusEvent,
} from '../src/twitch/eventsubWs.js';
import { createHelixClient } from '../src/twitch/helix.js';
import type { SharedChatChange } from '../src/twitch/sharedChat.js';

const CHANNELS = { A: 'chan-a', B: 'chan-b' } as const;
const READER = 'reader-user';
const TS = '2026-10-31T20:00:00.123456789Z';

interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
}

function fakeFetch(handler: (request: RecordedRequest) => Response | Promise<Response>) {
  const calls: RecordedRequest[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      url: new URL(href),
      headers: new Headers(init?.headers),
      body: init?.body === undefined || init.body === null ? '' : String(init.body),
    };
    calls.push(request);
    return handler(request);
  };
  return { fetch: fetchFn, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function subscriptionCreated(request: RecordedRequest): Response {
  const body = JSON.parse(request.body) as Record<string, unknown>;
  return json(202, {
    data: [{ id: `sub-${Math.random()}`, status: 'enabled', cost: 0, ...body, created_at: TS }],
    total: 2,
    total_cost: 0,
    max_total_cost: 10,
  });
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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ServerConnection {
  readonly socket: WebSocket;
  readonly path: string;
}

async function startTwitchStub() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const connections: ServerConnection[] = [];
  wss.on('connection', (socket, request) => {
    connections.push({ socket, path: request.url ?? '' });
  });
  const { port } = wss.address() as AddressInfo;
  return {
    wss,
    url: `ws://127.0.0.1:${port}/ws`,
    connections,
    connection: (index: number) => waitFor(() => connections[index]),
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

let seq = 0;
const envelopeId = () => `envelope-${(seq += 1)}`;

function welcome(sessionId: string, keepaliveSeconds = 10): string {
  return JSON.stringify({
    metadata: { message_id: envelopeId(), message_type: 'session_welcome', message_timestamp: TS },
    payload: {
      session: {
        id: sessionId,
        status: 'connected',
        connected_at: TS,
        keepalive_timeout_seconds: keepaliveSeconds,
        reconnect_url: null,
      },
    },
  });
}

function keepalive(): string {
  return JSON.stringify({
    metadata: {
      message_id: envelopeId(),
      message_type: 'session_keepalive',
      message_timestamp: TS,
    },
    payload: {},
  });
}

function reconnect(sessionId: string, reconnectUrl: string): string {
  return JSON.stringify({
    metadata: {
      message_id: envelopeId(),
      message_type: 'session_reconnect',
      message_timestamp: TS,
    },
    payload: {
      session: {
        id: sessionId,
        status: 'reconnecting',
        connected_at: TS,
        keepalive_timeout_seconds: null,
        reconnect_url: reconnectUrl,
      },
    },
  });
}

interface ChatFields {
  readonly broadcaster_user_id: string;
  readonly chatter_user_id: string;
  readonly message_id: string;
  readonly source_broadcaster_user_id?: string | null;
  readonly source_message_id?: string | null;
}

/** Realistic event including the content fields that must be stripped before normalization. */
function chat(fields: ChatFields, id = envelopeId(), version = '1'): string {
  return JSON.stringify({
    metadata: {
      message_id: id,
      message_type: 'notification',
      message_timestamp: TS,
      subscription_type: 'channel.chat.message',
      subscription_version: version,
    },
    payload: {
      subscription: {
        id: 'sub',
        status: 'enabled',
        type: 'channel.chat.message',
        version,
        condition: { broadcaster_user_id: fields.broadcaster_user_id, user_id: READER },
        transport: { method: 'websocket', session_id: 'session' },
        created_at: TS,
        cost: 0,
      },
      event: {
        broadcaster_user_login: 'broadcaster',
        broadcaster_user_name: 'Broadcaster',
        chatter_user_login: 'viewer',
        chatter_user_name: 'Viewer',
        message: { text: 'secret chat text', fragments: [{ type: 'text', text: 'secret' }] },
        color: '#FF0000',
        badges: [],
        message_type: 'text',
        source_broadcaster_user_id: null,
        source_message_id: null,
        ...fields,
      },
    },
  });
}

function sharedChatEvent(type: string, participants: readonly string[]): string {
  return JSON.stringify({
    metadata: {
      message_id: envelopeId(),
      message_type: 'notification',
      message_timestamp: TS,
      subscription_type: type,
      subscription_version: '1',
    },
    payload: {
      subscription: { id: 'sub', type, version: '1', status: 'enabled' },
      event: {
        session_id: 'shared-1',
        broadcaster_user_id: CHANNELS.A,
        host_broadcaster_user_id: CHANNELS.A,
        participants: participants.map((id) => ({
          broadcaster_user_id: id,
          broadcaster_user_login: id,
          broadcaster_user_name: id,
        })),
      },
    },
  });
}

function revocation(status: string): string {
  return JSON.stringify({
    metadata: {
      message_id: envelopeId(),
      message_type: 'revocation',
      message_timestamp: TS,
      subscription_type: 'channel.chat.message',
      subscription_version: '1',
    },
    payload: {
      subscription: {
        id: 'sub',
        status,
        type: 'channel.chat.message',
        version: '1',
        cost: 0,
        condition: { broadcaster_user_id: CHANNELS.B, user_id: READER },
        transport: { method: 'websocket', session_id: 'session-1' },
        created_at: TS,
      },
    },
  });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  overrides: Partial<EventSubOptions> = {},
  handler: (request: RecordedRequest) => Response | Promise<Response> = subscriptionCreated,
) {
  const stub = await startTwitchStub();
  cleanups.push(stub.close);
  const { fetch, calls } = fakeFetch(handler);
  const helix = createHelixClient({
    clientId: 'client-id',
    fetch,
    tokens: { getAccessToken: async () => 'access-1', refresh: async () => 'access-2' },
  });
  const chats: NormalizedChatEvent[] = [];
  const statuses: EventSubStatusEvent[] = [];
  const shared: SharedChatChange[] = [];
  const client: EventSubClient = createEventSubClient({
    helix,
    tokenUserId: READER,
    channels: CHANNELS,
    onChat: (event) => chats.push(event),
    onStatus: (event) => statuses.push(event),
    onSharedChat: (change) => shared.push(change),
    url: stub.url,
    now: () => 777,
    reconnectDelayMs: () => 10,
    ...overrides,
  });
  cleanups.push(() => client.stop());
  const subscriptionPosts = () =>
    calls.filter(
      (call) => call.method === 'POST' && call.url.pathname === '/helix/eventsub/subscriptions',
    );
  const chatPosts = () =>
    subscriptionPosts()
      .map((call) => JSON.parse(call.body) as { type: string; transport: { session_id: string } })
      .filter((body) => body.type === 'channel.chat.message');
  const connectedCount = () => statuses.filter((event) => event.status === 'connected').length;
  await client.start();
  return {
    stub,
    client,
    calls,
    chats,
    statuses,
    shared,
    subscriptionPosts,
    chatPosts,
    connectedCount,
  };
}

describe('EventSub WebSocket client', () => {
  it('creates one chat subscription per channel over Helix right after session_welcome', async () => {
    const t = await setup();
    const conn = await t.stub.connection(0);
    expect(conn.path).toBe('/ws');
    conn.socket.send(welcome('session-1'));
    await waitFor(() => t.connectedCount() === 1);

    const chatPosts = t
      .subscriptionPosts()
      .filter(
        (call) => (JSON.parse(call.body) as { type: string }).type === 'channel.chat.message',
      );
    expect(chatPosts).toHaveLength(2);
    for (const call of chatPosts) {
      expect(call.url.href).toBe('https://api.twitch.tv/helix/eventsub/subscriptions');
      expect(call.headers.get('authorization')).toBe('Bearer access-1');
      expect(call.headers.get('client-id')).toBe('client-id');
      expect(call.headers.get('content-type')).toBe('application/json');
    }
    expect(chatPosts.map((call) => JSON.parse(call.body) as unknown)).toEqual(
      [CHANNELS.A, CHANNELS.B].map((broadcaster) => ({
        type: 'channel.chat.message',
        version: '1',
        condition: { broadcaster_user_id: broadcaster, user_id: READER },
        transport: { method: 'websocket', session_id: 'session-1' },
      })),
    );
    // Shared Chat tracking (A only, both channels configured) is requested after chat.
    await waitFor(() => t.subscriptionPosts().length === 5);
    expect(
      t
        .subscriptionPosts()
        .slice(2)
        .map((call) => JSON.parse(call.body) as unknown),
    ).toEqual(
      ['channel.shared_chat.begin', 'channel.shared_chat.update', 'channel.shared_chat.end'].map(
        (type) => ({
          type,
          version: '1',
          condition: { broadcaster_user_id: CHANNELS.A },
          transport: { method: 'websocket', session_id: 'session-1' },
        }),
      ),
    );
    expect(t.statuses.map((event) => event.status)).toEqual(['connecting', 'connected']);
  });

  it('subscribes only channel A in single-channel mode', async () => {
    const t = await setup({ channels: { A: CHANNELS.A, B: null } });
    (await t.stub.connection(0)).socket.send(welcome('session-1'));
    await waitFor(() => t.connectedCount() === 1);
    await pause(30);
    expect(t.chatPosts()).toHaveLength(1);
    expect(t.subscriptionPosts()).toHaveLength(1);
  });

  it('delivers a validated, content-free normalized event and dedupes envelopes', async () => {
    const t = await setup();
    const conn = await t.stub.connection(0);
    conn.socket.send(welcome('session-1'));
    await waitFor(() => t.connectedCount() === 1);

    conn.socket.send(
      chat(
        { broadcaster_user_id: CHANNELS.B, chatter_user_id: 'viewer-1', message_id: 'm-1' },
        'env-dup',
      ),
    );
    // Redelivery of the same envelope (Twitch may resend) must not reach the engine twice.
    conn.socket.send(
      chat(
        { broadcaster_user_id: CHANNELS.B, chatter_user_id: 'viewer-1', message_id: 'm-1' },
        'env-dup',
      ),
    );
    conn.socket.send(
      chat({ broadcaster_user_id: CHANNELS.A, chatter_user_id: 'viewer-2', message_id: 'm-2' }),
    );
    await waitFor(() => t.chats.length === 2);
    await pause(30);
    expect(t.chats).toEqual([
      {
        messageKey: 'm-1',
        chatterId: 'viewer-1',
        chatterLogin: 'viewer',
        originBroadcasterId: CHANNELS.B,
        side: 'B',
        receivedAtMs: 777,
        simulated: false,
      },
      {
        messageKey: 'm-2',
        chatterId: 'viewer-2',
        chatterLogin: 'viewer',
        originBroadcasterId: CHANNELS.A,
        side: 'A',
        receivedAtMs: 777,
        simulated: false,
      },
    ]);
    expect(JSON.stringify(t.chats)).not.toMatch(/secret|Viewer|#FF0000/);
  });

  it.each([
    ['original first', ['original', 'copy']],
    ['copy first', ['copy', 'original']],
  ] as const)(
    'credits a Shared Chat message once, on its origin side (%s)',
    async (_label, order) => {
      const t = await setup();
      const conn = await t.stub.connection(0);
      conn.socket.send(welcome('session-1'));
      await waitFor(() => t.connectedCount() === 1);
      const frames = {
        // Delivered through A's subscription: the message was typed in A.
        original: chat({
          broadcaster_user_id: CHANNELS.A,
          chatter_user_id: 'viewer-9',
          message_id: 'src-1',
        }),
        // Same message relayed into B's chat: different envelope and message IDs, source = A.
        copy: chat({
          broadcaster_user_id: CHANNELS.B,
          chatter_user_id: 'viewer-9',
          message_id: 'relay-1',
          source_broadcaster_user_id: CHANNELS.A,
          source_message_id: 'src-1',
        }),
      };
      for (const name of order) conn.socket.send(frames[name]);
      await waitFor(() => t.chats.length === 1);
      await pause(30);
      expect(t.chats).toHaveLength(1);
      expect(t.chats[0]).toMatchObject({
        messageKey: 'src-1',
        side: 'A',
        originBroadcasterId: CHANNELS.A,
      });
    },
  );

  it('drops unknown origins, our own messages, wrong versions and malformed payloads', async () => {
    const t = await setup();
    const conn = await t.stub.connection(0);
    conn.socket.send(welcome('session-1'));
    await waitFor(() => t.connectedCount() === 1);
    conn.socket.send(
      chat({
        broadcaster_user_id: CHANNELS.B,
        chatter_user_id: 'viewer-1',
        message_id: 'x-1',
        source_broadcaster_user_id: 'third-channel',
        source_message_id: 'x-src',
      }),
    );
    conn.socket.send(
      chat({ broadcaster_user_id: CHANNELS.A, chatter_user_id: READER, message_id: 'x-2' }),
    );
    conn.socket.send(
      chat(
        { broadcaster_user_id: CHANNELS.A, chatter_user_id: 'viewer-1', message_id: 'x-3' },
        undefined,
        '2',
      ),
    );
    conn.socket.send(
      chat({ broadcaster_user_id: CHANNELS.A, chatter_user_id: '', message_id: 'x-4' }),
    );
    conn.socket.send('not json');
    conn.socket.send(JSON.stringify({ metadata: {}, payload: [] }));
    conn.socket.send(
      chat({ broadcaster_user_id: CHANNELS.A, chatter_user_id: 'viewer-ok', message_id: 'x-5' }),
    );
    await waitFor(() => t.chats.length === 1);
    await pause(30);
    expect(t.chats.map((event) => event.messageKey)).toEqual(['x-5']);
    expect(t.connectedCount()).toBe(1);
  });

  it('parseChatNotification rejects non-string source fields', () => {
    const payload = {
      subscription: { type: 'channel.chat.message', version: '1' },
      event: {
        broadcaster_user_id: 'a',
        chatter_user_id: 'c',
        message_id: 'm',
        source_message_id: 42,
      },
    };
    expect(parseChatNotification(payload)).toBeNull();
    expect(
      parseChatNotification({ ...payload, event: { ...payload.event, source_message_id: null } }),
    ).toEqual({
      broadcaster_user_id: 'a',
      chatter_user_id: 'c',
      message_id: 'm',
      source_broadcaster_user_id: null,
      source_message_id: null,
    });
  });

  it('forwards Shared Chat begin/end for the session tracker', async () => {
    const t = await setup();
    const conn = await t.stub.connection(0);
    conn.socket.send(welcome('session-1'));
    await waitFor(() => t.connectedCount() === 1);
    conn.socket.send(sharedChatEvent('channel.shared_chat.begin', [CHANNELS.A, CHANNELS.B]));
    conn.socket.send(sharedChatEvent('channel.shared_chat.end', []));
    await waitFor(() => t.shared.length === 2);
    expect(t.shared).toEqual([
      { kind: 'session', sessionId: 'shared-1', participantIds: [CHANNELS.A, CHANNELS.B] },
      { kind: 'end', sessionId: 'shared-1' },
    ]);
  });

  it('reconnects and resubscribes when keepalives stop (watchdog = timeout + grace)', async () => {
    const t = await setup({ keepaliveGraceMs: 50 });
    const first = await t.stub.connection(0);
    first.socket.send(welcome('session-1', 0.15));
    await waitFor(() => t.connectedCount() === 1);
    // Keepalives within the window hold the connection open.
    for (let i = 0; i < 4; i += 1) {
      await pause(80);
      first.socket.send(keepalive());
    }
    expect(t.stub.connections).toHaveLength(1);
    // Silence beyond 150 ms + 50 ms: the client drops the socket and starts a new session.
    const second = await t.stub.connection(1);
    expect(second.path).toBe('/ws');
    await waitFor(() => first.socket.readyState === WebSocket.CLOSED);
    second.socket.send(welcome('session-2', 10));
    await waitFor(() => t.connectedCount() === 2);
    expect(t.statuses.map((event) => event.status)).toContain('reconnecting');
    const sessions = t.chatPosts().map((body) => body.transport.session_id);
    expect(sessions).toEqual(['session-1', 'session-1', 'session-2', 'session-2']);
  });

  it('reconnects with backoff after an unexpected close', async () => {
    const t = await setup();
    const first = await t.stub.connection(0);
    first.socket.send(welcome('session-1'));
    await waitFor(() => t.connectedCount() === 1);
    first.socket.close(4006, 'network error');
    const second = await t.stub.connection(1);
    second.socket.send(welcome('session-2'));
    await waitFor(() => t.connectedCount() === 2);
    expect(t.chatPosts().map((body) => body.transport.session_id)).toEqual([
      'session-1',
      'session-1',
      'session-2',
      'session-2',
    ]);
  });

  it('switches sockets on session_reconnect without resubscribing or losing events', async () => {
    const t = await setup();
    const first = await t.stub.connection(0);
    first.socket.send(welcome('session-1'));
    await waitFor(() => t.connectedCount() === 1);
    await waitFor(() => t.subscriptionPosts().length === 5);
    const postsBefore = t.subscriptionPosts().length;

    const reconnectUrl = `${t.stub.url}?handover=opaque%2Fvalue`;
    first.socket.send(reconnect('session-1', reconnectUrl));
    const second = await t.stub.connection(1);
    expect(second.path).toBe('/ws?handover=opaque%2Fvalue'); // used unchanged

    // The old socket keeps delivering until the new welcome arrives.
    first.socket.send(
      chat(
        { broadcaster_user_id: CHANNELS.A, chatter_user_id: 'v-1', message_id: 'h-1' },
        'env-h1',
      ),
    );
    await waitFor(() => t.chats.length === 1);
    expect(first.socket.readyState).toBe(WebSocket.OPEN);

    second.socket.send(welcome('session-1'));
    await waitFor(() => first.socket.readyState === WebSocket.CLOSED);
    await waitFor(() => t.connectedCount() === 2);
    // Overlap redelivery on the new socket is deduped; new events flow through it.
    second.socket.send(
      chat(
        { broadcaster_user_id: CHANNELS.A, chatter_user_id: 'v-1', message_id: 'h-1' },
        'env-h1',
      ),
    );
    second.socket.send(
      chat({ broadcaster_user_id: CHANNELS.B, chatter_user_id: 'v-2', message_id: 'h-2' }),
    );
    await waitFor(() => t.chats.length === 2);
    await pause(30);
    expect(t.chats.map((event) => event.messageKey)).toEqual(['h-1', 'h-2']);
    expect(t.subscriptionPosts()).toHaveLength(postsBefore);
    expect(t.stub.connections).toHaveLength(2);
    expect(t.statuses.map((event) => event.status)).not.toContain('reconnecting');
  });

  it('falls back to a fresh session when the handover target never welcomes', async () => {
    const t = await setup({ handoverTimeoutMs: 100 });
    const first = await t.stub.connection(0);
    first.socket.send(welcome('session-1'));
    await waitFor(() => t.connectedCount() === 1);
    first.socket.send(reconnect('session-1', `${t.stub.url}?handover=1`));
    await t.stub.connection(1);
    const third = await t.stub.connection(2);
    expect(third.path).toBe('/ws');
    third.socket.send(welcome('session-3'));
    await waitFor(() => t.connectedCount() === 2);
    expect(
      t
        .chatPosts()
        .slice(-2)
        .map((body) => body.transport.session_id),
    ).toEqual(['session-3', 'session-3']);
  });

  it('halts with a recoverable status on revocation and does not reconnect', async () => {
    const t = await setup();
    const conn = await t.stub.connection(0);
    conn.socket.send(welcome('session-1'));
    await waitFor(() => t.connectedCount() === 1);
    conn.socket.send(revocation('user_removed'));
    const revoked = await waitFor(() => t.statuses.find((event) => event.status === 'revoked'));
    expect(revoked).toMatchObject({ status: 'revoked', reason: 'user_removed', side: 'B' });
    expect(revoked.status === 'revoked' && revoked.message).toMatch(/channel B/);
    await waitFor(() => conn.socket.readyState === WebSocket.CLOSED);
    await pause(50);
    expect(t.stub.connections).toHaveLength(1);
  });

  it('names the banned channel instead of suggesting a reconnect', async () => {
    const t = await setup();
    const conn = await t.stub.connection(0);
    conn.socket.send(welcome('session-1'));
    await waitFor(() => t.connectedCount() === 1);
    conn.socket.send(revocation('chat_user_banned'));
    const revoked = await waitFor(() => t.statuses.find((event) => event.status === 'revoked'));
    expect(revoked).toMatchObject({ reason: 'chat_user_banned', side: 'B' });
    expect(revoked.status === 'revoked' && revoked.message).toBe(
      "This Twitch account is banned from channel B's chat (chat_user_banned). Ask that channel to unban it, or remove it.",
    );
  });

  it('reports which channel a fatal subscription failure belongs to', async () => {
    const onlyB = await setup({}, (request) =>
      request.body.includes(`"broadcaster_user_id":"${CHANNELS.B}"`)
        ? json(403, { status: 403, message: 'forbidden' })
        : subscriptionCreated(request),
    );
    (await onlyB.stub.connection(0)).socket.send(welcome('session-1'));
    const failedB = await waitFor(() => onlyB.statuses.find((event) => event.status === 'failed'));
    expect(failedB).toMatchObject({ authRequired: false, side: 'B' });
    expect(failedB.status === 'failed' && failedB.message).toMatch(/channel B chat \(HTTP 403\)/);
    expect(failedB.status === 'failed' && failedB.message).toMatch(/not banned there/);
  });

  it.each([
    [409, { status: 409, message: 'subscription exists', id: 'subscription-on-another-socket' }],
    [202, { data: [] }],
    [202, { data: [{ id: 'sub-without-status' }] }],
    [202, { data: [{ id: 'sub-without-costs', status: 'enabled' }] }],
    [
      202,
      {
        data: [{ id: 'sub-over-budget', status: 'enabled', cost: 1 }],
        total_cost: 11,
        max_total_cost: 10,
      },
    ],
  ])(
    'does not report connected for an unconfirmed subscription (HTTP %i)',
    async (status, body) => {
      const t = await setup({}, () => json(status, body));
      const conn = await t.stub.connection(0);
      conn.socket.send(welcome('unconfirmed'));
      const result = await waitFor(() =>
        t.statuses.find((event) => event.status === 'failed' || event.status === 'connected'),
      );
      expect(result.status).toBe('failed');
      expect(t.connectedCount()).toBe(0);
    },
  );

  it('stops on non-retryable subscription errors and retries transient ones', async () => {
    const forbidden = await setup({}, () => json(403, { status: 403, message: 'missing scope' }));
    const conn = await forbidden.stub.connection(0);
    conn.socket.send(welcome('session-1'));
    const failed = await waitFor(() =>
      forbidden.statuses.find((event) => event.status === 'failed'),
    );
    // Both channels refused: channel A wins, so the whole client reports the failure.
    expect(failed).toMatchObject({ status: 'failed', authRequired: false, side: 'A' });
    await waitFor(() => conn.socket.readyState === WebSocket.CLOSED);
    await pause(50);
    expect(forbidden.stub.connections).toHaveLength(1);

    let calls = 0;
    const flaky = await setup({}, (request) => {
      calls += 1;
      return calls <= 2 ? json(503, {}) : subscriptionCreated(request);
    });
    (await flaky.stub.connection(0)).socket.send(welcome('session-1'));
    const retry = await flaky.stub.connection(1);
    retry.socket.send(welcome('session-2'));
    await waitFor(() => flaky.connectedCount() === 1);
    expect(
      flaky
        .chatPosts()
        .slice(-2)
        .map((body) => body.transport.session_id),
    ).toEqual(['session-2', 'session-2']);
  });
});

it('validates and keeps only the minimal login for server bot filtering', () => {
  const payload = {
    subscription: { type: 'channel.chat.message', version: '1' },
    event: {
      broadcaster_user_id: 'a',
      chatter_user_id: 'person',
      chatter_user_login: 'NightBot',
      message_id: 'm',
      chatter_user_name: 'Discard me',
      message: { text: 'Discard me too' },
    },
  };
  const parsed = parseChatNotification(payload);
  expect(parsed).toMatchObject({ chatter_user_login: 'nightbot' });
  expect(JSON.stringify(parsed)).not.toMatch(/Discard|chatter_user_name|message"/);
  for (const login of [null, 5, '', 'bad login', 'a'.repeat(26)])
    expect(
      parseChatNotification({ ...payload, event: { ...payload.event, chatter_user_login: login } }),
    ).toBeNull();
});
