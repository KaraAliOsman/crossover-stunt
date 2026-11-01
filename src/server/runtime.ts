import { randomUUID } from 'node:crypto';
import {
  GRID_ROWS,
  PALETTE,
  fullCols,
  parseArtwork,
  requiredSides,
  sideRegion,
} from '../engine/artwork.js';
import { DEFAULT_CONFIG, createInitialState, step, toSnapshot } from '../engine/engine.js';
import { buildRefinementPlan } from '../engine/quadtree.js';
import {
  SIDES,
  type EngineEvent,
  type NormalizedChatEvent,
  type RefinementPlan,
  type Side,
  type Snapshot,
  type SnapshotSide,
  type StuntConfig,
  type StuntPhase,
  type StuntState,
} from '../engine/types.js';
import type { CallRequest, RoundPayload } from '../shared/protocol.js';

/** Server-owned clock resolution for deadlines and reveal completion while a round runs. */
export const TICK_INTERVAL_MS = 250;
/** Coalesced snapshot pushes: at most 10 Hz (phase changes, CALL and RESET bypass this). */
export const MIN_PUSH_INTERVAL_MS = 100;
/** Labels are broadcaster display names; keep them short enough for the overlay HUD. */
export const MAX_LABEL_LENGTH = 40;

export const DEFAULT_IGNORED_LOGINS: readonly string[] = Object.freeze([
  'nightbot',
  'streamelements',
  'streamlabs',
  'fossabot',
  'moobot',
  'sery_bot',
  'wizebot',
  'soundalerts',
  'kofistreambot',
  'pokemoncommunitygame',
  'botrixoficial',
  'commanderroot',
]);
export type RuntimeChatEvent = NormalizedChatEvent & { readonly chatterLogin?: string };

export type Labels = Readonly<Record<Side, string>>;

export type RuntimeUpdate =
  | { readonly type: 'round'; readonly round: RoundPayload | null }
  | { readonly type: 'snapshot'; readonly snapshot: Snapshot }
  | { readonly type: 'labels'; readonly labels: Labels };

export type RuntimeListener = (update: RuntimeUpdate) => void;

export type TransitionListener = (from: StuntPhase, to: StuntPhase, snapshot: Snapshot) => void;

export interface StuntRuntimeOptions {
  /** Injected clock (epoch ms). The engine itself never reads time. */
  readonly now: () => number;
  /** Demo mode: snapshots say SIMULATED and only virtual (`simulated: true`) chat is accepted. */
  readonly simulated: boolean;
  /** Phase-change hook (live mode sends chat announcements from here). */
  readonly onTransition?: TransitionListener;
  readonly labels: Labels;
  readonly config?: StuntConfig;
  /** Signed-in Twitch sender: our own announcements echo back as chat and must never count. */
  readonly selfUserId?: () => string | null;
  readonly ignoredChatters?: readonly string[];
  /** Injectable for deterministic tests. */
  readonly createRoundId?: () => string;
}

export interface CallOptions {
  /**
   * When false (scripted SIMULATED showcase rounds) the request config is used for this round
   * only and does not become the operator's remembered config. Default true.
   */
  readonly remember?: boolean;
}

/** CALL while a round is active or revealing (HTTP 409). */
export class RoundConflictError extends Error {
  override readonly name = 'RoundConflictError';
}

export interface StuntRuntime {
  /** Validates, builds one refinement plan per required side and starts a round. */
  call(request: CallRequest, options?: CallOptions): RoundPayload;
  reset(): void;
  /** Returns false when the event is ignored before reaching the engine (own sender, wrong mode). */
  chat(event: RuntimeChatEvent): boolean;
  tick(): void;
  snapshot(): Snapshot;
  round(): RoundPayload | null;
  phase(): StuntPhase;
  /** Operator config remembered from the last successful (non-scripted) CALL. */
  config(): StuntConfig;
  labels(): Labels;
  setLabels(labels: Labels): void;
  subscribe(listener: RuntimeListener): () => void;
  /** Stops timers and drops listeners. The runtime must not be used afterwards. */
  dispose(): void;
}

function sameSide(a: SnapshotSide, b: SnapshotSide): boolean {
  return (
    a.participants === b.participants &&
    a.quorum === b.quorum &&
    a.progress === b.progress &&
    a.ready === b.ready
  );
}

