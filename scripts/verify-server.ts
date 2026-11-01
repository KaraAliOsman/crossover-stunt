/**
 * `pnpm verify:server`: start the real app on ephemeral loopback ports (demo and live without
 * credentials), smoke every route family, then stop. Never opens a tunnel or contacts Twitch,
 * and never prints the room token.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../src/server/http.js';
import { showcaseArtwork } from '../src/sim/showcase.js';
import type { ControlState, ServerMessage, SnapshotResponse } from '../src/shared/protocol.js';

const PRIVATE = /sim:\d|chatterId|participantIds|recentChatters|seenMessageKeys|messageKey/;

function pass(label: string): void {
  console.log(`PASS ${label}`);
}

async function expectStatus(base: string, path: string, status: number, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, init);
  assert.equal(response.status, status, `${init?.method ?? 'GET'} ${path}`);
  return response;
}

function postJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

/** Connects and resolves with the first `count` messages. */
function firstMessages(url: string, count: number): Promise<ServerMessage[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const received: ServerMessage[] = [];
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`WS ${url}: expected ${count} messages`));
    }, 5_000);
    socket.on('error', reject);
    socket.on('message', (data) => {
      received.push(JSON.parse(data.toString()) as ServerMessage);
      if (received.length < count) return;
      clearTimeout(timer);
      socket.close();
      resolve(received);
    });
  });
}

async function smokeDemo(): Promise<void> {
  const app = createApp({ demo: true });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const path of [
      '/',
      '/control',
      '/overlay/a',
      '/overlay/b',
      '/dev',
      '/overlay/overlay.js',
    ]) {
      const response = await expectStatus(base, path, 200);
      await response.arrayBuffer();
      pass(`demo GET ${path}`);
    }
    await expectStatus(base, '/..%2fpackage.json', 404);
    pass('demo static traversal rejected');

    const health = (await (await expectStatus(base, '/api/health', 200)).json()) as unknown;
    assert.deepEqual(health, { ok: true, simulated: true });
    pass('demo GET /api/health');

    const ws = await firstMessages(`ws://127.0.0.1:${port}/ws?side=A`, 4);
    assert.deepEqual(
      ws.map((message) => message.type),
      ['hello', 'meta', 'round', 'snapshot'],
    );
    pass('demo WS /ws?side=A hello → meta → round → snapshot');

    const call = await expectStatus(
      base,
      '/api/call',
      202,
      postJson({
        artwork: showcaseArtwork('crossover'),
        mode: 'crossover',
        durationMs: 30_000,
        quorumOverride: { A: 10, B: 10 },
      }),
    );
    const { roundId } = (await call.json()) as { roundId: string };
    pass('demo POST /api/call → 202');

    await expectStatus(base, '/dev/chat', 202, postJson({ side: 'A', count: 5, seed: 1 }));
    const polled = (await (
      await expectStatus(base, '/api/snapshot', 200)
    ).json()) as SnapshotResponse;
    assert.equal(polled.round?.roundId, roundId);
    assert.equal(polled.snapshot.sides.A.participants, 5);
    assert.equal(polled.snapshot.simulated, true);
    assert.doesNotMatch(JSON.stringify(polled), PRIVATE);
    pass('demo POST /dev/chat → GET /api/snapshot (aggregates only, SIMULATED)');

    const state = (await (await expectStatus(base, '/api/state', 200)).json()) as ControlState;
    assert.equal(state.twitch.status, 'demo');
    assert.equal(state.overlayUrls.partnerB, null);
    pass('demo GET /api/state');

    await expectStatus(base, '/api/reset', 200, postJson({}));
    await expectStatus(base, '/dev/showcase', 202, postJson({ scenario: 'single' }));
    await expectStatus(base, '/api/reset', 200, postJson({}));
    pass('demo POST /dev/showcase and /api/reset');

    const remote = { 'X-Forwarded-For': '203.0.113.9' };
    await expectStatus(base, '/api/state', 403, { headers: remote });
    await expectStatus(base, '/overlay/b', 403, { headers: remote });
    await expectStatus(base, `/overlay/b?room=${app.roomToken}`, 200, { headers: remote });
    await expectStatus(base, `/api/snapshot?room=${app.roomToken}`, 200, { headers: remote });
    await expectStatus(base, '/api/call', 403, postJson({}, remote));
    pass('remote access: room token required, controls forbidden');
  } finally {
    await app.close();
    pass('demo server stopped');
  }
}

async function smokeLiveWithoutCredentials(): Promise<void> {
  const app = createApp({ demo: false, twitchClientId: null });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = (await (await expectStatus(base, '/api/health', 200)).json()) as unknown;
    assert.deepEqual(health, { ok: true, simulated: false });
    const state = (await (await expectStatus(base, '/api/state', 200)).json()) as ControlState;
    assert.equal(state.twitch.status, 'signed-out');
    assert.match(state.twitch.error ?? '', /TWITCH_CLIENT_ID/);
    await expectStatus(base, '/dev', 404);
    await expectStatus(base, '/dev/chat', 404, postJson({ side: 'A', count: 1, seed: 1 }));
    pass('live without TWITCH_CLIENT_ID: starts, reports signed-out, /dev hidden');
  } finally {
    await app.close();
    pass('live server stopped');
  }
}

await smokeDemo();
await smokeLiveWithoutCredentials();
