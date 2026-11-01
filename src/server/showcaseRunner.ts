import {
  SHOWCASE_SCENARIOS,
  buildShowcase,
  showcaseChatEvent,
  type ShowcaseScenario,
  type ShowcaseScript,
} from '../sim/showcase.js';
import type { RoundPayload } from '../shared/protocol.js';
import { RoundConflictError, type StuntRuntime } from './runtime.js';

/** Retry delay when autoplay finds an operator round in progress. */
export const AUTOPLAY_RETRY_MS = 5_000;

export interface ShowcaseRunnerOptions {
  readonly runtime: StuntRuntime;
  readonly now: () => number;
}

export interface ShowcaseRunner {
  /**
   * Starts a scripted SIMULATED round. Replaces a showcase round that is still running; throws
   * RoundConflictError when an operator round is active.
   */
  play(scenario: ShowcaseScenario): RoundPayload;
  /** Stops delivering the current script's virtual people (the round itself is untouched). */
  stop(): void;
  /** Loops crossover → so-close → single until stopped (unattended judging, Playwright). */
  startAutoplay(): void;
  stopAutoplay(): void;
  isAutoplaying(): boolean;
  dispose(): void;
}

/** Demo-only timer driver for the pure schedules in src/sim/showcase.ts. */
export function createShowcaseRunner({ runtime, now }: ShowcaseRunnerOptions): ShowcaseRunner {
  let script: ShowcaseScript | null = null;
  let roundId: string | null = null;
  let startedAtMs = 0;
  let nextIndex = 0;
  let arrivalTimer: ReturnType<typeof setTimeout> | null = null;
  let autoplayTimer: ReturnType<typeof setTimeout> | null = null;
  let autoplayIndex = 0;

  function clearArrivalTimer(): void {
    if (arrivalTimer !== null) clearTimeout(arrivalTimer);
    arrivalTimer = null;
  }

  function stop(): void {
    clearArrivalTimer();
    script = null;
    roundId = null;
  }

  function scheduleNextArrival(): void {
    const arrival = script?.arrivals[nextIndex];
    if (arrival === undefined) {
      // Script delivered, but the round is still ours (it may be revealing or waiting for its
      // deadline): keep roundId so play() can still replace it instead of reporting an
      // operator round. Only RESET/dispose (stop) or a different round clears it.
      clearArrivalTimer();
      script = null;
      return;
    }
    const wait = Math.max(0, startedAtMs + arrival.atMs - now());
    arrivalTimer = setTimeout(deliverDue, wait);
  }

  /** Delivers every arrival that is due (catching up after a late timer), then reschedules. */
  function deliverDue(): void {
    arrivalTimer = null;
    // An operator RESET or another round ended this script: stop quietly.
    if (script === null || runtime.round()?.roundId !== roundId) {
      stop();
      return;
    }
    const elapsed = now() - startedAtMs;
    let arrival = script.arrivals[nextIndex];
    while (arrival !== undefined && arrival.atMs <= elapsed) {
      runtime.chat(showcaseChatEvent(arrival, now()));
      nextIndex += 1;
      arrival = script.arrivals[nextIndex];
    }
    scheduleNextArrival();
  }

  function play(scenario: ShowcaseScenario): RoundPayload {
    const phase = runtime.phase();
    if (phase === 'active' || phase === 'revealing') {
      if (roundId === null || runtime.round()?.roundId !== roundId) {
        throw new RoundConflictError('An operator round is running; RESET it first');
      }
      runtime.reset();
    }
    stop();
    const next = buildShowcase(scenario);
    // remember: false — scripted overrides must not leak into the operator's next CALL.
    const round = runtime.call(next.call, { remember: false });
    script = next;
    roundId = round.roundId;
    startedAtMs = now();
    nextIndex = 0;
    scheduleNextArrival();
    return round;
  }

  function runAutoplayStep(): void {
    autoplayTimer = null;
    const scenario = SHOWCASE_SCENARIOS[autoplayIndex % SHOWCASE_SCENARIOS.length] ?? 'crossover';
    let wait = AUTOPLAY_RETRY_MS;
    try {
      play(scenario);
      autoplayIndex += 1;
      wait = buildShowcase(scenario).slotMs;
    } catch (error) {
      if (!(error instanceof RoundConflictError)) {
        autoplayIndex += 1;
        console.error(
          `[showcase] autoplay ${scenario} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    autoplayTimer = setTimeout(runAutoplayStep, wait);
  }

  function stopAutoplay(): void {
    if (autoplayTimer !== null) clearTimeout(autoplayTimer);
    autoplayTimer = null;
  }

  return {
    play,
    stop,
    startAutoplay() {
      stopAutoplay();
      autoplayIndex = 0;
      runAutoplayStep();
    },
    stopAutoplay,
    isAutoplaying: () => autoplayTimer !== null,
    dispose() {
      stopAutoplay();
      stop();
    },
  };
}
