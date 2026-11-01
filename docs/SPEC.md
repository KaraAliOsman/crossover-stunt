# Crossover Stunt — Two streams. One picture.

Product specification distilled from `../PROPUESTA.md` section 6 on 2026-10-31. This English document is self-contained for a clean clone; the external proposal is planning context, not a runtime dependency. Defaults below are the implemented MVP decisions; see **Implementation status** for what has and has not been verified.

## Experience

An OBS browser source divides one hidden picture across two Twitch streams. A shows the left half at `/overlay/a`; B shows the right half at `/overlay/b?room=TOKEN`. Each distinct person who types anything in their channel during a 30–60 second CALL earns one quadtree refinement step on that community's side. Repeating messages earns no extra steps. Viewers are never required to type special commands, pay, subscribe or reveal their identity on screen.

The communities must both finish to reveal the complete picture. Each overlay shows a large local half and a full-image minimap with the partner's progress, such as `THEIR SIDE 7/12`. A completed half waits with `WAITING FOR B` (or A). On joint success a zipper closes the seam and a card wave crosses A → B, scheduled from server timestamps, followed by confetti and a synthesized Web Audio roar captioned `[crowd roars]`. Audio is optional; captions and clear states make the scene understandable muted. Timeout displays `SO CLOSE 9/12` and preserves incomplete detail.

Single-channel mode is **Card Stunt**: the same engine renders the whole image on A, requires only A's quorum, and has no partner dependency. It is a first-class daily-use mode and the delivery fallback.

Never show chat text, usernames, chatter IDs, fragments or emotes. Artwork text entered by the host is separate from chat content. Use owned/licensed images and local assets; do not introduce third-party logos or unlicensed music.

## Host journey

1. Open `/control`, authorize the public Twitch client, choose single/crossover, and identify channel B if needed. Resolve channel names to immutable user IDs server-side.
2. Add the relevant URLs as OBS browser sources. Aim for five-minute setup. Room tokens authorize read-only partner overlays; they are separate from Twitch credentials.
3. Choose an owned image or generate an image from host-entered text, set duration, then CALL. Send a prompt such as `STUNT! Type anything — 45 s` to both communities.
4. Display partial refinement, uneven WAITING, synchronized success or timeout. Publish an aggregate summary, such as `23 people across 2 streams made this`, to both chats. Count summary people as the union of participant IDs, not an inflated sum if the same person appears on both sides.
5. RESET and repeat. Reconnect or polling must restore the current state without replaying audio/confetti or summaries.

## Rules and defaults

| Setting / rule                        | MVP decision                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Window                                | 45 seconds by default; controls permit 30–60 seconds                                                                                       |
| Recent baseline                       | Distinct chatters observed during the previous 5 minutes, separately per origin channel                                                    |
| Quorum                                | `max(3, ceil(0.4 * recentDistinct))`, frozen per side on CALL                                                                              |
| Cold channel                          | Minimum target 3; never use viewer count or Get Chatters                                                                                   |
| Person credit                         | At most one step per person **per origin side per round**                                                                                  |
| Shared Chat copy                      | Route by `source_broadcaster_user_id ?? broadcaster_user_id`; dedupe globally by `source_message_id ?? message_id`                         |
| Person types independently in A and B | MVP permits one contribution to each side. Global once-only allocation/golden seam card is a deferred should, not silently enforced        |
| Unknown source channel                | Ignore; do not credit B merely because a copy arrived on B's subscription                                                                  |
| Bot's own sender account              | Ignore for participation and recent baseline                                                                                               |
| Active boundary                       | Credit when `startedAtMs <= now < deadlineAtMs`; at/after deadline process timeout before new credit                                       |
| Joint success                         | Latch success once all required sides reach target; use one `revealAtMs` shared by clients                                                 |
| Geometry                              | Full-image card coordinates, deterministic greedy quadtree (no randomness), ≤ 1295 steps per 48×27 side; the last 20 % is the reveal layer |
| Detail                                | Partial refinement may hint at the picture; the last detail layer stays gated until required sides finish                                  |
| Accessibility                         | Colorblind-readable palette (target 8 colors), text status, caption, reduced motion, silent mode/audio unlock                              |

Recent-chat observation must continue outside active rounds. Clear round participation/delivery state on RESET according to retention rules, but retain only the recent observation window needed for the next baseline. Decide and test a bounded delivery-key retention strategy across reconnect/round transitions. Use a periodic server TICK so a quiet round can expire. No timers or clocks live in the engine.

