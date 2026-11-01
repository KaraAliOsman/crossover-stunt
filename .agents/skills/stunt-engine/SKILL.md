---
name: stunt-engine
description: Implement or change the pure Crossover Stunt reducer, adaptive quorum, participant counting, timing, or quadtree geometry while preserving deterministic invariants.
---

Read `src/engine/types.ts`, `src/engine/AGENTS.md` and `docs/SPEC.md`. The reducer (`engine.ts`), quorum helpers (`quorum.ts`) and quadtree planner (`quadtree.ts`) are implemented; `stepsToShow` is mirrored in `public/overlay/plan.js`, so change both together.

Preserve these independent invariants:

- Same initial state, event order, times and seed produce equal states and public snapshots; no IO, wall clock, timers or ambient randomness.
- Earlier states are unchanged, including nested Sets/Maps. Do not conflate unique delivery keys with unique people.
- One chatter earns at most one refinement step per origin side per round. Shared Chat copies never credit the receiving side. A person intentionally typing separately in both channels follows the documented per-side MVP rule; global seam-bonus participation is deferred.
- Observe distinct recent chatters in an injected rolling window; CALL freezes `max(k_min, ceil(ratio * recentDistinct))` independently per required side. Defaults: `k_min=3`, `ratio=0.4`, recent window 5 minutes, duration 45 seconds. Do not silently lower quorum because a round is losing.
- Accept active credit only before the deadline. `now >= deadlineAtMs` times out unless success was already latched. A server TICK must expire quiet rounds. Duplicate events and ticks cannot replay success, summary or reveal side effects.
- Crossover reveal requires A AND B; single mode uses the full image and only A. A ready side waits visibly, preserving the other's progress. Timeout leaves the image incomplete.
- A deterministic refinement step preserves image coverage, disjoint cells, exact seam coordinates and a bounded maximum depth/cell count. Render using full-image coordinates, then crop; no gap/overlap at the center. Final detail remains gated on joint success.
- Public snapshots contain aggregates/geometry/timestamps only. No chatter IDs, dedupe keys, names, message content or emotes. Effect delivery belongs in the server adapter, not the reducer.

Add focused examples plus fast-check properties for the behavior being changed: spam/duplicate idempotence, immutable input, deterministic replay, quorum monotonicity, reveal gating, deadline boundaries and geometric area/coverage as appropriate. Use reproducible seeds and include minimal counterexamples in failures. Run `pnpm typecheck`, `pnpm test`, then credential-free server smoke.
