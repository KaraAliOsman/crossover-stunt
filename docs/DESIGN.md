# Crossover Stunt — integration design

Implementation contract for every module. `docs/SPEC.md` is the product scope; this file pins the
interfaces so modules can be built in parallel. Shared contracts already exist in code and are
**frozen** unless a change is applied to every consumer at once:

- `src/engine/types.ts` — engine + public data types (Snapshot, RefinementPlan, Artwork…)
- `src/engine/artwork.ts` — grid constants, palette, regions, `parseArtwork`
- `src/shared/protocol.ts` — WS/HTTP message shapes (PROTOCOL_VERSION 2)
- `src/twitch/service.ts` — `TwitchService` facade used by the server

## Grid, palette, artwork

- One overlay = 1920×1080 = **48×27 cards** of 40 px (card face 36 px + 4 px gap).
- Crossover full image = **96×27** (side A = columns 0–47, side B = 48–95). Single = 48×27 on A.
- `PALETTE` has 8 fixed colors; artwork is palette indices (row-major). Index order is protocol.
- Artwork is produced in the browser (control page) from presets, text (bitmap pixel font) or an
  uploaded image (cover-fit + nearest-palette quantization), then sent with `POST /api/call`.

## Engine (`src/engine/`, pure)

`step(state, event, now)` — see the doc comment in `engine.ts`. Additional rules:

- Never mutate inputs; return the same object when nothing changes (cheap equality).
- `CALL` validates merged config (durationMs 10 000–180 000, minQuorum 1–1000, ratio (0,1],
  overrides 1–1000 or absent); invalid config → throw `RangeError` (server maps to HTTP 400).
- Credit rules: dedupe on `messageKey` within the round; a chatter counts once per side; in single
  mode only side A credits; chats at `now >= deadlineAtMs` never credit (TICK may not have run).
- `crossovers` (snapshot) = |participants(A) ∩ participants(B)| in crossover mode, else 0.
- `toSnapshot`: progress = min(1, participants / quorum); ready = participants ≥ quorum;
  side B in single mode reports zeros/ready=false.

`buildRefinementPlan` — contract in `quadtree.ts`. The server builds one plan per required side on
CALL (`sideRegion(mode, side)`), and sends them in `RoundPayload`. Overlays render
`stepsToShow(plan, progress, revealed)` steps where `revealed` = phase ∈ {revealing, complete}
and `now >= revealAtMs` (before revealAtMs the final layer is still hidden). The per-step cost
is bounded: ≤ 1295 steps per side (each split adds ≥ 1 leaf on a 1296-card region).
`preRevealCount` is `ceil(0.8 × steps.length)`, capped at `steps.length - 1` for non-empty plans:
even a picture needing only one split must retain hidden detail while its partner is unfinished.
Uniform regions have no splits or additional detail to hide.

Tests (vitest + fast-check, `test/engine.test.ts`, `test/quadtree.test.ts`): spam invariance,
duplicate delivery, repeated chatter, deadline boundary (chat exactly at deadline), quorum freeze
(recent chatters after CALL do not move quorum), single vs crossover gating, timeout, RESET,
no input mutation, deterministic replay; plan: leaves tile the region exactly (area + no overlap),
applying all steps reproduces the artwork, determinism, preRevealCount bounds, uniform artwork →
0 steps.

## Server (`src/server/`, `src/sim/`)

### Runtime adapter — `src/server/runtime.ts`

`createStuntRuntime({ now, simulated, onTransition })` owns engine state, revision counter,
current `RoundPayload`, labels and config. API: `call(request)`, `reset()`, `chat(event)`,
`tick()`, `snapshot()`, `round()`, `subscribe(listener)`. A 250 ms interval calls `tick()` only
while phase is active/revealing. Snapshot pushes are coalesced to ≤ 10 Hz, but phase changes,
CALL and RESET push immediately. `onTransition(from, to, snapshot)` lets the server send chat:

- CALL (live only): to every required side: `STUNT! Type anything in chat — <N>s. <A label> + <B label>: one picture, neither chat can finish it alone.` (single mode: `STUNT! Type anything in chat — <N>s. Every new person sharpens the picture.`)
- reveal (live only): `<total> people across 2 streams made this · <crossovers> crossed over` (single: `<n> people made this`).
- An announcement identical to the previous one within 30 s (Twitch `msg_duplicate`, e.g. CALL → RESET → CALL) gets a ` (take N)` suffix.
- timed-out (live only): `SO CLOSE — <A label> <pA>/<qA> · <B label> <pB>/<qB>`.
- Messages ≤ 500 chars, no chatter names. Demo mode never sends anything to Twitch.
- Ignore chat whose `chatterId` equals the signed-in sender's user ID (our own messages echo back).

