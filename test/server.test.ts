import fc from 'fast-check';
import { parseLabelsRequest } from '../src/server/routes/api.js';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { NormalizedChatEvent } from '../src/engine/types.js';
import { createApp, type App, type AppOptions } from '../src/server/http.js';
import { showcaseArtwork } from '../src/sim/showcase.js';
import type { ControlState, ServerMessage, SnapshotResponse } from '../src/shared/protocol.js';
import {
  ChannelLookupError,
  TwitchAuthConflictError,
  type TwitchService,
  type TwitchServiceOptions,
  type TwitchServiceState,
} from '../src/twitch/service.js';

const ROOM = 'test-room-token-0123456789abcdef';
const PROXY = { 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '203.0.113.9' };
/** Anything that could identify a chatter or leak internals must never cross the protocol. */
const PRIVATE =
  /sim:\d|chatterId|chatterLogin|participantIds|recentChatters|seenMessageKeys|messageKey|token/i;

const apps: App[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.terminate());
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function start(options: Partial<AppOptions> = {}) {
  const app = createApp({ demo: true, roomToken: ROOM, ...options });
  apps.push(app);
  const port = await app.listen(0);
  return { app, port };
}

it('serves the self-hosted broadcast fonts with an explicit same-origin font CSP', async () => {
  const { port } = await start();
  for (const face of ['Archivo', 'GeistMono']) {
    const response = await raw(port, `/fonts/${face}-Variable.woff2`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('font/woff2');
    expect(response.headers['content-security-policy']).toContain("font-src 'self'");
    expect(response.body.length).toBeGreaterThan(10_000);
    const overlayPath = `/overlay/fonts/${face}-Variable.woff2`;
    expect((await raw(port, overlayPath, { headers: PROXY })).status).toBe(403);
    expect(
      (await raw(port, overlayPath, { headers: { ...PROXY, Cookie: 'crossover_room=wrong' } }))
        .status,
    ).toBe(403);
    const partner = await raw(port, overlayPath, {
      headers: { ...PROXY, Cookie: `crossover_room=${ROOM}` },
    });
    expect(partner.status).toBe(200);
    expect(partner.body).toBe(response.body);
  }
});

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** node:http instead of fetch: raw paths (no client-side normalization) and any header. */
function raw(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers ?? {} },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}) {
  return raw(port, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function getJson<T>(port: number, path: string, headers: Record<string, string> = {}) {
  const response = await raw(port, path, { headers });
  expect(response.status, path).toBe(200);
  return JSON.parse(response.body) as T;
}

function crossoverCall(quorum: number) {
  return {
    artwork: showcaseArtwork('crossover'),
    mode: 'crossover',
    durationMs: 30_000,
    quorumOverride: { A: quorum, B: quorum },
  };
}

function connect(port: number, query: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers });
  sockets.push(socket);
  const messages: ServerMessage[] = [];
  socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
  return {
    messages,
    waitFor(count: number): Promise<ServerMessage[]> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`expected ${count} messages`)), 3_000);
        const check = (): void => {
          if (messages.length < count) return;
          clearTimeout(timer);
          socket.off('message', check);
          resolve(messages.slice(0, count));
        };
        socket.on('message', check);
        check();
      });
    },
  };
}

/** HTTP status of a WebSocket upgrade attempt (101 when accepted). */
function upgradeStatus(port: number, query: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers });
    sockets.push(socket);
    socket.on('unexpected-response', (request, response) => {
      resolve(response.statusCode ?? 0);
      request.destroy();
    });
    socket.on('open', () => resolve(101));
    socket.on('error', () => undefined);
  });
}

/** Status code for a hand-written request line: clients would normalize these targets. */
function rawRequestStatus(port: number, target: string, upgrade: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1');
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no response for ${target}`));
    }, 3_000);
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
      const match = /^HTTP\/1\.1 (\d{3})/.exec(received);
      if (match === null) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(Number(match[1]));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    const headers = upgrade
      ? 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
      : 'Connection: close\r\n';
    socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headers}\r\n`);
  });
}

