import type { IncomingMessage } from 'node:http';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyRequest,
  generateRoomToken,
  isJsonContentType,
  isLoopbackHost,
  isSameOriginOrAbsent,
  readCookie,
  tokensEqual,
} from '../src/server/access.js';
import {
  parseCallRequest,
  parseChannelsRequest,
  snapshotResponse,
} from '../src/server/routes/api.js';
import { parseShowcaseRequest } from '../src/server/routes/dev.js';
import { createStaticResolver, toPublicRelativePath } from '../src/server/static.js';
import type { Snapshot } from '../src/engine/types.js';
import type { RoundPayload } from '../src/shared/protocol.js';

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const TOKEN = generateRoomToken();

describe('room token and request classification', () => {
  it('generates 24-byte base64url tokens and compares them safely', () => {
    expect(TOKEN).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(generateRoomToken()).not.toBe(TOKEN);
    expect(tokensEqual(TOKEN, TOKEN)).toBe(true);
    expect(tokensEqual(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokensEqual(TOKEN.slice(1), TOKEN)).toBe(false);
    expect(tokensEqual('', TOKEN)).toBe(false);
    expect(tokensEqual('x'.repeat(10_000), TOKEN)).toBe(false);
  });

  it('accepts only loopback Host headers as local', () => {
    for (const host of ['127.0.0.1:3000', 'localhost:3000', 'localhost', '[::1]:3000']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of [
      undefined,
      '',
      'evil.example',
      '127.0.0.1.evil.example',
      'abc.trycloudflare.com',
    ]) {
      expect(isLoopbackHost(host), String(host)).toBe(false);
    }
  });

  it('classifies proxy-header or foreign-Host requests as remote and checks the room token', () => {
    const url = (query = '') => new URL(`http://localhost/overlay/b${query}`);
    const local = request({ host: '127.0.0.1:3000' });
    expect(classifyRequest(local, url(), TOKEN)).toEqual({ kind: 'local' });
    for (const proxy of ['x-forwarded-for', 'cf-connecting-ip', 'cf-ray', 'forwarded']) {
      const remote = request({ host: '127.0.0.1:3000', [proxy]: '1' });
      expect(classifyRequest(remote, url(), TOKEN)).toMatchObject({
        kind: 'remote',
        roomOk: false,
      });
      expect(classifyRequest(remote, url(`?room=${TOKEN}`), TOKEN)).toEqual({
        kind: 'remote',
        roomOk: true,
        roomFromQuery: true,
      });
    }
    const cookie = request({ host: 'x.trycloudflare.com', cookie: `a=1; crossover_room=${TOKEN}` });
    expect(classifyRequest(cookie, url(), TOKEN)).toEqual({
      kind: 'remote',
      roomOk: true,
      roomFromQuery: false,
    });
    expect(readCookie(request({ cookie: 'x=1;  crossover_room=abc ; y' }), 'crossover_room')).toBe(
      'abc',
    );
  });

  it('requires same-origin (or absent) Origin and a JSON content type for POSTs', () => {
    expect(isSameOriginOrAbsent(request({ host: 'localhost:3000' }))).toBe(true);
    expect(
      isSameOriginOrAbsent(request({ host: 'localhost:3000', origin: 'http://localhost:3000' })),
    ).toBe(true);
    expect(
      isSameOriginOrAbsent(request({ host: 'localhost:3000', origin: 'http://localhost:4000' })),
    ).toBe(false);
    expect(isSameOriginOrAbsent(request({ host: 'localhost:3000', origin: 'null' }))).toBe(false);
    expect(isJsonContentType(request({ 'content-type': 'application/json; charset=utf-8' }))).toBe(
      true,
    );
    expect(isJsonContentType(request({ 'content-type': 'application/jsonp' }))).toBe(false);
    expect(isJsonContentType(request({ 'content-type': 'text/plain' }))).toBe(false);
    expect(isJsonContentType(request({}))).toBe(false);
  });
});

describe('static path resolution', () => {
  it('maps aliases and allowlisted files, rejecting everything unsafe', () => {
    expect(toPublicRelativePath('/')).toBe('control/index.html');
    expect(toPublicRelativePath('/overlay/b')).toBe('overlay/index.html');
    expect(toPublicRelativePath('/overlay/overlay.js')).toBe('overlay/overlay.js');
    expect(toPublicRelativePath('/fonts/pixel%20font.woff2')).toBe('fonts/pixel font.woff2');
    for (const unsafe of [
      '/../secret.js',
      '/overlay/../../secret.js',
      '/%2e%2e/secret.js',
      '/overlay/..%2f..%2fsecret.js',
      '/..%5csecret.js',
      '/a\\b.js',
      '/%00.js',
      '/C:/Windows/x.png',
      '/overlay//overlay.js',
      '/.hidden.js',
      '/overlay/.env.js',
      '/x.js::$DATA',
      '/package.json',
      '/README.md',
      '/overlay/overlay.ts',
      '/%E0%A4%A.js',
      'relative.js',
    ]) {
      expect(toPublicRelativePath(unsafe), unsafe).toBeNull();
    }
  });

  describe('resolver on disk (path with spaces)', () => {
    let root = '';
    afterEach(async () => {
      if (root !== '') await rm(path.dirname(root), { recursive: true, force: true });
      root = '';
    });

    it('serves real files only from inside the root, with the right content type', async () => {
      const base = await mkdtemp(path.join(tmpdir(), 'crossover static '));
      root = path.join(base, 'public dir');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.join(root, 'overlay'), { recursive: true });
      await writeFile(path.join(root, 'overlay', 'overlay.css'), 'body{}');
      await writeFile(path.join(base, 'outside.css'), 'secret{}');
      const resolve = createStaticResolver(root);
      expect(await resolve('/overlay/overlay.css')).toMatchObject({
        contentType: 'text/css; charset=utf-8',
      });
      expect((await resolve('/overlay/overlay.css'))?.body.toString()).toBe('body{}');
      expect(await resolve('/overlay/missing.css')).toBeNull();
      expect(await resolve('/overlay')).toBeNull();
      expect(await resolve('/%2e%2e/outside.css')).toBeNull();
      try {
        await symlink(path.join(base, 'outside.css'), path.join(root, 'overlay', 'link.css'));
      } catch {
        return; // Creating symlinks needs Developer Mode/admin on Windows; the rest is covered.
      }
      expect(await resolve('/overlay/link.css')).toBeNull();
    });
  });
});

