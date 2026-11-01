import { requiredSides } from './artwork.js';
import { computeQuorum, observeChatter, pruneRecentChatters } from './quorum.js';
import type {
  EngineEvent,
  NormalizedChatEvent,
  Side,
  SideState,
  Snapshot,
  SnapshotSide,
  StuntConfig,
  StuntMode,
  StuntState,
} from './types.js';

export const DEFAULT_CONFIG: StuntConfig = Object.freeze({
  mode: 'crossover',
  durationMs: 45_000,
  minQuorum: 3,
  quorumRatio: 0.4,
  // docs/SPEC.md: the recent baseline is the distinct chatters of the previous 5 minutes.
  recentWindowMs: 5 * 60_000,
  quorumOverride: Object.freeze({}),
  revealLeadMs: 1_500,
  revealDurationMs: 6_000,
});

/** Inclusive bounds enforced on every merged config (CALL) and on the initial config. */
export const CONFIG_LIMITS = Object.freeze({
  durationMs: Object.freeze({ min: 10_000, max: 180_000 }),
  minQuorum: Object.freeze({ min: 1, max: 1_000 }),
  quorumOverride: Object.freeze({ min: 1, max: 1_000 }),
  recentWindowMs: Object.freeze({ min: 0, max: 24 * 60 * 60_000 }),
  revealLeadMs: Object.freeze({ min: 0, max: 60_000 }),
  revealDurationMs: Object.freeze({ min: 0, max: 5 * 60_000 }),
});

function assertIntegerInRange(
  name: string,
  value: unknown,
  limits: { readonly min: number; readonly max: number },
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < limits.min ||
    value > limits.max
  ) {
    throw new RangeError(`${name} must be an integer in [${limits.min}, ${limits.max}]`);
  }
  return value;
}

function assertMode(value: unknown): StuntMode {
  if (value !== 'crossover' && value !== 'single') {
    throw new RangeError('mode must be "crossover" or "single"');
  }
  return value;
}

function assertRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new RangeError('quorumRatio must be in (0, 1]');
  }
  return value;
}

/** Keeps only valid A/B overrides; `undefined`/`null` per side mean "no override". */
function normalizeOverride(value: unknown): StuntConfig['quorumOverride'] {
  if (typeof value !== 'object' || value === null) {
    throw new RangeError('quorumOverride must be an object');
  }
  const source = value as Readonly<Record<string, unknown>>;
  const override: Partial<Record<Side, number>> = {};
  for (const side of ['A', 'B'] as const) {
    const candidate = source[side];
    if (candidate === undefined || candidate === null) continue;
    override[side] = assertIntegerInRange(
      `quorumOverride.${side}`,
      candidate,
      CONFIG_LIMITS.quorumOverride,
    );
  }
  return Object.freeze(override);
}

/**
 * Shallow-merges `patch` over `base` and validates the result. Absent (`undefined`) fields keep
 * the base value; a provided `quorumOverride` replaces the previous one as a whole.
 * Throws RangeError on any invalid field (the server maps this to HTTP 400).
 */
export function resolveConfig(base: StuntConfig, patch: Partial<StuntConfig> = {}): StuntConfig {
  return Object.freeze({
    mode: assertMode(patch.mode ?? base.mode),
    durationMs: assertIntegerInRange(
      'durationMs',
      patch.durationMs ?? base.durationMs,
      CONFIG_LIMITS.durationMs,
    ),
    minQuorum: assertIntegerInRange(
      'minQuorum',
      patch.minQuorum ?? base.minQuorum,
      CONFIG_LIMITS.minQuorum,
    ),
    quorumRatio: assertRatio(patch.quorumRatio ?? base.quorumRatio),
    recentWindowMs: assertIntegerInRange(
      'recentWindowMs',
      patch.recentWindowMs ?? base.recentWindowMs,
      CONFIG_LIMITS.recentWindowMs,
    ),
    quorumOverride: normalizeOverride(patch.quorumOverride ?? base.quorumOverride),
    revealLeadMs: assertIntegerInRange(
      'revealLeadMs',
      patch.revealLeadMs ?? base.revealLeadMs,
      CONFIG_LIMITS.revealLeadMs,
    ),
    revealDurationMs: assertIntegerInRange(
      'revealDurationMs',
      patch.revealDurationMs ?? base.revealDurationMs,
      CONFIG_LIMITS.revealDurationMs,
    ),
  });
}

