import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Page, type Route } from '@playwright/test';
import { parseArtwork } from '../../src/engine/artwork.js';
import type { Side, Snapshot, SnapshotSide, StuntMode } from '../../src/engine/types.js';
import type {
  CallRequest,
  ChannelInfo,
  ControlState,
  DemoChatRequest,
} from '../../src/shared/protocol.js';

/*
 * Control panel and SIMULATED injector in isolation: public/ is served from disk and every
 * /api/* and /dev/* call is answered by an in-memory mock of the server contract
 * (ControlState and request bodies from src/shared/protocol.ts). No server process is needed.
 * Run with: pnpm test:e2e --project=control
 */

// Never contacted: page.route answers every request for this origin.
const ORIGIN = 'http://127.0.0.1:3999';
const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const SHOTS_DIR = fileURLToPath(new URL('../../test-results/control/', import.meta.url));
// Same policy as the real server (src/server/http.ts): catches inline styles/scripts.
const CSP =
  "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const ALIASES: Readonly<Record<string, string>> = {
  '/': 'control/index.html',
  '/control': 'control/index.html',
  '/dev': 'dev/index.html',
};
const PARTNER_URL = 'https://quiet-river.trycloudflare.com/overlay/b?room=SECRET_ROOM_TOKEN';

interface RecordedPost {
  readonly path: string;
  readonly body: unknown;
  readonly contentType: string;
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

function side(participants: number, quorum: number): SnapshotSide {
  return {
    participants,
    quorum,
    progress: quorum > 0 ? Math.min(1, participants / quorum) : 0,
    ready: quorum > 0 && participants >= quorum,
  };
}

function idleSnapshot(simulated: boolean): Snapshot {
  return {
    revision: 1,
    mode: 'crossover',
    phase: 'idle',
    roundId: null,
    serverNowMs: Date.now(),
    startedAtMs: null,
    deadlineAtMs: null,
    revealAtMs: null,
    revealDurationMs: 6_000,
    simulated,
    crossovers: 0,
    sides: { A: side(0, 0), B: side(0, 0) },
  };
}

function initialState(demo: boolean): ControlState {
  const labels = demo ? { A: 'LEFT STAND', B: 'RIGHT STAND' } : { A: 'A', B: 'B' };
  const twitch = demo ? 'demo' : 'signed-out';
  return {
    protocol: 2,
    demo,
    twitch: { status: twitch, login: null, userCode: null, verificationUri: null, error: null },
    channels: { A: null, B: null },
    config: {
      mode: 'crossover',
      durationMs: 45_000,
      minQuorum: 3,
      quorumRatio: 0.4,
      recentWindowMs: 900_000,
      quorumOverride: {},
      revealLeadMs: 1_500,
      revealDurationMs: 6_000,
    },
    snapshot: idleSnapshot(demo),
    meta: { labels, twitch },
    overlayUrls: {
      A: 'http://127.0.0.1:3000/overlay/a',
      B: 'http://127.0.0.1:3000/overlay/b',
      partnerB: null,
    },
    share: { status: 'off', error: null },
    lastChat: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** In-memory stand-in for the server: records POSTs and evolves ControlState like the API. */
class MockServer {
  state: ControlState;
  sharedChat: { partners: ChannelInfo[]; notice: string | null } = { partners: [], notice: null };
  offline = false;
  readonly posts: RecordedPost[] = [];
  /** Replies that replace the default behaviour for a path (error injection). */
  readonly overrides = new Map<string, Reply>();

  constructor(demo: boolean) {
    this.state = initialState(demo);
  }

  postsTo(path: string): RecordedPost[] {
    return this.posts.filter((post) => post.path === path);
  }

  patch(update: Partial<ControlState>): void {
    this.state = { ...this.state, ...update };
  }

  patchSnapshot(update: Partial<Snapshot>): void {
    this.patch({
      snapshot: { ...this.state.snapshot, ...update, revision: this.state.snapshot.revision + 1 },
    });
  }

  handlePost(path: string, body: unknown): Reply {
    const now = Date.now();
    switch (path) {
      case '/api/call': {
        const request = body as CallRequest;
        const mode: StuntMode = request.mode ?? 'crossover';
        const quorum = (s: Side) => request.quorumOverride?.[s] ?? 5;
        this.patchSnapshot({
          mode,
          phase: 'active',
          roundId: 'round-1',
          startedAtMs: now,
          deadlineAtMs: now + (request.durationMs ?? 45_000),
          crossovers: 0,
          sides: {
            A: side(0, quorum('A')),
            B: mode === 'single' ? side(0, 0) : side(0, quorum('B')),
          },
        });
        return { status: 202, body: { roundId: 'round-1' } };
      }
      case '/api/reset':
        this.patch({ snapshot: { ...idleSnapshot(this.state.demo), revision: 99 } });
        return { status: 200, body: { ok: true } };
      case '/dev/chat': {
        const request = body as DemoChatRequest;
        const current = this.state.snapshot.sides[request.side];
        this.patchSnapshot({
          sides: {
            ...this.state.snapshot.sides,
            [request.side]: side(current.participants + request.count, current.quorum),
          },
        });
        return { status: 202, body: { simulated: true, accepted: request.count } };
      }
      case '/dev/showcase':
        return { status: 202, body: { simulated: true } };
      case '/api/labels': {
        if (!isRecord(body)) return { status: 400, body: { error: 'Expected labels' } };
        this.patch({
          meta: {
            ...this.state.meta,
            labels: {
              A:
                typeof body.A === 'string'
                  ? body.A || this.state.channels.A?.login || 'CHANNEL A'
                  : this.state.meta.labels.A,
              B:
                typeof body.B === 'string'
                  ? body.B || this.state.channels.B?.login || 'CHANNEL B'
                  : this.state.meta.labels.B,
            },
          },
        });
        return { status: 200, body: { labels: this.state.meta.labels } };
      }
      case '/api/channels': {
        const b = isRecord(body) && typeof body.b === 'string' ? body.b : null;
        const partner = b ? { login: b, displayName: 'NeonNomad', userId: '2' } : null;
        this.patch({
          channels: { ...this.state.channels, B: partner },
          meta: {
            ...this.state.meta,
            labels: { ...this.state.meta.labels, B: partner?.displayName ?? 'B' },
          },
        });
        return { status: 200, body: { ok: true } };
      }
      case '/api/shared-chat': {
        const partner = isRecord(body)
          ? this.sharedChat.partners.find((user) => user.userId === body.userId)
          : null;
        if (this.state.channels.B || !partner)
          return { status: 409, body: { error: 'Selection changed' } };
        this.patch({ channels: { ...this.state.channels, B: partner } });
        return { status: 200, body: { ok: true } };
      }
      case '/api/auth/start':
        this.patch({
          twitch: {
            ...this.state.twitch,
            status: 'authorizing',
            userCode: 'WDJB-MJHT',
            verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=WDJBMJHT',
          },
        });
        return {
          status: 200,
          body: {
            userCode: 'WDJB-MJHT',
            verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=WDJBMJHT',
          },
        };
      case '/api/auth/signout':
        this.patch({
          twitch: {
            status: 'signed-out',
            login: null,
            userCode: null,
            verificationUri: null,
            error: null,
          },
        });
        return { status: 200, body: { ok: true } };
      case '/api/share/start':
        this.patch({
          share: { status: 'on', error: null },
          overlayUrls: { ...this.state.overlayUrls, partnerB: PARTNER_URL },
        });
        return { status: 200, body: { ok: true } };
      case '/api/share/stop':
        this.patch({
          share: { status: 'off', error: null },
          overlayUrls: { ...this.state.overlayUrls, partnerB: null },
        });
        return { status: 200, body: { ok: true } };
      default:
        return { status: 404, body: { error: 'Not found' } };
    }
  }
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  });
}

async function handle(route: Route, mock: MockServer): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() === 'POST') {
    const body: unknown = request.postDataJSON();
    mock.posts.push({
      path: url.pathname,
      body,
      contentType: request.headers()['content-type'] ?? '',
    });
    const reply = mock.overrides.get(url.pathname) ?? mock.handlePost(url.pathname, body);
    await fulfillJson(route, reply.status, reply.body);
    return;
  }
  if (url.pathname === '/api/shared-chat') {
    const reply = mock.overrides.get(url.pathname) ?? { status: 200, body: mock.sharedChat };
    await fulfillJson(route, reply.status, reply.body);
    return;
  }
  if (url.pathname === '/api/state') {
    if (mock.offline) {
      await route.abort('connectionrefused');
      return;
    }
    const snapshot = { ...mock.state.snapshot, serverNowMs: Date.now() };
    await fulfillJson(route, 200, { ...mock.state, snapshot });
    return;
  }
  if (url.pathname === '/api/snapshot') {
    const snapshot = { ...mock.state.snapshot, serverNowMs: Date.now() };
    await fulfillJson(route, 200, { protocol: 2, snapshot, meta: mock.state.meta });
    return;
  }
  const relative = ALIASES[url.pathname] ?? decodeURIComponent(url.pathname.slice(1));
  const file = normalize(join(PUBLIC_DIR, relative));
  const type = CONTENT_TYPES[extname(file)];
  if (!type || !file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
    await fulfillJson(route, 404, { error: 'Not found' });
    return;
  }
  try {
    await route.fulfill({
      status: 200,
      body: await readFile(file),
      headers: {
        'Content-Type': `${type}; charset=utf-8`,
        'Content-Security-Policy': CSP,
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    await fulfillJson(route, 404, { error: 'Not found' });
  }
}

/** Opens a page against the mock; returns a list that collects errors, CSP violations, dialogs. */
async function open(page: Page, mock: MockServer, path = '/control'): Promise<string[]> {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    // HTTP error statuses are logged by Chromium itself; they are expected in error tests.
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
      problems.push(`console: ${message.text()}`);
    }
  });
  page.on('dialog', (dialog) => {
    problems.push(`dialog: ${dialog.type()} ${dialog.message()}`);
    void dialog.dismiss();
  });
  await page.route(`${ORIGIN}/**`, (route) => handle(route, mock));
  await page.goto(`${ORIGIN}${path}`);
  return problems;
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOTS_DIR, { recursive: true });
  await page.screenshot({
    path: join(SHOTS_DIR, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}

function expectJsonPosts(mock: MockServer): void {
  expect(mock.posts.length).toBeGreaterThan(0);
  for (const post of mock.posts) expect(post.contentType).toMatch(/^application\/json/);
}

type Rgb = readonly [number, number, number];

/** Minimal 8-bit RGB PNG encoder, so image fixtures are generated instead of checked in. */
function encodePng(width: number, height: number, pixel: (x: number, y: number) => Rgb): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter type: none
    for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), y * stride + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13); // compression, filter and interlace stay 0
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const channel = (i: 0 | 1 | 2) => Math.round(a[i] + (b[i] - a[i]) * t);
  return [channel(0), channel(1), channel(2)];
}

