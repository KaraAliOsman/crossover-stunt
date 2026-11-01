# Codex implementation log

The scaffold entry below is historical. The engine, Twitch integration, server, overlays and control
panel were implemented between the scaffold and review sessions following `AGENTS.md` and
`docs/DESIGN.md`. The appended review entry records the work performed in the current Codex session;
the scaffold session's unfinished list does not describe the current application.

## 2026-10-31 — scaffold session

Authoring tool: **OpenAI Codex**, operating through the Codex harness in T3 Code. Scope: repository/environment setup and typed interfaces for the next implementation block, not the full product. No runtime AI/API calls are part of the scaffold.

**Codex session ID:** `01a1937c-f04d-73f2-88f1-dc0d4c8e9283`.

Provenance: both `CODEX_SESSION_ID` and `CODEX_THREAD_ID` environment variables exposed that same value during this session. The local `session_index.jsonl` tail was inspected read-only but did not identify this active session. This log does not infer account, provider routing or hackathon eligibility from those variables; the human should confirm the session shown by Codex before submitting evidence. No global Codex configuration was opened or changed.

### Work actually performed

- Read the Spanish proposal, with focus on the hackathon context and section 6 product rules. Created the new `app/` Git repository with default branch `main`; made no commit, remote or push.
- Fetched official Twitch authentication, validation, refresh, EventSub lifecycle/subscription/payload, Send Chat Message, scopes and rate-limit documentation; distilled linked notes. Read official Codex project configuration and local skill documentation. Temporary reference text is outside the repo at `../research/scaffold-official/`; the app does not depend on it.
- Created strict NodeNext/ES2023 TypeScript, Vitest, fast-check, Playwright, Prettier and Windows-compatible package scripts. Installed dependencies and wrote the pnpm lockfile.
- Added immutable engine contracts, explicit throwing reducer/quadtree/snapshot TODOs, a real pure quorum helper, Shared Chat identity normalization and virtual crowd generator. No actual stunt progression or Twitch connection exists yet.
- Added a runnable `node:http` harness with explicit static-file allowlist, read-only WebSocket hello/snapshot, equivalent polling snapshot, loopback binding, clear 501 control/room TODOs and a demo-only bounded JSON injector. The injector reports accepted virtual events and `processed: false` while the engine adapter is missing.
- Added plain placeholder control/dev/Canvas pages; simulated output is labeled SIMULATED. Added root/module AGENTS instructions, three repository Codex skills, a safe comment-only project config, English spec/README, blank `.env.example`, ignore files and MIT license.
- Installed only the Chromium browser family and its required Playwright runtime helpers into ignored project-local `.cache/ms-playwright/`; no Firefox/WebKit install. The initial plain Playwright install command returned success with no download output; the reproducible project command uses the local wrapper and downloaded its binaries inside the repo's ignored cache.

### Verification observed so far

| Command / check                                                | Result                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `git init --initial-branch=main app`                           | PASS; no commit/remote/push                                                  |
| Initial `pnpm install`                                         | Dependencies resolved; failed on pnpm 12's ignored esbuild build-hook policy |
| `pnpm install` after project-local `allowBuilds.esbuild: true` | PASS; esbuild hook completed, lockfile present                               |
| Initial `pnpm typecheck`                                       | Found an `unknown` JSON test value; typed the test expectation boundary      |
| `pnpm typecheck`                                               | PASS after correction                                                        |
| `pnpm test`                                                    | PASS: 3 files, 5 tests; includes 300 reproducible fast-check cases           |
| `pnpm build`                                                   | PASS                                                                         |
| `pnpm verify:server`                                           | PASS: health, control, A, B, dev and clean stop on an ephemeral port         |
| `pnpm browsers:install`                                        | PASS: local Chromium/runtime download                                        |
| `pnpm test:e2e`                                                | PASS: 4 Chromium cases at n=5/25/300/3000, SIMULATED scaffold screenshots    |
| `pnpm dev` then `curl.exe` health / overlay A / overlay B      | PASS: health JSON and both overlays HTTP 200; stopped with Ctrl+C            |

### Final handoff checks

- `pnpm format` then `pnpm lint`: PASS; all authored matching files follow Prettier.
- `pnpm install --frozen-lockfile`: PASS; lockfile remained current.
- `pnpm typecheck`, `pnpm test`, `pnpm build`: PASS; unit/integration suite remains 5 tests in 3 files, including 300 seeded fast-check cases.
- `pnpm start` after build: PASS; `curl.exe` returned health JSON and HTTP 200 for the compiled server's overlay route. Stopped with Ctrl+C. The watch/start wrappers exit on that user interrupt; this is expected shutdown, not an application crash.
- The bundled skill-creator `quick_validate.py` reported all three repository skills valid. Python `tomllib` parsed the comment-only project config successfully.
- Inspected the first n=3000 placeholder capture and found the Desktop Chrome preset had overridden the intended viewport. Corrected project-level viewport configuration to 1920×1080, extended captures to both A/B, and reran `pnpm test:e2e`: **PASS, 5 browser tests** (4 population scenarios plus forced-WS-close polling recovery).
- Final capture set: **8 PNGs**, A/B at n=5/25/300/3000, each 1920×1080, in ignored `test-results/`. Opened the final B/n=3000 capture and confirmed readable SIMULATED/scaffold labeling, correct side and placeholder status. These are harness captures, not refinement/performance evidence.
- `pnpm share`: PASS as an instructional placeholder; no tunnel opened.
- Git hygiene: branch `main`, zero commits, empty index, no remotes; 54 authored/lock/config files remain untracked for the authorized implementer. Required secret/generated paths are ignored, `.env.example` remains eligible for version control, and no real `.env` exists.
- Confirmed no listeners remained on ports 3000 or 3100 after dev/compiled/demo verification. A source scan found no prohibited assistant/vendor references in authored files.

### Dependency versions resolved in this session

Runtime/tooling observed: Node `24.14.0`, pnpm `12.5.1`, Git `2.55.0.windows.2`.

| Package          | Version |
| ---------------- | ------- |
| ws               | 8.22.0  |
| typescript       | 5.9.3   |
| tsx              | 4.23.15 |
| @types/node      | 24.19.2 |
| @types/ws        | 8.18.2  |
| vitest           | 4.1.12  |
| fast-check       | 4.10.2  |
| @playwright/test | 1.64.1  |
| prettier         | 3.9.10  |

### Deliberately unfinished / unverified

