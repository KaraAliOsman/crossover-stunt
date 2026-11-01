# Crossover Stunt: instructions for OpenAI Codex

Two streams. One picture. This repository is an OBS browser-source overlay where two Twitch communities refine separate halves of one hidden image. Single-channel Card Stunt is the daily-use fallback. Read `docs/SPEC.md` before implementing behavior and `docs/TWITCH_NOTES.md` before touching authentication or EventSub.

The stunt works end to end in the credential-free SIMULATED demo (engine, server, overlays, control panel, Playwright seam test). The live Twitch path was verified with two real channels, one EventSub WebSocket and OBS 33 browser sources on two simultaneous streams (one viewer account, see README). Large real crowds, cloudflared sharing, reconnect/revocation and OBS performance under load remain covered by fakes/headless Chromium only. Never describe untested live behavior as verified; record real checks in `docs/CODEX_LOG.md` when they happen.

## Commands

Run from the repository root with Node 24+ and pnpm 12.5.1:

- `pnpm install` — resolve/install dependencies; commit the lockfile when commits are authorized.
- `pnpm dev` — live server with watch, for development: any save under `src/` or `.env` restarts it (round, channel B, room token and tunnel are lost), so live sessions use `pnpm build` + `pnpm start`. PORT defaults to 3000; Twitch needs `TWITCH_CLIENT_ID` in `.env` (else the control page shows setup help and status `signed-out`).
- `pnpm demo` — credential-free SIMULATED mode: no Twitch, `/dev` injector enabled. `pnpm demo --autoplay` loops the crossover → so-close → single showcase rounds.
- `pnpm build` / `pnpm start` — compile / run compiled server; keep `public/` alongside `dist/`.
- `pnpm typecheck` / `pnpm test` — strict types / Vitest including fast-check properties.
- `pnpm test:watch` — iterative engine work.
- `pnpm lint` / `pnpm format` — Prettier check / write.
- `pnpm verify:server` — start, HTTP smoke, and stop on an ephemeral loopback port.
- `pnpm browsers:install` / `pnpm test:e2e` — local Chromium / Playwright projects `demo` (real `pnpm demo` on port 3100: showcase, n=5/25/300/3000, seam, polling, control), `overlay-render` and `control` (isolated, mocked). Run one with `pnpm test:e2e --project=demo`; captures land in ignored `test-results/{e2e,overlay,control}/`.
- `pnpm share` / `pnpm share --stop` — ask the running server to open/close a cloudflared quick tunnel (cloudflared on PATH) and print the room-token partner URL for overlay B.

## Folder map and architecture

- `src/engine/` — pure deterministic state, immutable reducer, quorum and quadtree geometry.
- `src/twitch/` — public-client Device Code auth, EventSub lifecycle, Helix sending, identity normalization. Network and credentials stop here.
- `src/server/` — `node:http`, explicit static routes, control API, access model (local vs room-token remote), engine runtime adapter (`runtime.ts`), WebSocket hub, polling snapshots, chat announcements, showcase runner and cloudflared share. Inject the clock and transport side effects into the engine adapter.
- `src/shared/protocol.ts` — versioned aggregate-only server-to-overlay JSON contracts.
- `src/sim/` — deterministic virtual people and scripted showcase rounds; never sends anything to Twitch.
- `public/overlay/` — plain HTML + Canvas2D + Web Audio, no build step; `public/control/` and `public/dev/` are local tools.
- `test/` — Vitest/property tests; `test/e2e/` — Playwright: real-server end-to-end + A|B seam test (`overlay.spec.ts`), isolated overlay timeline (`overlay-render.spec.ts`) and control panel (`control.spec.ts`).
- `.agents/skills/` — reusable Codex workflows: `twitch-eventsub`, `overlay-visual-check`, `stunt-engine`.
- `docs/` — product scope, verified API references, truthful Codex evidence log.

One EventSub WebSocket connection receives `channel.chat.message` v1 for broadcaster A and B with the same validated user token. Normalize source-channel identity before deduplication and route to the pure engine. Project a whitelisted snapshot to `/ws` and `/api/snapshot`. Use no SSE. The server owns round timing; clients animate from server timestamps.

## Hard rules

1. Keep `src/engine/` pure: no IO, clocks, timers, `Date.now`, environment reads, unseeded randomness or mutable singleton state. `step(state, event, now)` must not mutate its inputs; inject time and seed.
2. Never render chat text, usernames, chatter IDs, messages, fragments or emotes on overlays. Do not serialize engine Sets/Maps or raw Twitch payloads to clients. Only aggregate progress and artwork cross the public protocol.
3. Never commit credentials, `.env`, token files, `data/`, request logs, or private capture data. No client secret is needed. Keep tokens server-side and exclude them from errors/URLs. `.env.example` must remain blank of real values.
4. Engine behavior changes need meaningful tests: duplicate delivery, repeated chatter, deadline boundary, quorum freeze, single/crossover reveal gating, geometry and deterministic replay as appropriate. Preserve at least one fast-check property.
5. Use cross-platform Node scripts. No shell-specific environment assignments, `rm`, `cp`, or bash pipelines in package scripts. Test Windows paths containing spaces.
6. Target 60 fps in OBS CEF: bound quadtree cells/particles, use `requestAnimationFrame`, precompute colors, avoid per-frame DOM/layout and per-chatter objects. Check reduced motion and a silent experience. Chromium screenshots alone do not prove OBS performance.
7. Label virtual crowds **SIMULATED** on screen and in evidence. Demo must never require Twitch credentials or send virtual events to Twitch. Preserve demo/live separation.
8. Keep overlays read-only. Before exposing a tunnel, implement room-token enforcement on HTTP snapshots, assets and WS plus protected local controls. Never treat a room token as a Twitch token.

## Coding style

Strict TypeScript, ESM, NodeNext `.js` import suffixes, ES2023. Prefer small explicit interfaces and discriminated unions. Treat external JSON as `unknown` and validate once at boundaries; a TypeScript cast is not runtime validation. Use readonly contracts and explicit units (`Ms`, seconds only at API boundaries). Use Prettier, named exports, `node:` built-ins, and minimal dependencies. Browser modules stay plain JS unless a real build requirement appears.

Use TODO comments with a module prefix and a concrete next action. Do not hide unimplemented behavior behind fake success. Make protocol changes in both transports and consumers together. Record only work actually performed in `docs/CODEX_LOG.md`; keep the same Codex session for follow-up work where possible.

## Definition of done per change

`pnpm typecheck`, `pnpm test` and `pnpm lint` pass; `pnpm demo` starts and its relevant route responds; stop the server after verification. For compiled-path changes, also run `pnpm build` and smoke `pnpm start`. For overlay changes, follow `overlay-visual-check` and inspect captures; for Twitch changes, follow `twitch-eventsub` and state whether credentials/live channels were available. Update docs for changed commands, interfaces and behavior. Report residual TODOs and untested live behavior honestly.
