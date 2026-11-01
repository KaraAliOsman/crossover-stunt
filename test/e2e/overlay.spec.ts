import { presetArtwork } from '../../public/control/artwork.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { GRID_ROWS, PALETTE_RGB, SIDE_COLS, fullCols } from '../../src/engine/artwork.js';
import { stepsToShow } from '../../src/engine/quadtree.js';
import type {
  Artwork,
  RefinementPlan,
  Side,
  Snapshot,
  StuntPhase,
} from '../../src/engine/types.js';
import type {
  CallRequest,
  DemoChatRequest,
  RoundPayload,
  ShowcaseRequest,
  SnapshotResponse,
} from '../../src/shared/protocol.js';

// Real end-to-end checks against `pnpm demo` (webServer in playwright.config.ts, project `demo`):
// the HTTP API, the engine, the WS hub and the overlay pages all run for real. Every crowd here is
// a SIMULATED virtual crowd from /dev/chat or /dev/showcase; nothing reaches Twitch. Captures go
// to test-results/e2e/ (ignored).

const SHOTS_DIR = fileURLToPath(new URL('../../test-results/e2e/', import.meta.url));
/** 1296 card faces of 36×36 px ≈ 1.68 M opaque pixels once the stand is up. */
const STAND_UP_PIXELS = 1_500_000;
/**
 * Rows whose edge cards are never covered by the HUD pill, minimap, SIMULATED badge, banners or
 * caption, so a center pixel there is exactly the card's palette color once it has settled.
 */
const CLEAR_ROWS = [8, 9, 10, 11, 12, 13, 14] as const;
/** Flip stagger + ripple + flip (≤ 1.6 s) plus slack for a busy CI machine. */
const SETTLE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------------------------
// Artwork and plan replay (reference implementation for the seam assertions)
// ---------------------------------------------------------------------------------------------

/**
 * Deterministic "sun over the seam" picture, 96×27: neither half shows the whole sun, so the
 * seam columns 47|48 carry real detail on most rows.
 */
function sunArtwork(): Artwork {
  const cols = fullCols('crossover');
  const rows = GRID_ROWS;
  const pixels: number[] = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const sunDistance = Math.hypot(x + 0.5 - 48, y + 0.5 - 13);
      const hill = 19 + Math.round(2.5 * Math.sin(x / 6.5) + 1.5 * Math.sin(x / 2.9));
      const cloud =
        ((x - 18) / 7) ** 2 + ((y - 4) / 2) ** 2 <= 1 ||
        ((x - 77) / 8) ** 2 + ((y - 5) / 2.2) ** 2 <= 1;
      let color = y < 8 ? 6 : 3; // blue sky above, light sky lower
      if (cloud) color = 1;
      if (sunDistance <= 9) color = 7; // vermillion corona
      if (sunDistance <= 7.6) color = 5; // yellow sun
      if (y >= hill) color = 4; // green hills
      if (y >= 24) color = 0; // ink ground
      if (y === 25 && x % 6 < 3) color = 2; // orange runway lights
      pixels.push(color);
    }
  }
  return { cols, rows, pixels };
}