function fakeTwitch() {
  let state: TwitchServiceState = {
    status: 'connected',
    login: 'alpha',
    userId: 'bot-id',
    userCode: null,
    verificationUri: null,
    error: null,
    channels: {
      A: { login: 'alpha', displayName: 'Alpha', userId: '100' },
      B: { login: 'beta', displayName: 'Beta', userId: '200' },
    },
  };
  let captured: TwitchServiceOptions | null = null;
  const service = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getState: () => state,
    beginAuth: vi.fn(async () => ({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://www.twitch.tv/activate',
    })),
    signOut: vi.fn(async () => undefined),
    setChannels: vi.fn(async () => undefined),
    say: vi.fn(async (sides: readonly ('A' | 'B')[], _message: string) =>
      Object.fromEntries(sides.map((side) => [side, { ok: true, reason: null }])),
    ),
  } satisfies TwitchService;
  const factory = vi.fn((options: TwitchServiceOptions) => {
    captured = options;
    return service;
  });
  const chat = (side: 'A' | 'B', chatterId: string, simulated = false) =>
    captured!.onChat({
      messageKey: `${side}-${chatterId}-${Math.random()}`,
      chatterId,
      originBroadcasterId: side === 'A' ? '100' : '200',
      side,
      receivedAtMs: Date.now(),
      simulated,
    } satisfies NormalizedChatEvent);
  const setStatus = (status: TwitchServiceState['status']) => {
    state = { ...state, status };
    captured?.onStateChange?.();
  };
  return { service, factory, chat, setStatus };
}

