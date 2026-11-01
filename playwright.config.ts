import { defineConfig, devices } from '@playwright/test';

/**
 * One Playwright entry point (`pnpm test:e2e`), three projects:
 *
 * - `demo`: real end-to-end against `pnpm demo` (started below on port 3100). Showcase reveal,
 *   n = 5/25/300/3000 crowd captures, the A|B seam test and the polling fallback.
 * - `overlay-render`: the overlay in isolation (public/ served from disk, mocked /ws, paused
 *   clock) for deterministic timeline captures, reduced motion, delayMs and frame pacing.
 * - `control`: the control panel and dev page against an in-memory mock of the API contract.
 *
 * Run one with `pnpm test:e2e --project=demo`. Captures land in `test-results/{e2e,overlay,
 * control}/` (ignored); Playwright's own artifacts (traces) go to `test-results/artifacts/`,
 * which is the only folder Playwright wipes at the start of a run.
 */
const PORT = 3100;
const OVERLAY_VIEWPORT = { width: 1920, height: 1080 } as const;

export default defineConfig({
  testDir: './test/e2e',
  outputDir: './test-results/artifacts',
  fullyParallel: false,
  // The demo server holds one shared round: tests must not race each other.
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'demo',
      testMatch: 'overlay.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${PORT}`,
        viewport: OVERLAY_VIEWPORT,
        deviceScaleFactor: 1,
      },
    },
    {
      name: 'overlay-render',
      testMatch: ['overlay-render.spec.ts', 'layout.spec.ts'],
      use: { ...devices['Desktop Chrome'], viewport: OVERLAY_VIEWPORT, deviceScaleFactor: 1 },
    },
    {
      name: 'control',
      testMatch: 'control.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: {
    command: 'pnpm demo',
    env: { PORT: String(PORT), HOST: '127.0.0.1' },
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