/** 800×225 test images: two flat halves, or a sunset with a sun, a ridge and grass. */
function makePng(kind: 'halves' | 'scene'): Buffer {
  if (kind === 'halves') {
    return encodePng(800, 225, (x) => (x < 400 ? [230, 159, 0] : [86, 180, 233]));
  }
  const ridge = (x: number) => 150 + 40 * Math.sin(x / 70) + 15 * Math.sin(x / 23);
  return encodePng(800, 225, (x, y) => {
    if (y >= 205) return [0, 158, 115];
    if (y >= ridge(x)) return [16, 24, 32];
    if ((x - 400) ** 2 + (y - 95) ** 2 < 55 ** 2) return [240, 228, 66];
    const t = y / 205;
    return t < 0.5
      ? mix([11, 61, 145], [86, 180, 233], t * 2)
      : mix([230, 159, 0], [213, 94, 0], (t - 0.5) * 2);
  });
}

/** Reads the clipboard in the page (typed narrowly: this file compiles without the DOM lib). */
async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() =>
    (
      globalThis as unknown as { navigator: { clipboard: { readText(): Promise<string> } } }
    ).navigator.clipboard.readText(),
  );
}

test('demo: CALL sends a valid CallRequest, live round renders, RESET needs confirmation', async ({
  page,
}) => {
  const mock = new MockServer(true);
  const problems = await open(page, mock);

  await expect(page.locator('#demo-banner')).toHaveText('DEMO — SIMULATED crowd, no Twitch');
  await expect(page.locator('#server-status')).toHaveText('Server connected');
  await expect(page.locator('#simulator')).toBeVisible();
  await expect(page.locator('#twitch-chip')).toHaveText('Demo · no Twitch');
  await expect(page.locator('#twitch-connect')).toBeHidden();
  await expect(page.locator('#call-btn')).toBeEnabled();
  await expect(page.locator('#preset-versus-name')).toHaveText('LEFT STAND + RIGHT STAND');
  await shot(page, 'demo-idle');

  await page.getByRole('radio', { name: '30 s' }).check();
  await expect(page.locator('.advanced')).not.toHaveAttribute('open', '');
  await page.locator('.advanced summary').click();
  await page.getByLabel('Minimum people').fill('4');
  await page.getByLabel('Share of recent chatters').fill('50');
  await page.locator('#override-A-on').check();
  await page.getByLabel('Fixed quorum for side A').fill('12');
  await page.getByRole('radio', { name: 'LEFT STAND + RIGHT STAND' }).check();
  await expect(page.locator('#call-sub')).toHaveText('30 s');
  await page.locator('#call-btn').click();

  await expect.poll(() => mock.postsTo('/api/call').length).toBe(1);
  const request = mock.postsTo('/api/call')[0]?.body as CallRequest;
  expect(request).toMatchObject({
    mode: 'crossover',
    durationMs: 30_000,
    minQuorum: 4,
    quorumRatio: 0.5,
    quorumOverride: { A: 12, B: null },
  });
  const artwork = parseArtwork(request.artwork, 'crossover');
  expect(artwork).not.toBeNull();
  expect(new Set(artwork?.pixels).size).toBeGreaterThan(2);

  await expect(page.locator('#phase-chip')).toHaveText('Running');
  await expect(page.locator('#call-btn')).toBeDisabled();
  await expect(page.locator('#call-blocker')).toContainText('A stunt is running');
  await expect(page.locator('#quorum-A')).toHaveText('12');
  // Demo never posts to Twitch, and the panel says so.
  await expect(page.locator('#stunt-status')).toHaveText(
    'SIMULATED round started — nothing is sent to Twitch. 30 s on the clock.',
  );

  // Simulator: each click uses a fresh seed, so it always adds new virtual people.
  await page.getByRole('button', { name: /Add 5 SIMULATED people to A/ }).click();
  await expect.poll(() => mock.postsTo('/dev/chat').length).toBe(1);
  await page.getByRole('button', { name: /Add 1 SIMULATED person to B/ }).click();
  await expect.poll(() => mock.postsTo('/dev/chat').length).toBe(2);
  const [first, second] = mock.postsTo('/dev/chat').map((post) => post.body as DemoChatRequest);
  expect(first).toMatchObject({ side: 'A', count: 5 });
  expect(second).toMatchObject({ side: 'B', count: 1 });
  expect(second?.seed).toBe((first?.seed ?? NaN) + 1);
  await expect(page.locator('#sim-status')).toContainText('SIMULATED: +1 virtual person on B');

  await page.getByRole('button', { name: 'So close' }).click();
  await expect.poll(() => mock.postsTo('/dev/showcase').length).toBe(1);
  expect(mock.postsTo('/dev/showcase')[0]?.body).toEqual({ scenario: 'so-close' });

  mock.patchSnapshot({ sides: { A: side(12, 12), B: side(7, 12) }, crossovers: 2 });
  await expect(page.locator('#round-summary')).toHaveText(
    'LEFT STAND is ready — waiting for RIGHT STAND.',
  );
  await expect(page.locator('#flag-A')).toHaveText('Ready · waiting');
  await expect(page.locator('#count-B')).toHaveText('7');
  await shot(page, 'demo-live-waiting');

  // A live stunt only stops on a second, deliberate click.
  await page.locator('#reset-btn').click();
  await expect(page.locator('#reset-btn')).toHaveText('Confirm reset');
  expect(mock.postsTo('/api/reset')).toHaveLength(0);
  await page.locator('#reset-btn').click();
  await expect.poll(() => mock.postsTo('/api/reset').length).toBe(1);
  await expect(page.locator('#phase-chip')).toHaveText('Idle');
  await expect(page.locator('#call-btn')).toBeEnabled();

  mock.patchSnapshot({
    phase: 'complete',
    roundId: 'round-2',
    sides: { A: side(14, 12), B: side(12, 12) },
    crossovers: 3,
  });
  await expect(page.locator('#round-summary')).toHaveText(
    '23 people from 2 communities made this · 3 in both chats.',
  );
  await expect(page.locator('#countdown')).toHaveText('DONE');
  await shot(page, 'demo-complete');

  expectJsonPosts(mock);
  expect(problems).toEqual([]);
});

