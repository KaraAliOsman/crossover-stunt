import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  SIDES,
  type Side,
  type Snapshot,
  type StuntMode,
  type StuntPhase,
} from '../engine/types.js';
import { makeSimulatedCrowd } from '../sim/crowd.js';
import {
  PROTOCOL_VERSION,
  type ChannelInfo,
  type ControlState,
  type OverlayMeta,
  type ServerMessage,
} from '../shared/protocol.js';
import {
  ChannelLookupError,
  TwitchAuthConflictError,
  createTwitchService,
  type TwitchService,
  type TwitchServiceOptions,
  type TwitchServiceState,
} from '../twitch/service.js';
import {
  classifyRequest,
  generateRoomToken,
  isJsonContentType,
  isSameOriginOrAbsent,
  roomCookieHeader,
} from './access.js';
import {
  announcementFor,
  createHelpAnnouncer,
  distinctAnnouncement,
  type Announcement,
  type SentAnnouncement,
} from './announce.js';
import {
  parseCallRequest,
  parseChannelsRequest,
  parseLabelsRequest,
  snapshotResponse,
} from './routes/api.js';
import { parseDemoChat, parseShowcaseRequest } from './routes/dev.js';
import { PAGE_ALIASES } from './routes/pages.js';
import {
  RoundConflictError,
  createStuntRuntime,
  type Labels,
  type StuntRuntime,
} from './runtime.js';
import { createShareTunnel, type ShareTunnelOptions } from './share.js';
import { createShowcaseRunner } from './showcaseRunner.js';
import { createStaticResolver, toPublicRelativePath } from './static.js';
import { attachWsHub, type UpgradeDecision, type WsHub } from './wsHub.js';

export const DEMO_LABELS: Labels = Object.freeze({ A: 'LEFT STAND', B: 'RIGHT STAND' });
export const LIVE_DEFAULT_LABELS: Labels = Object.freeze({ A: 'CHANNEL A', B: 'CHANNEL B' });
export const MISSING_CLIENT_ID_ERROR =
  'TWITCH_CLIENT_ID is not set. Register a Public application at https://dev.twitch.tv/console/apps, ' +
  'add TWITCH_CLIENT_ID=<client id> to .env and restart. (pnpm demo needs no Twitch.)';

const DEFAULT_PUBLIC_ROOT = fileURLToPath(new URL('../../public/', import.meta.url));
const SMALL_BODY_LIMIT = 8 * 1024;
/** A 96×27 artwork is ~5 KB of compact JSON; leave room for pretty-printed bodies. */
const CALL_BODY_LIMIT = 64 * 1024;
/**
 * Each engine CHAT copies the touched Set/Map (src/engine/AGENTS.md), so a 3000-person burst is
 * O(n²) and each event gets slower as recent chatters pile up. Feeding it in ~10 ms time slices
 * keeps the 250 ms tick, WS pushes and polling responsive whatever the per-event cost.
 */
export const DEV_CHAT_SLICE_MS = 10;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

const NO_CHANNELS: Readonly<Record<Side, ChannelInfo | null>> = Object.freeze({ A: null, B: null });

/** POST /api/channels failures from the Twitch module (its messages are safe to show). */
const CHANNEL_LOOKUP_STATUS: Readonly<Record<ChannelLookupError['code'], number>> = {
  'invalid-login': 400,
  'not-found': 400,
  'not-signed-in': 409,
  'selection-changed': 409,
  failed: 502,
};

export interface AppOptions {
  /** `pnpm demo`: SIMULATED crowd, no Twitch, /dev/* enabled. */
  readonly demo: boolean;
  readonly ignoredChatters?: readonly string[];
  readonly now?: () => number;
  /** Demo only: loop the showcase scenarios for unattended judging. */
  readonly autoplay?: boolean;
  /** Live only: public Device Code client ID (no secret exists or is needed). */
  readonly twitchClientId?: string | null;
  /** Token storage directory for the Twitch service (default ./data, gitignored). */
  readonly dataDir?: string;
  /** Injectable Twitch facade factory (tests use a fake). */
  readonly createTwitch?: (options: TwitchServiceOptions) => TwitchService;
  /** Injectable for tests; generated per start otherwise. */
  readonly roomToken?: string;
  readonly publicRoot?: string;
  readonly createRoundId?: () => string;
  readonly share?: Pick<ShareTunnelOptions, 'findBinary' | 'spawn' | 'startTimeoutMs'>;
}