Device Code networking/secure token persistence, refresh validation, EventSub subscriptions/lifecycle, Helix sends, engine reducer and quadtree, artwork/image processing, CALL/RESET, single mode, actual progress/wait/reveal/timeout, Web Audio/captions/effects, clock-offset sync, room access/tunnel protection, seam pixel comparison, live Twitch and OBS performance checks. The screenshots currently show placeholders, not progress at the injected crowd sizes. No secret was supplied. No reference repository was cloned; official documentation was sufficient for this scaffold time box.

Continue implementation in this Codex session where possible. Append what was actually changed/tested and label live versus simulated evidence. Do not rewrite this setup block as if later features existed during it.

## 2026-10-31 — Codex review and hardening session

**Codex session/thread ID:** `01a1940d-cc5d-7503-8f56-9aa4c4f617a5`, read from both
`CODEX_SESSION_ID` and `CODEX_THREAD_ID`. Runtime: Windows, Node `24.14.0`, pnpm `12.5.1`.

This session reviewed and hardened the existing implementation. It did not implement the modules
listed in the historical scaffold handoff. No commit, push, remote, real account authorization or
live chat send was performed. No `.env` or real token file was opened for review.

### Scope actually reviewed

- Read root and module `AGENTS.md`, `SPEC.md`, `DESIGN.md`, `TWITCH_NOTES.md`, the historical log,
  README and all three repository skills. Applied `stunt-engine`, `twitch-eventsub` and
  `overlay-visual-check`.
- Reviewed the immutable reducer, quorum window, quadtree planner, runtime adapter, aggregate-only
  protocol, simulator/showcase, HTTP/WS access checks, static resolver, room cookies, cloudflared
  lifecycle, announcements, control panel and overlay transport/render/effect timing.
