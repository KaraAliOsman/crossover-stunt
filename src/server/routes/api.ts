import type { Side, Snapshot, StuntMode } from '../../engine/types.js';
import {
  PROTOCOL_VERSION,
  type CallRequest,
  type ChannelsRequest,
  type OverlayMeta,
  type RoundPayload,
  type SnapshotResponse,
} from '../../shared/protocol.js';

/** Boundary validation result: either a typed value or a human-readable 400 message. */
export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const invalid = (error: string): { readonly ok: false; readonly error: string } => ({
  ok: false,
  error,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(source: Record<string, unknown>, key: string): number | undefined | null {
  const value = source[key];
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * POST /api/call shape check. Types only: ranges are enforced by the engine (RangeError → 400)
 * and the artwork by `parseArtwork` once the mode is known. Unknown keys are ignored.
 */
export function parseCallRequest(value: unknown): Parsed<CallRequest> {
  if (!isRecord(value)) return invalid('Expected a JSON object');
  if (value.artwork === undefined) return invalid('artwork is required');
  const request: { -readonly [K in keyof CallRequest]: CallRequest[K] } = {
    artwork: value.artwork,
  };

  if (value.mode !== undefined) {
    if (value.mode !== 'crossover' && value.mode !== 'single') {
      return invalid('mode must be "crossover" or "single"');
    }
    request.mode = value.mode satisfies StuntMode;
  }
  for (const key of ['durationMs', 'minQuorum', 'quorumRatio'] as const) {
    const number = optionalNumber(value, key);
    if (number === null) return invalid(`${key} must be a number`);
    if (number !== undefined) request[key] = number;
  }
  if (value.quorumOverride !== undefined) {
    if (!isRecord(value.quorumOverride)) return invalid('quorumOverride must be an object');
    const override: Partial<Record<Side, number | null>> = {};
    for (const side of ['A', 'B'] as const) {
      const entry = value.quorumOverride[side];
      if (entry === undefined) continue;
      if (entry !== null && (typeof entry !== 'number' || !Number.isFinite(entry))) {
        return invalid(`quorumOverride.${side} must be a number or null`);
      }
      override[side] = entry;
    }
    request.quorumOverride = override;
  }
  return { ok: true, value: request };
}

/** Twitch login rules: 1–25 letters, digits or underscores. */
const LOGIN_PATTERN = /^[A-Za-z0-9_]{1,25}$/;

/** POST /api/channels. `b: null` clears side B; omitted fields keep their current value. */
export function parseChannelsRequest(value: unknown): Parsed<ChannelsRequest> {
  if (!isRecord(value)) return invalid('Expected a JSON object');
  if (Object.keys(value).some((key) => key !== 'a' && key !== 'b')) {
    return invalid('Only "a" and "b" are accepted');
  }
  const request: { -readonly [K in keyof ChannelsRequest]: ChannelsRequest[K] } = {};
  if (value.a !== undefined) {
    if (typeof value.a !== 'string' || !LOGIN_PATTERN.test(value.a.trim())) {
      return invalid('a must be a Twitch login (letters, digits, underscore; 1–25 chars)');
    }
    request.a = value.a.trim();
  }
  if (value.b !== undefined) {
    if (value.b === null) request.b = null;
    else if (typeof value.b === 'string' && LOGIN_PATTERN.test(value.b.trim())) {
      request.b = value.b.trim();
    } else {
      return invalid('b must be a Twitch login or null');
    }
  }
  return { ok: true, value: request };
}

/**
 * GET /api/snapshot. `round` is included only when the client's `?round=` differs from the
 * current round id (absent/empty means "I have no round").
 */
export function snapshotResponse(
  snapshot: Snapshot,
  meta: OverlayMeta,
  round: RoundPayload | null,
  clientRoundId: string | null,
): SnapshotResponse {
  const known = clientRoundId === null || clientRoundId === '' ? null : clientRoundId;
  const current = round?.roundId ?? null;
  const base = { protocol: PROTOCOL_VERSION, snapshot, meta };
  return known === current ? base : { ...base, round };
}

export type LabelsRequest = Readonly<Partial<Record<Side, string>>>;

/** Local team labels. Empty values follow the channel login; omitted sides stay unchanged. */
export function parseLabelsRequest(value: unknown): Parsed<LabelsRequest> {
  if (!isRecord(value)) return invalid('Expected a JSON object');
  if (Object.keys(value).some((key) => key !== 'A' && key !== 'B'))
    return invalid('Only "A" and "B" are accepted');
  const labels: Partial<Record<Side, string>> = {};
  for (const side of ['A', 'B'] as const) {
    const entry = value[side];
    if (entry === undefined) continue;
    if (typeof entry !== 'string' || entry.trim().length > 24)
      return invalid(`${side} must be a team label of at most 24 characters`);
    labels[side] = entry.trim();
  }
  return { ok: true, value: labels };
}