test('errors stay inline: rejected CALL, invalid field, unreachable server', async ({ page }) => {
  const mock = new MockServer(true);
  const problems = await open(page, mock);
  await expect(page.locator('#call-btn')).toBeEnabled();

  mock.overrides.set('/api/call', { status: 409, body: { error: 'Round already active' } });
  await page.locator('#call-btn').click();
  await expect(page.locator('#stunt-error')).toHaveText(
    'A stunt is already running. Wait for it to finish or RESET first.',
  );

  mock.overrides.set('/api/call', {
    status: 400,
    body: { error: 'durationMs must be between 10000 and 180000' },
  });
  await page.locator('#call-btn').click();
  await expect(page.locator('#stunt-error')).toHaveText(
    'durationMs must be between 10000 and 180000',
  );
  expect(mock.postsTo('/api/call')).toHaveLength(2);

  await page.locator('.advanced summary').click();
  await page.getByLabel('Minimum people').fill('0');
  await page.locator('.advanced summary').click();
  await page.locator('#call-btn').click();
  await expect(page.locator('#stunt-error')).toHaveText(
    'Minimum people must be a whole number from 1 to 1000.',
  );
  await expect(page.getByLabel('Minimum people')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Minimum people')).toBeFocused();
  await expect(page.locator('.advanced')).toHaveAttribute('open', '');
  expect(mock.postsTo('/api/call')).toHaveLength(2);

  mock.overrides.set('/dev/chat', { status: 404, body: { error: 'Not found' } });
  await page.getByRole('button', { name: /Add 25 SIMULATED people to B/ }).click();
  await expect(page.locator('#sim-error')).toHaveText('The simulator only runs with pnpm demo.');

  mock.offline = true;
  await expect(page.locator('#server-status')).toHaveText('Server unreachable');
  await expect(page.locator('#server-banner')).toContainText('Cannot reach the server');
  await expect(page.locator('#call-btn')).toBeDisabled();
  await expect(page.locator('#call-blocker')).toContainText('server is unreachable');
  await shot(page, 'errors-inline');
  mock.offline = false;
  await expect(page.locator('#server-banner')).toBeHidden();
  await page.getByLabel('Minimum people').fill('3');
  await expect(page.locator('#call-btn')).toBeEnabled();

  expectJsonPosts(mock);
  expect(problems).toEqual([]);
});

test('picture builder: pixel text with palette pickers and quantized image upload', async ({
  page,
}) => {
  const mock = new MockServer(true);
  const problems = await open(page, mock);
  await expect(page.locator('#server-status')).toHaveText('Server connected');

  await page.getByRole('radio', { name: 'Text', exact: true }).check();
  await page.getByLabel('Line 1').fill('GG WP');
  await page.getByLabel(/^Line 2/).fill('see you, chat!');
  await page.locator('#fg-swatches input[aria-label="Paper"]').check();
  await page.locator('#bg-swatches input[aria-label="Vermillion"]').check();
  await expect(page.locator('#text-warning')).toBeHidden();
  await expect(page.locator('#call-btn')).toBeEnabled();
  await shot(page, 'text-builder');

  await page.getByLabel(/^Line 2/).fill('ñandú ☺');
  await expect(page.locator('#text-warning')).toHaveText('Not in the pixel font, left out: ☺');
  await expect(page.locator('#call-btn')).toBeEnabled();

  await page.getByRole('radio', { name: /Single/ }).check();
  await page.getByLabel('Line 1').fill('SUPERCALIFRAGILISTIC EXPIALIDOCIOUS');
  await expect(page.locator('#text-warning')).toContainText('Too long for single mode');
  await expect(page.locator('#call-btn')).toBeDisabled();
  await page.getByRole('radio', { name: /Crossover/ }).check();
  await page.getByLabel('Line 1').fill('GG WP');

  await page.getByRole('radio', { name: 'Image', exact: true }).check();
  await expect(page.locator('#call-btn')).toBeDisabled();
  await expect(page.locator('#call-blocker')).toHaveText(
    'Choose an image, or switch to a preset or text.',
  );
  await page.locator('#image-file').setInputFiles({
    name: 'halves.png',
    mimeType: 'image/png',
    buffer: makePng('halves'),
  });
  await expect(page.locator('#image-name')).toContainText('halves.png · 800 × 225 px');
  await expect(page.locator('#call-btn')).toBeEnabled();
  await page.locator('#call-btn').click();
  await expect.poll(() => mock.postsTo('/api/call').length).toBe(1);
  const request = mock.postsTo('/api/call')[0]?.body as CallRequest;
  const artwork = parseArtwork(request.artwork, 'crossover');
  expect(artwork).not.toBeNull();
  // Left half quantizes to palette orange (2), right half to sky (3).
  expect(artwork?.pixels[13 * 96 + 10]).toBe(2);
  expect(artwork?.pixels[13 * 96 + 85]).toBe(3);

  mock.patch({ snapshot: idleSnapshot(true) });
  await page.locator('#image-file').setInputFiles({
    name: 'sunset.png',
    mimeType: 'image/png',
    buffer: makePng('scene'),
  });
  await expect(page.locator('#image-name')).toContainText('sunset.png');
  await expect(page.locator('#call-btn')).toBeEnabled();
  await shot(page, 'image-upload');

  const rejected = page.locator('#image-file');
  await rejected.setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hi'),
  });
  await expect(page.locator('#picture-error')).toContainText('notes.txt is not an image');

  expectJsonPosts(mock);
  expect(problems).toEqual([]);
});

