/**
 * Token persistence (`<dataDir>/tokens.json`, gitignored, mode 0o600 where supported) and the
 * in-memory token manager with single-flight refresh.
 *
 * Twitch Device Code refresh tokens are ONE-USE: two concurrent refreshes with the same refresh
 * token would burn the session. The manager therefore runs at most one refresh at a time, stores
 * the new pair before any waiter resumes, and lets callers that saw a 401 with an already-rotated
 * access token reuse the newer token instead of refreshing again.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TokenRejectedError, refreshTokens, type AuthDeps, type TokenSet } from './deviceAuth.js';
import { isRecord, readNumber, readString, readStringArray } from './json.js';

export const TOKEN_FILE_NAME = 'tokens.json';
const TOKEN_FILE_VERSION = 1;
/** Refresh proactively when the access token has less than this left. */
const PROACTIVE_REFRESH_MS = 2 * 60_000;

/** Server-only. Never log, serialize to clients or include in error messages. */
export interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly scopes: readonly string[];
  /** Epoch ms when the access token expires, derived from `expires_in` at issue/validate time. */
  readonly expiresAtMs: number;
}

/** No usable tokens: the streamer must run the Device Code flow again. Safe to show. */
export class ReauthorizationRequiredError extends Error {
  override readonly name = 'ReauthorizationRequiredError';
  constructor(message = 'Twitch authorization expired or was revoked. Connect Twitch again.') {
    super(message);
  }
}

export function tokenFilePath(dataDir: string): string {
  return join(dataDir, TOKEN_FILE_NAME);
}

export function toStoredTokens(tokens: TokenSet, nowMs: number): StoredTokens {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    scopes: tokens.scope,
    expiresAtMs: nowMs + tokens.expires_in * 1000,
  };
}

