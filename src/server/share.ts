import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

/**
 * Optional cloudflared quick tunnel for a remote partner (docs/DESIGN.md §Server).
 * Only `/overlay/b`, its assets, `/api/snapshot` and `/ws?side=B` are reachable through it, and
 * only with the room token (see access.ts). Quick tunnels are temporary and need no account.
 */

export type ShareStatus = 'off' | 'starting' | 'on' | 'error';

export interface ShareState {
  readonly status: ShareStatus;
  readonly error: string | null;
  /** Public `https://*.trycloudflare.com` origin while `on`. */
  readonly url: string | null;
}

export const CLOUDFLARED_MISSING = 'cloudflared not installed';
export const DEFAULT_START_TIMEOUT_MS = 30_000;
const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
/** cloudflared logs a lot; only the recent tail is searched for the URL. */
const OUTPUT_TAIL_CHARS = 4096;

export type SpawnTunnel = (command: string, args: readonly string[]) => ChildProcess;

export interface ShareTunnelOptions {
  /** Local origin to expose, e.g. http://127.0.0.1:3000 (read at start time). */
  readonly localUrl: () => string;
  /** Resolves the cloudflared executable, or null when it is not installed. */
  readonly findBinary?: () => Promise<string | null>;
  readonly spawn?: SpawnTunnel;
  readonly startTimeoutMs?: number;
}

export interface ShareTunnel {
  /** Returns quickly with `starting` (or `error`); poll `state()` for the URL. */
  start(): Promise<ShareState>;
  stop(): Promise<void>;
  state(): ShareState;
}

/** Cross-platform PATH lookup without a shell (`cloudflared.exe` on Windows). */
export async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const searchPath = env.PATH ?? env.Path ?? '';
  const file = platform === 'win32' ? `${name}.exe` : name;
  const mode = platform === 'win32' ? constants.F_OK : constants.X_OK;
  for (const rawDir of searchPath.split(platform === 'win32' ? ';' : ':')) {
    // Windows PATH entries may be quoted when they contain spaces.
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (dir.length === 0) continue;
    const candidate =
      platform === 'win32' ? path.win32.join(dir, file) : path.posix.join(dir, file);
    try {
      await access(candidate, mode);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

const defaultSpawn: SpawnTunnel = (command, args) =>
  nodeSpawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

const OFF: ShareState = Object.freeze({ status: 'off', error: null, url: null });

function failed(error: string): ShareState {
  return Object.freeze({ status: 'error', error, url: null });
}

export function createShareTunnel(options: ShareTunnelOptions): ShareTunnel {
  const findBinary = options.findBinary ?? (() => findOnPath('cloudflared'));
  const spawn = options.spawn ?? defaultSpawn;
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  let state: ShareState = OFF;
  let child: ChildProcess | null = null;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every start/stop so stale async continuations become no-ops. */
  let generation = 0;

  function clearStartTimer(): void {
    if (startTimer !== null) clearTimeout(startTimer);
    startTimer = null;
  }

  function kill(proc: ChildProcess): void {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
  }

  function watch(proc: ChildProcess): void {
    let tail = '';
    const onOutput = (chunk: Buffer | string): void => {
      if (child !== proc || state.status !== 'starting') return;
      tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
      const match = TRYCLOUDFLARE_URL.exec(tail);
      if (match === null) return;
      clearStartTimer();
      state = Object.freeze({ status: 'on', error: null, url: match[0].toLowerCase() });
    };
    proc.stdout?.on('data', onOutput);
    proc.stderr?.on('data', onOutput);
    proc.once('error', (error: NodeJS.ErrnoException) => {
      if (child !== proc) return;
      child = null;
      clearStartTimer();
      state = failed(error.code === 'ENOENT' ? CLOUDFLARED_MISSING : 'cloudflared failed to start');
    });
    proc.once('exit', (code) => {
      if (child !== proc) return;
      child = null;
      clearStartTimer();
      state = failed(`cloudflared exited${code === null ? '' : ` (code ${code})`}`);
    });
  }

  return {
    async start() {
      if (state.status === 'starting' || state.status === 'on') return state;
      const current = ++generation;
      state = Object.freeze({ status: 'starting', error: null, url: null });
      const binary = await findBinary();
      if (current !== generation) return state;
      if (binary === null) {
        state = failed(CLOUDFLARED_MISSING);
        return state;
      }
      let proc: ChildProcess;
      try {
        proc = spawn(binary, ['tunnel', '--url', options.localUrl()]);
      } catch {
        state = failed('cloudflared failed to start');
        return state;
      }
      child = proc;
      watch(proc);
      startTimer = setTimeout(() => {
        startTimer = null;
        if (child !== proc || state.status !== 'starting') return;
        child = null;
        state = failed('Timed out waiting for the trycloudflare URL');
        kill(proc);
      }, startTimeoutMs);
      startTimer.unref();
      return state;
    },

    async stop() {
      generation += 1;
      clearStartTimer();
      const proc = child;
      child = null;
      state = OFF;
      if (proc !== null) kill(proc);
    },

    state: () => state,
  };
}