test('live mode: device code, channels, partner share link and copy', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const mock = new MockServer(false);
  const problems = await open(page, mock);

  await expect(page.locator('#server-status')).toHaveText('Server connected');
  await expect(page.locator('#demo-banner')).toBeHidden();
  await expect(page.locator('#simulator')).toBeHidden();
  await expect(page.locator('#twitch-chip')).toHaveText('Signed out');
  await expect(page.locator('#call-sub')).toHaveText('45 s');
  // Bare side letters are not repeated as labels.
  await expect(page.locator('#cap-a')).toHaveText('A · left half');
  await expect(page.locator('#label-B')).toHaveText('Side B');

  await page.getByRole('button', { name: 'Connect Twitch' }).click();
  await expect.poll(() => mock.postsTo('/api/auth/start').length).toBe(1);
  // Masked by default: a streamed panel must not let a viewer redeem the code first.
  await expect(page.locator('#twitch-code')).toHaveText('••••-••••');
  await page.locator('#twitch-copy-code').click();
  expect(await readClipboard(page)).toBe('WDJB-MJHT');
  await page.locator('#twitch-reveal-code').click();
  await expect(page.locator('#twitch-code')).toHaveText('WDJB-MJHT');
  await expect(page.locator('#twitch-verify-link')).toHaveAttribute(
    'href',
    'https://www.twitch.tv/activate?public=true&device-code=WDJBMJHT',
  );
  await expect(page.locator('#twitch-chip')).toHaveText('Waiting for approval');
  await expect(page.locator('#twitch-connect')).toBeHidden();
  await expect(page.locator('#twitch-connect')).toBeDisabled();
  // A live CALL needs EventSub reading chat: blocked until the Twitch card says Connected.
  await expect(page.locator('#call-btn')).toBeDisabled();
  await expect(page.locator('#call-blocker')).toContainText('Finish the Twitch sign-in first');
  await shot(page, 'live-device-code');

  mock.patch({
    twitch: {
      status: 'connected',
      login: 'pixelpilot',
      userCode: null,
      verificationUri: null,
      error: null,
    },
    channels: { A: { login: 'pixelpilot', displayName: 'PixelPilot', userId: '1' }, B: null },
    meta: { labels: { A: 'PixelPilot', B: 'B' }, twitch: 'connected' },
  });
  await expect(page.locator('#twitch-login')).toHaveText('pixelpilot');
  await expect(page.locator('#twitch-connect')).toBeHidden();
  await expect(page.locator('#twitch-connect')).toBeDisabled();
  await expect(page.locator('#call-blocker')).not.toContainText('Twitch');
  await expect(page.locator('#twitch-auth')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.locator('#channel-a')).toHaveValue('pixelpilot');

  await page.getByLabel('B · Partner channel').fill('bad login!');
  await page.getByRole('button', { name: 'Save channels' }).click();
  await expect(page.locator('#channels-error')).toContainText('is not a Twitch login');
  expect(mock.postsTo('/api/channels')).toHaveLength(0);
  await page.getByLabel('B · Partner channel').fill('neon_nomad');
  await page.getByRole('button', { name: 'Save channels' }).click();
  await expect.poll(() => mock.postsTo('/api/channels').length).toBe(1);
  expect(mock.postsTo('/api/channels')[0]?.body).toEqual({ a: 'pixelpilot', b: 'neon_nomad' });
  await expect(page.locator('#channel-b-current')).toHaveText('Using NeonNomad (neon_nomad).');
  await expect(page.locator('#label-B')).toHaveText('NeonNomad');

  await page.getByRole('button', { name: 'Start sharing' }).click();
  await expect.poll(() => mock.postsTo('/api/share/start').length).toBe(1);
  await expect(page.locator('#share-chip')).toHaveText('Sharing');
  // The room token stays masked on screen until explicitly revealed.
  await expect(page.locator('#url-partner')).toHaveValue(
    'https://quiet-river.trycloudflare.com/overlay/b?room=••••••••',
  );
  await page.locator('[data-copy="partner"]').click();
  expect(await readClipboard(page)).toBe(PARTNER_URL);
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(page.locator('#url-partner')).toHaveValue(PARTNER_URL);
  await page.getByRole('button', { name: 'Hide' }).click();
  await page.locator('[data-copy="A"]').click();
  expect(await readClipboard(page)).toBe('http://127.0.0.1:3000/overlay/a');

  mock.patch({ lastChat: { atMs: Date.now() - 5_000, ok: false, reason: 'followers_only' } });
  await expect(page.locator('#twitch-last-chat')).toContainText(
    'Last chat message was not delivered (followers_only)',
  );
  await shot(page, 'live-connected');

  await page.getByRole('button', { name: 'Stop sharing' }).click();
  await expect.poll(() => mock.postsTo('/api/share/stop').length).toBe(1);
  await expect(page.locator('#url-partner')).toHaveValue('Not sharing');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect.poll(() => mock.postsTo('/api/auth/signout').length).toBe(1);
  await expect(page.getByRole('button', { name: 'Connect Twitch' })).toBeVisible();

  expectJsonPosts(mock);
  expect(problems).toEqual([]);
});