/** Reads the token file; a missing, unreadable or malformed file is treated as "signed out". */
export async function loadTokens(dataDir: string): Promise<StoredTokens | null> {
  let text: string;
  try {
    text = await readFile(tokenFilePath(dataDir), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== TOKEN_FILE_VERSION) return null;
  const accessToken = readString(parsed.accessToken);
  const refreshToken = readString(parsed.refreshToken);
  const scopes = readStringArray(parsed.scopes);
  const expiresAtMs = readNumber(parsed.expiresAtMs);
  if (!accessToken || !refreshToken || !scopes || expiresAtMs === null) return null;
  return { accessToken, refreshToken, scopes, expiresAtMs };
}

/** Atomic replace: write a private temp file, then rename over the previous token file. */
export async function saveTokens(dataDir: string, tokens: StoredTokens): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const target = tokenFilePath(dataDir);
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const content = `${JSON.stringify({ version: TOKEN_FILE_VERSION, ...tokens }, null, 2)}\n`;
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
  try {
    await renameWithRetry(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function deleteTokens(dataDir: string): Promise<void> {
  await rm(tokenFilePath(dataDir), { force: true });
}

/** Windows can briefly lock the target (indexers, antivirus); retry a few times before failing. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

export interface TokenManagerOptions {
  readonly clientId: string;
  readonly dataDir: string;
  readonly deps: AuthDeps;
  /** Persisting rotated tokens failed: the in-memory pair still works until restart. */
  readonly onPersistFailure?: () => void;
  /** A later successful save clears the owner's persistent storage warning. */
  readonly onPersistSuccess?: () => void;
  /**
   * Twitch rejected the refresh token (tokens are already cleared from memory and disk). Fires
   * whichever caller triggered the refresh (a Helix send, a lookup, validation), so the owner
   * can end dependent sessions right away instead of at the next hourly validation.
   */
  readonly onReauthorizationRequired?: () => void;
}

export interface TokenManager {
  /** Loads `<dataDir>/tokens.json`; returns whether usable tokens were found. */
  load(): Promise<boolean>;
  hasTokens(): boolean;
  /** Current access token, refreshed first when about to expire. */
  getAccessToken(): Promise<string>;
  /**
   * Single-flight refresh after Twitch answered 401 to a request made with `staleAccessToken`.
   * Resolves with the newer access token; rejects with ReauthorizationRequiredError when the
   * refresh token was rejected (tokens are then cleared from memory and disk).
   */
  refresh(staleAccessToken: string): Promise<string>;
  /** Stores a fresh pair from the Device Code flow. */
  replace(tokens: TokenSet): Promise<void>;
  /** Updates the expiry from a validate response (`expires_in` seconds remaining). */
  noteExpiresIn(seconds: number): void;
  /** Forgets tokens in memory and on disk. Never rejects; reports what was dropped/removed. */
  clear(): Promise<{ readonly droppedAccessToken: string | null; readonly fileRemoved: boolean }>;
  /** Current secrets, exposed ONLY so error strings can be redacted defensively. */
  secrets(): readonly string[];
}

/** Same refresh token = same session (expiry updates from validate do not start a new pair). */
function isSamePair(a: StoredTokens | null, b: StoredTokens): boolean {
  return a !== null && a.refreshToken === b.refreshToken;
}

export function createTokenManager(options: TokenManagerOptions): TokenManager {
  const now = options.deps.now ?? Date.now;
  let current: StoredTokens | null = null;
  let inflight: Promise<string> | null = null;
  let generation = 0;
  // Disk mutations must finish in invocation order: a slow save must never run after sign-out's
  // deletion, and overlapping authorizations must leave the newest pair on disk.
  let disk: Promise<void> = Promise.resolve();

  function onDisk<T>(operation: () => Promise<T>): Promise<T> {
    const result = disk.then(operation);
    disk = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function currentAccessToken(): string {
    if (!current) throw new ReauthorizationRequiredError();
    return current.accessToken;
  }

  async function persist(tokens: StoredTokens): Promise<void> {
    try {
      await onDisk(() => saveTokens(options.dataDir, tokens));
    } catch {
      if (isSamePair(current, tokens)) options.onPersistFailure?.();
      return;
    }
    if (isSamePair(current, tokens)) options.onPersistSuccess?.();
  }

  function startRefresh(used: StoredTokens): Promise<string> {
    const gen = generation;
    // The first await below yields before the flight's finally can run.
    let flight!: Promise<string>;
    flight = (async () => {
      try {
        const set = await refreshTokens(options.clientId, used.refreshToken, options.deps);
        // Signed out or re-authorized meanwhile: never resurrect a session the user dropped.
        if (!isSamePair(current, used)) {
          return currentAccessToken();
        }
        const next = toStoredTokens(set, now());
        // Memory first, so the rotated pair is the one every later caller sees even if the disk
        // write fails (the old refresh token is already consumed and useless).
        current = next;
        await persist(next);
        return currentAccessToken();
      } catch (error) {
        if (gen !== generation) return currentAccessToken();
        if (error instanceof TokenRejectedError && isSamePair(current, used)) {
          const rejectedGeneration = ++generation;
          current = null;
          await onDisk(() => deleteTokens(options.dataDir)).catch(() => undefined);
          try {
            if (generation === rejectedGeneration) options.onReauthorizationRequired?.();
          } catch {
            // A listener failure must not mask the reauthorization error for the caller.
          }
          throw new ReauthorizationRequiredError();
        }
        throw error;
      } finally {
        if (inflight === flight) inflight = null;
      }
    })();
    inflight = flight;
    return flight;
  }

  function refresh(staleAccessToken: string): Promise<string> {
    if (inflight) return inflight;
    if (!current) return Promise.reject(new ReauthorizationRequiredError());
    // Another caller already rotated the pair after this request was sent: reuse it.
    if (current.accessToken !== staleAccessToken) return Promise.resolve(current.accessToken);
    return startRefresh(current);
  }

  return {
    async load() {
      const gen = generation;
      const loaded = await onDisk(() => loadTokens(options.dataDir));
      if (gen === generation) current = loaded;
      return current !== null;
    },
    hasTokens: () => current !== null,
    async getAccessToken() {
      if (inflight) return inflight;
      if (!current) throw new ReauthorizationRequiredError();
      if (current.expiresAtMs - now() > PROACTIVE_REFRESH_MS) return current.accessToken;
      const token = current.accessToken;
      try {
        return await refresh(token);
      } catch (error) {
        if (error instanceof ReauthorizationRequiredError) throw error;
        // Transient refresh failure: the old token may still have a little life left.
        return currentAccessToken();
      }
    },
    refresh,
    async replace(tokens) {
      generation += 1;
      inflight = null;
      const next = toStoredTokens(tokens, now());
      current = next;
      await persist(next);
    },
    noteExpiresIn(seconds) {
      if (!current || !Number.isFinite(seconds) || seconds <= 0) return;
      current = { ...current, expiresAtMs: now() + seconds * 1000 };
    },
    async clear() {
      generation += 1;
      inflight = null;
      const droppedAccessToken = current?.accessToken ?? null;
      current = null;
      try {
        await onDisk(() => deleteTokens(options.dataDir));
        return { droppedAccessToken, fileRemoved: true };
      } catch {
        return { droppedAccessToken, fileRemoved: false };
      }
    },
    secrets: () => (current ? [current.accessToken, current.refreshToken] : []),
  };
}
