/**
 * Twitch OAuth for a PUBLIC client: Device Code grant, refresh and validation. No client secret is
 * ever used. See docs/TWITCH_NOTES.md §Public Device Code authentication.
 *
 * Tokens returned here are server-only: never log them, put them in URLs or include them in errors.
 */
import {
  TWITCH_ID_BASE_URL,
  TwitchHttpError,
  TwitchNetworkError,
  defaultSleep,
  requestJson,
  type FetchFn,
  type SleepFn,
} from './http.js';
import { isRecord, readErrorMessage, readNumber, readString, readStringArray } from './json.js';

export const REQUIRED_SCOPES = ['user:read:chat', 'user:write:chat'] as const;

/** Space-separated scope list for the Device Code `scopes` (plural) form field. */
const SCOPES_PARAM = REQUIRED_SCOPES.join(' ');
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
/** RFC 8628: increase the polling interval by 5 seconds on `slow_down`. */
const SLOW_DOWN_STEP_MS = 5_000;

export interface DeviceAuthorization {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly expires_in: number;
  readonly interval: number;
}

/** Server-only; must never be logged, put in an overlay URL, or sent to overlay clients. */
export interface TokenSet {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly scope: readonly string[];
  readonly token_type: string;
}

export interface ValidatedToken {
  readonly client_id: string;
  readonly login: string;
  readonly user_id: string;
  readonly scopes: readonly string[];
  readonly expires_in: number;
}

/** Injectable side effects (tests pass a fake fetch, clock and sleep). */
export interface AuthDeps {
  readonly fetch?: FetchFn;
  readonly now?: () => number;
  readonly sleep?: SleepFn;
}

export type DeviceAuthFailure = 'expired' | 'denied' | 'failed';

/** The Device Code flow ended without tokens. The message is safe to show on local controls. */
export class DeviceAuthError extends Error {
  override readonly name = 'DeviceAuthError';
  constructor(
    readonly code: DeviceAuthFailure,
    message: string,
  ) {
    super(message);
  }
}

/** Twitch rejected an access or refresh token: the user must authorize again. */
export class TokenRejectedError extends Error {
  override readonly name = 'TokenRejectedError';
}

const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' } as const;