test('Connect shows a server conflict message when another panel already connected', async ({
  page,
}) => {
  const mock = new MockServer(false);
  const message = 'Already connected as pixelpilot. Sign out first to switch accounts.';
  mock.overrides.set('/api/auth/start', { status: 409, body: { error: message } });
  const problems = await open(page, mock);
  await page.getByRole('button', { name: 'Connect Twitch' }).click();
  await expect(page.locator('#twitch-error')).toHaveText(message);
  await expect(page.locator('#twitch-auth')).toBeHidden();
  expect(mock.postsTo('/api/auth/start')).toHaveLength(1);
  expect(problems).toEqual([]);
});

test('single mode on a narrow window sends a 48×27 artwork without a B override', async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 1000 });
  const mock = new MockServer(true);
  const problems = await open(page, mock);
  await expect(page.locator('#server-status')).toHaveText('Server connected');

  await page.getByRole('radio', { name: /Single/ }).check();
  await expect(page.locator('#grid-size')).toHaveText('48 × 27 cards · single');
  await expect(page.locator('#override-B-on')).toBeDisabled();
  await expect(page.locator('#call-sub')).toHaveText('45 s');
  await page.getByRole('radio', { name: 'NEXT: BOSS FIGHT' }).check();
  await page.locator('#call-btn').click();
  await expect.poll(() => mock.postsTo('/api/call').length).toBe(1);
  const request = mock.postsTo('/api/call')[0]?.body as CallRequest;
  expect(request).toMatchObject({ mode: 'single', quorumOverride: { A: null, B: null } });
  expect(parseArtwork(request.artwork, 'single')).not.toBeNull();
  await expect(page.locator('#meter-B .side-flag')).toHaveText('Not used in single mode');
  await shot(page, 'single-narrow');

  expectJsonPosts(mock);
  expect(problems).toEqual([]);
});