/** Region-local palette indices after `count` steps: the leaf covering each card. */
function leafColors(plan: RefinementPlan, count: number): number[] {
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

function planOf(round: RoundPayload, side: Side): RefinementPlan {
  const plan = round.plans[side];
  if (plan === undefined) throw new Error(`round ${round.roundId} has no plan for side ${side}`);
  return plan;
}

function rgba(color: number): number[] {
  const value = PALETTE_RGB[color];
  if (value === undefined) throw new RangeError(`palette index ${color}`);
  return [...value, 255];
}

// ---------------------------------------------------------------------------------------------
// Server API helpers
// ---------------------------------------------------------------------------------------------

async function postJson(api: APIRequestContext, route: string, body: unknown): Promise<unknown> {
  const response = await api.post(route, { data: body });
  const payload: unknown = await response.json();
  expect(response.status(), `${route} → ${JSON.stringify(payload)}`).toBeLessThan(300);
  return payload;
}

const reset = (api: APIRequestContext) => postJson(api, '/api/reset', {});

const call = (api: APIRequestContext, request: CallRequest) => postJson(api, '/api/call', request);

const showcase = (api: APIRequestContext, scenario: ShowcaseRequest['scenario']) =>
  postJson(api, '/dev/showcase', { scenario } satisfies ShowcaseRequest);

const chat = (api: APIRequestContext, request: DemoChatRequest) =>
  postJson(api, '/dev/chat', request);

/** Polling route with no `round` param, so the current RoundPayload is always included. */
async function serverState(
  api: APIRequestContext,
): Promise<{ snapshot: Snapshot; round: RoundPayload | null }> {
  const response = await api.get('/api/snapshot');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as SnapshotResponse;
  expect(body.protocol).toBe(2);
  return { snapshot: body.snapshot, round: body.round ?? null };
}

async function waitForPhase(
  api: APIRequestContext,
  phase: StuntPhase,
  timeout = 40_000,
): Promise<Snapshot> {
  await expect
    .poll(async () => (await serverState(api)).snapshot.phase, { timeout, intervals: [200] })
    .toBe(phase);
  return (await serverState(api)).snapshot;
}

// ---------------------------------------------------------------------------------------------
// Overlay page helpers
// ---------------------------------------------------------------------------------------------

interface ProbeCanvas {
  readonly width: number;
  readonly height: number;
  getContext(type: '2d'): {
    getImageData(x: number, y: number, w: number, h: number): { readonly data: ArrayLike<number> };
  } | null;
}

interface OverlayInspect {
  readonly stand: string;
  readonly roundId: string | null;
  readonly stepsShown: number;
  readonly flippedColumns: number;
  readonly cards: number[];
  readonly confetti: number;
}

type Overlays = Readonly<Record<Side, Page>>;

/** Opens /overlay/a and /overlay/b (muted) and waits for their WebSocket connections. */
async function openOverlays(context: BrowserContext, query = ''): Promise<Overlays> {
  const pages = {} as Record<Side, Page>;
  for (const side of ['A', 'B'] as const) {
    const page = await context.newPage();
    await page.goto(`/overlay/${side.toLowerCase()}?mute=1${query}`);
    await expect(page.locator('html')).toHaveAttribute('data-transport', 'ws');
    pages[side] = page;
  }
  return pages;
}

/** Waits until the overlay applied the server's current revision (pushes are ≤ 10 Hz). */
async function waitForRevision(api: APIRequestContext, overlays: readonly Page[]): Promise<void> {
  const { snapshot } = await serverState(api);
  for (const page of overlays) {
    await expect(page.locator('html')).toHaveAttribute('data-revision', String(snapshot.revision));
  }
}

async function canvasCoverage(page: Page): Promise<number> {
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

/** RGBA at the center of a card face (below the top sheen, above the bottom shade). */
async function cardPixel(page: Page, column: number, row: number): Promise<number[]> {
  return page.locator('#stage').evaluate(
    (node, [x, y]) => {
      const context = (node as unknown as ProbeCanvas).getContext('2d');
      if (!context) return [];
      return Array.from(context.getImageData(x, y, 1, 1).data);
    },
    [column * 40 + 20, row * 40 + 22] as const,
  );
}

async function inspect(page: Page): Promise<OverlayInspect> {
  return page.evaluate(() =>
    (
      globalThis as unknown as { crossoverOverlay: { inspect(): OverlayInspect } }
    ).crossoverOverlay.inspect(),
  );
}

/**
 * Seam check by pixels: the cards on full-image columns 47 (A's right edge) and 48 (B's left
 * edge) must show exactly the expected palette colors on every clear row.
 */
async function expectSeamPixels(
  overlays: Overlays,
  expected: Readonly<Record<Side, readonly number[]>>,
): Promise<void> {
  for (const side of ['A', 'B'] as const) {
    const column = side === 'A' ? SIDE_COLS - 1 : 0;
    const wanted = CLEAR_ROWS.map((row) => rgba(expected[side][row * SIDE_COLS + column] ?? -1));
    await expect
      .poll(
        async () => {
          const seen: number[][] = [];
          for (const row of CLEAR_ROWS) seen.push(await cardPixel(overlays[side], column, row));
          return seen;
        },
        { timeout: SETTLE_TIMEOUT_MS, message: `seam column on side ${side}` },
      )
      .toEqual(wanted);
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

/** Sleeps until a server timestamp (same machine, so the wall clocks agree). */
async function sleepUntil(page: Page, serverMs: number): Promise<void> {
  const wait = serverMs - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
}

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test.afterAll(async ({ request }) => {
  await reset(request);
});

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

test('showcase crossover: both overlays draw cards, wait, then reveal jointly (SIMULATED)', async ({
  context,
  request,
}) => {
  const overlays = await openOverlays(context, '&unite=0');
  for (const page of Object.values(overlays)) expect(await canvasCoverage(page)).toBe(0);

  const { roundId } = (await showcase(request, 'crossover')) as { roundId: string };
  for (const page of Object.values(overlays)) {
    await expect(page.locator('html')).toHaveAttribute('data-round', roundId);
    await expect(page.locator('html')).toHaveAttribute('data-phase', 'active');
  }

  // Partial refinement: A gains a person every 900 ms, B starts at 6 s.
  await overlays.A.waitForTimeout(5_000);
  for (const [side, page] of Object.entries(overlays)) {
    expect(await canvasCoverage(page)).toBeGreaterThan(STAND_UP_PIXELS);
    await shot(page, `showcase-1-active-${side.toLowerCase()}`);
  }

  // Uneven progress: A is ready, B is not → WAITING FOR on A, THEIR SIDE progress on B.
  await expect
    .poll(
      async () => {
        const { snapshot } = await serverState(request);
        return snapshot.sides.A.ready && !snapshot.sides.B.ready;
      },
      { timeout: 20_000, intervals: [200] },
    )
    .toBe(true);
  await overlays.A.waitForTimeout(1_500);
  for (const [side, page] of Object.entries(overlays)) {
    await shot(page, `showcase-2-waiting-${side.toLowerCase()}`);
  }

  const revealing = await waitForPhase(request, 'revealing');
  expect(revealing.revealAtMs).not.toBeNull();
  const revealAtMs = revealing.revealAtMs ?? 0;
  expect(revealing.crossovers).toBe(2);
  // Zipper (600 ms) then the wave crosses A during +600…+1775 ms and B during +1800…+2975 ms.
  await sleepUntil(overlays.A, revealAtMs + 1_700);
  for (const [side, page] of Object.entries(overlays)) {
    await shot(page, `showcase-3-wave-${side.toLowerCase()}`);
  }

  await waitForPhase(request, 'complete');
  const { round } = await serverState(request);
  expect(round?.roundId).toBe(roundId);
  if (round === null) throw new Error('round missing after reveal');
  // After the reveal every card shows the final leaf: the exact artwork of that half.
  await expectSeamPixels(overlays, {
    A: leafColors(planOf(round, 'A'), planOf(round, 'A').steps.length),
    B: leafColors(planOf(round, 'B'), planOf(round, 'B').steps.length),
  });
  for (const [side, page] of Object.entries(overlays)) {
    expect(await canvasCoverage(page)).toBeGreaterThan(STAND_UP_PIXELS);
    await shot(page, `showcase-4-complete-${side.toLowerCase()}`);
  }
});

test('showcase so-close: B stalls, the round times out without chat and SO CLOSE fades (SIMULATED)', async ({
  context,
  request,
}) => {
  const overlays = await openOverlays(context);
  await showcase(request, 'so-close');
  const timedOut = await waitForPhase(request, 'timed-out', 30_000);
  expect(timedOut.sides.A.ready).toBe(true);
  expect(timedOut.sides.B).toMatchObject({ participants: 9, quorum: 12, ready: false });
  for (const page of Object.values(overlays)) {
    await expect(page.locator('html')).toHaveAttribute('data-phase', 'timed-out');
  }
  await overlays.A.waitForTimeout(1_000);
  for (const [side, page] of Object.entries(overlays)) {
    // Cards keep their pre-reveal detail under the SO CLOSE banner…
    expect(await canvasCoverage(page)).toBeGreaterThan(STAND_UP_PIXELS);
    await shot(page, `so-close-${side.toLowerCase()}`);
  }
  // …and the overlay fades back to fully transparent ~6 s later.
  for (const page of Object.values(overlays)) {
    await expect.poll(() => canvasCoverage(page), { timeout: 12_000 }).toBe(0);
  }
});

test('showcase single: Card Stunt reveals on A while B stays transparent (SIMULATED)', async ({
  context,
  request,
}) => {
  const overlays = await openOverlays(context);
  await showcase(request, 'single');
  await expect(overlays.A.locator('html')).toHaveAttribute('data-phase', 'active');
  await overlays.A.waitForTimeout(4_000);
  await shot(overlays.A, 'single-active-a');
  await waitForPhase(request, 'complete', 30_000);
  await expect.poll(() => canvasCoverage(overlays.A)).toBeGreaterThan(STAND_UP_PIXELS);
  await shot(overlays.A, 'single-complete-a');
  expect(await canvasCoverage(overlays.B)).toBe(0);
});

test('crowd sizes n = 5 / 25 / 300 / 3000 on both sides, with the seam checked at each size (SIMULATED)', async ({
  context,
  request,
}) => {
  test.setTimeout(180_000);
  const overlays = await openOverlays(context, '&unite=0');
  // Quorum 400 per side = ceil(0.4 × 1000): a big channel's adaptive target, so the four crowd
  // sizes land at ~1 %, ~6 %, 75 % and "ready" on the same round.
  const QUORUM = 400;
  const { roundId } = (await call(request, {
    artwork: sunArtwork(),
    mode: 'crossover',
    durationMs: 180_000,
    quorumOverride: { A: QUORUM, B: QUORUM },
  })) as { roundId: string };
  const { round } = await serverState(request);
  if (round === null || round.roundId !== roundId) throw new Error('CALL did not publish a round');

  let total = 0;
  let batch = 0;
  for (const n of [5, 25, 300, 3000]) {
    const tag = `n${String(n).padStart(4, '0')}`;
    // Distinct people per batch and per side (different communities): seeds never repeat.
    batch += 1;
    for (const side of ['A', 'B'] as const) {
      await chat(request, { side, count: n - total, seed: side === 'A' ? batch : 100 + batch });
    }
    total = n;

    const { snapshot } = await serverState(request);
    const revealed = n >= QUORUM;
    expect(snapshot.simulated).toBe(true);
    expect(snapshot.sides.A.participants).toBe(n);
    // The joint reveal latches the moment B (fed last) reaches its quorum; later chat in the
    // same burst is no longer credited, so B freezes at exactly 400.
    expect(snapshot.sides.B.participants).toBe(revealed ? QUORUM : n);
    expect(snapshot.crossovers).toBe(0);
    if (revealed) {
      await waitForPhase(request, 'complete');
    } else {
      expect(snapshot.phase).toBe('active');
    }
    await waitForRevision(request, Object.values(overlays));

    // Same progress on both sides: every card shows the plan leaf for stepsToShow(progress).
    const expected = {
      A: leafColors(
        planOf(round, 'A'),
        stepsToShow(planOf(round, 'A'), snapshot.sides.A.progress, revealed),
      ),
      B: leafColors(
        planOf(round, 'B'),
        stepsToShow(planOf(round, 'B'), snapshot.sides.B.progress, revealed),
      ),
    };
    await expectSeamPixels(overlays, expected);
    // The seam settles first; give the staggered flips elsewhere time to finish for the capture.
    await overlays.A.waitForTimeout(1_500);
    for (const [side, page] of Object.entries(overlays)) {
      await shot(page, `crowd-${tag}-${side.toLowerCase()}`);
    }
  }
});

test('seam: A and B at the same progress show the plan leaves on columns 47|48 (debug hook + pixels)', async ({
  context,
  request,
}) => {
  const overlays = await openOverlays(context, '&debug=1&unite=0');
  const artwork = sunArtwork();
  await call(request, {
    artwork,
    mode: 'crossover',
    durationMs: 60_000,
    quorumOverride: { A: 10, B: 10 },
  });
  const { round } = await serverState(request);
  if (round === null) throw new Error('CALL did not publish a round');

  // 6/10 on each side: well into the plan, still below the reveal gate.
  for (const side of ['A', 'B'] as const) await chat(request, { side, count: 6, seed: 7 });
  const { snapshot } = await serverState(request);
  expect(snapshot.sides.A.progress).toBeCloseTo(0.6);
  expect(snapshot.sides.B.progress).toBeCloseTo(0.6);
  expect(snapshot.crossovers).toBe(6);
  await waitForRevision(request, Object.values(overlays));

  const expected = {} as Record<Side, number[]>;
  for (const side of ['A', 'B'] as const) {
    const plan = planOf(round, side);
    const shown = stepsToShow(plan, snapshot.sides[side].progress, false);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(plan.preRevealCount + 1);
    expected[side] = leafColors(plan, shown);
    const state = await inspect(overlays[side]);
    expect(state.roundId).toBe(round.roundId);
    expect(state.stepsShown).toBe(shown);
    // The full 48×27 stand, and in particular the seam column, matches the plan leaves.
    expect(state.cards).toEqual(expected[side]);
  }
  // Columns 47|48 explicitly (A's right edge, B's left edge), then the same cards by pixels.
  const seam = (cards: readonly number[], column: number) =>
    cards.filter((_, index) => index % SIDE_COLS === column);
  expect(seam((await inspect(overlays.A)).cards, SIDE_COLS - 1)).toEqual(
    seam(expected.A, SIDE_COLS - 1),
  );
  expect(seam((await inspect(overlays.B)).cards, 0)).toEqual(seam(expected.B, 0));
  await expectSeamPixels(overlays, expected);
  await shot(overlays.A, 'seam-progress-a');
  await shot(overlays.B, 'seam-progress-b');

  // Reveal: both halves end on the exact artwork, so the picture continues across the seam.
  for (const side of ['A', 'B'] as const) await chat(request, { side, count: 4, seed: 8 });
  await waitForPhase(request, 'complete');
  const finalArt = {
    A: Array.from({ length: SIDE_COLS * GRID_ROWS }, (_, i) => {
      return artwork.pixels[Math.floor(i / SIDE_COLS) * 96 + (i % SIDE_COLS)] ?? -1;
    }),
    B: Array.from({ length: SIDE_COLS * GRID_ROWS }, (_, i) => {
      return artwork.pixels[Math.floor(i / SIDE_COLS) * 96 + SIDE_COLS + (i % SIDE_COLS)] ?? -1;
    }),
  };
  for (const side of ['A', 'B'] as const) {
    await expect.poll(async () => (await inspect(overlays[side])).flippedColumns).toBe(SIDE_COLS);
    expect((await inspect(overlays[side])).cards).toEqual(finalArt[side]);
  }
  await expectSeamPixels(overlays, finalArt);
  for (const [side, page] of Object.entries(overlays)) {
    await shot(page, `seam-revealed-${side.toLowerCase()}`);
  }
});

test('polling fallback: with the socket refused, /api/snapshot restores the live round', async ({
  page,
  request,
}) => {
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    void socket.close({ code: 1011, reason: 'test: refused' });
  });
  await page.goto('/overlay/a?mute=1');
  await expect(page.locator('html')).toHaveAttribute('data-transport', 'poll');

  const { roundId } = (await showcase(request, 'crossover')) as { roundId: string };
  await expect(page.locator('html')).toHaveAttribute('data-round', roundId, { timeout: 5_000 });
  await expect(page.locator('html')).toHaveAttribute('data-phase', 'active');
  await expect.poll(() => canvasCoverage(page)).toBeGreaterThan(STAND_UP_PIXELS);
  await page.waitForTimeout(3_000);
  await shot(page, 'polling-active-a');
  await expect(page.locator('html')).toHaveAttribute('data-transport', 'poll');
});

test('control panel drives the real server: CALL goes live on the overlay, RESET clears it', async ({
  context,
  page,
  request,
}) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  await page.goto('/control');
  await expect(page.locator('#demo-banner')).toBeVisible();
  const overlays = await openOverlays(context);

  await page.locator('#call-btn').click();
  await expect(page.locator('#phase-chip')).toHaveAttribute('data-phase', 'active');
  const { snapshot, round } = await serverState(request);
  expect(snapshot.phase).toBe('active');
  expect(round?.mode).toBe('crossover');
  for (const overlay of Object.values(overlays)) {
    await expect(overlay.locator('html')).toHaveAttribute('data-phase', 'active');
    await expect.poll(() => canvasCoverage(overlay)).toBeGreaterThan(STAND_UP_PIXELS);
  }

  // Simulator buttons feed the same pipeline: +5 on A shows up on the scoreboard.
  await page.locator('[data-sim-side="A"][data-sim-count="5"]').click();
  await expect(page.locator('#count-A')).toHaveText('5');
  await shot(page, 'control-live');

  // RESET is a two-step confirmation.
  await page.locator('#reset-btn').click();
  await page.locator('#reset-btn').click();
  await expect(page.locator('#phase-chip')).toHaveAttribute('data-phase', 'idle');
  for (const overlay of Object.values(overlays)) {
    await expect(overlay.locator('html')).toHaveAttribute('data-phase', 'idle');
    await expect.poll(() => canvasCoverage(overlay)).toBe(0);
  }
  expect(problems).toEqual([]);
});

test('HYPE hero reveal is readable on both real demo overlays (SIMULATED)', async ({
  context,
  request,
}) => {
  const overlays = await openOverlays(context, '&hold=1');
  await showcase(request, 'crossover');
  const revealing = await waitForPhase(request, 'revealing');
  const revealAtMs = revealing.revealAtMs!;
  await waitForPhase(request, 'complete');
  const response = await serverState(request);
  const expected = presetArtwork('hype', 'crossover', { A: 'A', B: 'B' });
  const round = response.round!;
  for (const side of ['A', 'B'] as const) {
    const region = planOf(round, side).region;
    expect(leafColors(planOf(round, side), planOf(round, side).steps.length)).toEqual(
      Array.from(
        { length: region.w * region.h },
        (_, i) =>
          expected.pixels[Math.floor(i / region.w) * expected.cols + region.x + (i % region.w)],
      ),
    );
    await shot(overlays[side], `polish-hype-unite-${side}`);
  }
  // Restore the native halves after the title has faded, without replaying one-shots.
  await sleepUntil(overlays.A, revealAtMs + 14_500);
  for (const side of ['A', 'B'] as const) {
    await overlays[side].goto(`/overlay/${side.toLowerCase()}?mute=1&hold=1&unite=0`);
    await expect(overlays[side].locator('html')).toHaveAttribute('data-phase', 'complete');
    await overlays[side].waitForTimeout(800);
    await shot(overlays[side], `polish-hype-native-${side}`);
  }
});

test('broadcast design package: real SIMULATED demo capture sequence', async ({
  context,
  request,
}) => {
  test.setTimeout(150_000);
  const directory = path.resolve(SHOTS_DIR, '../design');
  await mkdir(directory, { recursive: true });
  await reset(request);
  await postJson(request, '/api/labels', { A: 'TEAM ORANGE', B: 'TEAM BLUE' });
  const overlays = await openOverlays(context, '&hold=1');
  for (const side of ['A', 'B'] as const) {
    await overlays[side].evaluate(
      "document.body.style.background = 'repeating-linear-gradient(115deg,rgba(255,255,255,.035) 0 18px,transparent 18px 46px),linear-gradient(145deg,#2c454d,#151c27)'",
    );
  }
  const control = await context.newPage();
  await control.goto('/control');
  await expect(control.locator('#call-btn')).toBeEnabled();
  await control.locator('input[name="preset"][value="hype"]').check();
  await control.evaluate('window.scrollTo(0,0)');
  await control.screenshot({ path: path.join(directory, 'control-idle.png') });
  const capture = async (name: string) => {
    // Follow-up art reviews can refresh just the changed score/result compositions.
    if (process.env['V3_POLISH_CAPTURE'] && !['waiting', 'finale', 'single'].includes(name)) return;
    await Promise.all(
      (['A', 'B'] as const).map((side) => {
        if (process.env['V3_POLISH_CAPTURE'] && name === 'single' && side === 'B') return;
        return overlays[side].screenshot({ path: path.join(directory, `${name}-${side}.png`) });
      }),
    );
  };
  await showcase(request, 'crossover');
  const active = await waitForPhase(request, 'active');
  await sleepUntil(overlays.A, active.startedAtMs! + 1200);
  await capture('intro');
  await sleepUntil(overlays.A, active.startedAtMs! + 8400);
  await capture('mid-refinement');
  await expect(control.locator('#call-btn')).toBeDisabled();
  await control.evaluate('window.scrollTo(0,0)');
  await control.screenshot({ path: path.join(directory, 'control-live.png') });
  await sleepUntil(overlays.A, active.startedAtMs! + 14400);
  await capture('waiting');
  const revealing = await waitForPhase(request, 'revealing');
  const at = revealing.revealAtMs!;
  await sleepUntil(overlays.A, at + 1300);
  await capture('wave-before-seam');
  await sleepUntil(overlays.A, at + 1940);
  await capture('wave-at-seam');
  await sleepUntil(overlays.A, at + 2540);
  await capture('wave-after-seam');
  await waitForPhase(request, 'complete');
  await capture('finale');
  await showcase(request, 'so-close');
  await waitForPhase(request, 'timed-out');
  await overlays.A.waitForTimeout(1200);
  await capture('so-close');
  await showcase(request, 'single');
  await waitForPhase(request, 'complete');
  await capture('single');
  await reset(request);
  await postJson(request, '/api/labels', { A: 'LEFT STAND', B: 'RIGHT STAND' });
  await control.goto('/dev');
  if (!process.env['V3_POLISH_CAPTURE'])
    await control.screenshot({ path: path.join(directory, 'dev.png') });
  await control.close();
});
