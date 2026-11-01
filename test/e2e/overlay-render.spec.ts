import { presetArtwork } from '../../public/control/artwork.js';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type FrameLocator,
  type Locator,
  type Page,
  type Route,
  type WebSocketRoute,
} from '@playwright/test';
import {
  GRID_ROWS,
  PALETTE,
  PALETTE_RGB,
  SIDE_COLS,
  fullCols,
  sideRegion,
} from '../../src/engine/artwork.js';
import { buildRefinementPlan, stepsToShow } from '../../src/engine/quadtree.js';
import type {
  Artwork,
  RefinementPlan,
  Side,
  Snapshot,
  SnapshotSide,
  StuntMode,
  StuntPhase,
} from '../../src/engine/types.js';
import type {
  OverlayMeta,
  RoundPayload,
  ServerMessage,
  SnapshotResponse,
} from '../../src/shared/protocol.js';

// Overlay render harness (Playwright project `overlay-render`), isolated from the server:
// `public/` is served from disk through page.route and /ws is mocked with page.routeWebSocket.
// A paused Playwright clock makes every capture deterministic (server time = page time). All
// crowds here are SIMULATED. test/e2e/overlay.spec.ts covers the same overlay against the real
// demo server.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHOTS_DIR = path.join(ROOT, 'test-results', 'overlay');
const ORIGIN = 'http://127.0.0.1:3199';
const T0 = Date.UTC(2026, 9, 31, 21, 0, 0);
const PAUSE_AT = T0 + 5_000;
const ROOM = 'room-token-for-tests';

// Same policy as src/server/http.ts minus frame-ancestors (the joint capture embeds overlays).
const CSP =
  "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'";
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const PAGE_ALIASES: Readonly<Record<string, string>> = {
  '/overlay/a': 'overlay/index.html',
  '/overlay/b': 'overlay/index.html',
};
// A busy, mid-tone "game stream" behind the transparent overlay: worst case for legibility.
const BACKDROP = [
  'repeating-linear-gradient(115deg, rgba(255,255,255,0.05) 0 18px, transparent 18px 46px)',
  'radial-gradient(circle at 22% 30%, #4f8f6a 0, transparent 38%)',
  'radial-gradient(circle at 78% 68%, #a04b6e 0, transparent 42%)',
  'radial-gradient(circle at 60% 15%, #c9a25a 0, transparent 25%)',
  'linear-gradient(160deg, #2b3f5c, #121822)',
].join(', ');

// Timeline constants mirrored from public/overlay/stage.js (docs/DESIGN.md §Overlay).
const ZIPPER_MS = 600;
const WAVE_MS = 2_400;
const SETTLE_MS = 1_800; // batch spread (≤ 900) + ripple (≤ 380) + flip (280) + slack

// ---------------------------------------------------------------------------------------------
// Artwork + plans (the real engine planner, so the overlay replays exactly what the server sends)
// ---------------------------------------------------------------------------------------------

function rgb(index: number): readonly [number, number, number] {
  const value = PALETTE_RGB[index];
  if (!value) throw new RangeError(`palette index ${index}`);
  return value;
}

/** "GG" on a blue field with ink drop shadow, an orange bar crossing the seam and a few stars. */
function ggArtwork(mode: StuntMode): Artwork {
  const cols = fullCols(mode);
  const rows = GRID_ROWS;
  const pixels = new Array<number>(cols * rows).fill(6);
  const set = (x: number, y: number, color: number) => {
    if (x >= 0 && x < cols && y >= 0 && y < rows) pixels[y * cols + x] = color;
  };
  const centers = mode === 'crossover' ? [24, 72] : [24];
  const isG = (x: number, y: number): boolean =>
    centers.some((cx) => {
      const rx = 15.5;
      const ry = 10.5;
      const px = x + 0.5 - cx;
      const py = y + 0.5 - 12;
      const outer = (px / rx) ** 2 + (py / ry) ** 2 <= 1;
      const inner = (px / (rx - 5)) ** 2 + (py / (ry - 3.6)) ** 2 < 1;
      const angle = (Math.atan2(-py, px) * 180) / Math.PI;
      const open = angle > -2 && angle < 42;
      const bar = outer && py >= -0.4 && py <= 3.4 && px >= 1.5;
      return (outer && !inner && !open) || bar;
    });
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) if (isG(x - 1, y - 1)) set(x, y, 0);
  }
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) if (isG(x, y)) set(x, y, 5);
  }
  for (let x = 14; x < cols - 14; x += 1) {
    set(x, 24, 2);
    set(x, 25, 2);
  }
  for (const [x, y] of [
    [3, 3],
    [8, 21],
    [43, 2],
    [52, 5],
    [61, 1],
    [88, 3],
    [92, 20],
    [5, 25],
    [90, 25],
  ] as const) {
    set(x, y, 1);
  }
  return { cols, rows, pixels };
}

/** Card colors of a plan's region after `count` steps (row-major, region-local). */
function replay(plan: RefinementPlan, count: number): number[] {
  const { region } = plan;
  const colors = new Array<number>(region.w * region.h).fill(plan.rootColor);
  for (const step of plan.steps.slice(0, count)) {
    for (const { rect, color } of step.children) {
      for (let y = rect.y; y < rect.y + rect.h; y += 1) {
        for (let x = rect.x; x < rect.x + rect.w; x += 1) {
          colors[(y - region.y) * region.w + (x - region.x)] = color;
        }
      }
    }
  }
  return colors;
}

function makeRound(roundId: string, mode: StuntMode, art: Artwork = ggArtwork(mode)): RoundPayload {
  const plans: Partial<Record<Side, RefinementPlan>> = {
    A: buildRefinementPlan({ artwork: art, side: 'A', region: sideRegion(mode, 'A') }),
  };
  if (mode === 'crossover')
    plans.B = buildRefinementPlan({ artwork: art, side: 'B', region: sideRegion(mode, 'B') });
  return { roundId, mode, cols: art.cols, rows: art.rows, palette: [...PALETTE], plans };
}

