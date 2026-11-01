import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DeviceAuthError,
  REQUIRED_SCOPES,
  awaitDeviceTokens,
  requestDeviceCode,
  validateToken,
  type DeviceAuthorization,
} from '../src/twitch/deviceAuth.js';
import { createHelixClient } from '../src/twitch/helix.js';
import {
  ReauthorizationRequiredError,
  createTokenManager,
  loadTokens,
  saveTokens,
  tokenFilePath,
} from '../src/twitch/tokenStore.js';

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

/** Fake clock whose sleep advances time instantly and records each requested delay. */
function fakeTime(start = 1_000_000) {
  let clock = start;
  const delays: number[] = [];
  return {
    now: () => clock,
    delays,
    sleep: async (ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      delays.push(ms);
      clock += ms;
    },
  };
}

const DEVICE: DeviceAuthorization = {
  device_code: 'device-code-1',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCD-EFGH',
  expires_in: 1800,
  interval: 5,
};

const TOKENS = {
  access_token: 'access-new',
  refresh_token: 'refresh-new',
  expires_in: 14_400,
  scope: [...REQUIRED_SCOPES],
  token_type: 'bearer',
};

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Data directories deliberately contain spaces (Windows profile paths often do). */
async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crossover twitch auth '));
  tempDirs.push(dir);
  return join(dir, 'data dir');
}

describe('Device Code flow (public client)', () => {
  it('starts with client_id and plural space-separated scopes, no secret', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, DEVICE));
    await expect(requestDeviceCode('client-id', { fetch })).resolves.toEqual(DEVICE);
    const [call] = calls;
    expect(call?.url.href).toBe('https://id.twitch.tv/oauth2/device');
    expect(call?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(call?.body);
    expect(form.get('client_id')).toBe('client-id');
    expect(form.get('scopes')).toBe('user:read:chat user:write:chat');
    expect(form.has('client_secret')).toBe(false);
  });

  it('rejects malformed device responses instead of inventing a verification URL', async () => {
    const { fetch } = fakeFetch(() => json(200, { ...DEVICE, verification_uri: 'javascript:x' }));
    await expect(requestDeviceCode('client-id', { fetch })).rejects.toThrow(/unexpected/);
  });

  it('polls at the interval through authorization_pending and slow_down until success', async () => {
    const responses = [
      json(400, { status: 400, message: 'authorization_pending' }),
      json(400, { status: 400, message: 'slow_down' }),
      json(400, { status: 400, message: 'authorization_pending' }),
      json(200, TOKENS),
    ];
    const { fetch, calls } = fakeFetch(() => responses.shift() ?? json(500, {}));
    const time = fakeTime();
    const tokens = await awaitDeviceTokens('client-id', DEVICE, new AbortController().signal, {
      fetch,
      now: time.now,
      sleep: time.sleep,
    });
    expect(tokens).toEqual(TOKENS);
    // Waits one interval before each poll; slow_down adds 5 s for every later poll.
    expect(time.delays).toEqual([5_000, 5_000, 10_000, 10_000]);
    expect(calls).toHaveLength(4);
    const form = new URLSearchParams(calls[0]?.body);
    expect(Object.fromEntries(form)).toEqual({
      client_id: 'client-id',
      scopes: 'user:read:chat user:write:chat',
      device_code: 'device-code-1',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
  });

  it('stops with an expired error once expires_in has elapsed', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(400, { status: 400, message: 'authorization_pending' }),
    );
    const time = fakeTime();
    const run = awaitDeviceTokens(
      'client-id',
      { ...DEVICE, expires_in: 12, interval: 5 },
      new AbortController().signal,
      { fetch, now: time.now, sleep: time.sleep },
    );
    await expect(run).rejects.toMatchObject({ name: 'DeviceAuthError', code: 'expired' });
    expect(calls).toHaveLength(2); // t = 5 s and 10 s; at 15 s the 12 s code is already expired
  });

  it('treats a consumed/invalid device code as expiry and surfaces denial', async () => {
    const time = fakeTime();
    const invalid = fakeFetch(() => json(400, { status: 400, message: 'invalid device code' }));
    await expect(
      awaitDeviceTokens('client-id', DEVICE, new AbortController().signal, {
        fetch: invalid.fetch,
        now: time.now,
        sleep: time.sleep,
      }),
    ).rejects.toBeInstanceOf(DeviceAuthError);
    const denied = fakeFetch(() => json(400, { status: 400, message: 'access_denied' }));
    await expect(
      awaitDeviceTokens('client-id', DEVICE, new AbortController().signal, {
        fetch: denied.fetch,
        now: time.now,
        sleep: time.sleep,
      }),
    ).rejects.toMatchObject({ code: 'denied' });
  });

  it('keeps polling through transient network failures and honors abort', async () => {
    let call = 0;
    const { fetch } = fakeFetch(() => {
      call += 1;
      if (call === 1) throw new TypeError('fetch failed');
      return json(200, TOKENS);
    });
    const time = fakeTime();
    await expect(
      awaitDeviceTokens('client-id', DEVICE, new AbortController().signal, {
        fetch,
        now: time.now,
        sleep: time.sleep,
      }),
    ).resolves.toEqual(TOKENS);

    const controller = new AbortController();
    controller.abort();
    await expect(
      awaitDeviceTokens('client-id', DEVICE, controller.signal, {
        fetch,
        now: time.now,
        sleep: time.sleep,
      }),
    ).rejects.toThrow();
  });

  it('validates with the OAuth header and maps 401 to a token rejection', async () => {
    const { fetch, calls } = fakeFetch((request) =>
      request.headers.get('authorization') === 'OAuth good'
        ? json(200, {
            client_id: 'client-id',
            login: 'streamer',
            user_id: '42',
            scopes: [...REQUIRED_SCOPES],
            expires_in: 3600,
          })
        : json(401, { status: 401, message: 'invalid access token' }),
    );
    await expect(validateToken('good', { fetch })).resolves.toMatchObject({ user_id: '42' });
    await expect(validateToken('bad', { fetch })).rejects.toMatchObject({
      name: 'TokenRejectedError',
    });
    expect(calls[0]?.url.href).toBe('https://id.twitch.tv/oauth2/validate');
  });
});

