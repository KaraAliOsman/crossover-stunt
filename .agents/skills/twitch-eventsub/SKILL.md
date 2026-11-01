---
name: twitch-eventsub
description: Implement or troubleshoot this project's Twitch Device Code auth, EventSub WebSocket lifecycle, Shared Chat deduplication, and Helix chat delivery.
---

Read `docs/TWITCH_NOTES.md` from the repository root for verified URLs, parameters and payload examples. Scope changes to the Twitch boundary and its consumers.

- Use a public client and user token with `user:read:chat` and `user:write:chat`. Device endpoints use `scopes` plural; no client secret. Validate on start/hourly. Serialize refresh and atomically rotate single-use refresh tokens; restart authorization if invalid.
- Open `wss://eventsub.wss.twitch.tv/ws`. On `session_welcome`, use `payload.session.id` to create subscriptions through Helix within 10 seconds by default. Create A/B `channel.chat.message` version `1` subscriptions with broadcaster ID and `user_id` equal to the validated token user. Never send subscribe JSON into the WS.
- Reset the watchdog for notifications and `session_keepalive` using welcome's `keepalive_timeout_seconds`. Ping/Pong does not reset this timer. `ws` handles protocol Pong automatically. On genuine connection loss, back off, reconnect to the base URL, and recreate subscriptions; events during the gap are not replayed.
- On `session_reconnect`, immediately use the supplied URL unchanged, retain the old connection until new welcome, then close it within the 30-second handover. Subscriptions migrate: do not recreate them. Dedupe overlap deliveries.
- Handle `revocation` by inspecting `payload.subscription.status` (`authorization_revoked`, `user_removed`, `version_removed`). Surface a recoverable control status; do not spin on invalid consent/version.
- Strip raw content before engine ingress. Use `source_message_id ?? message_id` for chat-delivery dedupe and `source_broadcaster_user_id ?? broadcaster_user_id` for origin-side attribution. A copy from A delivered via B must still count only on A. Drop unknown origins. Envelope `metadata.message_id` is a different delivery identifier. Bound dedupe retention and preserve it during handover.
- Keep one steady-state socket and two subscriptions. Current limits are 3 connections, 300 enabled subscriptions/socket, total cost 10 per client/user tuple; use returned cost accounting. Two subscriptions also consume channel joins: regular account limit 100 concurrent and 20 joins/10 seconds.
- Queue CALL/summary sends, conservatively 20/30 seconds globally and 1/second/channel; respect separate Send Chat Message API bucket and `Ratelimit-*` headers. On 429 distinguish reset exhaustion from subscription limits and retry only when it can succeed. Bound retries/queues and show failure on controls.
- Treat HTTP 200 `is_sent: false` as dropped, inspect `drop_reason`, avoid blind duplicate POST retries. User tokens cannot set `for_source_only`; Shared Chat sends propagate. Exclude our sender ID from counted people.

Exercise welcome, timeout, handover, unexpected close, revocation, duplicate original/copy, unknown origin, 401 refresh, and 429/drop behavior with recorded synthetic envelopes and an injected clock. Run typecheck/tests. Real Twitch verification requires authorized human accounts; mark it untested if unavailable. Never expose credentials or send messages merely to verify documentation.