/** Public content equality, ignoring `revision` and `serverNowMs`. */
function sameContent(a: Snapshot, b: Snapshot): boolean {
  return (
    a.mode === b.mode &&
    a.phase === b.phase &&
    a.roundId === b.roundId &&
    a.startedAtMs === b.startedAtMs &&
    a.deadlineAtMs === b.deadlineAtMs &&
    a.revealAtMs === b.revealAtMs &&
    a.revealDurationMs === b.revealDurationMs &&
    a.simulated === b.simulated &&
    a.crossovers === b.crossovers &&
    sameSide(a.sides.A, b.sides.A) &&
    sameSide(a.sides.B, b.sides.B)
  );
}

/** Collapses whitespace and bounds the length; empty labels fall back to `fallback`. */
export function sanitizeLabel(value: string, fallback: string): string {
  const clean = value.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LENGTH).trim();
  return clean.length > 0 ? clean : fallback;
}

/**
 * Merges a CALL request over the remembered config. Absent fields keep the previous value;
 * `quorumOverride` merges per side where `null` clears that side's override. Range checks are
 * the engine's job (it throws RangeError on an invalid merged config).
 */
export function mergeCallConfig(base: StuntConfig, request: CallRequest): StuntConfig {
  const quorumOverride: Partial<Record<Side, number>> = { ...base.quorumOverride };
  for (const side of SIDES) {
    const value = request.quorumOverride?.[side];
    if (value === null) delete quorumOverride[side];
    else if (value !== undefined) quorumOverride[side] = value;
  }
  return {
    ...base,
    mode: request.mode ?? base.mode,
    durationMs: request.durationMs ?? base.durationMs,
    minQuorum: request.minQuorum ?? base.minQuorum,
    quorumRatio: request.quorumRatio ?? base.quorumRatio,
    quorumOverride,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

export function createStuntRuntime(options: StuntRuntimeOptions): StuntRuntime {
  const { now, simulated } = options;
  const ignored = new Set(
    [...DEFAULT_IGNORED_LOGINS, ...(options.ignoredChatters ?? [])]
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
  const createRoundId = options.createRoundId ?? randomUUID;
  let state: StuntState = createInitialState(options.config ?? DEFAULT_CONFIG);
  let operatorConfig: StuntConfig = state.config;
  let currentRound: RoundPayload | null = null;
  let labels: Labels = Object.freeze({ ...options.labels });
  const listeners = new Set<RuntimeListener>();

  // Snapshot bookkeeping: `published` is the last materialized snapshot (with its revision);
  // `dirty` means engine state changed since then. Revisions only grow when public content
  // changes, so idle chat (recent-chatter bookkeeping) never produces pushes.
  let published: Snapshot = toSnapshot(state, now(), 0, simulated);
  let dirty = false;
  // Revision 0 (initial idle) reaches clients through their connect sequence, not a push.
  let pushedRevision = 0;
  let lastPushAtMs = Number.NEGATIVE_INFINITY;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  function emit(update: RuntimeUpdate): void {
    for (const listener of [...listeners]) {
      try {
        listener(update);
      } catch (error) {
        console.error(`[runtime] listener failed: ${describe(error)}`);
      }
    }
  }

  function materialize(): Snapshot {
    if (!dirty) return published;
    const candidate = toSnapshot(state, now(), published.revision, simulated);
    if (!sameContent(candidate, published)) {
      published = { ...candidate, revision: published.revision + 1 };
    }
    dirty = false;
    return published;
  }

  function clearPushTimer(): void {
    if (pushTimer === null) return;
    clearTimeout(pushTimer);
    pushTimer = null;
  }

  /** Pushes the current snapshot right away when its revision is new. */
  function publishSnapshot(): Snapshot {
    clearPushTimer();
    const snapshot = materialize();
    lastPushAtMs = now();
    const fresh: Snapshot = { ...snapshot, serverNowMs: lastPushAtMs };
    if (snapshot.revision !== pushedRevision) {
      pushedRevision = snapshot.revision;
      emit({ type: 'snapshot', snapshot: fresh });
    }
    return fresh;
  }

  /** Coalesces bursts (e.g. 3 000 chats in one tick) into one push per 100 ms window. */
  function schedulePush(): void {
    if (pushTimer !== null || disposed) return;
    const elapsed = now() - lastPushAtMs;
    const wait = Math.max(0, Math.min(MIN_PUSH_INTERVAL_MS, MIN_PUSH_INTERVAL_MS - elapsed));
    pushTimer = setTimeout(() => {
      pushTimer = null;
      try {
        publishSnapshot();
      } catch (error) {
        console.error(`[runtime] snapshot push failed: ${describe(error)}`);
      }
    }, wait);
  }

  function syncTicker(): void {
    const running = state.phase === 'active' || state.phase === 'revealing';
    if (running && ticker === null && !disposed) {
      ticker = setInterval(() => {
        try {
          runtime.tick();
        } catch (error) {
          console.error(`[runtime] tick failed: ${describe(error)}`);
        }
      }, TICK_INTERVAL_MS);
    } else if (!running && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  /**
   * Adopts `next` as the engine state. Phase changes (and `immediate` commands such as CALL
   * and RESET) push at once and fire onTransition; everything else is coalesced.
   */
  function commit(next: StuntState, immediate: boolean): void {
    const previous = state;
    if (next === previous && !immediate) return;
    state = next;
    if (next !== previous) dirty = true;
    const phaseChanged = next.phase !== previous.phase;
    if (phaseChanged) syncTicker();
    if (!phaseChanged && !immediate) {
      schedulePush();
      return;
    }
    const snapshot = publishSnapshot();
    if (!phaseChanged) return;
    try {
      options.onTransition?.(previous.phase, next.phase, snapshot);
    } catch (error) {
      console.error(`[runtime] transition hook failed: ${describe(error)}`);
    }
  }

  function apply(event: EngineEvent): void {
    commit(step(state, event, now()), false);
  }

  const runtime: StuntRuntime = {
    call(request, callOptions = {}) {
      if (state.phase === 'active' || state.phase === 'revealing') {
        throw new RoundConflictError('A round is already running; wait for it or RESET first');
      }
      const config = mergeCallConfig(operatorConfig, request);
      const artwork = parseArtwork(request.artwork, config.mode);
      if (artwork === null) {
        throw new RangeError(
          `artwork must be ${fullCols(config.mode)}×${GRID_ROWS} palette indices 0..${PALETTE.length - 1} for ${config.mode} mode`,
        );
      }
      const roundId = createRoundId();
      // Pure steps first: an invalid config (RangeError) or a plan failure commits nothing.
      const next = step(state, { type: 'CALL', roundId, config }, now());
      const plans: Partial<Record<Side, RefinementPlan>> = {};
      for (const side of requiredSides(config.mode)) {
        plans[side] = buildRefinementPlan({ artwork, side, region: sideRegion(config.mode, side) });
      }
      const round: RoundPayload = Object.freeze({
        roundId,
        mode: config.mode,
        cols: fullCols(config.mode),
        rows: GRID_ROWS,
        palette: PALETTE,
        plans: Object.freeze(plans),
      });
      if (callOptions.remember ?? true) operatorConfig = next.config;
      currentRound = round;
      // Overlays need the plans before the first snapshot of the new round.
      emit({ type: 'round', round });
      commit(next, true);
      return round;
    },

    reset() {
      const next = step(state, { type: 'RESET' }, now());
      if (currentRound !== null) {
        currentRound = null;
        emit({ type: 'round', round: null });
      }
      commit(next, true);
    },

    chat(event) {
      // Demo/live separation: virtual crowds never reach a live round and vice versa.
      if (event.simulated !== simulated) return false;
      const self = options.selfUserId?.() ?? null;
      if (self !== null && event.chatterId === self) return false;
      if (event.chatterLogin !== undefined && ignored.has(event.chatterLogin.trim().toLowerCase()))
        return false;
      // The optional filtering login stops here; the engine receives its frozen identity contract.
      const chat: NormalizedChatEvent = {
        messageKey: event.messageKey,
        chatterId: event.chatterId,
        originBroadcasterId: event.originBroadcasterId,
        side: event.side,
        receivedAtMs: event.receivedAtMs,
        simulated: event.simulated,
      };
      apply({ type: 'CHAT', chat });
      return true;
    },

    tick() {
      apply({ type: 'TICK' });
    },

    snapshot() {
      return { ...materialize(), serverNowMs: now() };
    },

    round: () => currentRound,
    phase: () => state.phase,
    config: () => operatorConfig,
    labels: () => labels,

    setLabels(next) {
      const clean: Labels = Object.freeze({
        A: sanitizeLabel(next.A, labels.A),
        B: sanitizeLabel(next.B, labels.B),
      });
      if (clean.A === labels.A && clean.B === labels.B) return;
      labels = clean;
      emit({ type: 'labels', labels });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      disposed = true;
      clearPushTimer();
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
      listeners.clear();
    },
  };
  return runtime;
}