function planOf(round: RoundPayload, side: Side): RefinementPlan {
  const plan = round.plans[side];
  if (!plan) throw new Error(`round has no plan for ${side}`);
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------------------------

function sideState(participants: number, quorum: number): SnapshotSide {
  return {
    participants,
    quorum,
    progress: quorum > 0 ? Math.min(1, participants / quorum) : 0,
    ready: quorum > 0 && participants >= quorum,
  };
}

interface SnapshotInput {
  readonly mode: StuntMode;
  readonly phase: StuntPhase;
  readonly roundId: string | null;
  readonly a: SnapshotSide;
  readonly b: SnapshotSide;
  readonly startedAtMs?: number | null;
  readonly deadlineAtMs?: number | null;
  readonly revealAtMs?: number | null;
  readonly crossovers?: number;
}

// ---------------------------------------------------------------------------------------------
// Fake server + page helpers
// ---------------------------------------------------------------------------------------------

interface ProbeCanvas {
  readonly width: number;
  readonly height: number;
  getContext(type: '2d'): {
    getImageData(x: number, y: number, w: number, h: number): { readonly data: ArrayLike<number> };
  } | null;
}

interface OverlayInspect {
  readonly uniteSince: number;
  readonly introAlpha: number;
  readonly introScale: number;
  readonly ctaChipAlpha: number;
  readonly lagAlpha: number;
  readonly lagScale: number;
  readonly waitingRemaining: number;
  readonly stand: string;
  readonly roundId: string | null;
  readonly stepsShown: number;
  readonly flippedColumns: number;
  readonly linkLost: boolean;
  readonly hudAlpha: number;
  readonly hudSeconds: number;
  readonly soCloseAlpha: number;
  readonly cards: number[];
  readonly confetti: number;
}

interface FakeServerOptions {
  /** 'refuse' closes every socket immediately to exercise the polling fallback. */
  readonly ws: 'mock' | 'refuse';
  /** Real-time tests skip the paused clock. */
  readonly clock: boolean;
}

class FakeOverlayServer {
  readonly sockets: WebSocketRoute[] = [];
  readonly requests: string[] = [];
  meta: OverlayMeta = { labels: { A: 'Left Stand', B: 'Right Stand' }, twitch: 'demo' };
  round: RoundPayload | null = null;
  snapshot: Snapshot;
  now = PAUSE_AT;
  /** Simulates a stopped server / closed tunnel: sockets refused, snapshot polls fail. */
  offline = false;
  #revision = 0;
  #greetReady = false;

  constructor(
    readonly page: Page,
    readonly options: FakeServerOptions = { ws: 'mock', clock: true },
  ) {
    this.snapshot = this.makeSnapshot({
      mode: 'crossover',
      phase: 'idle',
      roundId: null,
      a: sideState(0, 0),
      b: sideState(0, 0),
    });
  }

  makeSnapshot(input: SnapshotInput): Snapshot {
    this.#revision += 1;
    return {
      revision: this.#revision,
      mode: input.mode,
      phase: input.phase,
      roundId: input.roundId,
      serverNowMs: this.now,
      startedAtMs: input.startedAtMs ?? null,
      deadlineAtMs: input.deadlineAtMs ?? null,
      revealAtMs: input.revealAtMs ?? null,
      revealDurationMs: 6_000,
      simulated: true,
      crossovers: input.crossovers ?? 0,
      sides: { A: input.a, B: input.b },
    };
  }

  async install(): Promise<void> {
    await mkdir(SHOTS_DIR, { recursive: true });
    await this.page.route(`${ORIGIN}/**`, (route) => this.#serve(route));
    await this.page.routeWebSocket(/\/ws\?/, (ws) => {
      this.requests.push(new URL(ws.url()).pathname + new URL(ws.url()).search);
      if (this.options.ws === 'refuse' || this.offline) {
        void ws.close({ code: 1011, reason: 'test: refused' });
        return;
      }
      this.sockets.push(ws);
      if (this.#greetReady) this.#greet(ws);
    });
    if (this.options.clock) await this.page.clock.install({ time: T0 });
  }

  /** Navigates, pauses the clock at a known instant, then lets the mocked sockets say hello. */
  async open(pathAndQuery: string, expectedSockets = 1): Promise<void> {
    await this.page.goto(`${ORIGIN}${pathAndQuery}`);
    if (this.options.clock) await this.page.clock.pauseAt(PAUSE_AT);
    this.now = PAUSE_AT;
    if (this.options.ws === 'mock') {
      await expect.poll(() => this.sockets.length).toBe(expectedSockets);
      this.#greetReady = true;
      for (const ws of this.sockets) this.#greet(ws);
    }
    await this.page.evaluate((background) => {
      const doc = (
        globalThis as unknown as {
          document: { documentElement: { style: { background: string } } };
        }
      ).document;
      doc.documentElement.style.background = background;
    }, BACKDROP);
  }

  #greet(ws: WebSocketRoute): void {
    const side: Side = new URL(ws.url()).searchParams.get('side') === 'B' ? 'B' : 'A';
    const messages: ServerMessage[] = [
      { type: 'hello', protocol: 2, side, serverNowMs: this.now, simulated: true },
      { type: 'meta', meta: this.meta },
      { type: 'round', round: this.round },
      { type: 'snapshot', snapshot: this.snapshot },
    ];
    for (const message of messages) ws.send(JSON.stringify(message));
  }

  #broadcast(message: ServerMessage): void {
    for (const ws of this.sockets) ws.send(JSON.stringify(message));
  }

  async #serve(route: Route): Promise<void> {
    const url = new URL(route.request().url());
    this.requests.push(url.pathname + url.search);
    if (url.pathname === '/api/snapshot') {
      if (this.offline) {
        await route.abort('connectionrefused');
        return;
      }
      const response: SnapshotResponse =
        url.searchParams.get('round') === (this.round?.roundId ?? null)
          ? { protocol: 2, snapshot: this.snapshot, meta: this.meta }
          : { protocol: 2, snapshot: this.snapshot, meta: this.meta, round: this.round };
      await route.fulfill({ json: response, headers: { 'Cache-Control': 'no-store' } });
      return;
    }
    if (url.pathname === '/__harness/joint') {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: JOINT_HTML });
      return;
    }
    if (url.pathname === '/__harness/joint.css') {
      await route.fulfill({ contentType: 'text/css; charset=utf-8', body: jointCss() });
      return;
    }
    const relative = PAGE_ALIASES[url.pathname] ?? decodeURIComponent(url.pathname).slice(1);
    const file = path.resolve(PUBLIC_DIR, relative);
    const type = MIME[path.extname(file)];
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !type) {
      await route.fulfill({ status: 404, body: 'Not found' });
      return;
    }
    try {
      await route.fulfill({
        body: await readFile(file),
        contentType: type,
        headers: { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' },
      });
    } catch {
      await route.fulfill({ status: 404, body: 'Not found' });
    }
  }

  /** Drops every open socket (server stopped) and refuses new ones and polls while offline. */
  async goOffline(): Promise<void> {
    this.offline = true;
    for (const ws of this.sockets.splice(0)) await ws.close({ code: 1001, reason: 'test: down' });
  }

  setRound(round: RoundPayload | null): void {
    this.round = round;
    this.#broadcast({ type: 'round', round });
  }

  /** Publishes a snapshot and waits until every overlay document has processed it. */
  async publish(input: SnapshotInput, documents: Locator[] = [this.page.locator('html')]) {
    this.snapshot = this.makeSnapshot(input);
    this.#broadcast({ type: 'snapshot', snapshot: this.snapshot });
    for (const html of documents) {
      await expect(html).toHaveAttribute('data-revision', String(this.snapshot.revision));
    }
  }

  async advance(ms: number): Promise<void> {
    await this.page.clock.runFor(ms);
    this.now += ms;
  }

  /** Advances the paused clock to an absolute server time. */
  async advanceTo(serverMs: number): Promise<void> {
    if (serverMs > this.now) await this.advance(serverMs - this.now);
  }

  async shot(name: string): Promise<string> {
    const file = path.join(SHOTS_DIR, `${name}.png`);
    await this.page.screenshot({ path: file });
    return file;
  }
}

const JOINT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Joint view (A | B)</title>
<link rel="stylesheet" href="/__harness/joint.css"></head>
<body><iframe id="a" src="/overlay/a?mute=1"></iframe><iframe id="b" src="/overlay/b?mute=1"></iframe></body></html>`;

function jointCss(): string {
  return `html,body{margin:0;height:100%;overflow:hidden;background:${BACKDROP}}