### HTTP + WS (`http.ts`, `wsHub.ts`, `routes/*`)

Static files: serve any file under `public/` with extension `.html .js .css .svg .png .woff2`
through a safe resolver (no `..`, no absolute paths, decode once). Aliases: `/` and `/control` →
`control/index.html`, `/overlay/a` and `/overlay/b` → `overlay/index.html`, `/dev` →
`dev/index.html`. Keep the existing security headers/CSP.

Routes (JSON in/out, `Cache-Control: no-store`):

| Method | Path                                 | Access      | Behavior                                                                                                      |
| ------ | ------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                        | any         | `{ ok, simulated }`                                                                                           |
| GET    | `/api/snapshot?round=<id>`           | overlay     | `SnapshotResponse` (`round` only if id differs)                                                               |
| GET    | `/api/state`                         | local       | `ControlState`                                                                                                |
| POST   | `/api/call`                          | local       | `CallRequest` → 202 `{ roundId }`; 400 invalid; 409 if active/revealing or (live) Twitch chat not `connected` |
| POST   | `/api/reset`                         | local       | → idle, round = null                                                                                          |
| POST   | `/api/auth/start`                    | local, live | `{ userCode, verificationUri }`; 409 when already connected or completing authorization                       |
| POST   | `/api/auth/signout`                  | local, live | clears tokens                                                                                                 |
| POST   | `/api/channels`                      | local       | `ChannelsRequest`; 400 bad/unknown login, 409 not signed in, 502 Twitch; demo: labels only                    |
| POST   | `/api/share/start` `/api/share/stop` | local       | cloudflared quick tunnel (should)                                                                             |
| POST   | `/dev/chat`                          | local, demo | existing validation; feeds runtime in ~10 ms slices (yields between); `{ accepted, added }`                   |
| POST   | `/dev/showcase`                      | local, demo | `ShowcaseRequest`; scripted SIMULATED round                                                                   |
| GET    | `/ws?side=A\|B`                      | overlay     | `ServerMessage` stream (order in protocol.ts)                                                                 |

**Access model.** _local_ = request without proxy headers (`x-forwarded-for`, `cf-connecting-ip`,
`cf-ray`, `forwarded`) AND (for POST) same-origin `Origin` (or absent) AND JSON content type.
Requests carrying proxy headers are _remote_ (they came through the tunnel): remote clients may
only GET `/overlay/b`, overlay static assets, `/api/snapshot` and `/ws?side=B`, each with
`room=<ROOM_TOKEN>` (constant-time compare; token = 24 random bytes base64url generated at start,
never logged except inside `overlayUrls.partnerB`). Everything else remote → 403. Local clients
need no room token. Overlay JS appends `room=` to its own `/ws` and `/api/snapshot` URLs. Module
imports and the stylesheet cannot carry it, so a valid remote `GET /overlay/b?room=TOKEN` sets the
`crossover_room` cookie (HttpOnly, Secure, SameSite=Strict, Path=/, 12 h) and remote overlay
assets, `/api/snapshot` and `/ws?side=B` accept either the cookie or `?room=`. Remote clients only
get files under `/overlay/`. A non-loopback `Host` is treated as remote (DNS rebinding defense) and
local WS upgrades with a foreign `Origin` are refused. Host binding stays loopback (`127.0.0.1`).

`--demo` (`pnpm demo`): no Twitch; labels default to `LEFT STAND` / `RIGHT STAND`;
`snapshot.simulated = true`; `/dev/*` enabled. `pnpm demo --autoplay` loops `/dev/showcase`
(crossover → so-close → single) every ~25 s for unattended judging and Playwright.

Live mode (`pnpm dev`/`pnpm start`): requires `TWITCH_CLIENT_ID` (else the control page shows
setup instructions and status `signed-out` with an error). `simulated` false; `/dev/*` → 404.

### Showcase scripts (`src/sim/showcase.ts`, pure schedule + server timer)