test('dev page: SIMULATED injector and showcase buttons', async ({ page }) => {
  const mock = new MockServer(true);
  const problems = await open(page, mock, '/dev');

  await expect(page.locator('.demo-banner')).toContainText('SIMULATED');
  await expect(page.locator('#live-status')).toHaveText('Idle — no round running.');
  await page.getByLabel('Distinct virtual people').selectOption('25');
  await page.getByLabel('Replay seed').fill('7');
  await page.getByRole('button', { name: 'Inject SIMULATED chat' }).click();
  await expect.poll(() => mock.postsTo('/dev/chat').length).toBe(1);
  expect(mock.postsTo('/dev/chat')[0]?.body).toEqual({ side: 'A', count: 25, seed: 7 });
  await expect(page.locator('#result')).toHaveText(
    'SIMULATED: 25 virtual chat events sent to side A (seed 7).',
  );
  // The seed advances so the next click brings new virtual people instead of a silent replay.
  await expect(page.getByLabel('Replay seed')).toHaveValue('8');

  await page.getByRole('button', { name: 'Crossover' }).click();
  await expect.poll(() => mock.postsTo('/dev/showcase').length).toBe(1);
  expect(mock.postsTo('/dev/showcase')[0]?.body).toEqual({ scenario: 'crossover' });
  await expect(page.locator('#showcase-result')).toHaveText(
    'SIMULATED showcase started: Crossover.',
  );

  mock.overrides.set('/dev/showcase', { status: 409, body: { error: 'busy' } });
  await page.getByRole('button', { name: 'Single' }).click();
  await expect(page.locator('#showcase-result')).toContainText('RESET it first');

  mock.patchSnapshot({ phase: 'active', sides: { A: side(25, 12), B: side(3, 12) } });
  await expect(page.locator('#live-status')).toHaveText(
    'Running · LEFT STAND 25/12 · RIGHT STAND 3/12',
  );
  await shot(page, 'dev');

  expectJsonPosts(mock);
  expect(problems).toEqual([]);
});