- Re-read official Twitch [Device Code](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow),
  [token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/),
  [EventSub lifecycle](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/),
  [chat subscription authorization](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage),
  [Create EventSub Subscription](https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription),
  [Shared Chat lookup](https://dev.twitch.tv/docs/api/reference/#get-shared-chat-session),
  [Send Chat Message](https://dev.twitch.tv/docs/api/reference/#send-chat-message) and
  [chat rate limits](https://dev.twitch.tv/docs/chat/#rate-limits). Documentation checks and fake
  transports are not evidence of a real Twitch session.

### Findings and fixes

| Severity | Location                                                             | Reproduction and focused fix                                                                                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | `src/twitch/service.ts:478`, `pollForTokens`                         | An approved Device Code flow cleared its abort handle before the old socket finished closing. Sign out in that gap was followed by automatic sign-in and persisted credentials. Retain cancellation and check session generation after shutdown and persistence. |
| P1       | `src/twitch/tokenStore.ts:158`, persistence/load/refresh             | A pending save could finish after sign-out deleted the token file; overlapping saves could also leave an older pair. Serialize disk operations and fence stale loads/refreshes so a cleared or replaced session cannot be resurrected.                           |
| P2       | `src/twitch/service.ts:379`, `connectEventSub`                       | Concurrent channel saves opened two steady-state sockets and orphaned one. Superseded connection work now checks a generation, and chat callbacks are bound to the current client.                                                                               |
| P2       | `src/engine/quadtree.ts:274`, `buildRefinementPlan`                  | Rounding 80% upward exposed all detail for plans with one to four splits. Reserve at least one final split for every non-uniform region; preserve exact coverage and the existing plan shape.                                                                    |
| P2       | `public/overlay/net.js:248`, polling                                 | A slow fallback response replaced the newer round received after WebSocket reconnection, even when its snapshot was rejected as stale. Discard HTTP responses overtaken by round/snapshot pushes before applying any payload.                                    |
| P2       | `public/overlay/stage.js:273`, first reveal snapshot                 | Reloading within 500 ms of a reveal effect replayed its roar/confetti. Latch effects whose scheduled time has passed on the first snapshot; future effects still run normally.                                                                                   |
| P2       | `src/twitch/eventsubWs.ts:233`, subscription response classification | HTTP 409 and malformed HTTP 202 responses could report Connected without proving delivery on this socket. Require enabled status and valid cost accounting; surface conflicts as recoverable setup failures.                                                     |
| P2       | `src/twitch/service.ts:468`, Shared Chat seed                        | A delayed Helix session response overwrote a newer EventSub end/update, which could suppress B's announcement after the chats separated. Give observed EventSub changes precedence over the older lookup.                                                        |
| P2       | `src/twitch/helixChat.ts:193`, rate-limit queue                      | Retry waits were truncated before Twitch's reset, and the next queued channel forgot that reset. Share the sender's HTTP reset across channels and fail promptly when the wait exceeds the retry budget.                                                         |
| P2       | `src/twitch/service.ts:170`, persistence notice                      | A successful connection cleared the warning that token persistence had failed. Keep a separate storage notice visible until a later save succeeds; test both failure and recovery.                                                                               |
| P2       | `public/overlay/stage.js:362`, delayed round start                   | `delayMs` postponed the countdown/reveal but raised the stand immediately at CALL. Honor `startedAtMs` on the delayed stage clock so the stand stays transparent until its scheduled start.                                                                      |

All four frozen contracts remain unchanged: `src/engine/types.ts`, `src/engine/artwork.ts`,
`src/shared/protocol.ts` and the `TwitchService` interface. The scaffold-session record remains
intact. README now describes the minimum final split and treats OBS audio autoplay as unverified;
DESIGN and TWITCH_NOTES describe the corrected lifecycle behavior.

### Regression coverage added

- **21 Vitest cases:** simple-artwork reveal gating; save/sign-out and overlapping token saves;
  startup-load cancellation; late refresh success/rejection/server failure after sign-out or a new
  authorization; channel-save concurrency; Device Code cancellation during socket shutdown;
  stale Shared Chat seeding; 409, missing enabled status and invalid cost accounting; bounded
  retries and sender-wide reset pacing; persistent storage warnings and recovery. Strengthened
  the existing seeded quadtree property to
  require actual unrevealed detail for every non-uniform plan.
- **4 Playwright cases:** delayed polling overtaken by WS reconnection; reload inside the reveal
  effect's grace window; simple artwork waiting on B and completing only on joint reveal, with
  an additional 1280×720 capture; delayed stand start with `delayMs`.
- Core reproductions failed before their fixes. Focused post-fix runs passed, including the two
  original browser race reproductions. Additional lifecycle cases exercise successful, rejected
  and transient refresh responses using fake credentials only.

### Commands and observed results

| Command                          | Original baseline                                           | Final verification                                                         |
| -------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Not needed for baseline                                     | PASS; lockfile already current                                             |
| `pnpm browsers:install`          | Existing project-local Chromium used                        | PASS; already installed                                                    |
| `pnpm format`                    | No source changes before baseline                           | PASS                                                                       |
| `pnpm typecheck`                 | PASS                                                        | PASS                                                                       |
| `pnpm test`                      | PASS: 208 tests, 15 files                                   | PASS: 229 tests, 15 files                                                  |
| `pnpm lint`                      | PASS                                                        | PASS                                                                       |
| `pnpm test:e2e`                  | PASS: 33 tests, 3 projects                                  | PASS: 37 tests, 3 projects                                                 |
| `pnpm build`                     | PASS                                                        | PASS                                                                       |
| `pnpm verify:server`             | PASS; demo and credential-free live-mode smoke, clean close | PASS; demo and credential-free live-mode HTTP/WS/access smoke, clean close |

### Visual evidence and limits

The real demo baseline generated A/B PNGs at n=5/25/300/3000 in ignored
`test-results/e2e/`. Opened and inspected **all eight** captures: readable SIMULATED labels,
side attribution/counts, minimaps and continuous seam; the n=3000 summary correctly reflects
the credits actually accepted before success latched. The seam tests compare both debug grids
and canvas pixels against the independent plan replay before/after joint reveal.

The baseline Chromium frame-pacing check measured approximately 59.3 fps idle and 60.0 fps for
the static stand and flips/reveal (update/draw at most 6.08 ms average, 8.7 ms worst in that run).
The code bounds each side to 1296 cards/1295 splits and confetti to a 300-particle pool. These are
headless Chromium signals and inspected bounds, not measurements in OBS CEF.

The final full run measured 60.0 fps idle/static and 56.7 fps during flips/reveal (p95 33.3 ms;
update/draw 7.83 ms average, 13.2 ms worst). All checks passed, but this is below the 60 fps
target during that busy sample. Verify frame pacing on the actual OBS machines before going live;
this review does not claim a proven 60 fps OBS overlay.

Also opened post-fix WAITING, wave/caption, SO CLOSE, reduced-motion, long-label and simple-artwork
captures. `test-results/overlay/27-simple-waiting-a.png` (1920×1080) and
`28-simple-waiting-a-720p.png` (1280×720) keep the final split hidden and the status text readable.

`pnpm demo --autoplay` passed a separate credential-free smoke on port 3198: observed crossover
and single rounds and automatic looping, with `simulated: true` and Twitch status `demo`.
`pnpm start` passed a compiled live-mode smoke on port 3197 with the Client ID explicitly empty:
health reported `simulated: false`, controls reported `signed-out`, and control/A/B/overlay JS
routes returned 200. Both manual servers were stopped by their verified child process IDs and
their health endpoints were confirmed unreachable. The wrappers' exit code -1 reflects that
intentional Windows `Stop-Process`. The initial PowerShell HTML probe hit its legacy parser's
NullReferenceException; a Node `fetch`/assert probe verified the routes successfully.

`pnpm audit --prod`: PASS, no known production dependency vulnerabilities reported. Intermediate
typechecks caught a definite-assignment annotation and a missing test import; both were corrected
before the final passing run. Generated screenshots/traces, compiled output and token paths remain
gitignored.

Final cleanup: queried `Get-CimInstance Win32_Process` for `node.exe` with command lines matching
`*server*index*`, stopped the owned Playwright child left after its Windows wrapper exited, and
confirmed no matching project server remained. Node health probes on ports 3000, 3100, 3197 and
3198 all failed to connect as expected. The temporary review preview tab was also closed.

Real Twitch consent, refresh rotation, A/B EventSub, reconnect/revocation,
Shared Chat and dropped sends remain unverified; so do a real tunnel/remote OBS room cookie,
OBS frame pacing/audio autoplay and the roar by ear. Perform those human checks before the live
session; use single mode if the partner integration is not ready.

## 2026-10-31 — duplicate Twitch authorization fix

OpenAI Codex session/thread ID: `01a1945a-b68a-7033-a1fe-3d0b3cc336f1`, read from
`CODEX_SESSION_ID` and `CODEX_THREAD_ID`. Fixed the reported repeated-Connect bug: existing
connected/connecting/reconnecting identities receive HTTP 409 with an explicit sign-out message;
concurrent requests share one device-code request/poller. Codes clear on success, failure, expiry
and cancellation, with controller ownership protecting newer flows. Connect is hidden/disabled
while authorizing or connected; HTTP errors remain visible inline. Documented the behavior in
`DESIGN.md`; added service, HTTP and control browser regressions without changing frozen interfaces.

Verification: `pnpm format`, `pnpm typecheck`, `pnpm test` (238 tests), `pnpm lint`, `pnpm build`
and `pnpm verify:server` passed. The compiled `pnpm start` also passed a credential-free live-mode
smoke on port 3197, then its verified owned process was stopped (the wrapper's exit -1 reflects
that intentional stop). `pnpm test:e2e` passed all 38 tests, including the new conflict-message
check and disabled/hidden Connect assertions, on port 3100. Both owned test ports were confirmed
unreachable after cleanup.
The owner's port-3000 server was not stopped or restarted. No commits/pushes or manual `.env*`
reads were performed. This session did not authorize real Twitch accounts or retest live Twitch;
the reported live failure motivated the fix, while verification used fakes and local Chromium.

## 2026-10-31 — live crossover test blocked by browser login

Codex session/thread ID: `01a19464-c8a5-7641-bf02-7676cd6ffa75`, read from
`CODEX_SESSION_ID` and `CODEX_THREAD_ID`. Used T3 preview browser automation with its
Incognito profile to open `https://www.twitch.tv/efaoangssm`. That profile displayed
Log In / Sign Up and was not authenticated; stopped under the user's login stop rule.
No chat messages were sent, no CALL was started, and channel B was not opened.
This is a BLOCKED live test, not a product failure or a verified EventSub result.

At 20:57:08.905 -03:00, GET `/api/state` showed live mode, Twitch connected as
`efaoangssm`, phase idle, A 0/3, B 0/3, crossovers 0 and lastChat null.
After observing the logged-out page, closed the only opened tab and POSTed
`/api/reset`; at 20:57:21.625 -03:00 the reset returned `{ ok: true }` and the
same idle snapshot values remained (roundId null, revision 0, connected).
Screenshot: `C:\Users\alios\.t3\userdata\browser-artifacts\browser-screenshot-www-twitch-tv-mvx292ae-0c9e74c9.png`.
The owner must authenticate `efaoangsam` in the automation-accessible browser
profile, then rerun the requested two-chat 90-second test. The earlier zero-count
round remains undiagnosed. No source files changed, no commits, no credentials
read or entered, and the existing server was not stopped or restarted.

## 2026-10-31 - CDX-1 seam artwork presets

OpenAI Codex session/thread ID: `01a194b7-1fa1-7df1-9213-da7b4c07bf8b`, read from
`CODEX_SESSION_ID` and `CODEX_THREAD_ID`. Added HEART (default) and FACE before the existing
presets, including thumbnails, a bicolor axis split, paper heart outline/seam highlight and
asymmetric open-eye/wink expression. Showcase artwork mirrors the builder; single uses HEART.
Added palette/dimension, colour-side exclusion, highlight/asymmetry and showcase equality tests,
plus separate A/B/joined comparison PNGs under `test-results/overlay/seam-*`.

Verification: `pnpm format` PASS; `pnpm typecheck` PASS; `pnpm test` PASS (15 files,
240 tests); `pnpm lint` PASS; `pnpm test:e2e` PASS (39 tests, 5.7 minutes);
`pnpm build` PASS; `pnpm verify:server` PASS (17 PASS checks, both ephemeral servers stopped).
An initial typecheck failed because a browser test referenced DOM types in the Node-only tsconfig;
fixed with a typed canvas probe before the full passing run. Logs: `test-results/verification/cdx1-*`.
Inspected the showcase overlay and isolated HEART A/B/joined and FACE comparison PNGs. The
joined heart is obvious and aligned at 47|48. A alone is an orange lobe/wedge, B a blue opposing
lobe/wedge; each lacks the complete symbol. FACE halves each retain facial clues; the wink is
complete only when joined. These are contextual judgements, not an independent blind test:
both subjects can still be guessed from a fragment. Kept HEART as the audit's fallback and
recorded this recognition limitation in `../entrega/vision-check.md`. UNITE remains a later gate.
README and DESIGN updated. Commits/trailers, human blind tests, OBS performance/audio and live
Twitch checks are deferred. No port-3000 control calls, restarts, credentials reads or remote
operations were performed.

## 2026-10-31 - CDX-3 (a), (b), (c): honest titles and participation cues

OpenAI Codex session/thread ID: `01a194b7-1fa1-7df1-9213-da7b4c07bf8b`, from the same
`CODEX_SESSION_ID` / `CODEX_THREAD_ID` environment values. Replaced the overlay title's
communities claim with 2 STREAMS; retained conditional aggregate CROSSED OVER copy. Added the
2.8-second opening CTA, its persistent 28px HUD chip until local readiness, and the lagging-side
THEY'RE WAITING ON YOU banner with exact singular/plural remaining counts. The ready-side
WAITING banner now reports the partner's remaining count too. Cached sprites and fixed frame
keys preserve the renderer's bounded per-frame work. Reduced motion keeps scale cues static.

Added browser cases on both sides for opening/chip/readiness transitions and urgency, at 1080p
and 720p, plus single/reduced CTA coverage. Inspected `cta-intro-A-720p.png`,
`lagging-B-720p.png`, `showcase-2-waiting-b.png` and `showcase-4-complete-a.png`; no clipping,
the main CTA and the 1 MORE PERSON line remain legible at 720p. Captures are under
`test-results/overlay/` and `test-results/e2e/` and labelled SIMULATED.

Final commands: `pnpm format`, `pnpm typecheck`, `pnpm test` (15 files, 240 tests), `pnpm lint`,
`pnpm test:e2e` (42 tests, 6.5 minutes), `pnpm build`, `pnpm verify:server` (17 PASS checks)
all passed. Initial browser verification caught a stale chip variable reference; fixed it before
this passing run. A subsequent run was intentionally stopped to finish the ready-side remaining
copy and add its assertion; it is not counted as a pass. Evidence logs are `cdx3abc-*` under
`test-results/verification/`. Also ran `pnpm install` (already up to date) and
`pnpm browsers:install` (success, existing local Chromium). README/DESIGN updated.
No live Twitch sends, OBS checks, port-3000 mutations/restarts or git publishing were performed.

## 2026-10-31 - PROD-3: persistent team labels

OpenAI Codex session/thread ID: `01a194b7-1fa1-7df1-9213-da7b4c07bf8b` (environment session
values unchanged). Added local-only POST /api/labels with optional A/B strings, 24-character
validation and empty-to-channel-login behavior. Separate Team label controls use TEAM ORANGE /
TEAM BLUE placeholders and preserve unsaved edits during polling. Overrides remain above channel
display names on channel saves and all Twitch state/reconnect synchronizations; runtime label
sanitization and immediate meta pushes are retained. Labels are in-memory and reset on restart.
No frozen engine/protocol/TwitchService contract changed.

Added parser examples + a seeded fast-check property, real HTTP access/length tests, a fake
Twitch reconnect/channel-sync persistence regression, polling meta verification and a control
browser test for save, unsaved edits and clear-to-login. Inspected
`test-results/control/team-labels.png`: fields, saved state, preset thumbnails and preview fit
without clipping. A separate focused browser preflight passed (1 test).

`pnpm format`, `pnpm typecheck`, `pnpm test` (15 files, 243 tests), `pnpm lint`,
`pnpm test:e2e --max-failures=1` (43 tests, 6.5 minutes), `pnpm build`, and
`pnpm verify:server` (17 PASS checks) all passed. Logs: `test-results/verification/prod3-*`.
README/DESIGN updated. Real Twitch reconnect/overlay checks, OBS and commit trailers remain
deferred. The running port-3000 process was not restarted, stopped or sent CALL/RESET.

## 2026-10-31 - CDX-3 (d): UNITE finale

OpenAI Codex session/thread ID: `01a194b7-1fa1-7df1-9213-da7b4c07bf8b`, as read from the
session environment. Implemented UNITE only after CDX-1, CDX-3(a-c) and PROD-3 passed their
full verification gates. Crossover now shrinks the local half and slides in the partner half
into a cached 1920x540 band at y=270..810, scheduled at reveal +3500ms. Fit takes 900ms, followed
by a bounded burst, a 400ms seam flash and a 76px title at y=920. The SIMULATED badge moves into
the band. Reduced motion snaps into place; restored rounds latch the new burst as consumed.
`unite=0` opts out; `fit=seam` suppresses UNITE in preparation for PROD-1. A minimal overlay.js
query change was necessary for that option in addition to the stage/HUD files in the audit.

Added default-mode pixel tests on A and B proving both final HEART colours appear and the
upper area clears, plus opt-out and reduced/late-load cases. The native half-grid pixel tests
explicitly opt out so their original geometry assertions remain intact. Inspected
`test-results/overlay/unite-A.png` and `unite-B-720p.png`: the whole heart reads clearly on
both streams, title fits below the band and the stream is visible above. The focused preflight
passed all 4 new UNITE cases.

`pnpm format`, `pnpm typecheck`, `pnpm test` (15 files, 243 tests), `pnpm lint`,
`pnpm test:e2e --max-failures=1` (47 tests, 5.8 minutes), `pnpm build`,
`pnpm verify:server` (17 PASS checks) all passed. Also smoked `node dist/server/index.js`
(the compiled start entry) on port 3197 with Twitch configuration removed and without loading
.env: 9 assertions passed for health, signed-out state, pages/assets and label save/persistence.
Stopped that exact owned node PID after checking its command line with Get-CimInstance.
Logs: `test-results/verification/unite-*`. README/DESIGN updated. No OBS/live Twitch/audio-by-ear
verification or git publishing; the existing port-3000 process remains untouched.

## 2026-10-31 - PROD-2: help invitation, honest summary and bot exclusion

OpenAI Codex session/thread ID: `01a194b7-1fa1-7df1-9213-da7b4c07bf8b` (same environment
session). Added one crossover help invitation to the ready chat, active only while exactly one
side is ready; its latch retains 16 eligible round IDs. Help uses the existing Twitch queue,
duplicate variation and delivery/drop feedback. Summary now says people across 2 streams.
Added the 12 specified default ignored bot logins plus optional IGNORED_CHATTERS CSV configuration.
The Twitch boundary retains a validated lowercase server-only login; runtime filters it before
recent observation/credit and projects the unchanged engine identity fields. Frozen engine,
public protocol and TwitchService facade contracts are unchanged. The blank configuration was
appended to .env.example without reading any .env file. README, DESIGN, SPEC, TWITCH_NOTES and
the Twitch module rules document the boundary/queue change.

Added 6 tests covering help once per round/phase/mode, clamping/suffix/history bounds, default
and configured bot baseline/credit exclusion, normalization, EventSub validation/privacy and
fake-transport HTTP/runtime integration across two rounds. Updated the internal EventSub expected
identity to include only the necessary login; public-payload privacy assertions now also reject
chatterLogin. A review found an asymmetric-send interaction: A-only help hid B's previous CALL
from the global duplicate tracker. Added an assertion that failed (1 failed, 25 skipped), then
replaced it with two per-target records, selecting the largest required take suffix. The same
regression passed (1 passed, 25 skipped), followed by the full passing verification.

Final commands: `pnpm format`, `pnpm typecheck`, `pnpm test` (15 files, 249 tests), `pnpm lint`,
`pnpm test:e2e --max-failures=1` (47 tests, 6.5 minutes, command exit 0), `pnpm build`,
`pnpm verify:server` (17 PASS checks) all passed. The browser run printed a pnpm child
ELIFECYCLE exit 1 during webServer teardown after all tests passed; the runner returned 0.
The compiled entry also passed 9 assertions on owned port 3197 without .env loading or Twitch
configuration, then its verified owned process was stopped. Logs: `test-results/verification/prod2-*`.
No actual Twitch messages were sent for verification, and the existing port-3000 connection
was not used, restarted, stopped or sent CALL/RESET. Live help delivery/OBS and publishing remain deferred.

## 2026-10-31 - CDX-3 (e): automatic reveal retirement

OpenAI Codex session/thread ID: `01a194b7-1fa1-7df1-9213-da7b4c07bf8b`, unchanged environment
session values. Complete rounds now DROP after title hold/fade +4000ms: 18.4s from reveal for
UNITE, 17.7s for separate halves/single. UNITE uses a 9s title hold to keep that timing after
its later title entrance; other layouts retain 10s. hold=1 keeps the picture until RESET/new
CALL. The joined band moves down with DROP, reduced motion clears directly, and the server
remains complete. Repeated snapshots and late loads cannot resurrect a retired stand.

Added four retirement/hold/motion/mode browser cases, an already-retired load case and a
full-motion late-UNITE case that verifies its burst latch inside the live grace window. The
initial focused run caught a timing mismatch: retaining the original 10s UNITE title would
retire at 19.4s. Shortened that title hold by 1s and reran: all 7 focused cases passed.
Inspected `test-results/overlay/auto-retire-crossover-hold-false-reduced-false.png` (empty
canvas over the synthetic stream backdrop) and the corresponding hold-true capture (picture
retained). Reconnect, muted, reduced-motion, single and normal paths are covered.

`pnpm format`, `pnpm typecheck`, `pnpm test` (15 files, 249 tests), `pnpm lint`,
`pnpm test:e2e --max-failures=1` (53 tests, 7.2 minutes), `pnpm build`,
`pnpm verify:server` (17 PASS checks), and the compiled entry smoke (9 assertions on owned
port 3197, no .env/Twitch configuration) all passed. The compiled child was stopped by its
verified owned PID. Logs: `test-results/verification/retire-*`. README/DESIGN updated.
A comparison against the earlier snapshot also confirmed all four frozen contracts and the
historical CODEX_LOG prefix unchanged. OBS/live Twitch and git publishing remain deferred;
the running port-3000 process was not touched.

## 2026-10-31 - PROD-1: seam fit, facecam holes and layout URLs

OpenAI Codex session/thread ID: `01a194b7-1fa1-7df1-9213-da7b4c07bf8b`, read from the session
environment and retained for every workstream. Added fit=seam with scale clamped 0.4-0.9 (default
0.62): A anchors right, B left, both centred vertically, with UNITE disabled. One fixed native
canvas makes all cached sprites/particles follow the same composition without per-frame object
allocation; Full keeps the original direct render path. The edge card extends one physical
pixel to the seam. Added clipped integer cutout=x,y,w,h, ignored malformed/off-canvas holes,
and rounded 6px side-colour frames at current stand visibility. Both requested facecam presets
are available. Banners avoid the hole; the compact 76px UNITE title drops its team kicker and
moves above the band for bottom-corner cameras, preserving the count/crossover line.

Control On-stream layout radios rewrite A, local B and partner B URLs/Copy values, preserving
the room token. Added three parser/property unit tests (including 1000 seeded rectangle cases),
five browser layout cases and one control URL/clipboard case. Tests verify hole alpha/border
RGB, banners clear of the camera, physical seam anchoring, UNITE suppression and a pixel-identical
native/invalid-parameter render with reduced motion for a stable comparison. The first comparison
used an animated HUD and differed; its stable replacement passes with hashes instead of dumping
large image strings. Visual inspection also caught a fading stale lag banner over a catch-up
UNITE snapshot; participation cues now stop drawing once UNITE starts, with a visible-alpha
regression assertion. The focused layout suite passed 5 tests and the control preflight 1.

Inspected `test-results/layout/facecam-A-waiting.png`, `facecam-A-unite.png`,
`seam-fit-A-720p.png`, `seam-fit-B-720p.png` and `test-results/control/on-stream-layout.png`.
The camera is transparent, critical text remains whole, both seam anchors align to the edge,
and the 720p composition is legible. README now places the new behavior in setup/OBS guidance
with a layout table; DESIGN describes implementation/timing and limitations. Supplemental
inspection of isolated FACE A/B crops confirms facial clues remain: HEART stays the audit's
fallback, and strict independent blind recognition is not claimed (`../entrega/vision-check.md`).

Final required commands, all exit 0: `pnpm format`; `pnpm typecheck`; `pnpm test` (16 files,
252 tests); `pnpm lint`; `pnpm test:e2e --max-failures=1` (59 tests, 6.4 minutes); `pnpm build`;
`pnpm verify:server` (17 PASS checks). The final compiled entry `node dist/server/index.js`
also passed 10 assertions on owned port 3197, including the new layout module, with Twitch
configuration removed and no .env loading; its exact owned node was stopped after command-line
verification with Get-CimInstance. Evidence: `test-results/verification/layout-*`.
All four frozen contracts and the historical CODEX_LOG prefix compare unchanged with the earlier
snapshot. Every workstream has its own appended entry and passing full verification.

Deferred: OBS CEF performance/audio and live player/real Twitch checks, human rehearsals/blind
studies, commits/tags/pushes/trailers, and the optional countdown tick. No new audio was added.
No actual Twitch messages or port-3000 CALL/RESET were sent, and that existing process was not
restarted or stopped. Server upgrades are built but await a later permitted restart of the live
process; this session verified only isolated fakes/SIMULATED browsers and owned test servers.

Final cleanup audit: ports 3100/3197 have no listeners and the sole project server is the
original live node PID 110396. A first combined diagnostic returned exit 1 because the native
copy search/no-listener query found no matches; an explicit absence assertion rerun passed.
Frozen files and the historical log prefix were checked again after formatting and passed.

## 2026-11-01 - Demo-video polish from entrega/codex-fixes/BRIEF.md

OpenAI Codex session/thread ID: `01a194b7-1fa1-7df1-9213-da7b4c07bf8b`, read from `CODEX_SESSION_ID` and
confirmed against `CODEX_THREAD_ID`. Applied the local stunt-engine and overlay-visual-check
skills. This entry records the new follow-up brief after the overnight work above.

The crossover showcase now reveals HYPE (HY | PE), so-close uses crossover GG, and single
uses solo GG. `src/sim/showcase.ts` imports the existing DOM-free
`public/control/artwork.js` generator instead of maintaining a second shape implementation.
The returned showcase artwork/pixels stay frozen, and public/ remains beside dist/ as required
by the existing static server. Control defaults to A + B (`versus`) in crossover and HEART in
single, remembering explicit preset selections per mode (`public/control/control.js` and
`index.html`). HEART remains available.

`public/overlay/stage.js` now uses `<n> CROSSED OVER TO HELP THE OTHER SIDE` for positive
crossovers and `NEITHER CHAT COULD DO IT ALONE` for zero. The 76/92px titles and compact
facecam variant remain. Visual inspection caught the SIMULATED badge covering the upper-left
H stem during UNITE; it now sits above the joined band and below finished native artwork
(on the opposite corner for a left camera hole). A pixel regression assertion protects that
H stem. `.env.example` replaces the scaffold comment with the Public Twitch Client ID/no
client secret instruction and corrects the stale loopback/token comments. No actual .env or
data files were read. README.md and docs/DESIGN.md describe the new defaults and artwork.

Added four unit cases in `test/showcase.test.ts` for the three scenario presets, frozen results
and default HYPE. Added six browser cases across `test/e2e/control.spec.ts`,
`overlay-render.spec.ts` and `overlay.spec.ts`: per-mode defaults/remembered choices; zero,
singular/facecam and 3000/minimum-scale completion copy; isolated early-refinement crops; and
both real SIMULATED HYPE reveal overlays. Copy checks record the actual painted strings,
font sizes and measured bounds; they force reduced motion so confetti cannot mask the sampled
H pixel. The real demo hero case retains full motion.

Opened and inspected `test-results/e2e/polish-hype-unite-A.png` and
`polish-hype-unite-B.png` from the owned port-3100 demo: HYPE is obvious on both, the badge
clears the letters, and the completion banner fits below the band. Native captures
`polish-hype-native-A.png` / `polish-hype-native-B.png` read HY / PE after the title fades.
Opened `test-results/overlay/polish-copy-0.png`, `polish-copy-1.png`,
`polish-copy-1-720p.png` and `polish-copy-3000-720p.png`: zero/positive copy fits, the compact
banner clears the camera, and the longest copy fits at seam scale 0.4 (naturally small at
720p). Opened the step-3 HYPE A/B, GG crossover A/B and GG single A crops under
`test-results/overlay/polish-conceal-*`: they are coarse color blocks with no readable letters.
Steps 0, 1 and final crops are also saved. This is a visual judgment, not a blind-recognition
study. Also inspected the real single completion capture; GG remains identifiable.

Final required commands all exited 0: `pnpm format`; `pnpm typecheck`; `pnpm test`
(16 files, 256 passed); `pnpm lint`; `pnpm test:e2e --max-failures=1` (65 passed, 8.7 minutes);
`pnpm build`; `pnpm verify:server` (17 PASS checks). Full logs:
`test-results/verification/polish-*.log`. The compiled entry
`node dist/server/index.js --demo` additionally passed 21 assertions on owned loopback port
3197, checking SIMULATED mode, public module routes and all three generated showcase plans.
It ran without .env loading or Twitch credentials; its exact owned PID was checked with
Get-CimInstance and stopped. Evidence: `test-results/codex-fixes/compiled-demo-final.log`.

All four frozen contracts compare unchanged against the task-start SHA256 manifest, and all
historical CODEX_LOG bytes were preserved before this append. A final Windows cleanup query
briefly reported port 3197 with OwningProcess 0; direct TCP probes confirmed ECONNREFUSED on
both 3100/3197, and all three owned server PIDs were absent. No commands or API requests targeted the existing port-3000
server, no real Twitch messages were sent, and no commits/pushes/tags were made. OBS CEF,
real Twitch and audio-by-ear remain unverified. Only local Chromium/SIMULATED behavior is
claimed here.

## 2026-11-01 - Broadcast v3 redesign and final capture-review polish

OpenAI Codex session/thread: `01a194b7-1fa1-7df1-9213-da7b4c07bf8b`, read from
`CODEX_SESSION_ID` and `CODEX_THREAD_ID`. Implemented `entrega/codex-v3/BRIEF.md`
and the follow-up review in the same session, using the repository's
`overlay-visual-check` and `stunt-engine` instructions, plus the frontend-design
and animate skills. This entry covers the complete v3 change; earlier entries are
historical evidence for earlier packages.

Built a restrained broadcast package: self-hosted OFL Archivo and Geist Mono,
central typography/motion tokens, neutral glass with shadow bleed, fixed-width
rolling matchup counts, a quiet CTA, hatched whole-picture previews with correct
B attribution, unified lower thirds, calm SIMULATED identification and closed
captions. Font readiness triggers one cached-sprite refresh. Remote fonts and
licenses have byte-identical copies under the existing protected overlay asset
boundary; the only server behavior edit is explicit `font-src 'self'` CSP.
Two damaged server comments were repaired without changing their code.

Matte card atlases now include bounded deterministic 2.5% grain, a cosine flip
with midpoint face swap, edge shading and a short landing glint. The shared-clock
wave lifts 10px, scales to 1.06 and settles once with a 1.6px overshoot; its window
is bounded to 18 columns and texture drawing is batched. Finale stats count and
stagger in; zero crossovers retains the cooperation explanation. SO CLOSE dims
and desaturates. Reduced motion uses fades/brightness, and fewer dragged confetti
pieces stay behind the copy. Engine timing, sound and caption scheduling remain
unchanged. A 600ms post-wave stat delay clears the native/single/seam caption;
native retirement is reveal+18.3s and UNITE reveal+18.4s.

Control/dev now share the fonts, surfaces and focus/motion tokens. Matchup and
whole-picture preview lead; CALL is the white primary action/running bar; Reset
keeps its quiet two-click confirmation. Advanced quorum settings start closed,
and invalid hidden inputs open the disclosure before focus. Picker tiles use
neutral selection rings. Minimum seam scale uses an output-size two-row score
bug, readable badges/captions, compensated result labels and a three-line zero
explanation. The redundant tiny thumbnail is omitted there. README credits and
verification claims, DESIGN's visual system and SPEC were updated.

The final user review added three polish fixes: READY's check reserves 6px from
the cached glyph ink and sits on the count baseline; control counts align under
their team names with people as a quiet baseline suffix; the detached finale logo
was removed so its eyebrow stays centred. No per-frame text measurement was added.

Added four unit tests (font/CSP/protected asset equality plus motion bounds,
including 1,000-run seeded fast-check), and twelve browser tests across the v3
work: real capture sequence, font loading/24-character labels/hot-frame budget,
all presets, matte flip/grain/reduced fade, three caption-clearance layouts,
preview attribution, minimum-seam zero fit, READY ink spacing/baseline in normal
and compact layouts, and matchup name/count alignment at 1080p and 720p. Existing
pixel/copy/layout/control timing assertions were updated; privacy and A|B seam
checks remain in place.

Final full verification, after the three polish fixes, used
`test-results/verification/run.ps1 broadcast-v3-polish` with
`V3_POLISH_CAPTURE=1` for selective curated captures. All three relevant Playwright
projects ran: demo, overlay-render and control. Seven commands exited 0:

| Command                          | Exact result                                 |
| -------------------------------- | -------------------------------------------- |
| `pnpm format`                    | exit 0                                       |
| `pnpm typecheck`                 | exit 0                                       |
| `pnpm test`                      | exit 0; 260 passed in 17 files               |
| `pnpm lint`                      | exit 0; all matched files use Prettier style |
| `pnpm test:e2e --max-failures=1` | exit 0; 77 passed in 10.6 minutes            |
| `pnpm build`                     | exit 0                                       |
| `pnpm verify:server`             | exit 0; 17 PASS checks                       |

Per-command outputs and explicit exits are in
`test-results/verification/broadcast-v3-polish-*.log`. The compiled demo smoke
(`powershell -NoProfile -ExecutionPolicy Bypass -File test-results/codex-fixes/compiled-demo.ps1`)
also exited 0: 27 assertions covering shared artwork/static routes and all three
showcase presets. It started an owned credential-free server on 3197, verified
its command line with Get-CimInstance and stopped PID 26132. Output:
`test-results/design/compiled-demo-polish.log`. The earlier compiled smoke also
passed 27 assertions and stopped owned PID 82172.

The earlier complete pre-polish run also exited 0 for all seven required commands:
260 unit tests, 75 browser tests and 17 server checks
(`test-results/verification/broadcast-v3-verified-*.log`). Earlier failed attempts
were corrected rather than counted as passing: formatting, a flip assertion that
ignored intended edge shading, timeout/retirement assertions using old timing,
and minimum-seam zero text that was too small. The final polish preflight first
found a 10px visible tick gap caused by atlas padding; cached ink metrics corrected
it. A new control test initially evaluated a function string incorrectly; the
page expression was corrected. Both polish regressions then passed (2/2).

Visual evidence: `test-results/design/contact-sheet.png` indexes 35 source
captures; `test-results/design/critique.md` gives each image a judgment, records
the iterations and states accepted tradeoffs. `captures.json` records exact source
hashes/dimensions. The initial 35 sources and contact sheet were each opened
individually. The final follow-up opened only four downscaled PNG views, under
the requested image budget, in `test-results/design-polish-review/`: control,
score, finale and final-review. The latter includes the corrected control detail
and refreshed contact sheet. The initial review-detail crop missed the counts;
the artifact was corrected in the fourth view. The product did not need another
change. Curated intro/wave/timeout/dev/long-label captures were preserved.

The visual iterations fixed clipped sprite shadows, pale-background thumbnail
labels, incorrect B attribution, scrolled control captures, unreadable small-seam
copy, native caption/stat collision and the zero-crossover explanation. Final
READY checks separate cleanly on every preset; the count/name stacks and suffixes
read as one group; the finale eyebrow is balanced in full/single/facecam/minimum
layouts. Accepted limits: some lower native artwork rows meet the lower third
(including BOSS's decorative bottom bar); minimum-seam supporting text remains
compact; a deliberate facecam hole can remove artwork while critical copy moves
clear of the preset holes. No further visual iteration was warranted.

Latest real-clock Chromium sample at 1920x1080 and n=3000 per side:
idle 53.409 fps / p95 33.3ms / 81 frames;
static 57.525 fps / p95 16.8ms / 116 frames;
flips/reveal 43.381 fps / p95 33.4ms / 261 frames.
Maximum reported update/draw window average 9.7895ms, worst JS frame
12.7ms, observed crest 16 columns (bound 18), reported rounded heap
10,000,000 bytes. Source: `test-results/design/frame-pacing.json`. The earlier
full sample was 46.576 active fps and is preserved in `frame-pacing-pre-polish.json`;
the focused preflight was 49.53. These varying samples support no sustained-60fps
or causal performance claim. OBS CEF/game-load frame delivery still needs a real
rehearsal; the v3 visual package has Chromium validation only.

The four frozen contract SHA256 values match the task-start manifest. All 22
snapshot files under engine/shared/Twitch/sim remain byte-identical; the engine
stays pure. All 44,256 historical CODEX_LOG bytes were preserved before this one
append. Final prefix/hash/source checks are reproducible with
`test-results/design/integrity.py` and recorded in `integrity.json`.

Owned PIDs 61288, 26132 and 82172 are absent. Windows transiently listed 3197 with
OwningProcess 0, and the first Python timeout probe returned WSAEWOULDBLOCK; no
process-0 stop was attempted. Direct Node TCP probes confirmed ECONNREFUSED on
both 3100 and 3197. No action or API request targeted the existing port-3000
server, no real Twitch messages were sent, no credentials were opened, and no
commit/push/tag/remote operation was performed. OBS rehearsal, live Twitch with
this redesign, audio-by-ear and sustained 60fps remain unverified. Earlier live
evidence applies to the previous package, as README now states.

## 2026-11-01 - HUD fixes from the real two-channel v3 stream

OpenAI Codex session/thread `01a194b7-1fa1-7df1-9213-da7b4c07bf8b`, from
CODEX_SESSION_ID and CODEX_THREAD_ID. These defects were found during the
operator's real two-channel Twitch stream of v3: efaoangssm + efaoangsam, OBS 33,
real chats. I inspected only the three supplied recording crops:
`live-waiting-A.png`, `bug-wait.png`, `bug-wave.png`.

Production edits are confined to hud.js and its stage call site. Waiting text
shrinks to 40px, then narrows toward normal width before ellipsis; fitting names
retain their team colour. Reveal now shows accent REVEAL between checked READY
sides; other exits blank the clock. The scheduled fade remains. Labels are 18px
(compact 20px), counts/clock 34px and hint 16px, with taller glass and an 8px hint
gap. Preview clearance and viewport/seam transforms remain unchanged. Updated
README/DESIGN with the live-stream provenance and new HUD rules.

Three new layout regressions cover both 10-character logins, wide/narrow
25-character fixtures, text bounds/colour, font minima, six rendered accent
REVEAL glyphs, READY sides and clean exits at 1080p, 720p and minimum seam fit.
The existing tick crop was enlarged for the new type; hot-frame caching checks
remain. A focused run passed 5/5 after choosing 18px native labels to fit both
logins.

Commands: `pnpm format`, `pnpm typecheck`, `pnpm test` (260/17 files),
`pnpm lint`, and `pnpm build` exited 0. Browser coverage: 9/9 demo tests passed in
the combined run; that command exited 1 on an existing `pauseAt` navigation race.
Both isolated harnesses now pause before navigation. The full rerun
`pnpm test:e2e --project=overlay-render --max-failures=1` exited 0, 60/60 passed,
including the three new regressions: 69 relevant browser cases in total. No
production behavior or assertion was relaxed for the clock repair. Exact outputs
are in `test-results/live-hud-fixes/{final-*,test,summary}.log`.

Curated 12 affected active/waiting/maximum-label/reveal captures under
`test-results/live-hud-fixes/`; reviewed in four downscaled PNG views, including a final waiting-only sheet
after the harness clock repair.
Full names retain blue emphasis, enlarged chrome clears the preview, and only
the widest maximum fixture needs ellipsis. Judgments are in `critique.md`.

Frozen contracts and every historical log byte are preserved. Owned test servers
are absent by PID/port checks; cleanup evidence is in this capture
directory. Port 3000 was untouched, no real Twitch messages were sent, and no git
operation was performed. The corrections still await a subsequent live OBS check.

## 2026-11-01 - Final submission documentation and live HUD recheck

OpenAI Codex session/thread `01a194b7-1fa1-7df1-9213-da7b4c07bf8b`, read from
CODEX_SESSION_ID and CODEX_THREAD_ID. Recorded the operator-reported live recheck
of the HUD corrections on 2026-11-01, 16:35?16:43 Chile time (UTC?3): efaoangssm
and efaoangsam, OBS 33, real chats, two crossover HYPE rounds, one single GG round
and one SO CLOSE round. The operator reports OBS recordings showing the full
blue waiting name, READY / REVEAL / READY and larger HUD. This was not a live
session observed by OpenAI Codex; all other unverified items remain.

Updated README Status, Tests and evidence, Innovation, the short v3 Design
section, and Quickstart/control labels (Advanced, Call the stunt, Reset round /
Confirm reset). Updated SPEC's current verification status. Copied the four
operator-supplied JPGs unchanged into docs/media, added an alt-text hero and
three-image gallery, and noted that the demo video/submission are on Devpost.

`pnpm format`: exit 0. `pnpm lint`: exit 0, all matched files use Prettier style.
Checked media paths, byte-identical copies, unchanged unverified lists and all
111 protected product-file hashes. Historical log bytes are preserved. This pass
changed documentation/media only; no server was started (including port 3000),
no product behavior changed, and no commit or push was made. Evidence/check logs:
`test-results/docs-final-pass/`.