body{display:flex;align-items:center;justify-content:center}
iframe{width:960px;height:540px;border:0;display:block;background:transparent}`;
}

async function canvasCoverage(page: Page | FrameLocator): Promise<number> {
  return page.locator('#stage').evaluate((node) => {
    const canvas = node as unknown as ProbeCanvas;
    const context = canvas.getContext('2d');
    if (!context) return -1;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) opaque += 1;
    return opaque;
  });
}

/** RGBA at the center of a card face (below the highlight, above the shade). */
async function cardPixel(page: Page, column: number, row: number): Promise<number[]> {
  return page.locator('#stage').evaluate(
    (node, [x, y]) => {
      const context = (node as unknown as ProbeCanvas).getContext('2d');
      if (!context) return [];
      return Array.from(context.getImageData(x, y, 1, 1).data);
    },
    [column * 40 + 2 + 18, row * 40 + 2 + 20] as const,
  );
}

async function inspect(page: Page): Promise<OverlayInspect> {
  return page.evaluate(() =>
    (
      globalThis as unknown as { crossoverOverlay: { inspect(): OverlayInspect } }
    ).crossoverOverlay.inspect(),
  );
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

const QUORUM_A = 10;
const QUORUM_B = 12;

for (const side of ['A', 'B'] as const) {
  test(`crossover timeline renders every phase on side ${side} (SIMULATED)`, async ({ page }) => {
    const server = new FakeOverlayServer(page);
    await server.install();
    await server.open(`/overlay/${side.toLowerCase()}?mute=1&room=${ROOM}`);
    const tag = side.toLowerCase();

    // Idle: fully transparent canvas, nothing drawn.
    await server.advance(200);
    expect(await canvasCoverage(page)).toBe(0);
    if (side === 'A') await server.shot('01-idle-a');

    // CALL: the stand rises.
    const round = makeRound('round-crossover-1', 'crossover');
    const startedAtMs = server.now;
    const deadlineAtMs = startedAtMs + 45_000;
    const active = {
      mode: 'crossover',
      phase: 'active',
      roundId: round.roundId,
      startedAtMs,
      deadlineAtMs,
    } as const;
    server.setRound(round);
    await server.publish({ ...active, a: sideState(0, QUORUM_A), b: sideState(0, QUORUM_B) });
    await server.advance(250);
    await server.shot(`02-stand-rising-${tag}`);
    await server.advance(600);
    expect(await canvasCoverage(page)).toBeGreaterThan(1_500_000);

    // ~30 % progress, then a capture mid-ripple and once settled.
    await server.advance(3_000);
    await server.publish({ ...active, a: sideState(3, QUORUM_A), b: sideState(4, QUORUM_B) });
    await server.advance(260);
    await server.shot(`03-ripple-${tag}`);
    await server.advance(SETTLE_MS);
    await server.shot(`04-active-30-${tag}`);

    // ~70 %.
    await server.advance(6_000);
    await server.publish({ ...active, a: sideState(7, QUORUM_A), b: sideState(8, QUORUM_B) });
    await server.advance(SETTLE_MS);
    await server.shot(`05-active-70-${tag}`);

    // A ready, B still short: A waits (pulse + banner), B sees "LEFT STAND IS READY".
    await server.advance(5_000);
    await server.publish({ ...active, a: sideState(10, QUORUM_A), b: sideState(9, QUORUM_B) });
    await server.advance(SETTLE_MS);
    await server.shot(`06-waiting-${tag}`);

    // B reaches quorum → revealing with a shared revealAt.
    await server.advance(3_000);
    const revealAtMs = server.now + 1_500;
    const revealing = { ...active, phase: 'revealing', revealAtMs, crossovers: 3 } as const;
    await server.publish({ ...revealing, a: sideState(10, QUORUM_A), b: sideState(12, QUORUM_B) });
    await server.advance(700);
    await server.shot(`07-both-ready-${tag}`);

    await server.advanceTo(revealAtMs + 330);
    await server.shot(`08-zipper-${tag}`);
    // Mid-wave on this side: A is crossed during 600–1775 ms, B during 1800–2975 ms.
    await server.advanceTo(revealAtMs + (side === 'A' ? 1_250 : 2_450));
    await server.shot(`09-wave-${tag}`);
    await server.advanceTo(revealAtMs + ZIPPER_MS + WAVE_MS + 450);
    await server.shot(`10-finale-${tag}`);

    await server.advanceTo(revealAtMs + 6_000);
    await server.publish({
      ...revealing,
      phase: 'complete',
      a: sideState(10, QUORUM_A),
      b: sideState(12, QUORUM_B),
    });
    await server.advanceTo(revealAtMs + 15_000);
    await server.shot(`11-complete-${tag}`);
    expect(await canvasCoverage(page)).toBeGreaterThan(800_000);

    // RESET: the stand drops and the canvas is transparent again.
    server.setRound(null);
    await server.publish({
      mode: 'crossover',
      phase: 'idle',
      roundId: null,
      a: sideState(0, 0),
      b: sideState(0, 0),
    });
    await server.advance(900);
    expect(await canvasCoverage(page)).toBe(0);

    // Every request carried the room token.
    expect(server.requests.length).toBeGreaterThan(0);
    for (const request of server.requests.filter(
      (r) => r.startsWith('/ws') || r.startsWith('/api'),
    )) {
      expect(request).toContain(`room=${ROOM}`);
    }
  });
}

for (const side of ['A', 'B'] as const) {
  test(`side ${side} cards match the plan replay and the artwork seam after reveal`, async ({
    page,
  }) => {
    const round = makeRound('round-seam', 'crossover');
    const server = new FakeOverlayServer(page);
    server.round = round;
    const startedAtMs = PAUSE_AT;
    const active = {
      mode: 'crossover',
      phase: 'active',
      roundId: round.roundId,
      startedAtMs,
      deadlineAtMs: startedAtMs + 45_000,
    } as const;
    server.snapshot = server.makeSnapshot({
      ...active,
      a: sideState(0, QUORUM_A),
      b: sideState(0, QUORUM_B),
    });
    await server.install();
    await server.open(`/overlay/${side.toLowerCase()}?mute=1&debug=1&unite=0`);
    await server.advance(800);

    await server.publish({ ...active, a: sideState(7, QUORUM_A), b: sideState(8, QUORUM_B) });
    await server.advance(SETTLE_MS);
    const plan = planOf(round, side);
    const progress = side === 'A' ? 7 / QUORUM_A : 8 / QUORUM_B;
    const shown = stepsToShow(plan, progress, false);
    const state = await inspect(page);
    expect(state.stepsShown).toBe(shown);
    expect(state.cards).toEqual(replay(plan, shown));

    const revealAtMs = server.now + 1_500;
    await server.publish({
      ...active,
      phase: 'revealing',
      revealAtMs,
      a: sideState(10, QUORUM_A),
      b: sideState(12, QUORUM_B),
    });
    await server.advanceTo(revealAtMs + 14_500);
    const final = await inspect(page);
    expect(final.flippedColumns).toBe(48);
    const art = ggArtwork('crossover');
    const offset = side === 'A' ? 0 : 48;
    const expected = Array.from(
      { length: 48 * 27 },
      (_, i) => art.pixels[Math.floor(i / 48) * 96 + offset + (i % 48)] ?? -1,
    );
    expect(final.cards).toEqual(expected);

    // Pixel truth on rows clear of HUD/minimap/banners: the seam column and a middle one.
    for (const column of side === 'A' ? [47, 20] : [0, 30]) {
      for (const row of [9, 12, 14]) {
        const color = expected[row * 48 + column] ?? 0;
        expect(await cardPixel(page, column, row)).toEqual([...rgb(color), 255]);
      }
    }
  });

  test(`side ${side} timed-out shows SO CLOSE, keeps detail, then fades out`, async ({ page }) => {
    const server = new FakeOverlayServer(page);
    await server.install();
    await server.open(`/overlay/${side.toLowerCase()}?mute=1`);
    const round = makeRound('round-so-close', 'crossover');
    const startedAtMs = server.now;
    const deadlineAtMs = startedAtMs + 30_000;
    const base = { mode: 'crossover', roundId: round.roundId, startedAtMs, deadlineAtMs } as const;
    server.setRound(round);
    await server.publish({
      ...base,
      phase: 'active',
      a: sideState(10, QUORUM_A),
      b: sideState(9, QUORUM_B),
    });
    await server.advance(SETTLE_MS);
    await server.advanceTo(deadlineAtMs - 6_000);
    if (side === 'A') await server.shot('12-final-seconds-a');
    await server.advanceTo(deadlineAtMs + 250);
    await server.publish({
      ...base,
      phase: 'timed-out',
      a: sideState(10, QUORUM_A),
      b: sideState(9, QUORUM_B),
    });
    await server.advance(900);
    await server.shot(`13-so-close-${side.toLowerCase()}`);
    expect(await canvasCoverage(page)).toBeGreaterThan(1_000_000);
    await server.advanceTo(deadlineAtMs + 7_000);
    expect(await canvasCoverage(page)).toBe(0);
  });

  test(`single mode on side ${side}`, async ({ page }) => {
    const round = makeRound('round-single', 'single');
    const server = new FakeOverlayServer(page);
    await server.install();
    await server.open(`/overlay/${side.toLowerCase()}?mute=1`);
    const startedAtMs = server.now;
    const base = {
      mode: 'single',
      roundId: round.roundId,
      startedAtMs,
      deadlineAtMs: startedAtMs + 45_000,
    } as const;
    server.setRound(round);
    await server.publish({ ...base, phase: 'active', a: sideState(6, 10), b: sideState(0, 0) });
    await server.advance(SETTLE_MS);
    if (side === 'B') {
      // Single mode has no plan for B: that overlay stays fully transparent.
      expect(await canvasCoverage(page)).toBe(0);
      return;
    }
    await server.shot('14-single-active-a');
    const revealAtMs = server.now + 1_500;
    await server.publish({
      ...base,
      phase: 'revealing',
      revealAtMs,
      a: sideState(10, 10),
      b: sideState(0, 0),
    });
    await server.advanceTo(revealAtMs + ZIPPER_MS + WAVE_MS + 600);
    await server.shot('15-single-finale-a');
  });
}

test('reduced motion: no rise animation, no confetti, static waiting highlight', async ({
  page,
}) => {
  const server = new FakeOverlayServer(page);
  await server.install();
  await server.open('/overlay/a?mute=1&reducedMotion=1&debug=1');
  const round = makeRound('round-reduced', 'crossover');
  const startedAtMs = server.now;
  const base = {
    mode: 'crossover',
    roundId: round.roundId,
    startedAtMs,
    deadlineAtMs: startedAtMs + 45_000,
  } as const;
  server.setRound(round);
  await server.publish({
    ...base,
    phase: 'active',
    a: sideState(10, QUORUM_A),
    b: sideState(5, QUORUM_B),
  });
  await server.advance(50);
  expect((await inspect(page)).stand).toBe('up');
  await server.advance(SETTLE_MS);
  await server.shot('16-reduced-motion-waiting-a');
  const revealAtMs = server.now + 1_500;
  await server.publish({
    ...base,
    phase: 'revealing',
    revealAtMs,
    a: sideState(10, QUORUM_A),
    b: sideState(12, QUORUM_B),
  });
  await server.advanceTo(revealAtMs + ZIPPER_MS + WAVE_MS + 100);
  expect((await inspect(page)).confetti).toBe(0);
});

test('joint capture: A and B side by side continue the wave across the seam', async ({ page }) => {
  const server = new FakeOverlayServer(page);
  const round = makeRound('round-joint', 'crossover');
  server.round = round;
  const startedAtMs = PAUSE_AT;
  const base = {
    mode: 'crossover',
    roundId: round.roundId,
    startedAtMs,
    deadlineAtMs: startedAtMs + 45_000,
  } as const;
  server.snapshot = server.makeSnapshot({
    ...base,
    phase: 'active',
    a: sideState(7, QUORUM_A),
    b: sideState(8, QUORUM_B),
  });
  await server.install();
  await server.open('/__harness/joint', 2);
  const documents = [
    page.frameLocator('#a').locator('html'),
    page.frameLocator('#b').locator('html'),
  ];
  await server.advance(SETTLE_MS);
  await page.screenshot({ path: path.join(SHOTS_DIR, '17-joint-active.png') });
  const revealAtMs = server.now + 1_500;
  await server.publish(
    {
      ...base,
      phase: 'revealing',
      revealAtMs,
      crossovers: 2,
      a: sideState(10, QUORUM_A),
      b: sideState(12, QUORUM_B),
    },
    documents,
  );
  // Wave front right at the seam: A's last columns flipping, B's first ones next.
  await server.advanceTo(revealAtMs + ZIPPER_MS + 47 * (WAVE_MS / 96));
  await page.screenshot({ path: path.join(SHOTS_DIR, '18-joint-wave-at-seam.png') });
  await server.advanceTo(revealAtMs + 14_500);
  await page.screenshot({ path: path.join(SHOTS_DIR, '19-joint-complete.png') });
  expect(await canvasCoverage(page.frameLocator('#a'))).toBeGreaterThan(800_000);
  expect(await canvasCoverage(page.frameLocator('#b'))).toBeGreaterThan(800_000);
});

test('polling fallback restores the round with the room token when the socket is refused', async ({
  page,
}) => {
  const server = new FakeOverlayServer(page, { ws: 'refuse', clock: false });
  const round = makeRound('round-poll', 'crossover');
  server.round = round;
  server.now = Date.now();
  server.snapshot = server.makeSnapshot({
    mode: 'crossover',
    phase: 'active',
    roundId: round.roundId,
    startedAtMs: server.now,
    deadlineAtMs: server.now + 45_000,
    a: sideState(5, QUORUM_A),
    b: sideState(2, QUORUM_B),
  });
  await server.install();
  await server.open(`/overlay/b?mute=1&room=${ROOM}`);
  await expect(page.locator('html')).toHaveAttribute('data-transport', 'poll');
  await expect(page.locator('html')).toHaveAttribute('data-round', round.roundId);
  await expect.poll(() => canvasCoverage(page), { timeout: 5_000 }).toBeGreaterThan(1_500_000);
  // After the round is known, polls ask with its id so the server can omit the payload.
  await expect
    .poll(() => server.requests.some((r) => r.includes(`round=${round.roundId}`)), {
      timeout: 5_000,
    })
    .toBe(true);
  for (const request of server.requests.filter(
    (r) => r.startsWith('/ws') || r.startsWith('/api'),
  )) {
    expect(request).toContain(`room=${ROOM}`);
  }
});

test('simple artwork keeps its final split hidden while A waits, including at 720p', async ({
  page,
}) => {
  const server = new FakeOverlayServer(page);
  await server.install();
  await server.open('/overlay/a?mute=1&debug=1');
  const artwork: Artwork = {
    cols: 96,
    rows: GRID_ROWS,
    pixels: Array.from({ length: 96 * GRID_ROWS }, (_, i) =>
      i % SIDE_COLS < SIDE_COLS / 2 ? 2 : 7,
    ),
  };
  const plans = {
    A: buildRefinementPlan({ artwork, side: 'A', region: sideRegion('crossover', 'A') }),
    B: buildRefinementPlan({ artwork, side: 'B', region: sideRegion('crossover', 'B') }),
  };
  const round: RoundPayload = {
    roundId: 'simple-final-split',
    mode: 'crossover',
    cols: 96,
    rows: GRID_ROWS,
    palette: [...PALETTE],
    plans,
  };
  server.setRound(round);
  const active = {
    mode: 'crossover',
    phase: 'active',
    roundId: round.roundId,
    startedAtMs: server.now,
    deadlineAtMs: server.now + 60_000,
  } as const;
  await server.publish({ ...active, a: sideState(12, 12), b: sideState(0, 12) });
  await server.advance(SETTLE_MS);
  expect((await inspect(page)).cards).not.toEqual(replay(plans.A, plans.A.steps.length));
  await server.shot('27-simple-waiting-a');
  await page.setViewportSize({ width: 1280, height: 720 });
  await server.advance(20);
  await server.shot('28-simple-waiting-a-720p');
  const revealAtMs = server.now + 1_500;
  await server.publish({
    ...active,
    phase: 'revealing',
    revealAtMs,
    a: sideState(12, 12),
    b: sideState(12, 12),
  });
  await server.advanceTo(revealAtMs + ZIPPER_MS + WAVE_MS + 500);
  expect((await inspect(page)).cards).toEqual(replay(plans.A, plans.A.steps.length));
});

test('a delayed fallback poll cannot replace a newer WebSocket round', async ({ page }) => {
  const server = new FakeOverlayServer(page);
  await server.install();
  await server.open('/overlay/a?mute=1&debug=1');
  const oldRound = makeRound('round-before-reconnect', 'crossover');
  server.setRound(oldRound);
  const base = {
    mode: 'crossover',
    phase: 'active',
    startedAtMs: server.now,
    deadlineAtMs: server.now + 60_000,
    a: sideState(3, 12),
    b: sideState(2, 12),
  } as const;
  await server.publish({ ...base, roundId: oldRound.roundId });
  await server.advance(1_000);
  const stale: SnapshotResponse = {
    protocol: 2,
    snapshot: server.snapshot,
    meta: server.meta,
    round: oldRound,
  };
  let delayed: Route | null = null;
  await page.route(
    `${ORIGIN}/api/snapshot**`,
    (route) => {
      delayed = route;
    },
    { times: 1 },
  );
  for (const socket of server.sockets.splice(0)) await socket.close({ code: 1001 });
  await server.advance(10);
  await expect.poll(() => delayed !== null).toBe(true);

  const newRound = makeRound('round-after-reconnect', 'crossover');
  server.setRound(newRound);
  server.snapshot = server.makeSnapshot({ ...base, roundId: newRound.roundId });
  await server.advance(1_200);
  await expect(page.locator('html')).toHaveAttribute('data-round', newRound.roundId);
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/snapshot');
  await (delayed as unknown as Route).fulfill({ json: stale });
  await (await response).finished();
  await server.advance(1_000);
  expect((await inspect(page)).roundId).toBe(newRound.roundId);
  await expect(page.locator('html')).toHaveAttribute('data-round', newRound.roundId);
});

test('outside OBS a "click to enable sound" chip appears until a gesture unlocks audio', async ({
  page,
}) => {
  const server = new FakeOverlayServer(page, { ws: 'mock', clock: false });
  await server.install();
  await server.open('/overlay/a');
  const chip = page.locator('#sound-chip');
  const state = await page.evaluate(async () => {
    const AudioContextClass = (
      globalThis as unknown as { AudioContext: new () => { state: string; close(): Promise<void> } }
    ).AudioContext;
    const probe = new AudioContextClass();
    const value = probe.state;
    await probe.close();
    return value;
  });
  if (state === 'running') {
    // This Chromium build autoplays without a gesture, so the hint correctly stays hidden.
    await expect(chip).toBeHidden();
  } else {
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(chip).toBeHidden();
  }
  // mute=1 never shows the chip.
  await page.goto(`${ORIGIN}/overlay/a?mute=1`);
  await expect(page.locator('#sound-chip')).toBeHidden();
});

test('worst-case labels stay inside their panels', async ({ page }) => {
  const server = new FakeOverlayServer(page);
  server.meta = {
    labels: { A: 'xX_TheLongestNameEver_Xx', B: 'ＳｔｒｅａｍｅｒＢ　夜更かし配信' },
    twitch: 'demo',
  };
  await server.install();
  await server.open('/overlay/a?mute=1');
  const round = makeRound('round-labels', 'crossover');
  const startedAtMs = server.now;
  const base = {
    mode: 'crossover',
    roundId: round.roundId,
    startedAtMs,
    deadlineAtMs: startedAtMs + 45_000,
  } as const;
  server.setRound(round);
  await server.publish({
    ...base,
    phase: 'active',
    a: sideState(137, 120),
    b: sideState(88, 120),
  });
  await server.advance(SETTLE_MS);
  await server.shot('20-long-labels-waiting-a');
});

test('a reload just after the seam burst does not replay confetti', async ({ page }) => {
  const server = new FakeOverlayServer(page);
  const round = makeRound('reload-during-reveal', 'crossover');
  server.round = round;
  server.snapshot = server.makeSnapshot({
    mode: 'crossover',
    phase: 'revealing',
    roundId: round.roundId,
    startedAtMs: server.now - 20_000,
    deadlineAtMs: server.now + 25_000,
    revealAtMs: server.now - ZIPPER_MS - 100,
    a: sideState(12, 12),
    b: sideState(12, 12),
  });
  await server.install();
  await server.open('/overlay/a?mute=1&debug=1&reducedMotion=0');
  await server.advance(100);
  expect((await inspect(page)).confetti).toBe(0);
  // Future one-shots still run at their scheduled time; none has been replayed.
  await server.advance(WAVE_MS + 200);
  expect((await inspect(page)).confetti).toBeGreaterThan(0);
});

test('delayMs shifts every scheduled moment; late joiners never replay one-shots', async ({
  page,
  browser,
}) => {
  const round = makeRound('round-delay', 'crossover');
  const server = new FakeOverlayServer(page);
  server.round = round;
  const startedAtMs = PAUSE_AT - 20_000;
  const revealAtMs = PAUSE_AT + 1_000;
  const revealing = {
    mode: 'crossover',
    phase: 'revealing',
    roundId: round.roundId,
    startedAtMs,
    deadlineAtMs: startedAtMs + 45_000,
    revealAtMs,
    a: sideState(10, QUORUM_A),
    b: sideState(12, QUORUM_B),
  } as const;
  server.snapshot = server.makeSnapshot(revealing);
  await server.install();
  await server.open('/overlay/a?mute=1&debug=1&delayMs=2000');
  // Without the delay A's wave would be half done here; with 2 s of delay it has not started.
  await server.advanceTo(revealAtMs + 1_250);
  expect((await inspect(page)).flippedColumns).toBe(0);
  await server.advanceTo(revealAtMs + 2_000 + 1_250);
  const midWave = (await inspect(page)).flippedColumns;
  expect(midWave).toBeGreaterThan(10);
  expect(midWave).toBeLessThan(48);

  // A second overlay that loads long after the reveal shows the final picture immediately,
  // with no confetti burst (one-shots fire only when observed live). Own context: real clock.
  const lateContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const late = await lateContext.newPage();
  const lateServer = new FakeOverlayServer(late, { ws: 'mock', clock: false });
  lateServer.round = round;
  lateServer.now = Date.now();
  lateServer.snapshot = lateServer.makeSnapshot({
    ...revealing,
    phase: 'complete',
    startedAtMs: lateServer.now - 60_000,
    deadlineAtMs: lateServer.now - 15_000,
    revealAtMs: lateServer.now - 8_000,
  });
  await lateServer.install();
  await lateServer.open('/overlay/b?mute=1&debug=1');
  await expect.poll(async () => (await inspect(late)).flippedColumns).toBe(48);
  const state = await inspect(late);
  expect(state.confetti).toBe(0);
  const art = ggArtwork('crossover');
  expect(state.cards).toEqual(
    Array.from({ length: 48 * 27 }, (_, i) => art.pixels[Math.floor(i / 48) * 96 + 48 + (i % 48)]),
  );
  await lateContext.close();
});

test('delayMs waits for the scheduled round start before raising the stand', async ({ page }) => {
  const server = new FakeOverlayServer(page);
  await server.install();
  await server.open('/overlay/a?mute=1&debug=1&delayMs=2000');
  const round = makeRound('round-delayed-start', 'crossover');
  const startedAtMs = server.now;
  server.setRound(round);
  await server.publish({
    mode: 'crossover',
    phase: 'active',
    roundId: round.roundId,
    startedAtMs,
    deadlineAtMs: startedAtMs + 45_000,
    a: sideState(0, 12),
    b: sideState(0, 12),
  });
  await server.advance(1_000);
  expect((await inspect(page)).stand).toBe('down');
  expect(await canvasCoverage(page)).toBeLessThan(100_000); // only the debug readout
  await server.advance(1_800);
  expect((await inspect(page)).stand).toBe('up');
});

test('delayMs also delays the timeout: the countdown reaches 0:00 before SO CLOSE', async ({
  page,
}) => {
  const server = new FakeOverlayServer(page);
  await server.install();
  await server.open('/overlay/a?mute=1&debug=1&delayMs=2000');
  const round = makeRound('round-delay-timeout', 'crossover');
  const startedAtMs = server.now;
  const deadlineAtMs = startedAtMs + 10_000;
  const base = { mode: 'crossover', roundId: round.roundId, startedAtMs, deadlineAtMs } as const;
  server.setRound(round);
  await server.publish({
    ...base,
    phase: 'active',
    a: sideState(10, QUORUM_A),
    b: sideState(9, QUORUM_B),
  });
  await server.advanceTo(deadlineAtMs + 250);
  await server.publish({
    ...base,
    phase: 'timed-out',
    a: sideState(10, QUORUM_A),
    b: sideState(9, QUORUM_B),
  });
  // Stage time is server time − 2 s: the delayed stream still shows the last second ticking.
  await server.advanceTo(deadlineAtMs + 1_000);
  let state = await inspect(page);
  expect(state.stand).toBe('up');
  expect(state.hudAlpha).toBeGreaterThan(0.9);
  expect(state.soCloseAlpha).toBe(0);
  // Once the delayed clock passes the deadline, TIME'S UP / SO CLOSE takes over.
  await server.advanceTo(deadlineAtMs + 2_000 + 400);
  state = await inspect(page);
  expect(state.soCloseAlpha).toBeGreaterThan(0.5);
  expect(state.hudAlpha).toBeLessThan(0.1);
});

test('latencyMs ends the on-stream countdown early so the last visible second still counts', async ({
  page,
}) => {
  const server = new FakeOverlayServer(page);
  await server.install();
  await server.open('/overlay/a?mute=1&debug=1&latencyMs=3000');
  const round = makeRound('round-latency', 'crossover');
  const startedAtMs = server.now;
  const deadlineAtMs = startedAtMs + 20_000;
  server.setRound(round);
  await server.publish({
    mode: 'crossover',
    phase: 'active',
    roundId: round.roundId,
    startedAtMs,
    deadlineAtMs,
    a: sideState(3, QUORUM_A),
    b: sideState(2, QUORUM_B),
  });
  await server.advanceTo(deadlineAtMs - 5_500);
  expect((await inspect(page)).hudSeconds).toBe(3); // 5.5 s left on the server, 3 shown
  // The stream shows 0:00 while the server still credits chat for up to 3 more seconds.
  await server.advanceTo(deadlineAtMs - 2_500);
  expect(await inspect(page)).toMatchObject({ stand: 'up', hudSeconds: 0 });
});

test('reducedMotion=0 overrides an OS reduced-motion preference', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const server = new FakeOverlayServer(page);
  await server.install();
  await server.open('/overlay/a?mute=1&debug=1&reducedMotion=0');
  expect(
    await page.evaluate(
      () =>
        (globalThis as unknown as { matchMedia(query: string): { matches: boolean } }).matchMedia(
          '(prefers-reduced-motion: reduce)',
        ).matches,
    ),
  ).toBe(true);
  const round = makeRound('round-full-motion', 'crossover');
  server.setRound(round);
  await server.publish({
    mode: 'crossover',
    phase: 'active',
    roundId: round.roundId,
    startedAtMs: server.now,
    deadlineAtMs: server.now + 45_000,
    a: sideState(2, QUORUM_A),
    b: sideState(1, QUORUM_B),
  });
  await server.advance(50);
  // Full motion despite the OS setting: the stand animates up instead of snapping.
  expect((await inspect(page)).stand).toBe('rising');
});

test('a stale active round past its deadline drops instead of freezing on 0:00', async ({
  page,
}) => {
  const server = new FakeOverlayServer(page);
  await server.install();
  await server.open('/overlay/b?mute=1&debug=1');
  const round = makeRound('round-stale', 'crossover');
  const startedAtMs = server.now;
  const deadlineAtMs = startedAtMs + 10_000;
  server.setRound(round);
  await server.publish({
    mode: 'crossover',
    phase: 'active',
    roundId: round.roundId,
    startedAtMs,
    deadlineAtMs,
    a: sideState(4, QUORUM_A),
    b: sideState(3, QUORUM_B),
  });
  await server.advance(SETTLE_MS);
  expect(await canvasCoverage(page)).toBeGreaterThan(1_500_000);
  // The server never publishes timed-out (frozen process, half-open socket through a tunnel).
  await server.advanceTo(deadlineAtMs + 5_000);
  expect((await inspect(page)).stand).toBe('up');
  await server.advanceTo(deadlineAtMs + 9_500);
  expect(await inspect(page)).toMatchObject({ stand: 'down', roundId: round.roundId });
  expect(await canvasCoverage(page)).toBeLessThan(200_000); // debug readout only
});

test('losing the server hides the stand after a while and restores it on reconnect', async ({
  page,
}) => {
  const server = new FakeOverlayServer(page);
  await server.install();
  await server.open(`/overlay/b?mute=1&debug=1&room=${ROOM}`);
  const round = makeRound('round-lost', 'crossover');
  const startedAtMs = server.now;
  server.setRound(round);
  await server.publish({
    mode: 'crossover',
    phase: 'active',
    roundId: round.roundId,
    startedAtMs,
    deadlineAtMs: startedAtMs + 120_000,
    a: sideState(4, QUORUM_A),
    b: sideState(3, QUORUM_B),
  });
  await server.advance(SETTLE_MS);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-transport', 'ws');
  const transportAfterSecond = async () => {
    await server.advance(1_000);
    return html.getAttribute('data-transport');
  };

  await server.goOffline();
  await expect(html).toHaveAttribute('data-transport', 'poll');
  // Short outages keep the round on screen: local restarts reconnect within seconds.
  await server.advance(5_000);
  expect((await inspect(page)).stand).toBe('up');
  // Socket down and every poll failing for 15 s: report lost and drop the stand.
  await expect.poll(transportAfterSecond, { timeout: 30_000 }).toBe('lost');
  await server.advance(1_000);
  expect(await inspect(page)).toMatchObject({
    stand: 'down',
    linkLost: true,
    roundId: round.roundId,
  });

  // Back online: a poll or the next socket brings the same round back without a replay.
  server.offline = false;
  await expect.poll(transportAfterSecond, { timeout: 30_000 }).toMatch(/^(ws|poll)$/);
  await server.advance(1_000);
  expect(await inspect(page)).toMatchObject({
    stand: 'up',
    linkLost: false,
    roundId: round.roundId,
    confetti: 0,
  });
});

interface FrameStats {
  readonly frames: number;
  readonly meanFps: number;
  readonly p95Ms: number;
}

/** Samples requestAnimationFrame intervals in the page for `durationMs` (real clock). */
async function sampleFrames(page: Page, durationMs: number): Promise<FrameStats> {
  const deltas = await page.evaluate(
    (duration) =>
      new Promise<number[]>((resolve) => {
        const raf = (
          globalThis as unknown as { requestAnimationFrame(cb: (t: number) => void): number }
        ).requestAnimationFrame;
        const collected: number[] = [];
        let last = -1;
        let start = -1;
        const tick = (t: number) => {
          if (start < 0) start = t;
          if (last >= 0) collected.push(t - last);
          last = t;
          if (t - start < duration) raf(tick);
          else resolve(collected);
        };
        raf(tick);
      }),
    durationMs,
  );
  deltas.sort((x, y) => x - y);
  const mean = deltas.reduce((sum, value) => sum + value, 0) / Math.max(1, deltas.length);
  return {
    frames: deltas.length,
    meanFps: mean > 0 ? 1000 / mean : 0,
    p95Ms: deltas[Math.floor(deltas.length * 0.95)] ?? 0,
  };
}

function describeStats(stats: FrameStats): string {
  return `${stats.meanFps.toFixed(1)} fps (p95 ${stats.p95Ms.toFixed(1)} ms, ${stats.frames} frames)`;
}

test('frame pacing: idle, static stand, flips + reveal (informational, real clock)', async ({
  page,
}, testInfo) => {
  const server = new FakeOverlayServer(page, { ws: 'mock', clock: false });
  await server.install();
  await server.open('/overlay/a?mute=1&debug=1');
  const idle = await sampleFrames(page, 1_500);

  const round = makeRound('round-perf', 'crossover');
  const startedAtMs = Date.now();
  const base = {
    mode: 'crossover',
    roundId: round.roundId,
    startedAtMs,
    deadlineAtMs: startedAtMs + 45_000,
  } as const;
  server.setRound(round);
  server.now = Date.now();
  await server.publish({
    ...base,
    phase: 'active',
    a: sideState(5, QUORUM_A),
    b: sideState(5, QUORUM_B),
  });
  await page.waitForTimeout(2_500);
  const statik = await sampleFrames(page, 2_000);

  // One new person every 300 ms (continuous ripples), then the full reveal with confetti.
  const busy = sampleFrames(page, 6_000);
  for (let person = 6; person <= QUORUM_A; person += 1) {
    server.now = Date.now();
    await server.publish({
      ...base,
      phase: 'active',
      a: sideState(person, QUORUM_A),
      b: sideState(person, QUORUM_B),
    });
    await page.waitForTimeout(300);
  }
  server.now = Date.now();
  await server.publish({
    ...base,
    phase: 'revealing',
    revealAtMs: server.now + 200,
    a: sideState(QUORUM_A, QUORUM_A),
    b: sideState(QUORUM_B, QUORUM_B),
  });
  let jsAverage = 0;
  let jsWorst = 0;
  for (let i = 0; i < 8; i += 1) {
    await page.waitForTimeout(500);
    const cost = await page.evaluate(() =>
      (
        globalThis as unknown as {
          crossoverOverlay: { frameCost(): { averageMs: number; worstMs: number } };
        }
      ).crossoverOverlay.frameCost(),
    );
    jsAverage = Math.max(jsAverage, cost.averageMs);
    jsWorst = Math.max(jsWorst, cost.worstMs);
  }
  const active = await busy;
  expect(active.frames).toBeGreaterThan(30);
  const summary =
    `idle ${describeStats(idle)} | static stand ${describeStats(statik)} | ` +
    `flips+reveal ${describeStats(active)} | js update+draw ≤ ${jsAverage.toFixed(2)} ms avg, ` +
    `${jsWorst.toFixed(1)} ms worst frame`;
  // Headless Chromium is not OBS CEF: this is a regression signal, not a 60 fps claim.
  testInfo.annotations.push({ type: 'frame-pacing', description: summary });
  console.log(`[overlay frame pacing] ${summary}`);
});

test('seam artwork comparison: isolated halves and joined presets (SIMULATED)', async ({
  page,
}) => {
  await mkdir(SHOTS_DIR, { recursive: true });
  for (const id of ['heart', 'face']) {
    const art = presetArtwork(id, 'crossover', { A: 'A', B: 'B' });
    await page.setContent(
      '<body style="margin:0;background:#101820"><canvas id="comparison" width="1536" height="1024"></canvas></body>',
    );
    await page.locator('canvas').evaluate(
      (node, { art, palette }) => {
        const ctx = (
          node as unknown as {
            getContext(type: string): {
              fillStyle: string;
              strokeStyle: string;
              font: string;
              fillRect(x: number, y: number, w: number, h: number): void;
              fillText(text: string, x: number, y: number): void;
              setLineDash(d: number[]): void;
              beginPath(): void;
              moveTo(x: number, y: number): void;
              lineTo(x: number, y: number): void;
              stroke(): void;
            };
          }
        ).getContext('2d');
        ctx.fillStyle = '#101820';
        ctx.fillRect(0, 0, 1536, 1024);
        ctx.fillStyle = '#f5f5f0';
        ctx.font = 'bold 24px sans-serif';
        ctx.fillText('SIMULATED ARTWORK · A ALONE', 24, 40);
        ctx.fillText('B ALONE', 800, 40);
        ctx.fillText('JOINED · SEAM AT 47 | 48', 24, 550);
        art.pixels.forEach((color, i) => {
          const x = i % art.cols,
            y = Math.floor(i / art.cols);
          ctx.fillStyle = palette[color]!;
          ctx.fillRect(x * 16 + 1, 580 + y * 16 + 1, 14, 14);
          ctx.fillRect(x * 16 + 1, 64 + y * 16 + 1, 14, 14);
        });
        ctx.strokeStyle = '#f5f5f0';
        ctx.setLineDash([4, 8]);
        ctx.beginPath();
        ctx.moveTo(768, 580);
        ctx.lineTo(768, 1012);
        ctx.stroke();
      },
      { art, palette: [...PALETTE] },
    );
    await page
      .locator('canvas')
      .screenshot({ path: path.join(SHOTS_DIR, `seam-${id}-comparison.png`) });
    // Separate crops are captured from the page, so the object cannot be inferred from its partner.
    await page.screenshot({
      path: path.join(SHOTS_DIR, `seam-${id}-a.png`),
      clip: { x: 0, y: 64, width: 768, height: 432 },
    });
    await page.screenshot({
      path: path.join(SHOTS_DIR, `seam-${id}-b.png`),
      clip: { x: 768, y: 64, width: 768, height: 432 },
    });
    await page.screenshot({
      path: path.join(SHOTS_DIR, `seam-${id}-joined.png`),
      clip: { x: 0, y: 580, width: 1536, height: 432 },
    });
  }
});

for (const side of ['A', 'B'] as const) {
  test(`CTA and lagging-side urgency on ${side}, including 720p (SIMULATED)`, async ({ page }) => {
    const server = new FakeOverlayServer(page);
    await server.install();
    await server.open(`/overlay/${side.toLowerCase()}?mute=1&debug=1`);
    const round = makeRound('round-cta', 'crossover');
    const active = {
      mode: 'crossover',
      phase: 'active',
      roundId: round.roundId,
      startedAtMs: server.now,
      deadlineAtMs: server.now + 45_000,
    } as const;
    server.setRound(round);
    await server.publish({ ...active, a: sideState(0, 10), b: sideState(0, 10) });
    await server.advance(800);
    expect((await inspect(page)).introAlpha).toBeGreaterThan(0.99);
    expect((await inspect(page)).ctaChipAlpha).toBe(0);
    await server.shot(`cta-intro-${side}`);
    await page.setViewportSize({ width: 1280, height: 720 });
    await server.shot(`cta-intro-${side}-720p`);
    await server.advance(2_100);
    expect((await inspect(page)).introAlpha).toBe(0);
    expect((await inspect(page)).ctaChipAlpha).toBeGreaterThan(0.99);
    await server.shot(`cta-chip-${side}-720p`);
    await server.publish({
      ...active,
      a: sideState(side === 'A' ? 9 : 10, 10),
      b: sideState(side === 'B' ? 9 : 10, 10),
    });
    await server.advance(800);
    expect((await inspect(page)).lagAlpha).toBeGreaterThan(0.9);
    await server.shot(`lagging-${side}-720p`);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await server.shot(`lagging-${side}`);
    await server.publish({
      ...active,
      a: sideState(side === 'A' ? 10 : 9, 10),
      b: sideState(side === 'B' ? 10 : 9, 10),
    });
    await server.advance(800);
    expect((await inspect(page)).waitingRemaining).toBe(1);
    await server.publish({
      ...active,
      phase: 'revealing',
      revealAtMs: server.now + 1_000,
      a: sideState(10, 10),
      b: sideState(10, 10),
    });
    await server.advance(900);
    expect((await inspect(page)).ctaChipAlpha).toBe(0);
    expect((await inspect(page)).lagAlpha).toBeLessThan(0.1);
  });
}

test('single CTA uses one label and ready sides lose the chip; reduced urgency is static', async ({
  page,
}) => {
  const server = new FakeOverlayServer(page);
  await server.install();
  await server.open('/overlay/a?mute=1&debug=1&reducedMotion=1');
  const round = makeRound('round-single-cta', 'single');
  server.setRound(round);
  const base = {
    mode: 'single',
    phase: 'active',
    roundId: round.roundId,
    startedAtMs: server.now,
    deadlineAtMs: server.now + 45_000,
  } as const;
  await server.publish({ ...base, a: sideState(0, 10), b: sideState(0, 0) });
  await server.advance(100);
  expect((await inspect(page)).introScale).toBe(1);
  await server.shot('cta-single-reduced');
  await server.advance(3_000);
  expect((await inspect(page)).ctaChipAlpha).toBe(1);
  await server.publish({ ...base, a: sideState(10, 10), b: sideState(0, 0) });
  await server.advance(100);
  expect((await inspect(page)).ctaChipAlpha).toBe(0);
  expect((await inspect(page)).lagAlpha).toBe(0);
  expect((await inspect(page)).lagScale).toBe(1);
});

async function pixelAt(page: Page, x: number, y: number): Promise<number[]> {
  return page
    .locator('#stage')
    .evaluate(
      (node, [x, y]) =>
        Array.from(
          (node as unknown as ProbeCanvas).getContext('2d')!.getImageData(x, y, 1, 1).data,
        ),
      [x, y] as const,
    );
}

for (const side of ['A', 'B'] as const) {
  test(`UNITE shows both picture halves in the central band on ${side} (SIMULATED)`, async ({
    page,
  }) => {
    const server = new FakeOverlayServer(page);
    await server.install();
    await server.open(`/overlay/${side.toLowerCase()}?mute=1&debug=1`);
    const art = presetArtwork('heart', 'crossover', { A: 'A', B: 'B' });
    const round = makeRound('round-unite', 'crossover', art);
    const base = {
      mode: 'crossover',
      roundId: round.roundId,
      startedAtMs: server.now,
      deadlineAtMs: server.now + 45_000,
      a: sideState(10, 10),
      b: sideState(10, 10),
    } as const;
    server.setRound(round);
    const revealAtMs = server.now + 1_000;
    await server.publish({ ...base, phase: 'revealing', revealAtMs });
    await server.advanceTo(revealAtMs + 3_400);
    expect((await inspect(page)).uniteSince).toBeLessThan(0);
    await server.advanceTo(revealAtMs + 4_700);
    // Probe both halves, including the partner's previously unavailable half.
    for (const col of [40, 56]) {
      const row = 13;
      expect(await pixelAt(page, col * 20 + 10, 270 + row * 20 + 10)).toEqual([
        ...rgb(art.pixels[row * 96 + col]!),
        255,
      ]);
    }
    expect((await pixelAt(page, 1000, 100))[3]).toBe(0);
    expect((await pixelAt(page, 1900, 1060))[3]).toBe(0);
    await server.advanceTo(revealAtMs + 6_000);
    await server.publish({ ...base, phase: 'complete', revealAtMs });
    await server.shot(`unite-${side}`);
    await page.setViewportSize({ width: 1280, height: 720 });
    await server.shot(`unite-${side}-720p`);
  });
}

test('UNITE opt-out preserves full-size cards', async ({ page }) => {
  const server = new FakeOverlayServer(page);
  await server.install();
  await server.open('/overlay/a?mute=1&debug=1&unite=0');
  const round = makeRound('round-no-unite', 'crossover');
  server.setRound(round);
  const revealAtMs = server.now + 1_000;
  await server.publish({
    mode: 'crossover',
    phase: 'revealing',
    roundId: round.roundId,
    startedAtMs: server.now,
    deadlineAtMs: server.now + 45_000,
    revealAtMs,
    a: sideState(10, 10),
    b: sideState(10, 10),
  });
  await server.advanceTo(revealAtMs + 6_000);
  expect((await inspect(page)).uniteSince).toBeLessThan(0);
  expect(await canvasCoverage(page)).toBeGreaterThan(1_500_000);
});

for (const reduced of [true, false]) {
  test(`UNITE late load never replays its burst, reduced=${reduced}`, async ({ page }) => {
    const server = new FakeOverlayServer(page);
    const round = makeRound('round-unite-late', 'crossover');
    server.round = round;
    server.snapshot = server.makeSnapshot({
      mode: 'crossover',
      phase: 'complete',
      roundId: round.roundId,
      startedAtMs: PAUSE_AT - 45_000,
      deadlineAtMs: PAUSE_AT + 15_000,
      revealAtMs: PAUSE_AT - 4_500,
      a: sideState(10, 10),
      b: sideState(10, 10),
    });
    await server.install();
    await server.open(`/overlay/b?mute=1&debug=1&reducedMotion=${reduced ? 1 : 0}`);
    await server.advance(100);
    expect((await inspect(page)).confetti).toBe(0);
    expect((await pixelAt(page, 1000, 100))[3]).toBe(0);
    expect((await pixelAt(page, 1410, 540))[3]).toBe(255);
    await server.shot(`unite-late-reduced-${reduced}`);
  });
}

for (const variant of [
  { mode: 'crossover', hold: false, reduced: false },
  { mode: 'crossover', hold: true, reduced: false },
  { mode: 'crossover', hold: false, reduced: true },
  { mode: 'single', hold: false, reduced: false },
] as const) {
  test(`auto-retire ${variant.mode}, hold=${variant.hold}, reduced=${variant.reduced} (SIMULATED)`, async ({
    page,
  }) => {
    const server = new FakeOverlayServer(page);
    await server.install();
    await server.open(
      `/overlay/a?mute=1&hold=${variant.hold ? 1 : 0}&reducedMotion=${variant.reduced ? 1 : 0}`,
    );
    const round = makeRound('round-retire', variant.mode);
    const revealAtMs = server.now + 1_000;
    const base = {
      mode: variant.mode,
      roundId: round.roundId,
      startedAtMs: server.now,
      deadlineAtMs: server.now + 45_000,
      revealAtMs,
      a: sideState(10, 10),
      b: sideState(variant.mode === 'single' ? 0 : 10, variant.mode === 'single' ? 0 : 10),
    } as const;
    server.setRound(round);
    await server.publish({ ...base, phase: 'revealing' });
    await server.advance(800);
    const jumpTo = async (at: number) => {
      await page.clock.fastForward(at - server.now);
      server.now = at;
    };
    await jumpTo(revealAtMs + 6_000);
    await server.publish({ ...base, phase: 'complete' });
    await server.advance(100);
    expect(await canvasCoverage(page)).toBeGreaterThan(800_000);
    const retireAt = revealAtMs + (variant.mode === 'crossover' ? 18_400 : 17_700);
    await jumpTo(retireAt - 50);
    expect(await canvasCoverage(page)).toBeGreaterThan(800_000);
    await server.advance(850);
    if (variant.hold) expect(await canvasCoverage(page)).toBeGreaterThan(800_000);
    else expect(await canvasCoverage(page)).toBe(0);
    await expect(page.locator('html')).toHaveAttribute('data-phase', 'complete');
    await server.shot(
      `auto-retire-${variant.mode}-hold-${variant.hold}-reduced-${variant.reduced}`,
    );
    if (!variant.hold) {
      // Repeated complete snapshots cannot raise a retired stand again.
      await server.publish({ ...base, phase: 'complete' });
      await server.advance(1_000);
      expect(await canvasCoverage(page)).toBe(0);
    }
  });
}

test('loading an already retired round keeps the overlay transparent (SIMULATED)', async ({
  page,
}) => {
  const server = new FakeOverlayServer(page);
  const round = makeRound('round-retired-restore', 'crossover');
  server.round = round;
  server.snapshot = server.makeSnapshot({
    mode: 'crossover',
    phase: 'complete',
    roundId: round.roundId,
    startedAtMs: PAUSE_AT - 60_000,
    deadlineAtMs: PAUSE_AT - 15_000,
    revealAtMs: PAUSE_AT - 25_000,
    a: sideState(10, 10),
    b: sideState(10, 10),
  });
  await server.install();
  await server.open('/overlay/a?mute=1');
  await server.advance(800);
  expect(await canvasCoverage(page)).toBe(0);
  await expect(page.locator('html')).toHaveAttribute('data-phase', 'complete');
  await server.shot('auto-retired-late-load');
});

for (const variant of [
  { crossovers: 0, query: '', px: 76 },
  { crossovers: 1, query: '&cutout=1440,700,440,340', px: 76 },
  { crossovers: 3000, query: '&fit=seam&scale=0.4', px: 92 },
] as const) {
  test(`completion copy fits with ${variant.crossovers} crossovers ${variant.query}`, async ({
    page,
  }) => {
    await page.addInitScript(`
      window.__completionText = [];
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
        if (/CROSSED OVER|NEITHER CHAT|2 STREAMS/.test(String(text))) {
          window.__completionText.push({ text: String(text), font: this.font, align: this.textAlign,
            width: this.measureText(text).width, x, canvasWidth: this.canvas.width });
        }
        return Reflect.apply(original, this, [text, x, y, ...rest]);
      };
    `);
    const server = new FakeOverlayServer(page);
    await server.install();
    await server.open(`/overlay/a?mute=1&debug=1&reducedMotion=1${variant.query}`);
    const art = presetArtwork('hype', 'crossover', { A: 'A', B: 'B' });
    const round = makeRound('polish-copy', 'crossover', art);
    server.setRound(round);
    const revealAtMs = server.now + 1000;
    await server.publish({
      mode: 'crossover',
      phase: 'revealing',
      roundId: round.roundId,
      startedAtMs: server.now,
      deadlineAtMs: server.now + 45_000,
      revealAtMs,
      a: sideState(3000, 3000),
      b: sideState(3000, 3000),
      crossovers: variant.crossovers,
    });
    await server.advanceTo(revealAtMs + 6_000);
    const records = await page.evaluate(
      () =>
        (
          globalThis as unknown as {
            __completionText: {
              text: string;
              font: string;
              align: string;
              width: number;
              x: number;
              canvasWidth: number;
            }[];
          }
        ).__completionText,
    );
    const expected =
      variant.crossovers > 0
        ? `${variant.crossovers} CROSSED OVER TO HELP THE OTHER SIDE`
        : 'NEITHER CHAT COULD DO IT ALONE';
    const sub = records.find((r) => r.text === expected);
    expect(sub).toBeDefined();
    expect(sub!.align).toBe('center');
    expect(sub!.x - sub!.width / 2).toBeGreaterThanOrEqual(0);
    expect(sub!.x + sub!.width / 2).toBeLessThanOrEqual(sub!.canvasWidth);
    expect(
      records.some((r) => r.text.includes('2 STREAMS') && r.font.includes(`${variant.px}px`)),
    ).toBe(true);
    expect(records.some((r) => /ONE PICTURE.*TWO STREAMS/.test(r.text))).toBe(false);
    if (variant.query === '' || variant.query.includes('cutout=')) {
      // H's upper-left stem must stay visible; the old in-band SIMULATED badge covered it.
      expect(await pixelAt(page, 270, 320)).toEqual([...rgb(1), 255]);
    }
    await server.shot(`polish-copy-${variant.crossovers}`);
    await page.setViewportSize({ width: 1280, height: 720 });
    await server.shot(`polish-copy-${variant.crossovers}-720p`);
  });
}

test('early showcase refinements conceal the letters in isolated crops (SIMULATED)', async ({
  page,
}) => {
  await mkdir(SHOTS_DIR, { recursive: true });
  for (const [preset, mode] of [
    ['hype', 'crossover'],
    ['gg', 'crossover'],
    ['gg', 'single'],
  ] as const) {
    const art = presetArtwork(preset, mode, { A: 'A', B: 'B' });
    const round = makeRound('concealment', mode, art);
    for (const side of mode === 'crossover' ? (['A', 'B'] as const) : (['A'] as const)) {
      const plan = planOf(round, side);
      for (const steps of [0, 1, 3, plan.steps.length]) {
        const colors = replay(plan, steps);
        await page.setContent(
          '<body style="margin:0;background:#101820"><canvas width="768" height="432"></canvas></body>',
        );
        await page.locator('canvas').evaluate(
          (node, { colors, palette }) => {
            const ctx = (
              node as unknown as {
                getContext(type: string): {
                  fillStyle: string;
                  fillRect(x: number, y: number, w: number, h: number): void;
                };
              }
            ).getContext('2d');
            colors.forEach((color, i) => {
              ctx.fillStyle = palette[color]!;
              ctx.fillRect((i % 48) * 16 + 1, Math.floor(i / 48) * 16 + 1, 14, 14);
            });
          },
          { colors, palette: [...PALETTE] },
        );
        await page.locator('canvas').screenshot({
          path: path.join(
            SHOTS_DIR,
            `polish-conceal-${preset}-${mode}-${side}-${steps === plan.steps.length ? 'final' : steps}.png`,
          ),
        });
        if (steps <= 3) expect(colors).not.toEqual(replay(plan, plan.steps.length));
      }
    }
  }
});