`crossover`: CALL with a shared HYPE banner artwork across 96×27, quorumOverride A=12,
B=12, 30 s; A gains 1 person every ~900 ms, B lags (starts at 6 s, ~1.3 s per person, last 3 in a
burst) so `WAITING FOR` is visible, then joint reveal. `so-close`: GG artwork, B stops at 9/12 → timed-out.
`single`: single mode, GG, 10 people. Virtual IDs `sim:*`; everything labeled SIMULATED.

## Twitch (`src/twitch/`)

Implement `createTwitchService` (service.ts) on top of `deviceAuth.ts`, `eventsubWs.ts`,
`helixChat.ts`, `normalize.ts` (+ `helixUsers.ts`, `tokenStore.ts` as needed). Follow
`docs/TWITCH_NOTES.md` and `.agents/skills/twitch-eventsub`. Key points: Device Code with
`scopes=user:read:chat user:write:chat`; poll at `interval`, handle `authorization_pending`,
`slow_down` (+5 s), expiry; store tokens in `<dataDir>/tokens.json` (mode 0o600 where
supported); validate on start and hourly; single-flight refresh on 401; EventSub WS: subscribe via
Helix within 10 s of `session_welcome` for each configured channel (condition
`broadcaster_user_id` + `user_id` = token user); keepalive watchdog = keepalive_timeout + 3 s →
reconnect with backoff; `session_reconnect` → connect to `reconnect_url`, switch on its welcome,
then close old (no resubscribe needed); `revocation` → status error (a revocation or fatal
subscription failure of channel B only drops B and keeps reading A); dedupe envelopes by
`metadata.message_id` (bounded LRU 2 000); validate notification payload shape before
`normalizeChat`; drop events whose origin is neither channel. Helix Send Chat: queue with
≤ 20 messages / 30 s, check `is_sent` / `drop_reason`. Shared Chat: track
`channel.shared_chat.begin/end` (no auth) when cheap; if A and B share a session, `say` sends once.
Errors surfaced through `getState().error` must never contain tokens.

`beginAuth()` refuses an existing identity in `connected`, `connecting` or `reconnecting` with
HTTP 409: `Already connected as <login>. Sign out first to switch accounts.` Switching accounts
requires explicit sign-out. Concurrent Connect requests share the initial device-code request;
later requests reuse the pending code and one poller. Once tokens arrive, the code is cleared
immediately and Connect returns 409 while session setup completes. Failure, expiry, sign-out and
stop also clear the code; cleanup from a cancelled flow cannot clear a newer flow. The control
panel hides and disables Connect while authorizing/connected and displays server errors inline.

Accept subscription creation only with `enabled` status and valid returned cost accounting.
HTTP 409 identifies an existing type/condition combination, without proving it targets the current
socket; surface it as a recoverable failure. Connection changes superseded by another save or
sign-out must not open an orphan socket. Device authorization remains cancellable through socket
shutdown and token persistence, and disk saves/deletions are serialized so sign-out wins over an
earlier pending save. Shared Chat EventSub changes take precedence over an older in-flight Helix seed.
An HTTP 429 reset applies to the sender's entire chat queue, across channels; when waiting would
exceed the retry budget, report failure instead of retrying before reset.

Tests with injected `fetch` and a local `ws` server (`test/twitch-*.test.ts`): device-code polling
(pending → success, slow_down, expiry), refresh single-flight, EventSub welcome → 2 subscription
POSTs with correct bodies, notification → onChat, envelope dedupe, Shared Chat duplicate
(`source_message_id`) normalization, keepalive timeout → reconnect, session_reconnect switch,
send queue rate limit + drop_reason.

## Overlay (`public/overlay/`, plain JS + Canvas2D + Web Audio)

Files: `index.html` (transparent, no visible text by default), `overlay.css`, `overlay.js`
(entry), optional helper modules (`render.js`, `audio.js`, `net.js`). Query params: `room`,
`reducedMotion=1|0` (1 forces reduced motion, 0 forces full motion, absent follows
`prefers-reduced-motion`), `mute=1`, `delayMs=<n>` (adds a fixed local delay to all scheduled
timestamps, including the timeout banner, to align two streams), `latencyMs=<0–10000>` (the HUD
countdown reaches 0:00 that long before `deadlineAtMs`, covering stream latency; credit still ends
at `deadlineAtMs`), `debug=1` (fps + clock offset + transport + `rm on|off`).