export async function requestDeviceCode(
  clientId: string,
  deps: AuthDeps = {},
  signal?: AbortSignal,
): Promise<DeviceAuthorization> {
  const response = await requestJson(deps.fetch ?? fetch, `${TWITCH_ID_BASE_URL}/device`, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: new URLSearchParams({ client_id: clientId, scopes: SCOPES_PARAM }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (response.status !== 200) {
    throw new TwitchHttpError(
      response.status,
      `Twitch refused to start device authorization (HTTP ${response.status}); check TWITCH_CLIENT_ID and that the app is a Public client`,
    );
  }
  const device = parseDeviceAuthorization(response.body);
  if (!device) {
    throw new TwitchHttpError(
      response.status,
      'Twitch returned an unexpected device code response',
    );
  }
  return device;
}

/**
 * Polls the token endpoint at the server-provided interval until the user approves, the code
 * expires or `signal` aborts (rejects with the abort reason). Transient network/5xx failures keep
 * polling until expiry.
 */
export async function awaitDeviceTokens(
  clientId: string,
  device: DeviceAuthorization,
  signal: AbortSignal,
  deps: AuthDeps = {},
): Promise<TokenSet> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const expiresAtMs = now() + device.expires_in * 1000;
  let intervalMs = Math.max(1, device.interval) * 1000;
  const body = new URLSearchParams({
    client_id: clientId,
    scopes: SCOPES_PARAM,
    device_code: device.device_code,
    grant_type: DEVICE_GRANT_TYPE,
  });

  for (;;) {
    await sleep(intervalMs, signal);
    signal.throwIfAborted();
    if (now() >= expiresAtMs) throw expiredError();

    let response;
    try {
      response = await requestJson(deps.fetch ?? fetch, `${TWITCH_ID_BASE_URL}/token`, {
        method: 'POST',
        headers: FORM_HEADERS,
        body,
        signal,
      });
    } catch (error) {
      if (error instanceof TwitchNetworkError) continue;
      throw error;
    }

    if (response.status === 200) {
      const tokens = parseTokenSet(response.body);
      if (!tokens)
        throw new DeviceAuthError('failed', 'Twitch returned an unexpected token response');
      return tokens;
    }
    const message = readErrorMessage(response.body)?.toLowerCase() ?? '';
    if (message === 'authorization_pending') continue;
    if (message === 'slow_down') {
      intervalMs += SLOW_DOWN_STEP_MS;
      continue;
    }
    if (message === 'invalid device code' || message === 'expired_token') throw expiredError();
    if (message === 'access_denied') {
      throw new DeviceAuthError('denied', 'Twitch authorization was declined. Connect again.');
    }
    if (response.status === 429 || response.status >= 500) continue;
    throw new DeviceAuthError(
      'failed',
      `Twitch rejected the device authorization (HTTP ${response.status})`,
    );
  }
}

function expiredError(): DeviceAuthError {
  return new DeviceAuthError(
    'expired',
    'The Twitch code expired before it was approved. Press Connect Twitch to get a new code.',
  );
}

/**
 * Exchanges a ONE-USE refresh token for a new pair. Callers must serialize refreshes and persist the
 * returned pair before anyone else refreshes (see tokenStore.ts). Public clients omit the secret.
 */
export async function refreshTokens(
  clientId: string,
  refreshToken: string,
  deps: AuthDeps = {},
): Promise<TokenSet> {
  const response = await requestJson(deps.fetch ?? fetch, `${TWITCH_ID_BASE_URL}/token`, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (response.status === 400 || response.status === 401) {
    throw new TokenRejectedError('Twitch rejected the refresh token; connect Twitch again');
  }
  if (response.status !== 200) {
    throw new TwitchHttpError(
      response.status,
      `Twitch token refresh failed (HTTP ${response.status})`,
    );
  }
  const tokens = parseTokenSet(response.body);
  if (!tokens) throw new TwitchHttpError(200, 'Twitch returned an unexpected refresh response');
  return tokens;
}

/** GET /oauth2/validate. Required on startup and hourly while the session is in use. */
export async function validateToken(
  accessToken: string,
  deps: AuthDeps = {},
): Promise<ValidatedToken> {
  const response = await requestJson(deps.fetch ?? fetch, `${TWITCH_ID_BASE_URL}/validate`, {
    method: 'GET',
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (response.status === 401) {
    throw new TokenRejectedError('Twitch access token is no longer valid');
  }
  if (response.status !== 200) {
    throw new TwitchHttpError(
      response.status,
      `Twitch token validation failed (HTTP ${response.status})`,
    );
  }
  const validated = parseValidatedToken(response.body);
  if (!validated)
    throw new TwitchHttpError(200, 'Twitch returned an unexpected validation response');
  return validated;
}

/** Best-effort revocation on sign-out (public clients revoke with client_id + token, no secret). */
export async function revokeToken(
  clientId: string,
  token: string,
  deps: AuthDeps = {},
): Promise<void> {
  await requestJson(deps.fetch ?? fetch, `${TWITCH_ID_BASE_URL}/revoke`, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: new URLSearchParams({ client_id: clientId, token }),
    timeoutMs: 5_000,
  });
}

export function parseDeviceAuthorization(body: unknown): DeviceAuthorization | null {
  if (!isRecord(body)) return null;
  const deviceCode = readString(body.device_code);
  const userCode = readString(body.user_code);
  const verificationUri = readString(body.verification_uri);
  const expiresIn = readNumber(body.expires_in);
  const interval = readNumber(body.interval);
  if (!deviceCode || !userCode || !verificationUri || expiresIn === null || interval === null) {
    return null;
  }
  // Only ever show a Twitch-provided https URL to the streamer; never invent one.
  if (!verificationUri.startsWith('https://') || expiresIn <= 0 || interval < 0) return null;
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    expires_in: expiresIn,
    interval,
  };
}

export function parseTokenSet(body: unknown): TokenSet | null {
  if (!isRecord(body)) return null;
  const accessToken = readString(body.access_token);
  const refreshToken = readString(body.refresh_token);
  const expiresIn = readNumber(body.expires_in);
  const scope = body.scope === undefined ? [] : readStringArray(body.scope);
  if (!accessToken || !refreshToken || expiresIn === null || expiresIn < 0 || scope === null) {
    return null;
  }
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    scope,
    token_type: readString(body.token_type) ?? 'bearer',
  };
}

export function parseValidatedToken(body: unknown): ValidatedToken | null {
  if (!isRecord(body)) return null;
  const clientId = readString(body.client_id);
  const login = readString(body.login);
  const userId = readString(body.user_id);
  const scopes = body.scopes === null ? [] : readStringArray(body.scopes);
  const expiresIn = readNumber(body.expires_in);
  if (!clientId || !login || !userId || scopes === null || expiresIn === null) return null;
  return { client_id: clientId, login, user_id: userId, scopes, expires_in: expiresIn };
}

/** Required scopes missing from a validated token (empty when the token is usable). */
export function missingScopes(scopes: readonly string[]): readonly string[] {
  return REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
}
