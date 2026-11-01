/**
 * Thin JSON-over-fetch helper shared by the Twitch modules. All network calls go through an
 * injectable `fetch` so tests never reach Twitch. Error messages are built here from fixed text,
 * the HTTP status and the host name only: never request bodies, headers, URLs with query strings or
 * response bodies, so tokens cannot leak into errors.
 */
import { setTimeout as delay } from 'node:timers/promises';

export const TWITCH_ID_BASE_URL = 'https://id.twitch.tv/oauth2';
export const HELIX_BASE_URL = 'https://api.twitch.tv/helix';
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type FetchFn = typeof fetch;

/** Abortable sleep; rejects with the signal's reason when aborted. Injectable for tests. */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: SleepFn = async (ms, signal) => {
  await delay(Math.max(0, ms), undefined, signal ? { signal } : undefined);
};

export interface JsonRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: URLSearchParams | string | null;
  readonly signal?: AbortSignal | null;
  readonly timeoutMs?: number;
}

export interface JsonResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Parsed JSON body, or null when the body is empty or not JSON. Always untrusted. */
  readonly body: unknown;
}

/** The request never produced an HTTP response (DNS, TCP, TLS, timeout). Safe to show. */
export class TwitchNetworkError extends Error {
  override readonly name = 'TwitchNetworkError';
}

/** Twitch answered with an unexpected status or body. Safe to show. */
export class TwitchHttpError extends Error {
  override readonly name = 'TwitchHttpError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export async function requestJson(
  fetchFn: FetchFn,
  url: string,
  request: JsonRequest,
): Promise<JsonResponse> {
  const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: request.method,
      headers: request.headers ?? {},
      body: request.body ?? null,
      signal,
    });
  } catch (error) {
    // A caller-initiated abort is not a network failure: surface it unchanged so callers can stop.
    if (request.signal?.aborted) throw request.signal.reason ?? error;
    throw new TwitchNetworkError(`Network error contacting Twitch (${new URL(url).host})`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    if (request.signal?.aborted) throw request.signal.reason;
    throw new TwitchNetworkError(`Network error reading a Twitch response (${new URL(url).host})`);
  }
  return { status: response.status, headers: response.headers, body: parseJson(text) };
}

function parseJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Epoch ms when a rate-limited request may be retried, from `Ratelimit-Reset` (epoch seconds) or
 * `Retry-After` (seconds). Null when neither header is usable.
 */
export function rateLimitRetryAtMs(headers: Headers, nowMs: number): number | null {
  const reset = Number(headers.get('ratelimit-reset'));
  if (headers.has('ratelimit-reset') && Number.isFinite(reset) && reset > 0) return reset * 1000;
  const retryAfter = Number(headers.get('retry-after'));
  if (headers.has('retry-after') && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return nowMs + retryAfter * 1000;
  }
  return null;
}
