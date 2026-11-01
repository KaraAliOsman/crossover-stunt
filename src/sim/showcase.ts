import { presetArtwork } from '../../public/control/artwork.js';
import type { Artwork, NormalizedChatEvent, Side, StuntMode } from '../engine/types.js';
import type { CallRequest, ShowcaseRequest } from '../shared/protocol.js';

/**
 * Scripted SIMULATED rounds for the demo video, judges and Playwright (docs/DESIGN.md
 * §Showcase scripts). Everything here is a pure schedule; `src/server/showcaseRunner.ts` plays
 * it with timers. Virtual IDs all start with `sim:` and never reach Twitch.
 */

export type ShowcaseScenario = ShowcaseRequest['scenario'];

/** Autoplay order. */
export const SHOWCASE_SCENARIOS: readonly ShowcaseScenario[] = Object.freeze([
  'crossover',
  'so-close',
  'single',
]);

export interface ShowcaseArrival {
  /** Offset from the CALL, in ms. */
  readonly atMs: number;
  readonly side: Side;
  /** Virtual person (`sim:showcase:*`); the same ID on both sides is one crossover person. */
  readonly chatterId: string;
}

export interface ShowcaseCall extends CallRequest {
  readonly artwork: Artwork;
  readonly mode: StuntMode;
  readonly durationMs: number;
  readonly quorumOverride: Readonly<Partial<Record<Side, number | null>>>;
}

export interface ShowcaseScript {
  readonly scenario: ShowcaseScenario;
  readonly call: ShowcaseCall;
  /** Sorted by `atMs`. */
  readonly arrivals: readonly ShowcaseArrival[];
  /** CALL → next autoplay CALL: the round's natural end plus a hold to show the result. */
  readonly slotMs: number;
}

// One DOM-free generator serves the control panel and demo, in source and compiled layouts.
// public/ must remain beside dist/ (also required for the overlay/static routes).
export const DEFAULT_CROSSOVER_PRESET = 'hype' as const;

function presetShowcaseArtwork(id: 'hype' | 'gg', mode: StuntMode): Artwork {
  const grid = presetArtwork(id, mode, { A: 'A', B: 'B' });
  return Object.freeze({ ...grid, pixels: Object.freeze(grid.pixels) });
}

export function showcaseArtwork(mode: StuntMode): Artwork {
  return presetShowcaseArtwork(mode === 'single' ? 'gg' : DEFAULT_CROSSOVER_PRESET, mode);
}

function person(side: Side, index: number): string {
  return `sim:showcase:${side}:${index}`;
}

/** A: one person every 900 ms → ready at 10.8 s. */
function sideAArrivals(): ShowcaseArrival[] {
  return Array.from({ length: 12 }, (_, index) => ({
    atMs: 900 * (index + 1),
    side: 'A' as const,
    chatterId: person('A', index),
  }));
}

/**
 * B lags: starts at 6 s, one person every 1.3 s (9 people by 16.4 s) so WAITING FOR is visible
 * on A, then (when `finish`) the last 3 arrive in a burst. B's 3rd and 7th arrivals are A's 2nd
 * and 5th people chatting in the partner channel too: the reveal reports 2 crossovers.
 */
function sideBArrivals(finish: boolean): ShowcaseArrival[] {
  const crossoverPeople = new Map([
    [2, person('A', 1)],
    [6, person('A', 4)],
  ]);
  const steady = Array.from({ length: 9 }, (_, index) => ({
    atMs: 6_000 + 1_300 * index,
    side: 'B' as const,
    chatterId: crossoverPeople.get(index) ?? person('B', index),
  }));
  if (!finish) return steady;
  const burst = [18_000, 18_150, 18_300].map((atMs, offset) => ({
    atMs,
    side: 'B' as const,
    chatterId: person('B', 9 + offset),
  }));
  return [...steady, ...burst];
}

function sorted(arrivals: ShowcaseArrival[]): readonly ShowcaseArrival[] {
  return Object.freeze(
    arrivals
      .sort((a, b) => a.atMs - b.atMs || a.side.localeCompare(b.side))
      .map((arrival) => Object.freeze(arrival)),
  );
}

/** Deterministic script for one scenario. */
export function buildShowcase(scenario: ShowcaseScenario): ShowcaseScript {
  switch (scenario) {
    case 'crossover':
      // Joint reveal at ~18.3 s (+1.5 s lead, 6 s animation) → complete at ~25.8 s.
      return Object.freeze({
        scenario,
        call: Object.freeze({
          artwork: showcaseArtwork('crossover'),
          mode: 'crossover',
          durationMs: 30_000,
          quorumOverride: Object.freeze({ A: 12, B: 12 }),
        }),
        arrivals: sorted([...sideAArrivals(), ...sideBArrivals(true)]),
        slotMs: 30_000,
      });
    case 'so-close':
      // A completes, B stalls at 9/12 → timed-out at 20 s; the overlay fades SO CLOSE after 6 s.
      return Object.freeze({
        scenario,
        call: Object.freeze({
          artwork: presetShowcaseArtwork('gg', 'crossover'),
          mode: 'crossover',
          durationMs: 20_000,
          quorumOverride: Object.freeze({ A: 12, B: 12 }),
        }),
        arrivals: sorted([...sideAArrivals(), ...sideBArrivals(false)]),
        slotMs: 27_000,
      });
    case 'single':
      // Card Stunt: 10 people, one every 800 ms → reveal at ~9.5 s → complete at ~15.5 s.
      return Object.freeze({
        scenario,
        call: Object.freeze({
          artwork: showcaseArtwork('single'),
          mode: 'single',
          durationMs: 30_000,
          quorumOverride: Object.freeze({ A: 10, B: null }),
        }),
        arrivals: sorted(
          Array.from({ length: 10 }, (_, index) => ({
            atMs: 800 * (index + 1),
            side: 'A' as const,
            chatterId: person('A', index),
          })),
        ),
        slotMs: 20_000,
      });
  }
}

/** Normalized virtual chat for one arrival; the key is unique per round (person × side). */
export function showcaseChatEvent(
  arrival: ShowcaseArrival,
  receivedAtMs: number,
): NormalizedChatEvent {
  return {
    messageKey: `${arrival.chatterId}:${arrival.side}`,
    chatterId: arrival.chatterId,
    originBroadcasterId: `sim:channel:${arrival.side}`,
    side: arrival.side,
    receivedAtMs,
    simulated: true,
  };
}