describe('token store and single-flight refresh', () => {
  it('does not leave a token file when sign-out overlaps a pending save', async () => {
    const dataDir = await tempDataDir();
    const manager = createTokenManager({ clientId: 'client-id', dataDir, deps: {} });
    const replacing = manager.replace(TOKENS);
    await manager.clear();
    await replacing;
    expect(manager.hasTokens()).toBe(false);
    await expect(loadTokens(dataDir)).resolves.toBeNull();
  });

  it('persists the latest authorization when multiple replacements overlap', async () => {
    const dataDir = await tempDataDir();
    const manager = createTokenManager({ clientId: 'client-id', dataDir, deps: {} });
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        manager.replace({
          ...TOKENS,
          access_token: `fake-access-${i}`,
          refresh_token: `fake-refresh-${i}`,
        }),
      ),
    );
    await expect(loadTokens(dataDir)).resolves.toMatchObject({
      accessToken: 'fake-access-7',
      refreshToken: 'fake-refresh-7',
    });
    await expect(manager.getAccessToken()).resolves.toBe('fake-access-7');
  });

  it('does not reload credentials after a concurrent sign-out', async () => {
    const dataDir = await tempDataDir();
    const manager = createTokenManager({ clientId: 'client-id', dataDir, deps: {} });
    await manager.replace(TOKENS);
    await Promise.all([manager.load(), manager.clear()]);
    expect(manager.hasTokens()).toBe(false);
    await expect(loadTokens(dataDir)).resolves.toBeNull();
  });

  it.each([200, 400, 503])(
    'cannot return old credentials after sign-out during a refresh (HTTP %i)',
    async (status) => {
      const dataDir = await tempDataDir();
      let release: () => void = () => undefined;
      let started: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const requested = new Promise<void>((resolve) => {
        started = resolve;
      });
      const { fetch } = fakeFetch(async () => {
        started();
        await gate;
        return json(status, TOKENS);
      });
      const manager = createTokenManager({ clientId: 'client-id', dataDir, deps: { fetch } });
      await manager.replace({ ...TOKENS, expires_in: 30 });
      const pending = manager.getAccessToken().catch((error: unknown) => error);
      await requested;
      await manager.clear();
      release();
      expect(await pending).toBeInstanceOf(ReauthorizationRequiredError);
      expect(manager.hasTokens()).toBe(false);
      await expect(loadTokens(dataDir)).resolves.toBeNull();
    },
  );

  it.each([200, 400, 503])(
    'keeps a new authorization when an older refresh finishes (HTTP %i)',
    async (status) => {
      const dataDir = await tempDataDir();
      let release: () => void = () => undefined;
      let started: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const requested = new Promise<void>((resolve) => {
        started = resolve;
      });
      let reauthorizations = 0;
      const { fetch } = fakeFetch(async () => {
        started();
        await gate;
        return json(status, TOKENS);
      });
      const manager = createTokenManager({
        clientId: 'client-id',
        dataDir,
        deps: { fetch },
        onReauthorizationRequired: () => {
          reauthorizations += 1;
        },
      });
      await manager.replace({
        ...TOKENS,
        access_token: 'fake-old-access',
        refresh_token: 'fake-old-refresh',
      });
      const pending = manager.refresh('fake-old-access');
      await requested;
      await manager.replace({
        ...TOKENS,
        access_token: 'fake-current-access',
        refresh_token: 'fake-current-refresh',
      });
      await expect(manager.getAccessToken()).resolves.toBe('fake-current-access');
      release();
      await expect(pending).resolves.toBe('fake-current-access');
      expect(reauthorizations).toBe(0);
      await expect(loadTokens(dataDir)).resolves.toMatchObject({
        accessToken: 'fake-current-access',
        refreshToken: 'fake-current-refresh',
      });
    },
  );

  it('persists atomically to <dataDir>/tokens.json in a path with spaces', async () => {
    const dataDir = await tempDataDir();
    const stored = {
      accessToken: 'a-1',
      refreshToken: 'r-1',
      scopes: [...REQUIRED_SCOPES],
      expiresAtMs: 123,
    };
    await saveTokens(dataDir, stored);
    await expect(loadTokens(dataDir)).resolves.toEqual(stored);
    if (process.platform !== 'win32') {
      expect((await stat(tokenFilePath(dataDir))).mode & 0o777).toBe(0o600);
    }
    // Corrupt files read as "signed out" rather than crashing startup.
    await saveTokens(dataDir, { ...stored, accessToken: '' });
    await expect(loadTokens(dataDir)).resolves.toBeNull();
  });

  it('runs one refresh for concurrent 401s and stores the rotated one-use pair first', async () => {
    const dataDir = await tempDataDir();
    await saveTokens(dataDir, {
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      scopes: [...REQUIRED_SCOPES],
      expiresAtMs: 10_000_000_000,
    });
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const { fetch, calls } = fakeFetch(async (request) => {
      if (request.url.href === 'https://id.twitch.tv/oauth2/token') {
        await refreshGate;
        return json(200, TOKENS);
      }
      // Helix: the old token is rejected, the rotated one works.
      return request.headers.get('authorization') === 'Bearer access-new'
        ? json(200, { data: [] })
        : json(401, { status: 401, message: 'Invalid OAuth token' });
    });
    const manager = createTokenManager({ clientId: 'client-id', dataDir, deps: { fetch } });
    expect(await manager.load()).toBe(true);
    const helix = createHelixClient({ clientId: 'client-id', tokens: manager, fetch });

    const pending = Promise.all([
      helix.request('GET', '/users'),
      helix.request('GET', '/users'),
      manager.refresh('access-old'),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseRefresh();
    const [first, second, refreshed] = await pending;
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(refreshed).toBe('access-new');

    const refreshCalls = calls.filter((call) => call.url.pathname === '/oauth2/token');
    expect(refreshCalls).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(refreshCalls[0]?.body))).toEqual({
      client_id: 'client-id',
      refresh_token: 'refresh-old',
      grant_type: 'refresh_token',
    });
    await expect(loadTokens(dataDir)).resolves.toMatchObject({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
    });
    // A late 401 seen with the stale token reuses the rotated pair: no second refresh.
    await expect(manager.refresh('access-old')).resolves.toBe('access-new');
    expect(calls.filter((call) => call.url.pathname === '/oauth2/token')).toHaveLength(1);
  });

  it('clears tokens and requires reauthorization when the refresh token is rejected', async () => {
    const dataDir = await tempDataDir();
    await saveTokens(dataDir, {
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      scopes: [...REQUIRED_SCOPES],
      expiresAtMs: 10_000_000_000,
    });
    const { fetch } = fakeFetch(() => json(400, { status: 400, message: 'Invalid refresh token' }));
    const manager = createTokenManager({ clientId: 'client-id', dataDir, deps: { fetch } });
    await manager.load();
    const error = await manager.refresh('access-old').catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ReauthorizationRequiredError);
    expect(String(error)).not.toMatch(/access-old|refresh-old/);
    expect(manager.hasTokens()).toBe(false);
    await expect(readFile(tokenFilePath(dataDir), 'utf8')).rejects.toThrow();
  });

  it('refreshes proactively when the access token is about to expire', async () => {
    const dataDir = await tempDataDir();
    const time = fakeTime(5_000_000);
    await saveTokens(dataDir, {
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      scopes: [...REQUIRED_SCOPES],
      expiresAtMs: 5_000_000 + 30_000,
    });
    const { fetch, calls } = fakeFetch(() => json(200, TOKENS));
    const manager = createTokenManager({
      clientId: 'client-id',
      dataDir,
      deps: { fetch, now: time.now },
    });
    await manager.load();
    await expect(manager.getAccessToken()).resolves.toBe('access-new');
    expect(calls).toHaveLength(1);
  });
});
