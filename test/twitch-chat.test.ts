import { describe, expect, it } from 'vitest';
import { createHelixClient } from '../src/twitch/helix.js';
import {
  createChatQueue,
  sendChatMessage,
  type SendAttempt,
  type SendChatRequest,
} from '../src/twitch/helixChat.js';

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

/** Virtual clock: sleeping advances time instantly, so pacing is asserted exactly. */
function virtualClock(start = 0) {
  let clock = start;
  return {
    now: () => clock,
    sleep: async (ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      clock += ms;
    },
  };
}

const request = (
  broadcaster: string,
  message = 'STUNT! Type anything in chat',
): SendChatRequest => ({
  broadcaster_id: broadcaster,
  sender_id: 'sender',
  message,
});

function helixWith(fetchFn: typeof fetch) {
  return createHelixClient({
    clientId: 'client-id',
    fetch: fetchFn,
    tokens: { getAccessToken: async () => 'access-1', refresh: async () => 'access-2' },
  });
}

describe('Helix Send Chat Message queue', () => {
  it('does not retry before a reset beyond the bounded retry budget', async () => {
    const time = virtualClock();
    const attemptsAt: number[] = [];
    const queue = createChatQueue({
      now: time.now,
      sleep: time.sleep,
      maxRetryWaitMs: 30_000,
      send: async () => {
        attemptsAt.push(time.now());
        return { kind: 'rate-limited', retryAtMs: 120_000 };
      },
    });
    const outcome = await queue.enqueue(request('chan-a'));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/rate limit/);
    await expect(queue.enqueue(request('chan-b'))).resolves.toMatchObject({ ok: false });
    expect(attemptsAt).toEqual([0]);
  });

  it('shares the HTTP 429 reset across queued channels even when retries are disabled', async () => {
    const time = virtualClock();
    const attemptsAt: number[] = [];
    const queue = createChatQueue({
      now: time.now,
      sleep: time.sleep,
      maxRateLimitRetries: 0,
      send: async () => {
        attemptsAt.push(time.now());
        return attemptsAt.length === 1
          ? { kind: 'rate-limited', retryAtMs: 5_000 }
          : { kind: 'sent', messageId: 'fake-sent' };
      },
    });
    await expect(queue.enqueue(request('chan-a'))).resolves.toMatchObject({ ok: false });
    await expect(queue.enqueue(request('chan-b'))).resolves.toEqual({ ok: true, reason: null });
    expect(attemptsAt[1]).toBeGreaterThanOrEqual(5_000);
  });

  it('never exceeds 20 sends per rolling 30 s nor 1 send/s per channel', async () => {
    const time = virtualClock();
    const sends: { at: number; channel: string }[] = [];
    const queue = createChatQueue({
      now: time.now,
      sleep: time.sleep,
      maxPending: 100,
      send: async (req) => {
        sends.push({ at: time.now(), channel: req.broadcaster_id });
        return { kind: 'sent', messageId: `m-${sends.length}` };
      },
    });
    const outcomes = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        queue.enqueue(request(i % 2 === 0 ? 'chan-a' : 'chan-b')),
      ),
    );
    expect(outcomes.every((outcome) => outcome.ok && outcome.reason === null)).toBe(true);
    expect(sends).toHaveLength(25);
    // Twenty sends fit in the first window (two channels, one per second each)...
    expect(sends[19]?.at).toBe(9_000);
    // ...and the 21st waits until the first send leaves the 30 s window.
    expect(sends[20]?.at).toBe(30_000);
    for (const [index, send] of sends.entries()) {
      const inWindow = sends.filter((other) => other.at > send.at - 30_000 && other.at <= send.at);
      expect(inWindow.length, `window ending at send ${index}`).toBeLessThanOrEqual(20);
      const previous = sends
        .slice(0, index)
        .filter((other) => other.channel === send.channel)
        .at(-1);
      if (previous) expect(send.at - previous.at).toBeGreaterThanOrEqual(1_000);
    }
  });

  it('reports is_sent:false with its drop_reason and never sets for_source_only', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(200, {
        data: [
          {
            message_id: '',
            is_sent: false,
            drop_reason: {
              code: 'msg_duplicate',
              message: 'The message is identical to one you sent within the last 30 seconds.',
            },
          },
        ],
      }),
    );
    const helix = helixWith(fetch);
    const time = virtualClock();
    const queue = createChatQueue({
      now: time.now,
      sleep: time.sleep,
      send: (req) => sendChatMessage(helix, req, time.now()),
    });
    const outcome = await queue.enqueue(request('chan-a'));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/msg_duplicate/);
    expect(calls).toHaveLength(1); // drops are final: no blind re-post
    const [call] = calls;
    expect(call?.url.href).toBe('https://api.twitch.tv/helix/chat/messages');
    expect(call?.headers.get('authorization')).toBe('Bearer access-1');
    expect(call?.headers.get('client-id')).toBe('client-id');
    expect(JSON.parse(call?.body ?? '')).toEqual({
      broadcaster_id: 'chan-a',
      sender_id: 'sender',
      message: 'STUNT! Type anything in chat',
    });
  });

  it('retries HTTP 429 after Ratelimit-Reset, but not ambiguous 5xx failures', async () => {
    const time = virtualClock(1_000_000);
    const responses = [
      json(
        429,
        { status: 429, message: 'Too Many Requests' },
        {
          'Ratelimit-Limit': '800',
          'Ratelimit-Remaining': '0',
          'Ratelimit-Reset': String((1_000_000 + 5_000) / 1000),
        },
      ),
      json(200, { data: [{ message_id: 'ok-1', is_sent: true, drop_reason: null }] }),
      json(503, { status: 503, message: 'Service Unavailable' }),
    ];
    const attemptsAt: number[] = [];
    const { fetch } = fakeFetch(() => {
      attemptsAt.push(time.now());
      return responses.shift() ?? json(500, {});
    });
    const helix = helixWith(fetch);
    const queue = createChatQueue({
      now: time.now,
      sleep: time.sleep,
      send: (req) => sendChatMessage(helix, req, time.now()),
    });
    await expect(queue.enqueue(request('chan-a'))).resolves.toEqual({ ok: true, reason: null });
    expect(attemptsAt).toHaveLength(2);
    expect((attemptsAt[1] ?? 0) - (attemptsAt[0] ?? 0)).toBeGreaterThanOrEqual(5_000);

    const failed = await queue.enqueue(request('chan-b'));
    expect(failed.ok).toBe(false);
    expect(failed.reason).toMatch(/HTTP 503/);
    expect(attemptsAt).toHaveLength(3);
  });

  it('gives up after bounded 429 retries', async () => {
    const time = virtualClock();
    let attempts = 0;
    const queue = createChatQueue({
      now: time.now,
      sleep: time.sleep,
      maxRateLimitRetries: 2,
      send: async (): Promise<SendAttempt> => {
        attempts += 1;
        return { kind: 'rate-limited', retryAtMs: null };
      },
    });
    const outcome = await queue.enqueue(request('chan-a'));
    expect(outcome).toEqual({ ok: false, reason: expect.stringMatching(/rate limit/) as unknown });
    expect(attempts).toBe(3);
  });

  it('rejects oversize, empty and overflow messages without sending', async () => {
    const time = virtualClock();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent = 0;
    const queue = createChatQueue({
      now: time.now,
      sleep: time.sleep,
      maxPending: 2,
      send: async (): Promise<SendAttempt> => {
        await gate;
        sent += 1;
        return { kind: 'sent', messageId: 'x' };
      },
    });
    await expect(queue.enqueue(request('chan-a', 'x'.repeat(501)))).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/500/) as unknown,
    });
    await expect(queue.enqueue(request('chan-a', '   '))).resolves.toMatchObject({ ok: false });
    const inFlight = queue.enqueue(request('chan-a'));
    const waiting = [queue.enqueue(request('chan-b')), queue.enqueue(request('chan-c'))];
    await expect(queue.enqueue(request('chan-d'))).resolves.toEqual({
      ok: false,
      reason: 'Chat send queue is full; message skipped',
    });
    release();
    await expect(Promise.all([inFlight, ...waiting])).resolves.toEqual([
      { ok: true, reason: null },
      { ok: true, reason: null },
      { ok: true, reason: null },
    ]);
    expect(sent).toBe(3);
  });

  it('resolves waiting messages when cancelled and stays usable', async () => {
    const time = virtualClock();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createChatQueue({
      now: time.now,
      sleep: time.sleep,
      send: async (): Promise<SendAttempt> => {
        await gate;
        return { kind: 'sent', messageId: 'x' };
      },
    });
    const first = queue.enqueue(request('chan-a'));
    const second = queue.enqueue(request('chan-b'));
    queue.cancelAll('Signed out of Twitch');
    await expect(second).resolves.toEqual({ ok: false, reason: 'Signed out of Twitch' });
    release();
    await expect(first).resolves.toEqual({ ok: true, reason: null });
    await expect(queue.enqueue(request('chan-c'))).resolves.toEqual({ ok: true, reason: null });
  });
});
