# Twitch implementation reference

Verified against the linked **official `dev.twitch.tv` pages on 2026-10-31** by fetching and reading their relevant sections. These are implementation notes, not evidence of a live Twitch integration. No account was authorized and no chat message was sent in the scaffold session. All uppercase values in examples are placeholders.

## Public Device Code authentication

Register an application in the [Twitch developer console](https://dev.twitch.tv/console/apps), with client type **Public**. Registration needs a verified email and Twitch 2FA. The Client ID is public metadata; never generate or require a secret for this design. If the console asks for a redirect URL, a local URL such as `http://localhost:3000` can be registered; Device Code itself does not use a callback. [Registration](https://dev.twitch.tv/docs/authentication/register-app/) and [Device Code grant](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow).

Public clients obtain tokens through Device Code only; do not substitute client credentials, implicit or authorization-code grants. Our installed local app requests exactly `user:read:chat user:write:chat`.

| Step       | Method and endpoint                       | Body fields                                                                                                                 |
| ---------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Start      | `POST https://id.twitch.tv/oauth2/device` | `client_id=CLIENT_ID`, `scopes=user:read:chat user:write:chat`                                                              |
| Poll token | `POST https://id.twitch.tv/oauth2/token`  | `client_id`, `scopes` (same space-separated list), `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code` |
| Refresh    | `POST https://id.twitch.tv/oauth2/token`  | `client_id`, `refresh_token`, `grant_type=refresh_token`; omit `client_secret` for Public                                   |

Use `URLSearchParams` with `application/x-www-form-urlencoded` (documented DCF examples also use multipart form fields). The field is **`scopes` plural** for the two Device Code steps; token responses/validation use `scope` / `scopes` as shown below. Start returns `{ device_code, user_code, verification_uri, expires_in, interval }`. Present the returned verification URI and user code on local controls; do not invent a verification URL. Respect returned polling interval, abort on cancellation/expiry, and avoid busy loops. Token success returns `{ access_token, refresh_token, expires_in, scope: string[], token_type }`. Before consent the documented response is HTTP 400 with `message: "authorization_pending"`; a consumed device code produces `"invalid device code"`. [DCF parameters and examples](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow).

DCF's specific documentation says access tokens last about four hours (always use the actual response), refresh tokens are **one-use**, and an unused refresh token expires after **30 days**. Serialize refreshes and atomically store the returned token pair before another caller refreshes; stale retries can destroy the ability to recover. Restart authorization after invalid/expired consent. Keep tokens server-only, in memory initially or ignored `data/` with appropriate local access. Never put them in source, logs, public files or browser-source URLs. [DCF refresh behavior](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow).

Documentation nuance: the generic refresh page still says only authorization-code tokens are refreshable, but its parameter table explicitly exempts Public clients from `client_secret`, and the newer flow-specific DCF section expressly documents Public refresh. Follow the flow-specific instructions and verify rotation with a real Public app during implementation. React to 401 by attempting a serialized refresh where appropriate; invalid authorization must end dependent sessions rather than retry forever. [Refresh endpoint](https://dev.twitch.tv/docs/authentication/refresh-tokens/).

## Validate identity and permissions

`GET https://id.twitch.tv/oauth2/validate`, header `Authorization: OAuth ACCESS_TOKEN` (Bearer is also accepted), returns `{ client_id, login, scopes: string[], user_id, expires_in }` on HTTP 200. Invalid tokens return 401. Validate at startup and **hourly** while maintaining an OAuth session. Confirm client ID, reader/sender user ID and both required scopes; disconnect invalid sessions. Use this `user_id` as the chat-reading condition user and Helix sending identity. [Validate tokens](https://dev.twitch.tv/docs/authentication/validate-tokens/).

## One EventSub WebSocket, two subscriptions

Connect to `wss://eventsub.wss.twitch.tv/ws`. An optional `keepalive_timeout_seconds` query accepts integer 10–600; use the returned welcome value. This upstream connection receives messages; subscribe over Helix HTTP, **never by sending subscribe JSON into the WS**. Application traffic to Twitch's WS other than protocol Pong closes it. `ws` automatically answers protocol Ping. [Lifecycle](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/).

Envelope shapes below are synthetic, minimal JSON with the documented field names. See the [WebSocket field reference](https://dev.twitch.tv/docs/eventsub/websocket-reference/) for complete definitions. `metadata.message_id` identifies an envelope; it is **not** the chat event's `message_id`. Twitch may redeliver envelopes with the same metadata ID. Timestamps are RFC3339, potentially with nanosecond precision; internal scheduling uses epoch milliseconds.

### Welcome and subscribe

```json
{
  "metadata": {
    "message_id": "ENVELOPE_ID",
    "message_type": "session_welcome",
    "message_timestamp": "2026-10-31T20:00:00.000000000Z"
  },
  "payload": {
    "session": {
      "id": "SESSION_ID",
      "status": "connected",
      "connected_at": "2026-10-31T20:00:00.000000000Z",
      "keepalive_timeout_seconds": 10,
      "reconnect_url": null
    }
  }
}
```

By default subscribe to at least one event **within 10 seconds of welcome** or Twitch closes the unused connection. Obtain tokens/IDs before opening the socket so setup fits the window. Create both desired subscriptions promptly. [Welcome rules](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/#welcome-message).

`POST https://api.twitch.tv/helix/eventsub/subscriptions` with `Authorization: Bearer ACCESS_TOKEN`, `Client-Id: CLIENT_ID`, `Content-Type: application/json`:

```json
{
  "type": "channel.chat.message",
  "version": "1",
  "condition": {
    "broadcaster_user_id": "CHANNEL_A_USER_ID",
    "user_id": "TOKEN_USER_ID"
  },
  "transport": {
    "method": "websocket",
    "session_id": "SESSION_ID"
  }
}
```

Repeat with `CHANNEL_B_USER_ID`, keeping the same reader user and session. With a **user access token**, `channel.chat.message` v1 requires `user:read:chat`; the extra `user:bot` and broadcaster `channel:bot`/moderator conditions apply to the **app access token** route, which this project does not use. No Affiliate requirement is listed for this event. Condition `user_id` is the user we read as, not automatically the broadcaster. [Subscription authorization](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage), [condition fields](https://dev.twitch.tv/docs/eventsub/eventsub-reference/#channel-chat-message-condition), [Create EventSub Subscription](https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription).

Success is HTTP **202**, with `data` containing the created subscription (`id`, `status`, `type`, `version`, `condition`, `transport`, `created_at`, `cost`) and top-level `total`, `total_cost`, `max_total_cost`. Check enabled status and returned costs. Handle 401 (token/client mismatch), 403 (scope), 409 (already exists), 410 (removed version), 429 (subscription/rate constraints) distinctly. WebSocket transport requires a user access token. No webhook callback or secret belongs in this body. [Create API reference](https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription).

A 409 only confirms that a subscription with that type and condition exists; it does not establish delivery to the new socket. This app reports the conflict and asks the host to close other copies and save channels again. Missing enabled status or invalid cost accounting also fails setup instead of reporting Connected. For chat sends, retain a 429 reset across queued target channels; if it exceeds the bounded retry wait, report failure without sending early.

### Keepalive and loss

```json
{
  "metadata": {
    "message_id": "KEEPALIVE_ID",
    "message_type": "session_keepalive",
    "message_timestamp": "2026-10-31T20:00:10.000000000Z"
  },
  "payload": {}
}
```

Reset the watchdog on **notification or session_keepalive**. If neither arrives for longer than welcome's `keepalive_timeout_seconds`, treat the connection as lost. Protocol Ping/Pong is independent and does not reset that timer. Unexpected disconnect: reconnect to the base URL with bounded backoff and recreate subscriptions using the new session ID. Lost events are not replayed; show connection state on controls. [Keepalive and disconnect rules](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/#keepalive-message).

### Instructed reconnect

```json
{
  "metadata": {
    "message_id": "RECONNECT_ID",
    "message_type": "session_reconnect",
    "message_timestamp": "2026-10-31T20:01:00.000000000Z"
  },
  "payload": {
    "session": {
      "id": "SESSION_ID",
      "status": "reconnecting",
      "connected_at": "2026-10-31T20:00:00.000000000Z",
      "keepalive_timeout_seconds": null,
      "reconnect_url": "wss://eventsub.wss.twitch.tv/ws?OPAQUE_RECONNECT_PARAMETERS"
    }
  }
}
```

Use the actual `reconnect_url` **unchanged** immediately. Keep the old socket until welcome arrives on the new one, then close the old socket, within the documented **30-second** handover. Existing subscriptions migrate; **do not resubscribe** in this successful handover. Keep dedupe state through overlap. Reconnect URL handovers do not add to the enabled-socket count. This temporary overlap is the exception to one steady-state socket. [Reconnect procedure](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/#reconnect-message).

### Revocation

```json
{
  "metadata": {
    "message_id": "REVOCATION_ID",
    "message_type": "revocation",
    "message_timestamp": "2026-10-31T20:02:00.000000000Z",
    "subscription_type": "channel.chat.message",
    "subscription_version": "1"
  },
  "payload": {
    "subscription": {
      "id": "SUBSCRIPTION_ID",
      "status": "authorization_revoked",
      "type": "channel.chat.message",
      "version": "1",
      "cost": 0,
      "condition": { "broadcaster_user_id": "CHANNEL_A_USER_ID", "user_id": "TOKEN_USER_ID" },
      "transport": { "method": "websocket", "session_id": "SESSION_ID" },
      "created_at": "2026-10-31T20:00:00.000000000Z"
    }
  }
}
```

The reason is `payload.subscription.status`: documented reasons are `authorization_revoked`, `user_removed`, `version_removed`. Stop the affected behavior and ask for reauthorization or a supported version through local controls as appropriate. Do not treat revoked consent as a transient network failure. [Revocation](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/#revocation-message). The Get EventSub Subscriptions status list also includes `chat_user_banned` (the condition user was banned from that broadcaster's chat). Implementation: a revocation or fatal subscription failure that concerns only channel B (not `authorization_revoked`, not a 401) drops B and resubscribes channel A on a fresh session, so single mode keeps working; the reason stays visible on the control panel until channels are saved again.

Useful close codes: 4001 inbound application traffic; 4002 failed Pong; 4003 unused socket; 4004 reconnect grace expired; 4005/4006 network timeout/error; 4007 invalid reconnect. Current enabled-subscription limits per client-ID/user-ID tuple: **3 sockets, 300 subscriptions/socket, max total cost 10**. This design needs one socket and two subscriptions; inspect real cost fields rather than assuming. [Close codes and limits](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/#subscription-limits).

## Chat notification and Shared Chat

`metadata.message_type = "notification"`, `subscription_type = "channel.chat.message"`, `subscription_version = "1"`; payload is `{ subscription: { ... }, event: { ... } }`. Validate type, version and required identity fields before normalization. The [event reference](https://dev.twitch.tv/docs/eventsub/eventsub-reference/#channel-chat-message-event) and [regular/Shared Chat examples](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage) describe:

| Event field                                                                      | Meaning / project handling                                                                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `broadcaster_user_id`                                                            | Channel for the delivery/subscription; may be a receiving channel in Shared Chat                                           |
| `chatter_user_id`                                                                | Sender's stable user ID; server-only participant identity                                                                  |
| `message_id`                                                                     | Chat message UUID; fallback dedupe key                                                                                     |
| `message.text`, `message.fragments`                                              | Raw content and ordered fragments, including emotes/mentions/cheermotes and potentially newer types; discard, never render |
| `chatter_user_login`, `chatter_user_name`, broadcaster login/name, badges, color | Not needed for stunt credit; keep out of public payloads                                                                   |
| `source_broadcaster_user_id`                                                     | Optional/null for local messages; origin channel for a relayed Shared Chat message                                         |
| `source_message_id`                                                              | Optional/null for local messages; original source message UUID for a relayed Shared Chat message                           |
| `source_broadcaster_user_login`, `source_broadcaster_user_name`, `source_badges` | Optional Shared Chat origin metadata; discard                                                                              |
| `is_source_only`                                                                 | Optional Shared Chat delivery flag; does not replace origin attribution                                                    |

Normalization policy:

```ts
const messageKey = event.source_message_id ?? event.message_id;
const originBroadcasterId = event.source_broadcaster_user_id ?? event.broadcaster_user_id;
```

Map origin to A/B; ignore unknown third-channel origins. Deduplicate that key **across both subscriptions and reconnect overlap**, then separately count distinct `chatter_user_id` per origin side per round. A message from A and its copy delivered to B share one source key and must never advance B. A person typing a new message directly in B is a separate source event; whether to allocate them globally is a product rule (MVP is per-side). `normalizeChat` implements only this identity projection, not runtime validation or retention/dedupe storage. Test both original-first and copy-first orders.

## Send Chat Message

`POST https://api.twitch.tv/helix/chat/messages` with Bearer user token, matching `Client-Id`, and JSON body:

```json
{
  "broadcaster_id": "CHANNEL_A_USER_ID",
  "sender_id": "TOKEN_USER_ID",
  "message": "STUNT! Type anything — 45 s"
}
```

Requires `user:write:chat`; `sender_id` must equal the token user; maximum message length **500 characters**. Twitch drops a message identical to the sender's previous one in that channel within 30 seconds (`msg_duplicate`, [IRC msg-id table](https://dev.twitch.tv/docs/chat/irc/)); the server appends `(take N)` to a repeated announcement inside that window (CALL → RESET → CALL). We use only fixed prompts and aggregate summaries; no pin/reply/moderation features. Success HTTP 200 contains `data: [{ message_id, is_sent, drop_reason? }]`. A valid HTTP response can still have `is_sent: false`; `drop_reason` contains `code` and `message`. Surface failure in controls, avoid retrying non-transient drops or ambiguous POSTs blindly. [Request, response and errors](https://dev.twitch.tv/docs/api/reference/#send-chat-message).

**Shared Chat nuance:** user-token sends propagate to all channels in the shared session and cannot be restricted with `for_source_only`; setting that parameter with a user token returns 400. App-token defaults/extra scopes in the API reference do not apply here. For independent chats send one prompt/summary per channel; for a known shared session avoid duplicate cross-posts by sending once to the group. Implement a session-aware policy or document conservative behavior before live testing. Exclude our sender account from crowd participation. [Shared Chat send behavior](https://dev.twitch.tv/docs/api/reference/#send-chat-message).

## Scopes and limits

| Capability                                               | Required scope for this design |
| -------------------------------------------------------- | ------------------------------ |
| Read `channel.chat.message` using user-token EventSub WS | `user:read:chat`               |
| Helix Send Chat Message with that user token             | `user:write:chat`              |

No `chat:read`/`chat:edit` IRC scopes, `user:bot`, `channel:bot`, moderation or Affiliate-only capabilities are needed for this user-token design. [Scope definitions](https://dev.twitch.tv/docs/authentication/scopes/) and [subscription authorization](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage).

Ordinary account chat sending is **20 messages/30 seconds across the user** and **1 message/second/channel** when not broadcaster/moderator/VIP. Elevated status can allow 100/30 seconds; don't depend on it. Verified accounts have separate higher limits; don't assume verification. Excess chat traffic may be ignored for one hour. The Send Chat Message API has a separate HTTP rate bucket from regular Helix, in addition to chat backend limits. Concurrent channel joins are normally **100/user**, with ordinary join attempts **20/10 seconds/user**; a `channel.chat.message` subscription counts as a join. [Chat rate limits](https://dev.twitch.tv/docs/chat/#rate-limits).

Honor `Ratelimit-Limit`, `Ratelimit-Remaining`, `Ratelimit-Reset` (Unix epoch seconds). On general 429, wait for reset with bounded jitter; distinguish subscription-count/condition limits that waiting cannot fix. Respect Retry-After if supplied and use bounded fallback/backoff when headers are absent. Log safe status/category only, never auth headers/raw events. [API rate-limit guide](https://dev.twitch.tv/docs/api/guide/#twitch-rate-limits).

Implementation verification still required: real Public app registration/consent/rotation; two channels on one EventSub connection; expiry/revocation UX; synthetic unexpected disconnect and instructed reconnect; Shared Chat copy-first dedupe and announcement behavior; real chat restrictions/dropped sends. Do not claim these passed from the local tests, which use an injected `fetch` and a local `ws` server only.

### Server-only bot filtering and help messages (2026-10-31)

The chat parser now retains a validated, lowercased chatter_user_login solely for bot exclusion.
Normalization exposes it as optional chatterLogin to the server runtime. Text, fragments, emotes
and display names are still discarded. Runtime filters built-in bot logins and IGNORED_CHATTERS,
then projects the original frozen identity fields before engine ingress. No login reaches overlays.

A ready crossover chat receives at most one invitation per round to help the unfinished side.
It uses the existing say queue and delivery/drop feedback. Duplicate-announcement history now
tracks each target chat independently: help to A cannot erase B's preceding CALL, so a rapid
RESET/CALL still adds (take N) when B would otherwise receive an identical prompt within 30s.
Verification uses synthetic EventSub and fake Helix; the existing live connection was not used.