## Architecture and contracts

Node 24, strict TypeScript, pnpm. `node:http` serves static plain HTML/JS and API routes. `ws` pushes aggregate snapshots to overlays; HTTP polling provides the same representation on interruption. **No SSE**: optional Cloudflare quick tunnels do not support it. Canvas2D draws bounded quadtree cells; browser preprocessing quantizes artwork. Web Audio synthesizes the roar without audio assets.

One user token from a **PUBLIC Device Code client** uses `user:read:chat` and `user:write:chat`. One steady-state EventSub WS connection has two `channel.chat.message` v1 subscriptions. Keep upstream Twitch EventSub distinct from downstream overlay `/ws`. Instructed Twitch reconnect briefly requires two sockets for handover. See `TWITCH_NOTES.md`.

`src/engine/types.ts` defines immutable server-only state, events, config, geometry and public `Snapshot`. `step(state, event, now)` is a pure reducer; IO and once-only side effects (chat announcements, pushes) live in the server adapter `src/server/runtime.ts`. `src/shared/protocol.ts` defines protocol version 2: `hello` → `meta` → `round` → `snapshot` on connect, then pushes (`error` on refusal). Poll responses are `{ protocol, snapshot, meta, round? }`. All times in internal/public contracts are epoch milliseconds; Twitch input timestamps are RFC3339 strings.

Implemented protocol behavior: `RoundPayload` carries the palette and one refinement plan per required side (the hidden picture, sent once per CALL); snapshot `revision` only grows when public content changes; overlays estimate the server clock offset from `serverNowMs` samples, reconnect with exponential backoff and poll `/api/snapshot?round=<id>` while the socket is down; partner access is bound to a room token. Never send participant sets, raw Twitch messages or token data. Both overlay clients render from the same full-image coordinate system; the Playwright seam test checks columns 47|48 against the plan leaves.

### Implementation status (2026-11-01)

| Route / command                              | Behavior                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `/control`, `/`                              | Control panel: Twitch connect, channels, mode, picture (presets/text/image), duration/quorum, CALL/RESET, overlay URLs, share      |
| `/overlay/a`, `/overlay/b`                   | Transparent 1920×1080 Canvas2D overlays: stand, flips, HUD, minimap, WAITING, zipper + wave, confetti, roar caption, SO CLOSE      |
| `/dev` (demo only)                           | SIMULATED injector (5/25/300/3000) and showcase buttons; 404 in live mode                                                          |
| `GET /api/health`                            | `{ ok, simulated }`                                                                                                                |
| `GET /api/snapshot`, `GET /ws?side=A` or `B` | Aggregate-only snapshot + round + meta (WS push ≤ 10 Hz, immediate on phase change; polling fallback)                              |
| `POST /api/call`, `/api/reset`               | 202 `{ roundId }` / 400 invalid / 409 while active or revealing; RESET returns to idle                                             |
| `POST /api/auth/*`, `/api/channels`          | Live Device Code flow and Helix channel lookup (400 unknown login, 409 not signed in, 502 Twitch failure); demo: labels only       |
| `POST /api/share/start`, `/stop`             | cloudflared quick tunnel; remote clients may only read overlay B, its assets, `/api/snapshot` and `/ws?side=B` with the room token |
| `pnpm demo --autoplay`                       | Loops crossover → so-close → single SIMULATED showcase rounds (~25 s average)                                                      |

Verified locally (Windows 11, Node 24, headless Chromium): Vitest suites (engine properties, server, runtime, access, Twitch module against fake `fetch` and a local `ws` server), Playwright end-to-end against `pnpm demo` (showcase reveal, timeout, single mode, n=5/25/300/3000, A|B seam pixels, polling fallback, control panel), `pnpm build` + `pnpm start` live mode without a client ID (`signed-out`), and `pnpm verify:server`.

**Verified live (2026-10-31 / 2026-11-01):** Public app + Device Code consent with a real broadcaster, two real channels on one EventSub WebSocket, Helix sends in both chats, OBS 33 browser sources on two simultaneous Twitch streams, crossover / single / timed-out rounds (our two channels, one viewer account).

