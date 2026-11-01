export type Side = 'A' | 'B';
export type StuntMode = 'crossover' | 'single';
/**
 * idle → active (CALL) → revealing (every required side reached quorum; reveal scheduled at
 * revealAtMs) → complete (revealAtMs + revealDurationMs elapsed). active → timed-out when the
 * deadline passes first. RESET returns to idle from any phase.
 */
export type StuntPhase = 'idle' | 'active' | 'revealing' | 'complete' | 'timed-out';

export const SIDES: readonly Side[] = ['A', 'B'];

/** Server-only IDs, stripped of chat content at the Twitch boundary. */
export interface NormalizedChatEvent {
  /** Delivery dedupe key: `source_message_id ?? message_id` (Shared Chat safe). */
  readonly messageKey: string;
  readonly chatterId: string;
  readonly originBroadcasterId: string;
  readonly side: Side;
  readonly receivedAtMs: number;
  readonly simulated: boolean;
}

export interface StuntConfig {
  readonly mode: StuntMode;
  readonly durationMs: number;
  readonly minQuorum: number;
  /** Quorum = max(minQuorum, ceil(recent distinct chatters of that side × quorumRatio)). */
  readonly quorumRatio: number;
  /** Chatters seen within this window before CALL feed the adaptive quorum. */
  readonly recentWindowMs: number;
  /** Optional manual quorum per side; wins over the adaptive value when set. */
  readonly quorumOverride: Readonly<Partial<Record<Side, number>>>;
  /** Delay between "all sides ready" and the synchronized reveal (lets both overlays schedule). */
  readonly revealLeadMs: number;
  /** Length of the reveal animation window; complete = revealAtMs + revealDurationMs. */
  readonly revealDurationMs: number;
}

export interface SideState {
  /** Distinct chatter IDs credited this round (server-only). */
  readonly participantIds: ReadonlySet<string>;
  /** chatterId → last seen epoch ms, across rounds, pruned at CALL (server-only). */
  readonly recentChatters: ReadonlyMap<string, number>;
  /** Frozen on CALL; never chases a moving goal during the active window. */
  readonly quorum: number;
}

export interface StuntState {
  readonly config: StuntConfig;
  readonly phase: StuntPhase;
  readonly roundId: string | null;
  readonly startedAtMs: number | null;
  readonly deadlineAtMs: number | null;
  readonly revealAtMs: number | null;
  /** Delivery keys seen during the current round (cleared on CALL/RESET). */
  readonly seenMessageKeys: ReadonlySet<string>;
  readonly sides: Readonly<Record<Side, SideState>>;
}

export type EngineEvent =
  | { readonly type: 'CALL'; readonly roundId: string; readonly config?: Partial<StuntConfig> }
  | { readonly type: 'CHAT'; readonly chat: NormalizedChatEvent }
  | { readonly type: 'TICK' }
  | { readonly type: 'RESET' };

/** Public aggregate projection. Never serialize StuntState directly. */
export interface SnapshotSide {
  readonly participants: number;
  readonly quorum: number;
  /** min(1, participants / quorum). Overlays map this onto the refinement plan. */
  readonly progress: number;
  readonly ready: boolean;
}

export interface Snapshot {
  readonly revision: number;
  readonly mode: StuntMode;
  readonly phase: StuntPhase;
  readonly roundId: string | null;
  readonly serverNowMs: number;
  readonly startedAtMs: number | null;
  readonly deadlineAtMs: number | null;
  readonly revealAtMs: number | null;
  readonly revealDurationMs: number;
  readonly simulated: boolean;
  /** Distinct people credited on BOTH sides this round (aggregate count only). */
  readonly crossovers: number;
  readonly sides: Readonly<Record<Side, SnapshotSide>>;
}

/** Normalized rectangle in card-grid units of the FULL image (crossover = both halves). */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Hidden picture as palette indices on the full card grid (row-major, length cols × rows). */
export interface Artwork {
  readonly cols: number;
  readonly rows: number;
  readonly pixels: readonly number[];
}

/** One quadtree split: parent rect → 2..4 children with their (palette) mean colors. */
export interface RefinementStep {
  readonly parent: Rect;
  readonly children: readonly { readonly rect: Rect; readonly color: number }[];
}

/**
 * Deterministic, greedy (highest color error first) refinement order for one side's region.
 * Applying steps[0..k) to the root leaf yields the picture at "k splits"; applying all steps
 * yields the exact artwork for the region. Steps at index >= preRevealCount are the final
 * detail layer that only appears in the joint reveal.
 */
export interface RefinementPlan {
  readonly side: Side;
  readonly region: Rect;
  readonly rootColor: number;
  readonly steps: readonly RefinementStep[];
  readonly preRevealCount: number;
}