Network: WS `/ws?side=X[&room]` with exponential reconnect; on close fall back to polling
`/api/snapshot?round=<id>` every 1 s until WS returns. With the socket down and no successful
poll for 15 s the link is `lost` (`forbidden` on HTTP 403): the stand drops but the round is kept,
and it returns without replaying one-shots on the next socket open or good poll. An `active`
snapshot more than 8 s past `deadlineAtMs` is stale (no server tick reached us) and also drops
the stand. Clock offset = **max** over a sliding
window of samples of (serverNowMs − local receive time): network delay only makes that
difference smaller, so the least-delayed sample is the largest. Schedule with
`serverTime = performance-based local now + offset`.
Discard polling responses overtaken by newer WebSocket round/snapshot frames before applying
their round payload. A first snapshot arriving just after a one-shot effect's timestamp marks
that effect as already consumed, including during its live grace window; future effects retain
their normal schedule.

Rendering (single `requestAnimationFrame` loop, one canvas 1920×1080, transparent background):

1. **Idle**: draw nothing (fully transparent).
2. **Stand rises** on a new round (≈600 ms ease-out from bottom; reduced motion: instant).
3. **Cards**: each of the 48×27 cards shows the color of the leaf covering it after applying
   `stepsToShow` steps of this side's plan (replicate `stepsToShow` in JS exactly; it is tiny).
   Maintain a `Uint8Array` of target colors; when it changes, flip the changed cards (scaleY
   1→0→1 over 280 ms, color swaps at midpoint) with a stagger by distance from the split center.
   Cards 36 px rounded 4 px with subtle top highlight; 4 px gaps stay transparent so the stream
   shows through.
4. **HUD** (top center pill): `<label> · <participants>/<quorum> · 0:21` + a progress bar;
   SIMULATED badge top-left whenever `snapshot.simulated` (always visible, not subtle).
5. **Minimap** (top-right, 32:9 for crossover, 16:9 single, ~6 px per card): both sides at their
   current progress (render from both plans), seam line, own half outlined; label
   `THEIR SIDE 7/12` under the other half.
6. **WAITING FOR <other label>**: when own side ready and the other not, pulse own cards' brightness
   and show a banner.
7. **Joint reveal** at `revealAtMs`: zipper glow travels down the seam edge (A: right edge,
   B: left edge) during the first 600 ms; then a wave sweeps left→right across the FULL image —
   global column c flips to its final color at `revealAtMs + 600 + c × (2400 / cols)` ms, so it
   crosses from A into B continuously; confetti (≤ 300 particles, pooled) and a synthesized roar
   (Web Audio: filtered noise swell + low rumble, ~2.5 s, master gain ≤ 0.5) with caption
   `[crowd roars]` bottom center. Title banner `<total> PEOPLE · 2 STREAMS` after the wave.
8. **Timed-out**: banner `SO CLOSE · 9/12` (own side numbers; crossover shows both), cards stay at
   their pre-reveal resolution, fade out after 6 s.
9. **Complete**: retire the stand after the title hold/fade and a 4s pause (about 18s after reveal); hold=1 retains it until RESET or new CALL.
10. Audio: OBS browser sources autoplay; in a normal browser show a small "click to enable sound"
    chip until the first gesture. `mute=1` disables audio but keeps captions.

Performance: precompute per-card leaf mapping incrementally per step; never allocate per frame
except pooled particles; target 60 fps at 1080p in Chromium; `debug=1` shows fps.

## Control panel (`public/control/`) and dev page (`public/dev/`)

Control (`index.html`, `control.css`, `control.js`, `pixelfont.js`, `artwork.js`) — polls
`GET /api/state` every 1 s:

- **Twitch** card: status; "Connect Twitch" → `POST /api/auth/start` → show user code big (masked
  until **Show**, so a streamed panel cannot leak it; Copy code copies the real value) + link to
  verification URI; signed-in login. Live CALL stays disabled until the status is `connected`. Demo mode: banner "DEMO — SIMULATED crowd, no Twitch".
- **Channels**: your channel (A, auto) and partner login (B) → `POST /api/channels`; mode toggle
  Crossover / Single.
