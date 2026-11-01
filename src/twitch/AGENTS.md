# Twitch boundary rules

- Read `../../docs/TWITCH_NOTES.md` and use `twitch-eventsub` before implementation.
- User access token, PUBLIC Device Code client, scopes `user:read:chat user:write:chat`; no secret and no app-token auth flow.
- Validate on startup and hourly. Serialized refresh replaces the single-use refresh token atomically; revoked access ends dependent sessions.
- ONE steady-state EventSub WebSocket, TWO Helix subscriptions. During instructed reconnect, temporary old/new socket overlap is required and existing subscriptions migrate.
- Validate untrusted JSON and subscription type/version before normalization. Strip text/display names/emotes; retain only the server-only normalized login needed for bot filtering. Normalize origin before routing; dedupe source message IDs across both subscriptions and reconnect overlap.
- Never log full events, auth responses, request headers, tokens, URLs containing credentials, or user identities.
- Queue only CALL/help/summary messages. Check `is_sent` and `drop_reason`; exclude the sending account from participation. Shared Chat user-token sends propagate to all channels, so avoid duplicate announcements.
- Do not introduce Get Chatters, moderation privileges, IRC, pinned messages, or Affiliate requirements.
