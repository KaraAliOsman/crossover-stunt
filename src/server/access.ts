import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Access model (docs/DESIGN.md §Server). The server binds loopback only, so a request is
 * *local* when it carries no proxy header and addresses a loopback Host. Anything else came
 * through a tunnel/proxy (or is a DNS-rebinding attempt) and is *remote*: remote clients may only
 * read the partner overlay B, its assets, the polling snapshot and `/ws?side=B`, each authorized
 * by the room token. The room token is never a Twitch credential.
 */

/** Headers added by cloudflared/Cloudflare or any reverse proxy. Presence alone means remote. */
const PROXY_HEADERS: readonly string[] = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
  'true-client-ip',
  'cdn-loop',
];

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Cookie set on a successful remote overlay page load so module/asset requests stay authorized. */
export const ROOM_COOKIE = 'crossover_room';
/** Remote overlay sessions last one long stream at most. */
const ROOM_COOKIE_MAX_AGE_S = 12 * 60 * 60;
/** Tokens are 32 base64url chars; anything far longer is rejected before hashing. */
const MAX_TOKEN_LENGTH = 256;

export type RequestAccess =
  | { readonly kind: 'local' }
  | {
      readonly kind: 'remote';
      /** True when `?room=` or the room cookie matches the server's room token. */
      readonly roomOk: boolean;
      /** True when the token arrived in the query string (eligible to set the cookie). */
      readonly roomFromQuery: boolean;
    };

/** 24 random bytes, base64url: unguessable, URL-safe, generated once per server start. */
export function generateRoomToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Constant-time token comparison. Hashing first makes the comparison length-independent, so
 * neither the content nor the length of the expected token leaks through timing.
 */
export function tokensEqual(candidate: string, expected: string): boolean {
  if (candidate.length === 0 || candidate.length > MAX_TOKEN_LENGTH) return false;
  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** True when the Host header names this machine's loopback interface (any port). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host.length === 0 || host.length > 300) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export function hasProxyHeaders(request: IncomingMessage): boolean {
  return PROXY_HEADERS.some((name) => request.headers[name] !== undefined);
}

/** Reads one cookie value without a dependency; ignores malformed pairs. */
export function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return null;
}

export function classifyRequest(
  request: IncomingMessage,
  url: URL,
  roomToken: string,
): RequestAccess {
  if (!hasProxyHeaders(request) && isLoopbackHost(request.headers.host)) return { kind: 'local' };
  const queryToken = url.searchParams.get('room');
  if (queryToken !== null && tokensEqual(queryToken, roomToken)) {
    return { kind: 'remote', roomOk: true, roomFromQuery: true };
  }
  const cookieToken = readCookie(request, ROOM_COOKIE);
  return {
    kind: 'remote',
    roomOk: cookieToken !== null && tokensEqual(cookieToken, roomToken),
    roomFromQuery: false,
  };
}

/**
 * Browser-originated cross-site requests carry a foreign Origin. Same-origin pages, OBS and CLI
 * tools either send our own origin or none at all.
 */
export function isSameOriginOrAbsent(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return origin === `http://${request.headers.host ?? ''}`;
}

export function isJsonContentType(request: IncomingMessage): boolean {
  const type = request.headers['content-type'];
  return typeof type === 'string' && /^application\/json\s*(;|$)/i.test(type);
}

/** Session cookie for the tunnel origin; HttpOnly so overlay scripts never see it. */
export function roomCookieHeader(roomToken: string): string {
  return `${ROOM_COOKIE}=${roomToken}; Path=/; Max-Age=${ROOM_COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`;
}