- **Picture**: presets (`A + B` using both labels, default in crossover; `HEART` default in single, `FACE`, `GG`, `HYPE`, `NEXT: BOSS FIGHT`), custom text
  (1–2 lines, auto-scaled 5×7 bitmap font, fg/bg palette pickers), or image upload (cover-fit to
  96×27 or 48×27, nearest-palette quantization). Preview canvas at 10 px per card with the seam
  drawn between A and B halves. Artwork must match `parseArtwork` exactly.
- **Stunt**: duration (30/45/60 s), min quorum, ratio, optional per-side quorum override; big
  **CALL** (disabled while active/revealing) and **RESET**; live per-side `p/q`, countdown, phase.
- **Overlay URLs** with copy buttons: A, B (same PC), partner B via tunnel (share start/stop).
- **Simulator** (demo only): +1 / +5 / +25 people per side, and showcase buttons.

Dev page: keep the existing injector, add showcase buttons; everything labeled SIMULATED.

## Tests and evidence

- Vitest suites per module (above) + server API tests (call/reset/dev chat change the snapshot;
  remote access rules with proxy headers and room token; static resolver rejects traversal).
- Playwright (`playwright.config.ts`, one config, three projects):
  - `demo` (`test/e2e/overlay.spec.ts`, real `pnpm demo` on port 3100): overlays draw cards after
    `/dev/showcase` crossover and reach the joint reveal; so-close times out without chat and
    fades; single mode; A/B captures at n = 5/25/300/3000 after a CALL; **seam test** (A and B at
    the same progress: `?debug=1` exposes `window.crossoverOverlay.inspect()` and the cards on
    columns 47|48 must equal the plan leaves, checked by debug hook and by canvas pixels, before
    and after the reveal); polling fallback; control panel CALL/RESET against the real server.
  - `overlay-render` (`overlay-render.spec.ts`): overlay alone with mocked `/ws`, paused clock,
    real engine plans: deterministic timeline captures, reduced motion, delayMs, late joiners,
    labels, joint A|B capture, frame pacing (informational).
  - `control` (`control.spec.ts`): control panel and dev page against an in-memory API mock.
- Screenshots go to `test-results/{e2e,overlay,control}/` (ignored); curated ones for the README
  may be copied to `docs/media/`.

### Seam artwork presets

HEART and FACE lead the preset grid. HEART spans columns 28-67 in crossover (22 cards wide
in single), with orange confined to A and sky to B, a paper contour and a two-card seam
highlight. FACE is a 34x24 yellow silhouette with one open eye, one wink and a smile crossing
the axis. The showcase and control panel share the DOM-free preset builder. Crossover uses HYPE,
so-close uses GG, and single showcase uses GG; scenario equality tests pin those choices. Comparison captures include both isolated halves and their joined image.
These silhouettes increase dependence on the seam; recognition of a partial silhouette remains
subjective and is recorded honestly in CODEX_LOG.

### Participation cues

The opening 2.8 seconds show TYPE ANYTHING IN CHAT with the team labels and the spam rule.
It becomes a persistent 28px chip below the HUD until the local side is ready. If the partner
is ready first, the local overlay displays THEY'RE WAITING ON YOU and the exact remaining
people count (singular for one). The ready side's WAITING FOR banner also shows the remaining
count. Urgency pulses gently at 1.3 seconds; reduced motion keeps it static. Completion copy
reports people across 2 STREAMS, plus CROSSED OVER only when that count is positive.

### Team label overrides

Local POST /api/labels accepts optional A/B strings (up to 24 trimmed characters), with the
same JSON, Origin and tunnel protection as /api/channels. Overrides take precedence over
channel display names on every syncLiveLabels invocation, including reconnect and channel saves.
An explicit empty value follows the channel login. Omitted sides remain unchanged. The runtime
still sanitizes labels and pushes meta updates immediately over both overlay transports.
Control inputs preserve unsaved edits while polling. Labels live in memory and reset on server
restart; channel identities and authentication are separate.

### UNITE finale

Crossover defaults to UNITE (`unite=0` opts out; `fit=seam` always disables it). At reveal +
600ms zipper + 2400ms wave + 500ms, the local half shrinks over 900ms and the partner half
slides in after a 200ms delay. A cached 1920x540 final-colour canvas joins at y=270..810 on
both streams. A 400ms seam flash and bounded burst mark the fit. The 76px title enters 300ms
after fitting, centred at y=920. The artwork clears the rest of the stream; title/debug are
separate chrome, and the SIMULATED badge stays above the band, clear of full-bleed text. Reduced motion snaps to the
joined image. Reload restores the composition without replaying bursts. Native per-card seam
pixel tests explicitly use unite=0; dedicated default-mode tests check both joined halves.

