---
name: overlay-visual-check
description: Verify Crossover Stunt overlays in the local SIMULATED demo with Chromium captures at 5, 25, 300 and 3000 virtual participants, the A|B seam test, and (manually) OBS performance.
---

Read `docs/SPEC.md` and `playwright.config.ts`. Keep captures inside ignored `test-results/` and never use real chat identities.

1. Run `pnpm install`, then `pnpm browsers:install` (Chromium only, project-local browser cache). Run `pnpm test:e2e` (or one project: `--project=demo|overlay-render|control`); its webServer starts/stops `pnpm demo` on loopback port 3100. For manual work, run `pnpm demo --autoplay`, visit `/overlay/a`, `/overlay/b`, `/control`, and `/dev`, then stop it when done.
2. Project `demo` (`test/e2e/overlay.spec.ts`) drives the real server: `/dev/showcase` crossover (active, WAITING, wave, complete), so-close (timeout without chat, fade to transparent), single, a CALL with quorum 400 per side plus `POST /dev/chat` bodies such as `{ "side": "A", "count": 20, "seed": 2 }` until n=5/25/300/3000, the seam test, polling recovery and the control panel. Captures: `test-results/e2e/*.png`. Project `overlay-render` replays a mocked timeline with a paused clock (captures in `test-results/overlay/`), including reduced motion, delayMs, worst-case labels and a joint A|B view.
3. When behavior changes, keep each scenario covering CALL/RESET, both sides independently, partial progress, uneven WAITING, joint reveal, timeout, single mode, disconnected WS/poll recovery, muted audio and reduced motion. SIMULATED labels must stay visible on both overlays. Use 1920x1080 OBS dimensions and check a smaller 1280x720 viewport.
4. Open the PNGs and inspect clipping, text readability, minimap attribution, seam alignment, status cues without color/audio, caption `[crowd roars]`, and target progress at each crowd size. Fix and capture again only where a failure warrants it.
5. The seam test puts A and B at the same progress and compares columns 47|48 with the plan leaves (debug hook `?debug=1` → `window.crossoverOverlay.inspect()`, plus canvas pixels at card centers), then again after the reveal against the artwork. Check that reveal timing uses server timestamps and clock-offset sampling, not arrival time.
6. Measure frame duration, cell/particle bounds, and memory in real OBS CEF at n=3000. Playwright screenshot success does not prove 60 fps. Record measured environment/results and any untested OBS/audio behavior in `docs/CODEX_LOG.md`.
