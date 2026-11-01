import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '../src/server/http.js';
import {
  CLOUDFLARED_MISSING,
  createShareTunnel,
  findOnPath,
  type SpawnTunnel,
} from '../src/server/share.js';
import type { ControlState } from '../src/shared/protocol.js';

/** Minimal stand-in for a cloudflared child process. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => {
    child.signalCode = 'SIGTERM';
    return true;
  });
  return child;
}

function fakeSpawn() {
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawn = vi.fn((_command: string, _args: readonly string[]) => {
    const child = fakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  return { spawn: spawn satisfies SpawnTunnel, children };
}

const BANNER =
  '2026-10-31T20:00:00Z INF |  Your quick Tunnel has been created! Visit it at:  |\n' +
  '2026-10-31T20:00:00Z INF |  https://Calm-River-1234.trycloudflare.com          |\n';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('cloudflared quick tunnel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a missing binary instead of crashing', async () => {
    const { spawn } = fakeSpawn();
    const tunnel = createShareTunnel({
      localUrl: () => 'http://127.0.0.1:3000',
      findBinary: async () => null,
      spawn,
    });
    expect(await tunnel.start()).toEqual({
      status: 'error',
      error: CLOUDFLARED_MISSING,
      url: null,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns cloudflared, parses the trycloudflare URL and stops the child', async () => {
    const { spawn, children } = fakeSpawn();
    const tunnel = createShareTunnel({
      localUrl: () => 'http://127.0.0.1:3456',
      findBinary: async () => 'C:\\Program Files\\cloudflared\\cloudflared.exe',
      spawn,
    });
    expect((await tunnel.start()).status).toBe('starting');
    expect(spawn).toHaveBeenCalledWith('C:\\Program Files\\cloudflared\\cloudflared.exe', [
      'tunnel',
      '--url',
      'http://127.0.0.1:3456',
    ]);
    expect((await tunnel.start()).status).toBe('starting'); // idempotent while starting
    expect(spawn).toHaveBeenCalledTimes(1);
    // The URL may arrive split across chunks on stderr.
    children[0]!.stderr.write(BANNER.slice(0, 120));
    await tick();
    expect(tunnel.state().status).toBe('starting');
    children[0]!.stderr.write(BANNER.slice(120));
    await tick();
    expect(tunnel.state()).toEqual({
      status: 'on',
      error: null,
      url: 'https://calm-river-1234.trycloudflare.com',
    });
    await tunnel.stop();
    expect(children[0]!.kill).toHaveBeenCalled();
    expect(tunnel.state()).toEqual({ status: 'off', error: null, url: null });
    children[0]!.emit('exit', null);
    expect(tunnel.state().status).toBe('off');
  });

  it('turns spawn errors, early exits and silence into error states', async () => {
    vi.useFakeTimers();
    const { spawn, children } = fakeSpawn();
    const tunnel = createShareTunnel({
      localUrl: () => 'http://127.0.0.1:3000',
      findBinary: async () => '/usr/local/bin/cloudflared',
      spawn,
      startTimeoutMs: 1_000,
    });
    await tunnel.start();
    children[0]!.emit('error', Object.assign(new Error('spawn'), { code: 'ENOENT' }));
    expect(tunnel.state()).toMatchObject({ status: 'error', error: CLOUDFLARED_MISSING });

    await tunnel.start();
    children[1]!.emit('exit', 1);
    expect(tunnel.state()).toMatchObject({ status: 'error', error: 'cloudflared exited (code 1)' });

    await tunnel.start();
    vi.advanceTimersByTime(1_000);
    expect(tunnel.state()).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Timed out'),
    });
    expect(children[2]!.kill).toHaveBeenCalled();
  });

  it('finds the executable on PATH, including directories with spaces', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'crossover share '));
    try {
      const dir = path.join(base, 'Program Files', 'cloudflared');
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
      await writeFile(file, '', { mode: 0o755 });
      const quoted = process.platform === 'win32' ? `"${dir}"` : dir;
      const env = { PATH: [path.join(base, 'empty'), quoted].join(path.delimiter) };
      expect(await findOnPath('cloudflared', env)).toBe(file);
      expect(await findOnPath('cloudflared', { PATH: path.join(base, 'empty') })).toBeNull();
      expect(await findOnPath('cloudflared', {})).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('share routes', () => {
  const apps: App[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('exposes partnerB with the room token once the tunnel is up', async () => {
    const { spawn, children } = fakeSpawn();
    const app = createApp({
      demo: true,
      roomToken: 'room-token-for-test',
      share: { findBinary: async () => '/bin/cloudflared', spawn },
    });
    apps.push(app);
    const port = await app.listen(0);
    const post = (route: string) =>
      fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    const started = await post('/api/share/start');
    expect(started.status).toBe(202);
    expect(spawn).toHaveBeenCalledWith('/bin/cloudflared', [
      'tunnel',
      '--url',
      `http://127.0.0.1:${port}`,
    ]);
    children[0]!.stdout.write(BANNER);
    await tick();
    const state = (await (
      await fetch(`http://127.0.0.1:${port}/api/state`)
    ).json()) as ControlState;
    expect(state.share).toEqual({ status: 'on', error: null });
    expect(state.overlayUrls.partnerB).toBe(
      'https://calm-river-1234.trycloudflare.com/overlay/b?room=room-token-for-test',
    );
    expect((await post('/api/share/stop')).status).toBe(200);
    expect(children[0]!.kill).toHaveBeenCalled();
  });
});
