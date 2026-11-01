import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { presetArtwork } from '../../public/control/artwork.js';
import { PALETTE, sideRegion } from '../../src/engine/artwork.js';
import { buildRefinementPlan } from '../../src/engine/quadtree.js';
import type { RoundPayload, ServerMessage } from '../../src/shared/protocol.js';
import type { Side, Snapshot } from '../../src/engine/types.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ORIGIN = 'http://127.0.0.1:3199';
const SHOTS = path.join(ROOT, 'test-results', 'layout');
const NOW = Date.UTC(2026, 10, 1, 2);
interface CanvasProbe {
  getContext(type: string): {
    getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
  };
  toDataURL(): string;
}

async function openLayout(page: Page, side: Side, query: string) {
  const sockets: WebSocketRoute[] = [];
  const art = presetArtwork('heart', 'crossover', { A: 'TEAM ORANGE', B: 'TEAM BLUE' });
  const round: RoundPayload = {
    roundId: 'layout-round',
    mode: 'crossover',
    cols: 96,
    rows: 27,
    palette: [...PALETTE],
    plans: {
      A: buildRefinementPlan({ artwork: art, side: 'A', region: sideRegion('crossover', 'A') }),
      B: buildRefinementPlan({ artwork: art, side: 'B', region: sideRegion('crossover', 'B') }),
    },
  };
  const snapshot: Snapshot = {
    revision: 1,
    mode: 'crossover',
    phase: 'active',
    roundId: round.roundId,
    serverNowMs: NOW + 1000,
    startedAtMs: NOW - 5000,
    deadlineAtMs: NOW + 40000,
    revealAtMs: null,
    revealDurationMs: 6000,
    simulated: true,
    crossovers: 0,
    sides: {
      A: { participants: 5, quorum: 10, progress: 0.5, ready: false },
      B: { participants: 5, quorum: 10, progress: 0.5, ready: false },
    },
  };
  await mkdir(SHOTS, { recursive: true });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const relative = /^\/overlay\/[ab]$/.test(url.pathname)
      ? 'overlay/index.html'
      : url.pathname.slice(1);
    const file = path.resolve(ROOT, 'public', relative);
    if (!file.startsWith(path.resolve(ROOT, 'public') + path.sep))
      return route.fulfill({ status: 404 });
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
    };
    await route.fulfill({
      body: await readFile(file),
      contentType: mime[path.extname(file)] ?? 'text/plain',
    });
  });
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    sockets.push(socket);
  });
  await page.clock.install({ time: NOW });
  await page.goto(`${ORIGIN}/overlay/${side.toLowerCase()}?mute=1&${query}`);
  await page.clock.pauseAt(NOW + 1000);
  await expect.poll(() => sockets.length).toBe(1);
  const messages: ServerMessage[] = [
    { type: 'hello', protocol: 2, side, serverNowMs: NOW + 1000, simulated: true },
    { type: 'meta', meta: { labels: { A: 'TEAM ORANGE', B: 'TEAM BLUE' }, twitch: 'demo' } },
    { type: 'round', round },
    { type: 'snapshot', snapshot },
  ];
  for (const message of messages) sockets[0]!.send(JSON.stringify(message));
  await expect(page.locator('html')).toHaveAttribute('data-phase', 'active');
  await page.clock.runFor(800);
  await page.evaluate(() => {
    (
      globalThis as unknown as { document: { documentElement: { style: { background: string } } } }
    ).document.documentElement.style.background =
      'repeating-linear-gradient(115deg, #243b48 0 35px, #324e55 35px 70px)';
  });
  return { round, snapshot, sockets };
}
async function pixel(page: Page, x: number, y: number) {
  return page
    .locator('#stage')
    .evaluate(
      (node, [x, y]) =>
        Array.from((node as unknown as CanvasProbe).getContext('2d').getImageData(x, y, 1, 1).data),
      [x, y] as const,
    );
}
for (const side of ['A', 'B'] as const) {
  test(`facecam hole and side-colour border on ${side} (SIMULATED)`, async ({ page }) => {
    const x = side === 'A' ? 1440 : 40;
    const { snapshot, sockets } = await openLayout(page, side, `cutout=${x},700,440,340&debug=1`);
    expect((await pixel(page, x + 220, 870))[3]).toBe(0);
    expect(await pixel(page, x + 3, 870)).toEqual(
      side === 'A' ? [230, 159, 0, 255] : [86, 180, 233, 255],
    );
    await page.screenshot({ path: path.join(SHOTS, `facecam-${side}.png`) });
    const now = NOW + 1800;
    const ready = { participants: 10, quorum: 10, progress: 1, ready: true };
    sockets[0]!.send(
      JSON.stringify({
        type: 'snapshot',
        snapshot: {
          ...snapshot,
          revision: 2,
          serverNowMs: now,
          sides: {
            A: side === 'B' ? ready : snapshot.sides.A,
            B: side === 'A' ? ready : snapshot.sides.B,
          },
        },
      }),
    );
    await expect(page.locator('html')).toHaveAttribute('data-revision', '2');
    await page.clock.runFor(800);
    const inspect = () =>
      page.evaluate(() =>
        (
          globalThis as unknown as {
            crossoverOverlay: {
              inspect(): {
                lagAlpha: number;
                lagCenterY: number;
                lagHeight: number;
                titleCenterY: number;
                titleHeight: number;
              };
            };
          }
        ).crossoverOverlay.inspect(),
      );
    const waiting = await inspect();
    expect(waiting.lagCenterY + waiting.lagHeight / 2).toBeLessThan(700);
    await page.screenshot({ path: path.join(SHOTS, `facecam-${side}-waiting.png`) });
    sockets[0]!.send(
      JSON.stringify({
        type: 'snapshot',
        snapshot: {
          ...snapshot,
          revision: 3,
          phase: 'complete',
          serverNowMs: now + 800,
          revealAtMs: now - 5200,
          sides: { A: ready, B: ready },
        },
      }),
    );
    await expect(page.locator('html')).toHaveAttribute('data-phase', 'complete');
    await page.clock.runFor(100);
    const united = await inspect();
    expect(united.lagAlpha).toBe(0);
    expect(united.titleCenterY + united.titleHeight / 2).toBeLessThan(270);
    expect((await pixel(page, x + 220, 870))[3]).toBe(0);
    await page.screenshot({ path: path.join(SHOTS, `facecam-${side}-unite.png`) });
  });
  test(`seam fit anchors ${side} to the physical seam and disables UNITE (SIMULATED)`, async ({
    page,
  }) => {
    const { round, snapshot, sockets } = await openLayout(page, side, 'fit=seam&scale=.62&debug=1');
    expect((await pixel(page, side === 'A' ? 1919 : 0, 500))[3]).toBeGreaterThan(0);
    expect((await pixel(page, side === 'A' ? 100 : 1800, 540))[3]).toBe(0);
    expect((await pixel(page, 1000, 100))[3]).toBe(0);
    await page.screenshot({ path: path.join(SHOTS, `seam-fit-${side}.png`) });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.screenshot({ path: path.join(SHOTS, `seam-fit-${side}-720p.png`) });
    const now = NOW + 1800;
    sockets[0]!.send(
      JSON.stringify({
        type: 'snapshot',
        snapshot: {
          ...snapshot,
          revision: 2,
          phase: 'complete',
          roundId: round.roundId,
          serverNowMs: now,
          revealAtMs: now - 6000,
          sides: {
            A: { participants: 10, quorum: 10, progress: 1, ready: true },
            B: { participants: 10, quorum: 10, progress: 1, ready: true },
          },
        },
      }),
    );
    await expect(page.locator('html')).toHaveAttribute('data-phase', 'complete');
    await page.clock.runFor(100);
    const state = await page.evaluate(() =>
      (
        globalThis as unknown as { crossoverOverlay: { inspect(): { uniteSince: number } } }
      ).crossoverOverlay.inspect(),
    );
    expect(state.uniteSince).toBeLessThan(0);
  });
}

test('no parameters and invalid composition parameters preserve the native render', async ({
  page,
  context,
}) => {
  await openLayout(page, 'A', 'reducedMotion=1');
  const baseline = await page
    .locator('#stage')
    .evaluate((node) => (node as unknown as CanvasProbe).toDataURL());
  const invalid = await context.newPage();
  await openLayout(invalid, 'A', 'fit=unknown&scale=bad&cutout=bad&reducedMotion=1');
  const actual = await invalid
    .locator('#stage')
    .evaluate((node) => (node as unknown as CanvasProbe).toDataURL());
  expect(createHash('sha256').update(actual).digest('hex')).toBe(
    createHash('sha256').update(baseline).digest('hex'),
  );
});