/** Throws RangeError when `config` is invalid (same rules as CALL). */
export function createInitialState(config: StuntConfig = DEFAULT_CONFIG): StuntState {
  const validConfig = resolveConfig(config);
  const side = (): SideState => ({
    participantIds: new Set(),
    recentChatters: new Map(),
    quorum: validConfig.minQuorum,
  });
  return {
    config: validConfig,
    phase: 'idle',
    roundId: null,
    startedAtMs: null,
    deadlineAtMs: null,
    revealAtMs: null,
    seenMessageKeys: new Set(),
    sides: { A: side(), B: side() },
  };
}

/**
 * Pure immutable reducer. Contract in docs/DESIGN.md §Engine. Summary:
 * - CHAT always refreshes recentChatters[side] (lastSeen = now). During `active` and
 *   now < deadlineAtMs it credits a distinct chatter once per side (dedupe messageKey first).
 *   Crossover mode credits sides independently; a person on both sides counts on both.
 *   Single mode credits only side A (side B chat is ignored for credit).
 *   When every required side has participants >= quorum → `revealing`,
 *   revealAtMs = now + revealLeadMs.
 * - CALL (from idle | complete | timed-out; ignored while active/revealing) merges
 *   event.config, prunes recentChatters older than recentWindowMs, freezes each side's quorum
 *   (override ?? computeQuorum(recent distinct, minQuorum, quorumRatio)), clears participants
 *   and seenMessageKeys, sets startedAtMs = now, deadlineAtMs = now + durationMs.
 * - TICK: active && now >= deadlineAtMs → `timed-out` (deadline check precedes credit);
 *   revealing && now >= revealAtMs + revealDurationMs → `complete`.
 * - RESET → idle, clears round fields and participants, keeps recentChatters and config.
 *
 * Implementation notes:
 * - CHAT applies the same clock transitions as TICK before crediting, so a chat at or after the
 *   deadline times the round out (if TICK has not yet) instead of earning credit. CALL and
 *   RESET never advance the clock, so a server adapter observes every phase change.
 * - Delivery dedupe only records keys while credit is possible (bounded by the active window);
 *   a duplicate delivery inside that window is a complete no-op.
 * - Returns the input object itself when nothing changes; never mutates inputs.
 */
export function step(state: StuntState, event: EngineEvent, now: number): StuntState {
  if (!Number.isFinite(now)) throw new RangeError('now must be a finite epoch millisecond value');
  switch (event.type) {
    case 'CALL':
      return call(state, event.roundId, event.config, now);
    case 'CHAT':
      return chat(state, event.chat, now);
    case 'TICK':
      return advanceClock(state, now);
    case 'RESET':
      return reset(state);
    default:
      return unknownEvent(event);
  }
}

function unknownEvent(event: never): never {
  // Report only the discriminant: event payloads may carry chatter IDs.
  const type: unknown = (event as { readonly type?: unknown }).type;
  throw new TypeError(`Unknown engine event type: ${String(type)}`);
}

function call(
  state: StuntState,
  roundId: string,
  patch: Partial<StuntConfig> | undefined,
  now: number,
): StuntState {
  if (state.phase === 'active' || state.phase === 'revealing') return state;
  if (typeof roundId !== 'string' || roundId.length === 0) {
    throw new RangeError('roundId must be a non-empty string');
  }
  const config = resolveConfig(state.config, patch);
  const freezeSide = (side: Side): SideState => {
    const recentChatters = pruneRecentChatters(
      state.sides[side].recentChatters,
      now,
      config.recentWindowMs,
    );
    return {
      participantIds: new Set(),
      recentChatters,
      quorum:
        config.quorumOverride[side] ??
        computeQuorum(recentChatters.size, config.minQuorum, config.quorumRatio),
    };
  };
  return {
    config,
    phase: 'active',
    roundId,
    startedAtMs: now,
    deadlineAtMs: now + config.durationMs,
    revealAtMs: null,
    seenMessageKeys: new Set(),
    sides: { A: freezeSide('A'), B: freezeSide('B') },
  };
}

/** Time-driven transitions shared by TICK and CHAT. */
function advanceClock(state: StuntState, now: number): StuntState {
  if (state.phase === 'active' && state.deadlineAtMs !== null && now >= state.deadlineAtMs) {
    return { ...state, phase: 'timed-out' };
  }
  if (
    state.phase === 'revealing' &&
    state.revealAtMs !== null &&
    now >= state.revealAtMs + state.config.revealDurationMs
  ) {
    return { ...state, phase: 'complete' };
  }
  return state;
}

/** Credit window: `startedAtMs <= now < deadlineAtMs` while the round is still active. */
function isCreditWindow(state: StuntState, now: number): boolean {
  return (
    state.phase === 'active' &&
    state.startedAtMs !== null &&
    state.deadlineAtMs !== null &&
    state.startedAtMs <= now &&
    now < state.deadlineAtMs
  );
}

