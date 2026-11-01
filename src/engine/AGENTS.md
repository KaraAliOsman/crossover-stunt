# Pure engine rules

- Read `../../docs/SPEC.md`, `../../docs/DESIGN.md` §Engine and use the `stunt-engine` skill for behavior changes.
- Do not import server, Twitch, filesystem, sockets or time APIs. Inject epoch milliseconds via `step`; the engine uses no randomness (the quadtree plan is a deterministic function of artwork + region).
- Preserve prior states, including their Sets, Maps and plans. Copy collections before changing them and return the input state itself when an event changes nothing.
- Distinguish delivery deduplication (`messageKey`, recorded only while credit is possible) from participant deduplication (person per origin side per round). Ignore unknown origins upstream.
- Freeze each side's target on CALL from distinct recent chatters (`quorum.ts` window helpers), not viewers or message volume. Chat after CALL feeds the next round's baseline only.
- Emit terminal reveal only after all required sides are ready. Single mode requires only A. Time at or after the deadline cannot earn credit: CHAT applies the TICK clock transitions before crediting.
- Invalid merged config throws `RangeError` (`CONFIG_LIMITS`); the server maps it to HTTP 400.
- Keep final image detail locked until joint reveal; quadtree geometry uses full-image coordinates. `stepsToShow` is replicated in `public/overlay/`, so change both together.
- Cost model: each CHAT copies the touched Set/Map (O(n) per event, Map copies dominate). Live chat rates are fine; feed very large simulated bursts gradually.
- Test changed invariants and deterministic replay; never weaken a property just to make a reducer pass.