test('team labels post independently and the next state poll reflects them', async ({ page }) => {
  const mock = new MockServer(false);
  const problems = await open(page, mock);
  await page.locator('#label-a').fill('TEAM ORANGE');
  await page.locator('#label-b').fill('TEAM BLUE');
  await page.getByRole('button', { name: 'Save team labels' }).click();
  await expect.poll(() => mock.postsTo('/api/labels').length).toBe(1);
  expect(mock.postsTo('/api/labels')[0]?.body).toEqual({ A: 'TEAM ORANGE', B: 'TEAM BLUE' });
  expect(mock.state.meta.labels).toEqual({ A: 'TEAM ORANGE', B: 'TEAM BLUE' });
  await expect(page.locator('#labels-status')).toHaveText('Team labels saved.');
  await page.locator('#label-a').fill('UNSAVED LABEL');
  await page.waitForTimeout(1_100);
  await expect(page.locator('#label-a')).toHaveValue('UNSAVED LABEL');
  await page.locator('#label-a').fill('');
  await page.getByRole('button', { name: 'Save team labels' }).click();
  await expect.poll(() => mock.postsTo('/api/labels').length).toBe(2);
  await page.locator('#twitch-title').click();
  await expect(page.locator('#label-a')).toHaveValue(mock.state.channels.A?.login ?? 'CHANNEL A');
  await shot(page, 'team-labels');
  expect(problems).toEqual([]);
});

test('layout radios rewrite both local URLs and the private partner Copy URL', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const mock = new MockServer(true);
  mock.patch({
    overlayUrls: {
      ...mock.state.overlayUrls,
      partnerB: 'https://partner.example/overlay/b?room=fixture-room',
    },
    share: { status: 'on', error: null },
  });
  const problems = await open(page, mock);
  await page.getByRole('radio', { name: 'Seam fit', exact: true }).check();
  for (const selector of ['#url-A', '#url-B']) {
    const url = new URL(await page.locator(selector).inputValue());
    expect(url.searchParams.get('fit')).toBe('seam');
    expect(url.searchParams.get('scale')).toBe('0.62');
  }
  await page.locator('[data-copy="partner"]').click();
  const copied = await page.evaluate(() =>
    (
      globalThis as unknown as { navigator: { clipboard: { readText(): Promise<string> } } }
    ).navigator.clipboard.readText(),
  );
  expect(new URL(copied).searchParams.get('room')).toBe('fixture-room');
  expect(new URL(copied).searchParams.get('fit')).toBe('seam');
  await page.getByRole('radio', { name: 'Facecam bottom right', exact: true }).check();
  expect(new URL(await page.locator('#url-A').inputValue()).searchParams.get('cutout')).toBe(
    '1440,700,440,340',
  );
  await page.getByRole('radio', { name: 'Facecam bottom left', exact: true }).check();
  expect(new URL(await page.locator('#url-B').inputValue()).searchParams.get('cutout')).toBe(
    '40,700,440,340',
  );
  await shot(page, 'on-stream-layout');
  await page.getByRole('radio', { name: 'Full', exact: true }).check();
  expect(await page.locator('#url-A').inputValue()).toBe(mock.state.overlayUrls.A);
  expect(problems).toEqual([]);
});

for (const count of [1, 3]) {
  test(`Shared Chat: ${count} partner suggestions require host consent`, async ({ page }) => {
    const mock = new MockServer(false);
    mock.patch({ twitch: { ...mock.state.twitch, status: 'connected', login: 'pixelpilot' } });
    mock.sharedChat.partners = Array.from({ length: count }, (_, i) => ({
      userId: `partner-${i}`,
      login: `partner_${i}`,
      displayName: `Partner ${i}`,
    }));
    const problems = await open(page, mock);
    await expect(page.locator('#shared-chat-pairing')).toBeVisible();
    expect(mock.postsTo('/api/shared-chat')).toHaveLength(0);
    expect(mock.state.channels.B).toBeNull();
    if (count === 1) {
      await expect(page.locator('#shared-chat-detected')).toHaveText(
        'Shared Chat with partner_0 detected - Use as channel B',
      );
      await expect(page.locator('#shared-chat-picker')).toBeHidden();
    } else {
      await expect(page.getByLabel('Shared Chat partner')).toBeVisible();
      await page.getByLabel('Shared Chat partner').selectOption('partner-2');
    }
    await mkdir(SHOTS_DIR, { recursive: true });
    await page
      .locator('#channels')
      .screenshot({ path: join(SHOTS_DIR, `shared-chat-${count}-partners.png`) });
    await page.getByRole('button', { name: 'Use as channel B', exact: true }).click();
    await expect.poll(() => mock.postsTo('/api/shared-chat').length).toBe(1);
    expect(mock.postsTo('/api/shared-chat')[0]?.body).toEqual({
      userId: count === 1 ? 'partner-0' : 'partner-2',
    });
    await expect(page.locator('#shared-chat-pairing')).toBeHidden();
    expect(mock.postsTo('/api/channels')).toHaveLength(0);
    expect(problems).toEqual([]);
  });
}