describe('static files', () => {
  it('serves page aliases and allowlisted assets with the security headers', async () => {
    const { port } = await start();
    for (const path of ['/', '/control', '/overlay/a', '/overlay/b', '/dev']) {
      const response = await raw(port, path);
      expect(response.status, path).toBe(200);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.headers['content-security-policy']).toContain("script-src 'self'");
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const script = await raw(port, '/overlay/overlay.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    const head = await raw(port, '/overlay/a', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect((await raw(port, '/overlay/missing.js')).status).toBe(404);
    expect((await raw(port, '/api/nope')).status).toBe(404);
  });

  it('rejects traversal, encoded separators, dotfiles and non-allowlisted extensions', async () => {
    const { port } = await start();
    const attempts = [
      '/../package.json',
      '/%2e%2e/package.json',
      '/overlay/..%2f..%2fpackage.json',
      '/overlay/%2e%2e%2f%2e%2e%2fsrc%2fserver%2fhttp.ts',
      '/..%5c..%5cpackage.json',
      '/overlay/..\\..\\package.json',
      '/%2e%2e%2f%2e%2e%2fsrc/server/index.js',
      '/C:%2fWindows%2fwin.ini',
      '/overlay/overlay.js%00.html',
      '/.gitignore',
      '/%252e%252e/package.json',
      '/overlay/index.html::$DATA',
    ];
    for (const path of attempts) {
      const response = await raw(port, path);
      expect(response.status, path).toBe(404);
      expect(response.body, path).not.toContain('crossover-stunt');
    }
  });
});

describe('HTTP API (demo)', () => {
  it('reports health and serves polling snapshots with round only when it changed', async () => {
    const { port } = await start();
    expect(await getJson(port, '/api/health')).toEqual({ ok: true, simulated: true });
    const idle = await getJson<SnapshotResponse>(port, '/api/snapshot');
    expect(idle).toMatchObject({
      protocol: 2,
      snapshot: { phase: 'idle', simulated: true, roundId: null },
      meta: { labels: { A: 'LEFT STAND', B: 'RIGHT STAND' }, twitch: 'demo' },
    });
    expect('round' in idle).toBe(false);

    const called = await post(port, '/api/call', crossoverCall(5));
    expect(called.status).toBe(202);
    const { roundId } = JSON.parse(called.body) as { roundId: string };
    const fresh = await getJson<SnapshotResponse>(port, '/api/snapshot');
    expect(fresh.round?.roundId).toBe(roundId);
    expect(Object.keys(fresh.round?.plans ?? {}).sort()).toEqual(['A', 'B']);
    const known = await getJson<SnapshotResponse>(port, `/api/snapshot?round=${roundId}`);
    expect('round' in known).toBe(false);
    expect(known.snapshot).toMatchObject({ phase: 'active', roundId });
    const stale = await getJson<SnapshotResponse>(port, '/api/snapshot?round=older');
    expect(stale.round?.roundId).toBe(roundId);

    expect((await post(port, '/api/reset', {})).status).toBe(200);
    const cleared = await getJson<SnapshotResponse>(port, `/api/snapshot?round=${roundId}`);
    expect(cleared.round).toBeNull();
    expect(cleared.snapshot.phase).toBe('idle');
  });

  it('CALL, SIMULATED chat and RESET drive the aggregate snapshot', async () => {
    const { port } = await start();
    expect((await post(port, '/api/call', crossoverCall(30))).status).toBe(202);
    expect((await post(port, '/api/call', crossoverCall(30))).status).toBe(409);
    const injected = await post(port, '/dev/chat', { side: 'A', count: 25, seed: 7 });
    expect(injected.status).toBe(202);
    expect(JSON.parse(injected.body)).toEqual({
      simulated: true,
      accepted: 25,
      added: 25,
      processed: true,
    });
    // Replaying the same seed adds nobody; the same seed on B is the same virtual people.
    const replayed = await post(port, '/dev/chat', { side: 'A', count: 25, seed: 7 });
    expect(JSON.parse(replayed.body)).toMatchObject({ accepted: 25, added: 0 });
    await post(port, '/dev/chat', { side: 'B', count: 10, seed: 7 });
    const { snapshot } = await getJson<SnapshotResponse>(port, '/api/snapshot');
    expect(snapshot).toMatchObject({
      phase: 'active',
      crossovers: 10,
      sides: { A: { participants: 25, quorum: 30 }, B: { participants: 10, quorum: 30 } },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(PRIVATE);
    expect((await post(port, '/api/reset', {})).status).toBe(200);
    const after = await getJson<SnapshotResponse>(port, '/api/snapshot');
    expect(after.snapshot).toMatchObject({ phase: 'idle', sides: { A: { participants: 0 } } });
  });

  it('feeds a 3000-person SIMULATED burst in time slices so timers keep running', async () => {
    const { app, port } = await start();
    expect((await post(port, '/api/call', crossoverCall(1_000))).status).toBe(202);
    const chat = app.runtime.chat.bind(app.runtime);
    let calls = 0;
    let callsWhenTimerRan = -1;
    vi.spyOn(app.runtime, 'chat').mockImplementation((event) => {
      if (calls === 0) setTimeout(() => (callsWhenTimerRan = calls), 0);
      calls += 1;
      return chat(event);
    });
    const burst = await post(port, '/dev/chat', { side: 'A', count: 3000, seed: 11 });
    expect(JSON.parse(burst.body)).toMatchObject({ accepted: 3000, added: 3000 });
    // The 250 ms tick / WS pushes get the event loop between slices, not only after the burst.
    expect(callsWhenTimerRan).toBeGreaterThan(0);
    expect(callsWhenTimerRan).toBeLessThan(3000);
    const { snapshot } = await getJson<SnapshotResponse>(port, '/api/snapshot');
    // Same outcome as feeding everything at once: A is past its quorum, B still waiting.
    expect(snapshot).toMatchObject({
      phase: 'active',
      sides: { A: { participants: 3000, ready: true }, B: { participants: 0 } },
    });
  });

  it('stops a burst that a RESET or new CALL superseded', async () => {
    const { app, port } = await start();
    expect((await post(port, '/api/call', crossoverCall(1_000))).status).toBe(202);
    const chat = app.runtime.chat.bind(app.runtime);
    let calls = 0;
    vi.spyOn(app.runtime, 'chat').mockImplementation((event) => {
      // An operator RESET lands while the burst yields between chunks.
      if (calls === 0) setTimeout(() => app.runtime.reset(), 0);
      calls += 1;
      return chat(event);
    });
    const burst = await post(port, '/dev/chat', { side: 'B', count: 3000, seed: 12 });
    const body = JSON.parse(burst.body) as { accepted: number; added: number };
    expect(body.accepted).toBeGreaterThan(0);
    expect(body.accepted).toBeLessThan(3000); // stopped at the first slice after the RESET
    expect(body.added).toBe(body.accepted); // everyone counted before the RESET was new
    expect(app.runtime.snapshot()).toMatchObject({
      phase: 'idle',
      sides: { B: { participants: 0 } },
    });
  });

  it('validates CALL bodies (400) and exposes the remembered config in /api/state', async () => {
    const { port } = await start();
    const bad = [
      {},
      { artwork: showcaseArtwork('single'), mode: 'crossover' },
      { ...crossoverCall(3), durationMs: 5_000 },
      { ...crossoverCall(3), minQuorum: 'many' },
      { ...crossoverCall(3), quorumOverride: { A: 0 } },
      { ...crossoverCall(3), mode: 'triple' },
    ];
    for (const body of bad) expect((await post(port, '/api/call', body)).status).toBe(400);
    expect(
      (
        await raw(port, '/api/call', {
          method: 'POST',
          body: '{nope',
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(400);

    const state = await getJson<ControlState>(port, '/api/state');
    expect(state).toMatchObject({
      protocol: 2,
      demo: true,
      twitch: { status: 'demo', error: null },
      config: { mode: 'crossover', durationMs: 45_000 },
      snapshot: { phase: 'idle' },
      overlayUrls: {
        A: `http://127.0.0.1:${port}/overlay/a`,
        B: `http://127.0.0.1:${port}/overlay/b`,
        partnerB: null,
      },
      share: { status: 'off', error: null },
      lastChat: null,
    });
    expect(JSON.stringify(state)).not.toContain(ROOM);
  });

  it('guards local POSTs: same origin, JSON only, bounded bodies, right method', async () => {
    const { port } = await start();
    const foreign = await post(port, '/api/reset', {}, { Origin: 'http://evil.example' });
    expect(foreign.status).toBe(403);
    const sameOrigin = await post(port, '/api/reset', {}, { Origin: `http://127.0.0.1:${port}` });
    expect(sameOrigin.status).toBe(200);
    const form = await raw(port, '/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(form.status).toBe(415);
    expect((await raw(port, '/api/call')).status).toBe(405);
    const huge = await post(port, '/dev/chat', {
      side: 'A',
      count: 1,
      seed: 1,
      pad: 'x'.repeat(9_000),
    });
    expect(huge.status).toBe(413);
  });

  it('turns demo channel logins into stand labels', async () => {
    const { port } = await start();
    const set = await post(port, '/api/channels', { a: 'night_owls', b: 'DayCrew' });
    expect(set.status).toBe(200);
    let { meta } = await getJson<SnapshotResponse>(port, '/api/snapshot');
    expect(meta.labels).toEqual({ A: 'night_owls', B: 'DayCrew' });
    await post(port, '/api/channels', { b: null });
    ({ meta } = await getJson<SnapshotResponse>(port, '/api/snapshot'));
    expect(meta.labels).toEqual({ A: 'night_owls', B: 'RIGHT STAND' });
    expect((await post(port, '/api/channels', { a: 'not a login!' })).status).toBe(400);
    expect((await post(port, '/api/auth/start', {})).status).toBe(404);
  });

  it('plays a scripted SIMULATED showcase round', async () => {
    const { port } = await start();
    const played = await post(port, '/dev/showcase', { scenario: 'single' });
    expect(played.status).toBe(202);
    expect(JSON.parse(played.body)).toMatchObject({ simulated: true, scenario: 'single' });
    const { snapshot } = await getJson<SnapshotResponse>(port, '/api/snapshot');
    expect(snapshot).toMatchObject({ mode: 'single', phase: 'active', simulated: true });
    expect((await post(port, '/dev/showcase', { scenario: 'boss' })).status).toBe(400);
    // An operator CALL cannot interrupt the scripted round; RESET first.
    expect((await post(port, '/api/call', crossoverCall(3))).status).toBe(409);
  });

  it('reports a missing cloudflared without crashing', async () => {
    const { port } = await start({ share: { findBinary: async () => null } });
    const started = await post(port, '/api/share/start', {});
    expect(started.status).toBe(503);
    expect(JSON.parse(started.body)).toMatchObject({
      status: 'error',
      error: 'cloudflared not installed',
      partnerB: null,
    });
    const state = await getJson<ControlState>(port, '/api/state');
    expect(state.share).toEqual({ status: 'error', error: 'cloudflared not installed' });
    expect((await post(port, '/api/share/stop', {})).status).toBe(200);
  });
});

describe('remote access model (tunnel)', () => {
  it('lets remote clients read only overlay B, its assets and snapshots with the room token', async () => {
    const { port } = await start();
    for (const proxy of [PROXY, { forwarded: 'for=203.0.113.9' }, { 'cf-ray': 'abc-SCL' }]) {
      const get = (path: string, headers: Record<string, string> = {}) =>
        raw(port, path, { headers: { ...proxy, ...headers } });
      expect((await get('/api/health')).status).toBe(200);
      for (const path of [
        '/api/state',
        '/control',
        '/',
        `/control?room=${ROOM}`,
        `/overlay/a?room=${ROOM}`,
        `/dev?room=${ROOM}`,
        `/dev/dev.js?room=${ROOM}`,
        `/style.css?room=${ROOM}`,
        '/overlay/b',
        '/overlay/b?room=wrong',
        '/overlay/overlay.js',
        '/api/snapshot',
        `/api/state?room=${ROOM}`,
      ]) {
        expect((await get(path)).status, path).toBe(403);
      }
      const page = await get(`/overlay/b?room=${ROOM}`);
      expect(page.status).toBe(200);
      const cookie = String(page.headers['set-cookie']);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect((await get(`/overlay/overlay.js?room=${ROOM}`)).status).toBe(200);
      expect((await get('/overlay/overlay.js', { Cookie: `crossover_room=${ROOM}` })).status).toBe(
        200,
      );
      expect((await get('/overlay/overlay.js', { Cookie: 'crossover_room=nope' })).status).toBe(
        403,
      );
      expect((await get(`/api/snapshot?room=${ROOM}`)).status).toBe(200);
      const remotePost = await raw(port, `/api/call?room=${ROOM}`, {
        method: 'POST',
        headers: { ...proxy, 'Content-Type': 'application/json' },
        body: JSON.stringify(crossoverCall(3)),
      });
      expect(remotePost.status).toBe(403);
      const remoteChat = await raw(port, `/dev/chat?room=${ROOM}`, {
        method: 'POST',
        headers: { ...proxy, 'Content-Type': 'application/json' },
        body: JSON.stringify({ side: 'B', count: 5, seed: 1 }),
      });
      expect(remoteChat.status).toBe(403);
    }
  });

  it('treats a non-loopback Host as remote (DNS rebinding)', async () => {
    const { port } = await start();
    const rebound = { Host: `attacker.example:${port}` };
    expect((await raw(port, '/api/state', { headers: rebound })).status).toBe(403);
    expect(
      (
        await post(
          port,
          '/api/reset',
          {},
          { ...rebound, Origin: `http://attacker.example:${port}` },
        )
      ).status,
    ).toBe(403);
    expect((await raw(port, '/api/state', { headers: { Host: `localhost:${port}` } })).status).toBe(
      200,
    );
  });

  it('applies the same rules to WebSocket upgrades', async () => {
    const { port } = await start();
    expect(await upgradeStatus(port, '?side=A')).toBe(101);
    expect(await upgradeStatus(port, '?side=C')).toBe(400);
    expect(await upgradeStatus(port, '?side=A', { Origin: 'http://evil.example' })).toBe(403);
    expect(await upgradeStatus(port, `?side=B&room=${ROOM}`, PROXY)).toBe(101);
    expect(
      await upgradeStatus(port, '?side=B', { ...PROXY, Cookie: `crossover_room=${ROOM}` }),
    ).toBe(101);
    expect(await upgradeStatus(port, `?side=A&room=${ROOM}`, PROXY)).toBe(403);
    expect(await upgradeStatus(port, '?side=B', PROXY)).toBe(403);
    expect(await upgradeStatus(port, '?side=B&room=wrong', PROXY)).toBe(403);
  });

  it('refuses malformed request targets with 400 instead of crashing the process', async () => {
    const { port } = await start();
    // WHATWG URL throws on these protocol-relative targets (invalid port / host).
    for (const target of ['//x:99999', '//[', '//x:99999/ws?side=A']) {
      expect(await rawRequestStatus(port, target, true), `upgrade ${target}`).toBe(400);
      expect(await rawRequestStatus(port, target, false), `GET ${target}`).toBe(400);
    }
    expect(await getJson(port, '/api/health')).toEqual({ ok: true, simulated: true });
    expect(await upgradeStatus(port, '?side=A')).toBe(101);
  });
});

describe('overlay WebSocket stream', () => {
  it('sends hello → meta → round → snapshot, then pushes rounds and snapshots', async () => {
    const { port } = await start();
    const client = connect(port, '?side=B');
    const initial = await client.waitFor(4);
    expect(initial.map((message) => message.type)).toEqual(['hello', 'meta', 'round', 'snapshot']);
    expect(initial[0]).toMatchObject({ type: 'hello', protocol: 2, side: 'B', simulated: true });
    expect(initial[1]).toEqual({
      type: 'meta',
      meta: { labels: { A: 'LEFT STAND', B: 'RIGHT STAND' }, twitch: 'demo' },
    });
    expect(initial[2]).toEqual({ type: 'round', round: null });

    await post(port, '/api/call', crossoverCall(3));
    const pushed = await client.waitFor(6);
    expect(pushed[4]).toMatchObject({ type: 'round', round: { mode: 'crossover', cols: 96 } });
    expect(pushed[5]).toMatchObject({ type: 'snapshot', snapshot: { phase: 'active' } });

    await post(port, '/dev/chat', { side: 'A', count: 3, seed: 1 });
    await post(port, '/dev/chat', { side: 'B', count: 3, seed: 2 });
    await vi.waitFor(() => {
      const last = client.messages.at(-1);
      expect(last).toMatchObject({ type: 'snapshot', snapshot: { phase: 'revealing' } });
    });
    await post(port, '/api/channels', { a: 'renamed' });
    await vi.waitFor(() =>
      expect(client.messages.at(-1)).toMatchObject({
        type: 'meta',
        meta: { labels: { A: 'renamed' } },
      }),
    );
    expect(JSON.stringify(client.messages)).not.toMatch(PRIVATE);
  });
});

describe('live mode', () => {
  it('starts without TWITCH_CLIENT_ID, reports signed-out and hides /dev', async () => {
    const { port } = await start({ demo: false, twitchClientId: null });
    expect(await getJson(port, '/api/health')).toEqual({ ok: true, simulated: false });
    const state = await getJson<ControlState>(port, '/api/state');
    expect(state).toMatchObject({ demo: false, twitch: { status: 'signed-out' } });
    expect(state.twitch.error).toContain('TWITCH_CLIENT_ID');
    for (const path of ['/dev', '/dev/dev.js', '/dev/index.html', '/%64ev/dev.js']) {
      expect((await raw(port, path)).status, path).toBe(404);
    }
    expect((await post(port, '/dev/chat', { side: 'A', count: 5, seed: 1 })).status).toBe(404);
    expect((await post(port, '/dev/showcase', { scenario: 'single' })).status).toBe(404);
    expect((await post(port, '/api/auth/start', {})).status).toBe(503);
    expect((await post(port, '/api/call', crossoverCall(3))).status).toBe(400);
    const { snapshot, meta } = await getJson<SnapshotResponse>(port, '/api/snapshot');
    expect(snapshot.simulated).toBe(false);
    expect(meta).toEqual({ labels: { A: 'CHANNEL A', B: 'CHANNEL B' }, twitch: 'signed-out' });
  });

  it('announces in chat only in live mode and ignores its own echoed messages', async () => {
    const twitch = fakeTwitch();
    const { port } = await start({
      demo: false,
      twitchClientId: 'public-client-id',
      createTwitch: twitch.factory,
    });
    expect(twitch.factory).toHaveBeenCalledTimes(1);
    expect(twitch.factory.mock.calls[0]?.[0]).toMatchObject({ clientId: 'public-client-id' });
    await vi.waitFor(() => expect(twitch.service.start).toHaveBeenCalled());
    await vi.waitFor(async () => {
      const { meta } = await getJson<SnapshotResponse>(port, '/api/snapshot');
      expect(meta).toEqual({ labels: { A: 'Alpha', B: 'Beta' }, twitch: 'connected' });
    });

    expect(
      (await post(port, '/api/call', { ...crossoverCall(1), durationMs: 10_000 })).status,
    ).toBe(202);
    expect(twitch.service.say).toHaveBeenLastCalledWith(
      ['A', 'B'],
      'STUNT! Type anything in chat — 10s. Alpha + Beta: one picture, neither chat can finish it alone.',
    );
    twitch.chat('A', 'bot-id'); // our own prompt echoing back
    twitch.chat('A', 'sim:1:0', true); // virtual events never reach a live round
    let { snapshot } = await getJson<SnapshotResponse>(port, '/api/snapshot');
    expect(snapshot.sides.A.participants).toBe(0);
    twitch.chat('A', 'viewer-1');
    twitch.chat('B', 'viewer-1');
    ({ snapshot } = await getJson<SnapshotResponse>(port, '/api/snapshot'));
    expect(snapshot).toMatchObject({ phase: 'revealing', crossovers: 1 });
    expect(twitch.service.say).toHaveBeenLastCalledWith(
      ['A', 'B'],
      '1 person across 2 streams made this · 1 crossed over',
    );
    await vi.waitFor(async () => {
      const state = await getJson<ControlState>(port, '/api/state');
      expect(state.lastChat).toMatchObject({ ok: true, reason: null });
    });
    twitch.setStatus('signed-out');
    expect((await post(port, '/api/auth/start', {})).status).toBe(200);
    expect((await post(port, '/api/channels', { b: 'gamma' })).status).toBe(200);
    expect(twitch.service.setChannels).toHaveBeenCalledWith({ b: 'gamma' });
  });

  it('returns the safe auth conflict message with 409 and keeps live CALL available', async () => {
    const twitch = fakeTwitch();
    const message = 'Already connected as alpha. Sign out first to switch accounts.';
    twitch.service.beginAuth.mockRejectedValueOnce(new TwitchAuthConflictError(message));
    const { port } = await start({
      demo: false,
      twitchClientId: 'public-client-id',
      createTwitch: twitch.factory,
    });
    const response = await post(port, '/api/auth/start', {});
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: message });
    expect((await getJson<ControlState>(port, '/api/state')).twitch).toMatchObject({
      status: 'connected',
      userCode: null,
    });
    expect((await post(port, '/api/call', crossoverCall(1))).status).toBe(202);
  });

  it('refuses a live CALL while Twitch chat is not connected, without posting the prompt', async () => {
    const twitch = fakeTwitch();
    const { port } = await start({
      demo: false,
      twitchClientId: 'public-client-id',
      createTwitch: twitch.factory,
    });
    for (const status of ['error', 'reconnecting', 'connecting', 'signed-out'] as const) {
      twitch.setStatus(status);
      const refused = await post(port, '/api/call', crossoverCall(1));
      expect(refused.status, status).toBe(409);
      expect((JSON.parse(refused.body) as { error: string }).error).toContain(`status: ${status}`);
    }
    expect(twitch.service.say).not.toHaveBeenCalled();
    const { snapshot } = await getJson<SnapshotResponse>(port, '/api/snapshot');
    expect(snapshot.phase).toBe('idle');
    twitch.setStatus('connected');
    expect((await post(port, '/api/call', crossoverCall(1))).status).toBe(202);
    expect(twitch.service.say).toHaveBeenCalledTimes(1);
    const prompt =
      'STUNT! Type anything in chat — 30s. Alpha + Beta: one picture, neither chat can finish it alone.';
    expect(twitch.service.say).toHaveBeenLastCalledWith(['A', 'B'], prompt);
    // CALL → RESET → CALL inside 30 s: Twitch would drop an identical prompt (msg_duplicate).
    expect((await post(port, '/api/reset', {})).status).toBe(200);
    expect((await post(port, '/api/call', crossoverCall(1))).status).toBe(202);
    expect(twitch.service.say).toHaveBeenLastCalledWith(['A', 'B'], `${prompt} (take 2)`);
  });

  it('maps channel lookup failures to 400 / 409 / 502 with safe messages', async () => {
    const twitch = fakeTwitch();
    const { port } = await start({
      demo: false,
      twitchClientId: 'public-client-id',
      createTwitch: twitch.factory,
    });
    const cases = [
      [new ChannelLookupError('not-found', 'No Twitch channel named "ghost".'), 400],
      [new ChannelLookupError('invalid-login', 'Channel B is not a valid Twitch login.'), 400],
      [new ChannelLookupError('not-signed-in', 'Connect Twitch before choosing channels.'), 409],
      [new ChannelLookupError('failed', 'Could not look up Twitch channels'), 502],
      [new Error('socket hang up'), 502],
    ] as const;
    for (const [failure, status] of cases) {
      twitch.service.setChannels.mockRejectedValueOnce(failure);
      const response = await post(port, '/api/channels', { b: 'ghost' });
      expect(response.status, failure.message).toBe(status);
      const body = JSON.parse(response.body) as { error: string };
      // Operator mistakes are explained verbatim; unexpected failures stay generic.
      expect(body.error).toBe(
        status === 502 ? 'Twitch could not resolve those channels' : failure.message,
      );
    }
  });

  it('never constructs Twitch or sends chat in demo mode', async () => {
    const twitch = fakeTwitch();
    const { port } = await start({ demo: true, createTwitch: twitch.factory, twitchClientId: 'x' });
    await post(port, '/api/call', crossoverCall(1));
    await post(port, '/dev/chat', { side: 'A', count: 1, seed: 1 });
    await post(port, '/dev/chat', { side: 'B', count: 1, seed: 1 });
    const { snapshot } = await getJson<SnapshotResponse>(port, '/api/snapshot');
    expect(snapshot.phase).toBe('revealing');
    expect(twitch.factory).not.toHaveBeenCalled();
    expect(twitch.service.say).not.toHaveBeenCalled();
  });
});

describe('team label boundary and persistence', () => {
  it('validates sides, text types and the 24-character bound', () => {
    for (const value of [null, [], { a: 'wrong' }, { A: 3 }, { B: null }, { A: 'x'.repeat(25) }])
      expect(parseLabelsRequest(value).ok).toBe(false);
    expect(parseLabelsRequest({ A: ' TEAM ORANGE ', B: '' })).toEqual({
      ok: true,
      value: { A: 'TEAM ORANGE', B: '' },
    });
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), (A) => {
        expect(parseLabelsRequest({ A })).toEqual({ ok: true, value: { A: A.trim() } });
      }),
      { seed: 1101, numRuns: 100 },
    );
  });

  it('preserves team labels over channel synchronization and reconnect, clearing to login', async () => {
    const twitch = fakeTwitch();
    const { port } = await start({
      demo: false,
      twitchClientId: 'test-client',
      createTwitch: twitch.factory,
    });
    expect((await post(port, '/api/labels', { A: 'TEAM ORANGE', B: 'TEAM BLUE' })).status).toBe(
      200,
    );
    twitch.setStatus('reconnecting');
    twitch.setStatus('connected');
    await post(port, '/api/channels', { b: 'gamma' });
    const state = await getJson<ControlState>(port, '/api/state');
    expect(state.meta.labels).toEqual({ A: 'TEAM ORANGE', B: 'TEAM BLUE' });
    const overlay = await getJson<SnapshotResponse>(port, '/api/snapshot');
    expect(overlay.meta.labels).toEqual(state.meta.labels);
    expect((await post(port, '/api/labels', { A: '' })).status).toBe(200);
    expect((await getJson<ControlState>(port, '/api/state')).meta.labels).toEqual({
      A: 'alpha',
      B: 'TEAM BLUE',
    });
  });

  it('uses the same local-only controls protection as channels, including room tokens', async () => {
    const { port } = await start();
    expect((await post(port, '/api/labels', { A: 'TEAM ORANGE' }, PROXY)).status).toBe(403);
    expect((await post(port, `/api/labels?room=${ROOM}`, { A: 'TEAM ORANGE' }, PROXY)).status).toBe(
      403,
    );
    expect(
      (await post(port, '/api/labels', { A: 'TEAM ORANGE' }, { Origin: 'https://foreign.example' }))
        .status,
    ).toBe(403);
    expect((await post(port, '/api/labels', { A: 'x'.repeat(25) })).status).toBe(400);
    expect((await post(port, '/api/labels', { A: 'TEAM ORANGE', B: 'TEAM BLUE' })).status).toBe(
      200,
    );
    await post(port, '/api/channels', { a: 'demo_a', b: 'demo_b' });
    expect((await getJson<ControlState>(port, '/api/state')).meta.labels).toEqual({
      A: 'TEAM ORANGE',
      B: 'TEAM BLUE',
    });
  });
});

it('sends one help call per live round through the existing Twitch queue', async () => {
  const twitch = fakeTwitch();
  const { app, port } = await start({
    demo: false,
    twitchClientId: 'test-client',
    createTwitch: twitch.factory,
  });
  const helpCalls = () =>
    twitch.service.say.mock.calls.filter(([, message]) => message.includes(' is done! '));
  for (let round = 0; round < 2; round += 1) {
    expect((await post(port, '/api/call', crossoverCall(3))).status).toBe(202);
    if (round > 0)
      await vi.waitFor(() =>
        expect(twitch.service.say).toHaveBeenLastCalledWith(
          ['A', 'B'],
          expect.stringMatching(/\(take 2\)$/),
        ),
      );
    for (let i = 0; i < 3; i += 1) twitch.chat('A', `a-${i}`);
    await vi.waitFor(() => expect(helpCalls()).toHaveLength(round + 1));
    twitch.chat('A', 'extra');
    twitch.chat('B', 'one');
    app.runtime.tick();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(helpCalls()).toHaveLength(round + 1);
    expect(helpCalls().at(-1)?.[0]).toEqual(['A']);
    await post(port, '/api/reset', {});
  }
  expect((await getJson<SnapshotResponse>(port, '/api/snapshot')).snapshot.phase).toBe('idle');
});