export interface App {
  readonly server: Server;
  readonly runtime: StuntRuntime;
  readonly hub: WsHub;
  /** Read-only partner room token. Never log it; it only appears inside overlayUrls.partnerB. */
  readonly roomToken: string;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/** Expected client-facing failure with a safe message. */
class HttpError extends Error {
  override readonly name = 'HttpError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) => Promise<void> | void;
type Routes = Readonly<Record<string, Readonly<Partial<Record<'GET' | 'POST', Handler>>>>>;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse): void {
  sendJson(response, 404, { error: 'Not found' });
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'Request body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

/** Paths a remote (tunnel) client may GET with the room token: partner overlay B only. */
function remoteMayRead(pathname: string): boolean {
  if (pathname === '/overlay/b' || pathname === '/api/snapshot') return true;
  if (PAGE_ALIASES[pathname] !== undefined) return false;
  // Case-sensitive on purpose: case variants that Windows would still resolve fail closed.
  return toPublicRelativePath(pathname)?.startsWith('overlay/') ?? false;
}

/** /dev, /dev/* routes and any static file that resolves into public/dev/ (live: 404). */
function isDevPath(pathname: string): boolean {
  if (pathname === '/dev' || pathname.startsWith('/dev/')) return true;
  return toPublicRelativePath(pathname)?.toLowerCase().startsWith('dev/') ?? false;
}

function summarizeSay(
  outcome: Readonly<
    Partial<Record<Side, { readonly ok: boolean; readonly reason: string | null }>>
  >,
  atMs: number,
): NonNullable<ControlState['lastChat']> {
  const results = SIDES.flatMap((side) => {
    const result = outcome[side];
    return result === undefined ? [] : [{ side, ...result }];
  });
  if (results.length === 0) return { atMs, ok: false, reason: 'No chat message was sent' };
  const failure = results.find((result) => !result.ok);
  if (failure === undefined) return { atMs, ok: true, reason: null };
  return { atMs, ok: false, reason: `${failure.side}: ${failure.reason ?? 'not sent'}` };
}

export function createApp(options: AppOptions): App {
  const { demo } = options;
  const now = options.now ?? Date.now;
  const roomToken = options.roomToken ?? generateRoomToken();
  const resolveStatic = createStaticResolver(options.publicRoot ?? DEFAULT_PUBLIC_ROOT);
  let port = 0;
  let hub: WsHub | null = null;
  let twitch: TwitchService | null = null;
  let twitchSetupError: string | null = null;
  let lastChat: ControlState['lastChat'] = null;
  let observedSharedChatEnd = 0;
  let sharedChatEndedRound: string | null = null;
  const helpAnnouncement = createHelpAnnouncer();
  const lastAnnouncements: Partial<Record<Side, SentAnnouncement>> = {};
  let lastMetaJson = '';
  const labelOverride: Partial<Record<Side, string>> = {};
  const demoChannels: Record<Side, ChannelInfo | null> = { A: null, B: null };

  const runtime = createStuntRuntime({
    now,
    simulated: demo,
    labels: demo ? DEMO_LABELS : LIVE_DEFAULT_LABELS,
    // Our own prompt/summary messages echo back through EventSub: never count them.
    selfUserId: () => (twitch === null ? null : twitchState().userId),
    ignoredChatters: options.ignoredChatters ?? [],
    onTransition: announce,
    ...(options.createRoundId === undefined ? {} : { createRoundId: options.createRoundId }),
  });
  const showcase = demo ? createShowcaseRunner({ runtime, now }) : null;
  const share = createShareTunnel({ localUrl: () => `http://127.0.0.1:${port}`, ...options.share });

  /** Live mode only: chat prompt on CALL, summary on reveal, SO CLOSE on timeout. */
  function announce(from: StuntPhase, to: StuntPhase, snapshot: Snapshot): void {
    sendAnnouncement(announcementFor(from, to, snapshot, runtime.labels()));
  }

  function sendAnnouncement(announcement: Announcement | null): void {
    if (demo || announcement === null) return;
    if (twitch === null) {
      lastChat = { atMs: now(), ok: false, reason: 'Twitch is not configured' };
      return;
    }
    const service = twitch;
    const atMs = now();
    let sent: SentAnnouncement | null = null;
    for (const side of announcement.sides) {
      const candidate = distinctAnnouncement(
        announcement.message,
        lastAnnouncements[side] ?? null,
        atMs,
      );
      if (sent === null || candidate.take > sent.take) sent = candidate;
    }
    if (sent === null) return;
    for (const side of announcement.sides) lastAnnouncements[side] = sent;
    const { message } = sent;
    // Fire and forget: the round never waits for Helix; the outcome feeds the control panel.
    Promise.resolve()
      .then(() => service.say(announcement.sides, message))
      .then(
        (outcome) => {
          lastChat = summarizeSay(outcome, now());
        },
        (error: unknown) => {
          lastChat = { atMs: now(), ok: false, reason: 'Chat send failed' };
          console.error(`[twitch] say failed: ${errorName(error)}`);
        },
      );
  }

  function twitchState(): TwitchServiceState {
    const blank = {
      login: null,
      userId: null,
      userCode: null,
      verificationUri: null,
      sharedChat: { partners: [], endedRevision: 0, sharesSession: false },
    } as const;
    if (demo) return { ...blank, status: 'demo', error: null, channels: { ...demoChannels } };
    if (twitch === null) {
      const missing = twitchSetupError === MISSING_CLIENT_ID_ERROR;
      return {
        ...blank,
        status: missing ? 'signed-out' : 'error',
        error: twitchSetupError,
        channels: NO_CHANNELS,
      };
    }
    try {
      return twitch.getState();
    } catch {
      return {
        ...blank,
        status: 'error',
        error: 'Twitch state unavailable',
        channels: NO_CHANNELS,
      };
    }
  }

  function meta(): OverlayMeta {
    return { labels: runtime.labels(), twitch: twitchState().status };
  }

  function publishMetaIfChanged(): void {
    const next = meta();
    const json = JSON.stringify(next);
    if (json === lastMetaJson) return;
    lastMetaJson = json;
    hub?.broadcast({ type: 'meta', meta: next });
  }

  /** Team overrides survive channel saves and every Twitch state/reconnect notification. */
  function syncLiveLabels(): void {
    const { channels, sharedChat } = twitchState();
    if (sharedChat.endedRevision > observedSharedChatEnd) {
      const snapshot = runtime.snapshot();
      if (snapshot.phase === 'active' || snapshot.phase === 'revealing') {
        sharedChatEndedRound = snapshot.roundId;
      }
    }
    observedSharedChatEnd = sharedChat.endedRevision;
    const defaults = demo ? DEMO_LABELS : LIVE_DEFAULT_LABELS;
    const label = (side: Side): string => {
      const override = labelOverride[side];
      if (override !== undefined) return override || channels[side]?.login || defaults[side];
      return channels[side]?.displayName ?? defaults[side];
    };
    runtime.setLabels({ A: label('A'), B: label('B') });
    publishMetaIfChanged();
  }

  if (!demo) {
    const clientId = options.twitchClientId?.trim() ?? '';
    if (clientId.length === 0) {
      twitchSetupError = MISSING_CLIENT_ID_ERROR;
    } else {
      try {
        twitch = (options.createTwitch ?? createTwitchService)({
          clientId,
          dataDir: options.dataDir ?? path.resolve('data'),
          onChat: (chat) => {
            try {
              runtime.chat(chat);
            } catch (error) {
              console.error(`[runtime] chat failed: ${errorName(error)}`);
            }
          },
          onStateChange: syncLiveLabels,
          now,
        });
      } catch (error) {
        twitchSetupError = 'Twitch integration failed to initialize';
        console.error(`[twitch] init failed: ${errorName(error)}`);
      }
    }
  }
  lastMetaJson = JSON.stringify(meta());

  runtime.subscribe((update) => {
    if (update.type === 'labels') publishMetaIfChanged();
    else if (update.type === 'round') hub?.broadcast({ type: 'round', round: update.round });
    else {
      if (!demo)
        sendAnnouncement(
          helpAnnouncement(
            update.snapshot,
            runtime.labels(),
            twitchState().sharedChat.sharesSession,
          ),
        );
      hub?.broadcast({ type: 'snapshot', snapshot: update.snapshot });
    }
  });

  function partnerB(): string | null {
    const state = share.state();
    return state.status === 'on' && state.url !== null
      ? `${state.url}/overlay/b?room=${encodeURIComponent(roomToken)}`
      : null;
  }

  function controlState(request: IncomingMessage): ControlState {
    const state = twitchState();
    const shareState = share.state();
    // Local requests only: the Host header was validated as loopback by classifyRequest.
    const base = `http://${request.headers.host ?? `127.0.0.1:${port}`}`;
    return {
      protocol: PROTOCOL_VERSION,
      demo,
      twitch: {
        status: state.status,
        login: state.login,
        userCode: state.userCode,
        verificationUri: state.verificationUri,
        error: state.error,
      },
      channels: state.channels,
      config: runtime.config(),
      snapshot: runtime.snapshot(),
      meta: meta(),
      overlayUrls: { A: `${base}/overlay/a`, B: `${base}/overlay/b`, partnerB: partnerB() },
      share: { status: shareState.status, error: shareState.error },
      lastChat,
    };
  }

  /** Live CALLs need the channels whose chat gates the round. */
  function liveChannelProblem(mode: StuntMode): string | null {
    if (demo) return null;
    const { channels } = twitchState();
    if (channels.A === null) return 'Connect Twitch and set your channel (A) before a CALL';
    if (mode === 'crossover' && channels.B === null) {
      return 'Set the partner channel (B) for a crossover CALL, or switch to single mode';
    }
    return null;
  }

  /**
   * Live CALLs also need EventSub actually reading chat: the prompt goes out through Helix
   * either way, so without this the viewers type, nobody is counted and SO CLOSE 0/q follows.
   */
  function liveChatProblem(): string | null {
    if (demo) return null;
    const { status } = twitchState();
    if (status === 'connected') return null;
    return (
      `Twitch chat is not connected (status: ${status}). Wait until it shows Connected, ` +
      'or fix the Twitch error and press Save channels, before a CALL'
    );
  }

  function requireTwitch(response: ServerResponse): TwitchService | null {
    if (demo) {
      notFound(response);
      return null;
    }
    if (twitch === null) {
      sendJson(response, 503, { error: twitchSetupError ?? 'Twitch is not configured' });
      return null;
    }
    return twitch;
  }

  function sendSnapshot(response: ServerResponse, url: URL): void {
    sendJson(
      response,
      200,
      snapshotResponse(runtime.snapshot(), meta(), runtime.round(), url.searchParams.get('round')),
    );
  }

  async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
    const file = await resolveStatic(pathname);
    if (file === null) {
      notFound(response);
      return;
    }
    response.writeHead(200, {
      'Content-Type': file.contentType,
      'Content-Length': file.body.length,
      'Cache-Control': 'no-store',
    });
    response.end(file.body);
  }

  const routes: Routes = {
    '/api/health': {
      GET: (_request, response) => sendJson(response, 200, { ok: true, simulated: demo }),
    },
    '/api/snapshot': { GET: (_request, response, url) => sendSnapshot(response, url) },
    '/api/state': { GET: (request, response) => sendJson(response, 200, controlState(request)) },
    // Separate local-only endpoint: broadcaster suggestions never enter the overlay protocol.
    '/api/shared-chat': {
      GET: (_request, response) => {
        const state = twitchState();
        const snapshot = runtime.snapshot();
        sendJson(response, 200, {
          partners: !state.channels.B ? state.sharedChat.partners : [],
          notice:
            sharedChatEndedRound !== null &&
            sharedChatEndedRound === snapshot.roundId &&
            (snapshot.phase === 'active' || snapshot.phase === 'revealing')
              ? 'Shared Chat ended. This round keeps running and channel B stays selected.'
              : null,
        });
      },
      POST: async (request, response) => {
        const body = await readJsonBody(request, SMALL_BODY_LIMIT);
        if (
          typeof body !== 'object' ||
          body === null ||
          !('userId' in body) ||
          typeof body.userId !== 'string' ||
          body.userId.length === 0 ||
          body.userId.length > 100
        ) {
          throw new HttpError(400, 'Choose a detected Shared Chat partner.');
        }
        const phase = runtime.snapshot().phase;
        if (phase === 'active' || phase === 'revealing') {
          throw new HttpError(409, 'Wait for the round to finish before choosing channel B.');
        }
        const service = requireTwitch(response);
        if (!service) return;
        try {
          await service.useSharedChatPartner(body.userId);
        } catch (error) {
          if (error instanceof ChannelLookupError) {
            throw new HttpError(CHANNEL_LOOKUP_STATUS[error.code], error.message);
          }
          throw new HttpError(502, 'Could not select the Shared Chat partner. Try manual entry.');
        }
        syncLiveLabels();
        sendJson(response, 200, { channels: twitchState().channels });
      },
    },
    '/api/call': {
      POST: async (request, response) => {
        const parsed = parseCallRequest(await readJsonBody(request, CALL_BODY_LIMIT));
        if (!parsed.ok) throw new HttpError(400, parsed.error);
        const problem = liveChannelProblem(parsed.value.mode ?? runtime.config().mode);
        if (problem !== null) throw new HttpError(400, problem);
        const chatProblem = liveChatProblem();
        if (chatProblem !== null) throw new HttpError(409, chatProblem);
        // The operator took over: the unattended showcase loop stops.
        showcase?.stopAutoplay();
        try {
          sendJson(response, 202, { roundId: runtime.call(parsed.value).roundId });
        } catch (error) {
          if (error instanceof RoundConflictError) throw new HttpError(409, error.message);
          if (error instanceof RangeError) throw new HttpError(400, error.message);
          throw error;
        }
      },
    },
    '/api/reset': {
      POST: async (request, response) => {
        await readJsonBody(request, SMALL_BODY_LIMIT);
        showcase?.stopAutoplay();
        showcase?.stop();
        runtime.reset();
        sendJson(response, 200, { ok: true });
      },
    },
    '/api/auth/start': {
      POST: async (request, response) => {
        await readJsonBody(request, SMALL_BODY_LIMIT);
        const service = requireTwitch(response);
        if (service === null) return;
        try {
          const { userCode, verificationUri } = await service.beginAuth();
          sendJson(response, 200, { userCode, verificationUri });
        } catch (error) {
          if (error instanceof TwitchAuthConflictError) {
            sendJson(response, 409, { error: error.message });
            return;
          }
          console.error(`[twitch] beginAuth failed: ${errorName(error)}`);
          sendJson(response, 502, {
            error: 'Could not start Twitch authorization',
            detail: twitchState().error,
          });
        }
      },
    },
    '/api/auth/signout': {
      POST: async (request, response) => {
        await readJsonBody(request, SMALL_BODY_LIMIT);
        const service = requireTwitch(response);
        if (service === null) return;
        await service.signOut();
        sendJson(response, 200, { ok: true });
      },
    },
    '/api/labels': {
      POST: async (request, response) => {
        const parsed = parseLabelsRequest(await readJsonBody(request, SMALL_BODY_LIMIT));
        if (!parsed.ok) throw new HttpError(400, parsed.error);
        Object.assign(labelOverride, parsed.value);
        syncLiveLabels();
        sendJson(response, 200, { labels: runtime.labels() });
      },
    },
    '/api/channels': {
      POST: async (request, response) => {
        const parsed = parseChannelsRequest(await readJsonBody(request, SMALL_BODY_LIMIT));
        if (!parsed.ok) throw new HttpError(400, parsed.error);
        const { a, b } = parsed.value;
        if (demo) {
          // Demo: logins only become stand labels; nothing is resolved on Twitch.
          const virtual = (side: Side, login: string): ChannelInfo => ({
            login: login.toLowerCase(),
            displayName: login,
            userId: `sim:channel:${side}`,
          });
          if (a !== undefined) demoChannels.A = virtual('A', a);
          if (b !== undefined) demoChannels.B = b === null ? null : virtual('B', b);
          syncLiveLabels();
          sendJson(response, 200, { channels: demoChannels, labels: runtime.labels() });
          return;
        }
        const service = requireTwitch(response);
        if (service === null) return;
        try {
          await service.setChannels(parsed.value);
        } catch (error) {
          if (error instanceof ChannelLookupError && error.code !== 'failed') {
            // Operator input problem (typo, unknown login, not signed in): say exactly what.
            sendJson(response, CHANNEL_LOOKUP_STATUS[error.code], { error: error.message });
            return;
          }
          console.error(`[twitch] setChannels failed: ${errorName(error)}`);
          sendJson(response, CHANNEL_LOOKUP_STATUS.failed, {
            error: 'Twitch could not resolve those channels',
            detail: twitchState().error,
          });
          return;
        }
        syncLiveLabels();
        sendJson(response, 200, { channels: twitchState().channels, labels: runtime.labels() });
      },
    },
    '/api/share/start': {
      POST: async (request, response) => {
        await readJsonBody(request, SMALL_BODY_LIMIT);
        const state = await share.start();
        sendJson(response, state.status === 'error' ? 503 : 202, {
          status: state.status,
          error: state.error,
          partnerB: partnerB(),
        });
      },
    },
    '/api/share/stop': {
      POST: async (request, response) => {
        await readJsonBody(request, SMALL_BODY_LIMIT);
        await share.stop();
        sendJson(response, 200, { status: 'off', error: null });
      },
    },
    '/dev/chat': {
      POST: async (request, response) => {
        const parsed = parseDemoChat(await readJsonBody(request, SMALL_BODY_LIMIT));
        if (parsed === null) {
          throw new HttpError(
            400,
            'Expected { side: A|B, count: 1..3000, seed: non-negative integer }',
          );
        }
        const { side } = parsed;
        const roundId = runtime.round()?.roundId ?? null;
        const participants = (): number => runtime.snapshot().sides[side].participants;
        const before = participants();
        let counted = before;
        let accepted = 0;
        let superseded = false;
        const events = makeSimulatedCrowd(parsed, now());
        let sliceStart = performance.now();
        for (let index = 0; index < events.length; index += 1) {
          if (index > 0 && performance.now() - sliceStart >= DEV_CHAT_SLICE_MS) {
            counted = participants();
            await yieldToEventLoop();
            sliceStart = performance.now();
            // RESET or a new CALL while yielding: the rest of the burst belongs to no round.
            if ((runtime.round()?.roundId ?? null) !== roundId) {
              superseded = true;
              break;
            }
          }
          const event = events[index];
          if (event !== undefined && runtime.chat(event)) accepted += 1;
        }
        if (!superseded) counted = participants();
        // `added` = new distinct people on that side; a replayed seed adds nobody.
        const added = roundId === null ? 0 : Math.max(0, counted - before);
        sendJson(response, 202, { simulated: true, accepted, added, processed: true });
      },
    },
    '/dev/showcase': {
      POST: async (request, response) => {
        const parsed = parseShowcaseRequest(await readJsonBody(request, SMALL_BODY_LIMIT));
        if (parsed === null) {
          throw new HttpError(400, 'Expected { scenario: "crossover" | "so-close" | "single" }');
        }
        if (showcase === null) throw new HttpError(404, 'Not found');
        showcase.stopAutoplay();
        try {
          const round = showcase.play(parsed.scenario);
          sendJson(response, 202, {
            simulated: true,
            scenario: parsed.scenario,
            roundId: round.roundId,
          });
        } catch (error) {
          if (error instanceof RoundConflictError) throw new HttpError(409, error.message);
          throw error;
        }
      },
    },
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      // e.g. `//x:99999`: WHATWG URL rejects it as a protocol-relative URL with a bad port.
      throw new HttpError(400, 'Bad request');
    }
    const { pathname } = url;
    // HEAD behaves like GET; node:http drops the body for HEAD responses by itself.
    const method = request.method === 'HEAD' ? 'GET' : (request.method ?? 'GET');
    const access = classifyRequest(request, url, roomToken);

    if (access.kind === 'remote') {
      // Tunnel traffic: health, or partner overlay B reads with the room token. Nothing else.
      if (method === 'GET' && pathname === '/api/health') {
        sendJson(response, 200, { ok: true, simulated: demo });
        return;
      }
      if (method !== 'GET' || !access.roomOk || !remoteMayRead(pathname)) {
        sendJson(response, 403, { error: 'Forbidden' });
        return;
      }
      if (pathname === '/api/snapshot') {
        sendSnapshot(response, url);
        return;
      }
      // Module imports and stylesheets cannot carry ?room=; the HttpOnly cookie covers them.
      if (access.roomFromQuery && PAGE_ALIASES[pathname] !== undefined) {
        response.setHeader('Set-Cookie', roomCookieHeader(roomToken));
      }
      await serveStatic(response, pathname);
      return;
    }

    if (!demo && isDevPath(pathname)) {
      notFound(response);
      return;
    }
    const route = routes[pathname];
    if (route !== undefined) {
      const handler = method === 'GET' || method === 'POST' ? route[method] : undefined;
      if (handler === undefined) {
        response.setHeader('Allow', Object.keys(route).join(', '));
        sendJson(response, 405, { error: 'Method not allowed' });
        return;
      }
      if (method === 'POST') {
        // Same-origin + JSON: browsers cannot forge this cross-site without a CORS preflight.
        if (!isSameOriginOrAbsent(request)) throw new HttpError(403, 'Origin not allowed');
        if (!isJsonContentType(request))
          throw new HttpError(415, 'Use Content-Type: application/json');
      }
      await handler(request, response, url);
      return;
    }
    if (method === 'GET') {
      await serveStatic(response, pathname);
      return;
    }
    notFound(response);
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
      } else if (error instanceof HttpError) {
        if (error.status === 413) response.setHeader('Connection', 'close');
        sendJson(response, error.status, { error: error.message });
      } else {
        sendJson(response, 500, { error: 'Internal server error' });
        // No request URL/body, token, user ID or upstream payload in logs.
        console.error(`[http] ${errorName(error)}`);
      }
    });
  });

  function authorizeUpgrade(request: IncomingMessage, url: URL): UpgradeDecision {
    if (url.pathname !== '/ws') return { ok: false, status: 404 };
    const side = url.searchParams.get('side');
    if (side !== 'A' && side !== 'B') return { ok: false, status: 400 };
    const access = classifyRequest(request, url, roomToken);
    if (access.kind === 'local') {
      // WebSockets ignore the same-origin policy: refuse foreign web pages on loopback.
      return isSameOriginOrAbsent(request) ? { ok: true, side } : { ok: false, status: 403 };
    }
    return access.roomOk && side === 'B' ? { ok: true, side } : { ok: false, status: 403 };
  }

  hub = attachWsHub(server, {
    authorize: authorizeUpgrade,
    initialMessages(side): readonly ServerMessage[] {
      const snapshot = runtime.snapshot();
      return [
        {
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          side,
          serverNowMs: snapshot.serverNowMs,
          simulated: demo,
        },
        { type: 'meta', meta: meta() },
        { type: 'round', round: runtime.round() },
        { type: 'snapshot', snapshot },
      ];
    },
  });
  const wsHub = hub;

  let closing: Promise<void> | null = null;
  async function shutdown(): Promise<void> {
    showcase?.dispose();
    runtime.dispose();
    await share.stop();
    if (twitch !== null) {
      try {
        await twitch.stop();
      } catch (error) {
        console.error(`[twitch] stop failed: ${errorName(error)}`);
      }
    }
    await wsHub.close();
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }

  return {
    server,
    runtime,
    hub: wsHub,
    roomToken,
    async listen(listenPort: number, host = '127.0.0.1'): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');
      port = address.port;
      const service = twitch;
      if (service !== null) {
        // Never blocks startup: failures surface as status/error in GET /api/state.
        Promise.resolve()
          .then(() => service.start())
          .catch((error: unknown) => console.error(`[twitch] start failed: ${errorName(error)}`))
          .finally(syncLiveLabels);
      }
      if (options.autoplay === true) showcase?.startAutoplay();
      return port;
    },
    close(): Promise<void> {
      closing ??= shutdown();
      return closing;
    },
  };
}