test('Shared Chat: configured B stays selected when the session ends mid-round', async ({
  page,
}) => {
  const mock = new MockServer(false);
  const partner = {
    userId: 'already-set',
    login: 'current_partner',
    displayName: 'Current partner',
  };
  mock.patch({ channels: { ...mock.state.channels, B: partner } });
  mock.sharedChat.partners = [
    { userId: 'different', login: 'other_partner', displayName: 'Other partner' },
  ];
  const problems = await open(page, mock);
  await expect(page.locator('#shared-chat-pairing')).toBeHidden();
  mock.patchSnapshot({
    phase: 'active',
    roundId: 'shared-active',
    startedAtMs: Date.now(),
    deadlineAtMs: Date.now() + 45000,
  });
  mock.sharedChat = {
    partners: [],
    notice: 'Shared Chat ended. This round keeps running and channel B stays selected.',
  };
  await expect(page.locator('#shared-chat-notice')).toContainText('round keeps running');
  await expect(page.locator('#channel-b')).toHaveValue('current_partner');
  expect(mock.state.snapshot.phase).toBe('active');
  expect(mock.posts).toHaveLength(0);
  expect(problems).toEqual([]);
});

test('Shared Chat: failed discovery leaves manual setup usable and running rounds block pairing', async ({
  page,
}) => {
  const mock = new MockServer(false);
  mock.overrides.set('/api/shared-chat', { status: 503, body: { error: 'Lookup unavailable' } });
  const problems = await open(page, mock);
  await expect(page.locator('#shared-chat-pairing')).toBeHidden();
  await expect(page.locator('#channels-save')).toBeEnabled();
  await page.locator('#channel-b').fill('manual_partner');
  mock.overrides.delete('/api/shared-chat');
  mock.sharedChat.partners = [{ userId: 'p', login: 'partner', displayName: 'Partner' }];
  mock.patchSnapshot({
    phase: 'active',
    roundId: 'running',
    startedAtMs: Date.now(),
    deadlineAtMs: Date.now() + 45000,
  });
  await expect(page.locator('#shared-chat-pairing')).toBeVisible();
  await expect(page.locator('#shared-chat-use')).toBeDisabled();
  await expect(page.locator('#channel-b')).toHaveValue('manual_partner');
  expect(mock.postsTo('/api/shared-chat')).toHaveLength(0);
  expect(problems).toEqual([]);
});

test('matchup counts align beneath team names with a quiet baseline suffix', async ({ page }) => {
  const mock = new MockServer(true);
  const problems = await open(page, mock);
  for (const width of [1920, 1280]) {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 720 });
    for (const team of ['A', 'B']) {
      const label = await page.locator(`#label-${team}`).boundingBox();
      const count = await page.locator(`#count-${team}`).boundingBox();
      const suffix = page.locator(`#meter-${team} .side-count-unit`);
      const unit = await suffix.boundingBox();
      expect(label).not.toBeNull();
      expect(count).not.toBeNull();
      expect(unit).not.toBeNull();
      expect(Math.abs(label!.x - count!.x)).toBeLessThanOrEqual(1);
      expect(count!.y - (label!.y + label!.height)).toBeLessThan(24);
      expect(unit!.y).toBeGreaterThan(count!.y);
      expect(
        await page.evaluate(
          `Number(getComputedStyle(document.querySelector('#meter-${team} .side-count-unit')).fontWeight)`,
        ),
      ).toBeLessThan(550);
    }
  }
  expect(problems).toEqual([]);
});

test('crossover defaults to names, single to HEART, and explicit choices survive mode switches', async ({
  page,
}) => {
  const mock = new MockServer(true);
  const problems = await open(page, mock);
  const preset = (id: string) => page.locator(`input[name="preset"][value="${id}"]`);
  await expect(preset('versus')).toBeChecked();
  await page.getByRole('radio', { name: 'Single A only' }).check();
  await expect(preset('heart')).toBeChecked();
  await preset('gg').check();
  await page.getByRole('radio', { name: 'Crossover A + B' }).check();
  await expect(preset('versus')).toBeChecked();
  await preset('hype').check();
  await page.getByRole('radio', { name: 'Single A only' }).check();
  await expect(preset('gg')).toBeChecked();
  await page.getByRole('radio', { name: 'Crossover A + B' }).check();
  await expect(preset('hype')).toBeChecked();
  expect(problems).toEqual([]);
});