function creditsSide(mode: StuntMode, side: Side): boolean {
  return requiredSides(mode).includes(side);
}

function isReady(side: SideState): boolean {
  return side.quorum > 0 && side.participantIds.size >= side.quorum;
}

function withAdded<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  next.add(value);
  return next;
}

function withSide(sides: StuntState['sides'], side: Side, value: SideState): StuntState['sides'] {
  return side === 'A' ? { A: value, B: sides.B } : { A: sides.A, B: value };
}

function chat(state: StuntState, event: NormalizedChatEvent, now: number): StuntState {
  const current = advanceClock(state, now);
  const crediting = isCreditWindow(current, now);
  // Delivery dedupe first: a redelivered message changes nothing, not even recency.
  if (crediting && current.seenMessageKeys.has(event.messageKey)) return current;

  const sideState = current.sides[event.side];
  const recentChatters = observeChatter(
    sideState.recentChatters,
    event.chatterId,
    now,
    current.config.recentWindowMs,
  );
  // Person dedupe: one credit per chatter per side per round, only on required sides.
  const credited =
    crediting &&
    creditsSide(current.config.mode, event.side) &&
    !sideState.participantIds.has(event.chatterId);
  const participantIds = credited
    ? withAdded(sideState.participantIds, event.chatterId)
    : sideState.participantIds;
  const seenMessageKeys = crediting
    ? withAdded(current.seenMessageKeys, event.messageKey)
    : current.seenMessageKeys;

  if (
    recentChatters === sideState.recentChatters &&
    participantIds === sideState.participantIds &&
    seenMessageKeys === current.seenMessageKeys
  ) {
    return current;
  }

  const next: StuntState = {
    ...current,
    seenMessageKeys,
    sides: withSide(current.sides, event.side, { ...sideState, recentChatters, participantIds }),
  };
  if (credited && requiredSides(next.config.mode).every((side) => isReady(next.sides[side]))) {
    return { ...next, phase: 'revealing', revealAtMs: now + next.config.revealLeadMs };
  }
  return next;
}

function isPristineIdle(state: StuntState): boolean {
  return (
    state.phase === 'idle' &&
    state.roundId === null &&
    state.startedAtMs === null &&
    state.deadlineAtMs === null &&
    state.revealAtMs === null &&
    state.seenMessageKeys.size === 0 &&
    (['A', 'B'] as const).every(
      (side) =>
        state.sides[side].participantIds.size === 0 &&
        state.sides[side].quorum === state.config.minQuorum,
    )
  );
}

function reset(state: StuntState): StuntState {
  if (isPristineIdle(state)) return state;
  const clearSide = (side: Side): SideState => ({
    participantIds: new Set(),
    recentChatters: state.sides[side].recentChatters,
    quorum: state.config.minQuorum,
  });
  return {
    config: state.config,
    phase: 'idle',
    roundId: null,
    startedAtMs: null,
    deadlineAtMs: null,
    revealAtMs: null,
    seenMessageKeys: new Set(),
    sides: { A: clearSide('A'), B: clearSide('B') },
  };
}

function countIntersection(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let count = 0;
  for (const id of small) if (large.has(id)) count += 1;
  return count;
}

/** Whitelisted aggregate projection; never leaks IDs, keys, Sets or Maps. */
export function toSnapshot(
  state: StuntState,
  now: number,
  revision: number,
  simulated: boolean,
): Snapshot {
  const { mode } = state.config;
  const projectSide = (side: Side): SnapshotSide => {
    // Sides that do not gate the reveal (B in single mode) report zeros.
    if (!creditsSide(mode, side)) return { participants: 0, quorum: 0, progress: 0, ready: false };
    const sideState = state.sides[side];
    const participants = sideState.participantIds.size;
    const { quorum } = sideState;
    return {
      participants,
      quorum,
      progress: quorum > 0 ? Math.min(1, participants / quorum) : 0,
      ready: isReady(sideState),
    };
  };
  return {
    revision,
    mode,
    phase: state.phase,
    roundId: state.roundId,
    serverNowMs: now,
    startedAtMs: state.startedAtMs,
    deadlineAtMs: state.deadlineAtMs,
    revealAtMs: state.revealAtMs,
    revealDurationMs: state.config.revealDurationMs,
    simulated,
    crossovers:
      mode === 'crossover'
        ? countIntersection(state.sides.A.participantIds, state.sides.B.participantIds)
        : 0,
    sides: { A: projectSide('A'), B: projectSide('B') },
  };
}
