/**
 * Helix Get Users: resolves channel logins (or the signed-in user's ID) to immutable user IDs and
 * display names. Only broadcaster identity is returned; nothing about chatters.
 */
import type { ChannelInfo } from '../shared/protocol.js';
import type { HelixClient } from './helix.js';
import { TwitchHttpError } from './http.js';
import { isRecord, readDataArray, readString } from './json.js';

/** Twitch logins: 1–25 of a–z, 0–9 and underscore (case-insensitive, stored lowercase). */
const LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;

export type ChannelLookupFailure =
  'invalid-login' | 'not-found' | 'not-signed-in' | 'selection-changed' | 'failed';

/** Channel selection could not be applied. The message is safe to show on local controls. */
export class ChannelLookupError extends Error {
  override readonly name = 'ChannelLookupError';
  constructor(
    readonly code: ChannelLookupFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Accepts `login`, `@login` or a `twitch.tv/login` URL and returns the lowercase login, or null
 * when the input cannot be a Twitch login.
 */
export function normalizeLogin(input: string): string | null {
  let value = input.trim();
  const url = /^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(value);
  if (url?.[1]) value = url[1];
  if (value.startsWith('@')) value = value.slice(1);
  value = value.toLowerCase();
  return LOGIN_PATTERN.test(value) ? value : null;
}

export interface UserQuery {
  readonly logins?: readonly string[];
  readonly ids?: readonly string[];
}

/** GET /helix/users. Unknown logins/IDs are simply absent from the result. */
export async function getUsers(helix: HelixClient, query: UserQuery): Promise<ChannelInfo[]> {
  const logins = query.logins ?? [];
  const ids = query.ids ?? [];
  if (logins.length + ids.length === 0) return [];
  const response = await helix.request('GET', '/users', {
    query: { ...(logins.length ? { login: logins } : {}), ...(ids.length ? { id: ids } : {}) },
  });
  if (response.status !== 200) {
    throw new TwitchHttpError(
      response.status,
      `Twitch user lookup failed (HTTP ${response.status})`,
    );
  }
  const data = readDataArray(response.body);
  if (!data) throw new TwitchHttpError(200, 'Twitch returned an unexpected user lookup response');
  const users: ChannelInfo[] = [];
  for (const item of data) {
    const user = parseUser(item);
    if (user) users.push(user);
  }
  return users;
}

function parseUser(item: unknown): ChannelInfo | null {
  if (!isRecord(item)) return null;
  const userId = readString(item.id);
  const login = readString(item.login);
  if (!userId || !login) return null;
  return { login, displayName: readString(item.display_name) ?? login, userId };
}