**Operator-reported v3 HUD recheck (2026-11-01, 16:35–16:43 Chile time, UTC−3):** Both real channels, efaoangssm and efaoangsam, streamed again from OBS 33 with real chats. The operator reports two crossover HYPE rounds, one single-channel GG round and one SO CLOSE round. Their OBS recordings show `WAITING FOR EFAOANGSAM` in full with the blue name, `READY · REVEAL · READY` during the wave, and the larger HUD type. This check is attributed to the operator and their OBS recordings; OpenAI Codex did not observe the live session itself.

**Not verified yet:** real crowds of many distinct people, refresh rotation, reconnect/revocation, Shared Chat, sends and drops under load, a real cloudflared tunnel and the remote room cookie in OBS, OBS frame rate under heavy load.

The entrypoint binds loopback only. The simulator generates local virtual IDs; it never impersonates Twitch users or sends messages upstream.

## Delivery scope

### Must, in implementation order

1. Public Device Code auth, startup/hourly validate, refresh rotation, one EventSub WS/two subscriptions, dedupe and reconnect/revocation handling.
2. Pure engine with example/property tests: unique people, adaptive frozen targets, spam protection, deterministic quadtree, success/timeout and single mode.
3. Both overlays: refinements, minimap/partner progress, waiting, seam zipper, timestamped wave, confetti, captioned roar, reduced motion.
4. `/control`: image/text, duration, CALL/RESET, mode and partner channel.
5. Queued prompt/summary to both communities, dropped-message feedback and Shared Chat announcement strategy.
6. Credential-free `pnpm demo`, clearly SIMULATED crowds, injector exercising the same normalized-event pipeline.
7. English README/run instructions, Codex project conventions and truthful implementation/evidence log, MIT license, no secrets.

### Should, only after must works

- Read-only room token + `pnpm share` via cloudflared. This becomes **must** for a remote partner; protect every overlay transport and leave controls/injector unexposed.
- A person participating across both chats counts globally once and earns a golden seam card. Requires an explicit fairness/allocation rule and revised tests before enabling.
- `/director` with two Twitch embeds for recording; optional `?delayMs=` for differing broadcast latency.
- Playwright pixel seam comparison, capture contact sheet and real OBS frame measurements.
- Inform host about slow/followers-only chat restrictions without adding unnecessary moderation scopes.
- Self-hosted Archivo and Geist Mono under OFL 1.1 are bundled for the v3 broadcast package; the artwork generator retains its original bitmap pixel font. Font licenses ship with the assets.

### Won't for this entry

Physics/rally gameplay, Get Chatters, pinning messages in a partner channel, raids/clips/whispers, runtime AI, Channel Points, Bits, Extensions, Affiliate-only features, rendered chat content or third-party logos. No application Client Secret. No hosted deployment is required.

## Decision gates and evidence

Planning gates from the source proposal use Chile time (America/Santiago):

- **G1: Sat Oct 31, 21:30.** Receive real chat events from both channels on one connection. If blocked, use a clearly labeled local/offline B or an authorized partner account, preserving single-channel delivery.
- **G2: Sun Nov 1, 12:30.** Complete crossover end-to-end with the injector. If it fails, ship single mode and label crossover experimental/SIMULATED where appropriate.

Hackathon context supplied by the brief/proposal (not independently audited here): official deadline Mon Nov 2, 2026 at 14:00 PT = 22:00 UTC = 19:00 Chile; proposal recommends a conservative 21:00 UTC cutoff due to inconsistent FAQ wording. Aim to submit by 18:00 UTC. Preserve one Codex session's work/evidence, a reproducible clean checkout, English materials and live Twitch footage. Judges equally weigh Innovation, Impact, Technological implementation (including Codex use), and Design. Recheck event rules before submission.

## Acceptance checks for the implementer

- `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`, and clean-start demo pass on Windows without credentials.
- Repeated chatter/delivery cannot increase unique progress; Shared Chat copies never credit the wrong side; duplicate/handover fixtures pass.
- Frozen targets reflect distinct recent participants, small/large channels each control their own half, timeout is reliable without incoming chat.
- A+B success gates final detail; single mode works alone; reload/poll recovery uses current state without replaying transient effects.
- n=5/25/300/3000 scenarios remain labeled SIMULATED; public payloads contain only aggregates. Real Twitch/OBS checks are recorded separately.
- Host completes setup and partner uses a read-only URL; controls and credentials remain private. Record measured audio/frame/timing limitations rather than claiming unmeasured performance.
