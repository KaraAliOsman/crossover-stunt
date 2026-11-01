/**
 * Authenticated Helix requests with the user access token. A 401 triggers ONE single-flight
 * refresh (tokenStore.ts) and one retry; the caller handles any other status.
 */
import { HELIX_BASE_URL, requestJson, type FetchFn, type JsonResponse } from './http.js';
import type { TokenManager } from './tokenStore.js';

export type HelixQuery = Readonly<Record<string, string | readonly string[]>>;

export interface HelixRequest {
  readonly query?: HelixQuery;
  /** Serialized as JSON. */
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface HelixClient {
  readonly clientId: string;
  request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options?: HelixRequest,
  ): Promise<JsonResponse>;
}

export interface HelixClientOptions {
  readonly clientId: string;
  readonly tokens: Pick<TokenManager, 'getAccessToken' | 'refresh'>;
  readonly fetch: FetchFn;
  readonly baseUrl?: string;
}

export function createHelixClient(options: HelixClientOptions): HelixClient {
  const baseUrl = options.baseUrl ?? HELIX_BASE_URL;

  function buildUrl(path: string, query: HelixQuery | undefined): string {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      for (const item of typeof value === 'string' ? [value] : value) {
        url.searchParams.append(key, item);
      }
    }
    return url.toString();
  }

  return {
    clientId: options.clientId,
    async request(method, path, request = {}) {
      const url = buildUrl(path, request.query);
      const send = (accessToken: string) =>
        requestJson(options.fetch, url, {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Client-Id': options.clientId,
            ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: request.body === undefined ? null : JSON.stringify(request.body),
          signal: request.signal ?? null,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        });
      const token = await options.tokens.getAccessToken();
      const first = await send(token);
      if (first.status !== 401) return first;
      return send(await options.tokens.refresh(token));
    },
  };
}