### Crossover help and bot exclusion

Exactly one ready side during active crossover sends one help-the-other-chat invitation to the
ready side through the same bounded Twitch queue and delivery-result handling as CALL/summary.
The latch retains at most 16 round IDs. Single, idle, reveal and timeout never send help. Summary
copy counts the union of people across 2 streams, plus the crossover count.

Common bot logins are ignored before engine ingress and recent-baseline observation. Additional
comma-separated logins come from IGNORED_CHATTERS, normalized to lowercase. The Twitch parser
retains only a validated server-only login for this filter; runtime strips it before the frozen
engine identity contract. No login/name enters any overlay payload. Engine and public protocol
contracts, and the TwitchService facade, are unchanged.

Announcement duplicate history is maintained per target side (two bounded records). When a
multi-chat send repeats a target's previous message, the largest required take suffix is used
for both targets. An A-only help message therefore cannot cause B's next CALL to be dropped as
a duplicate. A fake-transport regression covers CALL, A-ready help, RESET and repeated CALL.

### Reveal retirement

In complete, the existing DROP starts after title hold + fade + 4000ms: reveal +18400ms for
UNITE, +17700ms for separate halves/single. The joined band moves down as the stand drops;
reduced motion clears immediately. hold=1 retains the picture until RESET/new CALL. The engine
stays complete and accepts the next CALL; reconnecting or duplicate complete snapshots cannot
raise a retired overlay. Retirement uses server time including delayMs, not snapshot arrival time.

UNITE holds its title for 9 seconds (separate halves/single retain 10 seconds), followed by the
700ms fade and 4-second pause. This keeps the drop near 18 seconds despite UNITE's later title.

### On-stream composition

`fit=seam&scale=0.62` scales the native overlay (clamped 0.4..0.9) toward A's right edge or B's
left edge, centred vertically. It always disables UNITE. A single fixed native canvas preserves
the renderer's sprite/particle transforms before composition; full layout keeps the original
render path. The edge card extends one pixel to the physical seam. No per-frame objects are
allocated. `cutout=x,y,w,h` clears an integer native-canvas facecam rectangle after composition
and draws a rounded 6px side-colour border at current visibility. Invalid rectangles are ignored;
valid ones clip to 1920x1080. Presets: 1440,700,440,340 and 40,700,440,340.

Control On-stream layout radios rewrite A, local B and partner B URLs and Copy values, while
preserving the private room token. Layout choices stay local to that panel session and do not
change server/engine state. Parser properties cover clipping; browser tests check transparency,
border colours, physical seam anchoring, UNITE suppression and native-render equivalence.

Facecam layouts move any intersecting participation/result banner to a clear vertical slot.
For the bottom-corner presets, the waiting banner moves to the centre and the UNITE title moves
above the picture band. Bounds include the urgency pulse and glow. This prevents the requested
post-draw camera clear from cutting critical words. Custom holes that cover every candidate slot
can still occlude chrome; the host controls that crop. No per-frame layout objects are created.

The facecam UNITE title keeps the 76px count and crossover line while omitting its team-label
kicker, fitting above the central band; the normal UNITE layout retains all three lines.

Participation banners are suppressed once UNITE starts, including a catch-up snapshot that jumps
straight from active to a past reveal. A fading stale waiting cue cannot obscure the joined image.

### Demo-video polish (2026-11-01)

Control defaults are remembered per mode: channel-name A + B in crossover, HEART in single;
explicit selections survive mode switches. The showcase imports the same pure artwork source
as the browser (public/control/artwork.js), which ships beside dist/, eliminating the duplicated
shape mirror. HYPE splits HY | PE across the seam; so-close and solo use GG. Early-refinement
crops are saved with the visual checks. Completion copy is CROSSED OVER TO HELP THE OTHER SIDE
when positive, otherwise NEITHER CHAT COULD DO IT ALONE, preserving the 76/92px title variants.
The simulation badge sits above UNITE artwork or below the finished native half, keeping text
presets readable; the left camera preset uses the opposite corner for that native badge.