describe('request parsers', () => {
  it('validates CALL bodies by type and keeps unknown keys out', () => {
    const parsed = parseCallRequest({
      artwork: { cols: 1 },
      mode: 'single',
      durationMs: 30_000,
      quorumOverride: { A: 4, B: null, C: 9 },
      extra: 'ignored',
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        artwork: { cols: 1 },
        mode: 'single',
        durationMs: 30_000,
        quorumOverride: { A: 4, B: null },
      },
    });
    expect(parseCallRequest(null)).toMatchObject({ ok: false });
    expect(parseCallRequest([])).toMatchObject({ ok: false });
    expect(parseCallRequest({})).toMatchObject({ ok: false, error: 'artwork is required' });
    expect(parseCallRequest({ artwork: 1, quorumRatio: Number.NaN })).toMatchObject({ ok: false });
    expect(parseCallRequest({ artwork: 1, quorumOverride: { A: '3' } })).toMatchObject({
      ok: false,
    });
  });

  it('validates channel logins and showcase scenarios', () => {
    expect(parseChannelsRequest({ a: ' Night_Owls ', b: null })).toEqual({
      ok: true,
      value: { a: 'Night_Owls', b: null },
    });
    expect(parseChannelsRequest({ a: 'two words' })).toMatchObject({ ok: false });
    expect(parseChannelsRequest({ b: 'x'.repeat(26) })).toMatchObject({ ok: false });
    expect(parseChannelsRequest({ a: 'ok', token: 'nope' })).toMatchObject({ ok: false });
    expect(parseShowcaseRequest({ scenario: 'so-close' })).toEqual({ scenario: 'so-close' });
    expect(parseShowcaseRequest({ scenario: 'so-close', extra: 1 })).toBeNull();
    expect(parseShowcaseRequest({ scenario: 'toString' })).toBeNull();
  });

  it('includes the round in polling responses only when the client id differs', () => {
    const snapshot = { phase: 'idle' } as unknown as Snapshot;
    const meta = { labels: { A: 'A', B: 'B' }, twitch: 'demo' } as const;
    const round = { roundId: 'r2' } as unknown as RoundPayload;
    expect('round' in snapshotResponse(snapshot, meta, null, null)).toBe(false);
    expect('round' in snapshotResponse(snapshot, meta, null, '')).toBe(false);
    expect(snapshotResponse(snapshot, meta, null, 'r1').round).toBeNull();
    expect(snapshotResponse(snapshot, meta, round, null).round).toBe(round);
    expect(snapshotResponse(snapshot, meta, round, 'r1').round).toBe(round);
    expect('round' in snapshotResponse(snapshot, meta, round, 'r2')).toBe(false);
  });
});
