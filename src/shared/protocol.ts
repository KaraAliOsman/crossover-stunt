import type { RefinementPlan, Side, Snapshot, StuntConfig, StuntMode } from '../engine/types.js';

export const PROTOCOL_VERSION = 2 as const;

/** Public, per-server presentation data. Broadcaster labels only — never chatter data. */
export interface OverlayMeta {
  /** Channel display names configured by the streamers (e.g. "WAITING FOR <B>"). */
  readonly labels: Readonly<Record<Side, string>>;
  readonly twitch: TwitchStatus;
}

/**
 * Everything an overlay needs to draw a round, sent once per CALL (and on connect).
 * Plans encode the hidden picture; only the rendered progress is visible on stream.
 */
export interface RoundPayload {
  readonly roundId: string;
  readonly mode: StuntMode;
  /** Full-image grid (crossover 96×27, single 48×27). */
  readonly cols: number;
  readonly rows: number;
  readonly palette: readonly string[];
  readonly plans: Readonly<Partial<Record<Side, RefinementPlan>>>;
}

/**
 * Overlay transport: GET /ws?side=A|B[&room=TOKEN]. Read-only; clients never send commands.
 * Order on connect: hello → meta → round (or null) → snapshot. Afterwards the server pushes
 * `round` on every CALL/RESET, `meta` on label/status changes and `snapshot` at most ~10 Hz
 * (plus immediately on phase changes).
 */
export type ServerMessage =
  | {
      readonly type: 'hello';
      readonly protocol: typeof PROTOCOL_VERSION;
      readonly side: Side;
      readonly serverNowMs: number;
      readonly simulated: boolean;
    }
  | { readonly type: 'meta'; readonly meta: OverlayMeta }
  | { readonly type: 'round'; readonly round: RoundPayload | null }
  | { readonly type: 'snapshot'; readonly snapshot: Snapshot }
  | {
      readonly type: 'error';
      readonly code: 'BAD_REQUEST' | 'FORBIDDEN';
      readonly message: string;
    };

/** GET /api/snapshot[?room=TOKEN] — polling fallback with the same data as the WS stream. */
export interface SnapshotResponse {
  readonly protocol: typeof PROTOCOL_VERSION;
  readonly snapshot: Snapshot;
  readonly meta: OverlayMeta;
  /** Included only when the client's `round` query param differs from the current round id. */
  readonly round?: RoundPayload | null;
}

export type TwitchStatus =
  'demo' | 'signed-out' | 'authorizing' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface ChannelInfo {
  readonly login: string;
  readonly displayName: string;
  readonly userId: string;
}

/** GET /api/state — local control panel only (never via tunnel). */
export interface ControlState {
  readonly protocol: typeof PROTOCOL_VERSION;
  readonly demo: boolean;
  readonly twitch: {
    readonly status: TwitchStatus;
    readonly login: string | null;
    /** Present while authorizing (Device Code flow): show both to the streamer. */
    readonly userCode: string | null;
    readonly verificationUri: string | null;
    readonly error: string | null;
  };
  readonly channels: Readonly<Record<Side, ChannelInfo | null>>;
  readonly config: StuntConfig;
  readonly snapshot: Snapshot;
  readonly meta: OverlayMeta;
  readonly overlayUrls: {
    readonly A: string;
    readonly B: string;
    /** Public tunnel URL for a remote partner, including the room token, when sharing. */
    readonly partnerB: string | null;
  };
  readonly share: {
    readonly status: 'off' | 'starting' | 'on' | 'error';
    readonly error: string | null;
  };
  /** Result of the last Helix chat send (prompt/summary), for operator feedback. */
  readonly lastChat: {
    readonly atMs: number;
    readonly ok: boolean;
    readonly reason: string | null;
  } | null;
}

/** POST /api/call */
export interface CallRequest {
  readonly artwork: unknown; // validated with parseArtwork(artwork, mode)
  readonly mode?: StuntMode;
  readonly durationMs?: number; // 10_000..180_000
  readonly minQuorum?: number; // 1..1000
  readonly quorumRatio?: number; // (0, 1]
  readonly quorumOverride?: Partial<Record<Side, number | null>>;
}

/** POST /api/channels — Twitch logins (resolved via Helix Get Users). `b: null` clears B. */
export interface ChannelsRequest {
  readonly a?: string;
  readonly b?: string | null;
}

/** POST /dev/chat (demo only). No usernames or message text accepted. */
export interface DemoChatRequest {
  readonly side: Side;
  readonly count: number;
  /** Judges can replay a seed to reproduce virtual IDs. */
  readonly seed: number;
}

/** POST /dev/showcase (demo only): scripted SIMULATED round for the video and judges. */
export interface ShowcaseRequest {
  readonly scenario: 'crossover' | 'single' | 'so-close';
}
