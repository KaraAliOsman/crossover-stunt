// Scene choreography: turns (round, snapshot, meta) plus the stage clock into what is on the
// canvas. All scheduled moments derive from server timestamps (deadlineAtMs, revealAtMs), so
// both overlays animate in lockstep and a reload restores state without replaying one-shots.
import { Confetti, ZIPPER_TOTAL_MS, Zipper } from './effects.js';
import {
  DEFAULT_PALETTE,
  HEIGHT,
  ROLE,
  WIDTH,
  approach,
  clamp01,
  easeInCubic,
  createCanvas,
  roundRectPath,
  easeOutBack,
  easeOutCubic,
  shade,
  withAlpha,
} from './draw.js';
import { CARD_COUNT, COLS, CardGrid, FLIP_MS, PITCH, ROWS } from './grid.js';
import {
  CAPTION_Y,
  CachedSprite,
  HudPill,
  Minimap,
  buildBanner,
  buildCaption,
  buildDebug,
  buildSimulatedBadge,
  drawCentered,
  spriteBuildCount,
} from './hud.js';
import { PlanReplay, SEEK_NONE, SEEK_REBUILT, finalColors, stepsToShow } from './plan.js';

// Timeline (docs/DESIGN.md §Overlay). All values in milliseconds.
const ROW_RISE_MS = 420;
const ROW_LAG_MS = 7; // 26 rows × 7 ms + 420 ms ≈ 600 ms total
const RISE_TOTAL_MS = ROW_RISE_MS + (ROWS - 1) * ROW_LAG_MS;
const ROW_DROP_MS = 340;
const DROP_TOTAL_MS = ROW_DROP_MS + (ROWS - 1) * ROW_LAG_MS;
const ZIPPER_MS = 600;
const WAVE_MS = 2_400;
const TITLE_HOLD_MS = 10_000;
const UNITE_TITLE_HOLD_MS = 9_000;
const TITLE_FADE_MS = 700;
const TIMEOUT_HOLD_MS = 6_000;
const TIMEOUT_FADE_MS = 800;
const CAPTION_MS = 3_000;
/** One-shot effects (confetti, roar) fire only when observed this close to their schedule. */
const LIVE_GRACE_MS = 500;
/**
 * A healthy server ticks every 250 ms and publishes `timed-out` right at the deadline. An
 * `active` snapshot this far past its deadline is stale (server or tunnel gone without a clean
 * close), so the stand drops instead of freezing on 0:00 until someone hides the source.
 */
const STALE_ACTIVE_MS = 8_000;
const RIPPLE_MS_PER_CARD = 14;
const RIPPLE_MAX_MS = 380;
const STEP_SPACING_MS = 110;
const BATCH_SPREAD_MS = 900;
const BANNER_ALTERNATES = Object.freeze([520, 140, 920]);
const UNITE_TITLE_ALTERNATES = Object.freeze([140, 520, 714]);
const BANNER_Y = Math.round(HEIGHT * 0.66);
const STAND_CODES = Object.freeze({ down: 0, rising: 1, up: 2, dropping: 3 });
const FRAME_KEY_SIZE = 27;
const UNITE_DELAY_MS = 500;
const UNITE_FIT_MS = 900;
const CTA_MS = 2_800;

/** Alpha/scale quantization for the frame key (1/1024 steps are invisible). */
function quantize(value) {
  return Math.round(value * 1024);
}

function isRevealPhase(phase) {
  return phase === 'revealing' || phase === 'complete';
}

const SIDE_KEYS = ['A', 'B'];

/**
 * Per-round derived data, rebuilt on every new roundId. The minimap reuses our own side's
 * replay (same plan, same progress) and only adds one for the partner's half.
 */
function createRoundState(payload, side) {
  const plans = SIDE_KEYS.map((key) => payload.plans[key] ?? null);
  const replays = plans.map((plan) => (plan ? new PlanReplay(plan) : null));
  const finals = plans.map((plan) => (plan ? finalColors(plan) : null));
  const own = side === 'A' ? 0 : 1;
  const ownPlan = plans[own];
  return {
    payload,
    ownPlan,
    ownReplay: replays[own],
    ownFinal: finals[own],
    regionX: ownPlan ? ownPlan.region.x : 0,
    miniReplays: replays,
    miniFinals: finals,
    miniDirty: true,
    miniFlipped: 0,
    /** Local columns already flipped to their final color by the reveal wave. */
    flippedCols: 0,
    seenSnapshot: false,
    seamBurstDone: false,
    roarDone: false,
    finaleDone: false,
    uniteBurstDone: false,
    uniteLayer: null,
    captionUntil: -Infinity,
    timedOutSeenAt: null,
  };
}

export class Stage {
  constructor({
    side,
    reducedMotion,
    audio,
    countdownLeadMs = 0,
    unite = true,
    hold = false,
    occlusion = null,
  }) {
    this.side = side;
    this.unite = unite;
    this.hold = hold;
    this.occlusion = occlusion;
    /**
     * `latencyMs` overlay param: the on-stream countdown reaches 0:00 this long before the
     * server deadline. Viewers see the stream seconds late while their chat arrives almost
     * live, so with the lead covering that latency every visible second still counts.
     */
    this.countdownLeadMs = countdownLeadMs;
    /** Seconds shown on the HUD (-1 when hidden); exposed through inspect(). */
    this.hudSeconds = -1;
    this.other = side === 'A' ? 'B' : 'A';
    this.audio = audio;
    this.reducedMotion = false;
    this.palette = null;
    this.labels = { A: 'SIDE A', B: 'SIDE B' };
    this.round = null;
    /** Server unreachable for a while (socket closed and polls failing): keep the round, hide. */
    this.linkLost = false;
    /** Round waiting for the stand to finish dropping (undefined = nothing pending). */
    this.pendingRound = undefined;
    this.snapshot = null;

    this.grid = new CardGrid();
    this.confetti = new Confetti();
    this.zipper = new Zipper();
    this.hud = new HudPill();
    this.minimap = new Minimap();
    this.badge = null;
    this.caption = buildCaption('[crowd roars]');
    this.debugSprite = new CachedSprite((text) => buildDebug(text));
    this.debugText = '';
    this.waitingBanner = new CachedSprite((label, color, remaining) =>
      this.#buildWaiting(label, color, remaining),
    );
    this.introBanner = new CachedSprite((mode, a, b) => this.#buildIntro(mode, a, b));
    this.lagBanner = new CachedSprite((label, remaining) => this.#buildLagging(label, remaining));
    this.soCloseBanner = new CachedSprite((a, b, c, d, e, f, g, h) =>
      this.#buildSoClose(a, b, c, d, e, f, g, h),
    );
    this.titleBanner = new CachedSprite((a, b, c, d, e) => this.#buildTitle(a, b, c, d, e));

    this.stand = 'down';
    this.standAt = 0;
    this.cleared = false;
    /** Draw parameters of the current frame (fixed shape, reused every frame). */
    this.plan = {
      fade: 1,
      visibility: 0,
      pulse: 0,
      zipper: -1,
      caption: 0,
      barReady: false,
      simulated: false,
      waitAlpha: 0,
      waitScale: 1,
      soCloseAlpha: 0,
      soCloseScale: 1,
      titleAlpha: 0,
      titleScale: 1,
      introAlpha: 0,
      introScale: 1,
      lagScale: 1,
      ctaChipAlpha: 0,
      uniteSince: -1,
    };
    /** Previous frame's parameters; an identical key means the canvas is already correct. */
    this.frameKey = new Float64Array(FRAME_KEY_SIZE).fill(Number.NaN);
    this.hudAlpha = 0;
    this.waitAlpha = 0;
    this.waitSince = 0;
    this.chipAlpha = 0;
    this.barProgress = 0;
    this.setReducedMotion(reducedMotion);
    this.#setPalette(DEFAULT_PALETTE);
  }

  setReducedMotion(reduced) {
    this.reducedMotion = reduced;
    this.grid.setReducedMotion(reduced);
  }

  setMeta(meta) {
    const a = meta.labels.A.toUpperCase();
    const b = meta.labels.B.toUpperCase();
    // Keep the object identity when nothing changed: polling re-sends meta every second and
    // sprite caches compare the labels object by reference.
    if (a !== this.labels.A || b !== this.labels.B) this.labels = { A: a, B: b };
  }

  setDebugText(text) {
    this.debugText = text;
  }

  /**
   * Lost contact hides the stand without discarding the round; when contact returns the next
   * snapshot shows it again and one-shots stay latched (they only fire when observed live).
   */
  setLinkLost(lost) {
    this.linkLost = lost;
  }

  /** Accepts a validated RoundPayload (or null after RESET). */
  setRound(payload, now) {
    const currentId = this.round ? this.round.payload.roundId : null;
    const nextId = payload ? payload.roundId : null;
    if (this.pendingRound === undefined && currentId === nextId) return;
    if (this.stand === 'rising' || this.stand === 'up') {
      this.pendingRound = payload;
      this.#startDrop(now);
      return;
    }
    if (this.stand === 'dropping') {
      this.pendingRound = payload;
      return;
    }
    this.#applyRound(payload, now);
  }

  /**
   * Accepts a validated snapshot. Returns true when it references a round this overlay has not
   * received, so the caller can request a sync.
   */
  setSnapshot(snapshot, now) {
    const previous = this.snapshot;
    // Drop out-of-order frames (WS vs polling). A restarted server resets `revision` but its
    // clock keeps moving forward, so a newer serverNowMs is still accepted.
    if (
      previous &&
      snapshot.revision < previous.revision &&
      snapshot.serverNowMs <= previous.serverNowMs
    ) {
      return false;
    }
    this.snapshot = snapshot;
    const round = this.round;
    if (round && snapshot.roundId === round.payload.roundId) this.#applySnapshot(now);
    const pendingId = this.pendingRound ? this.pendingRound.roundId : null;
    return (
      snapshot.roundId !== null &&
      snapshot.roundId !== (round ? round.payload.roundId : null) &&
      snapshot.roundId !== pendingId
    );
  }

  #setPalette(palette) {
    if (this.palette === palette) return;
    this.palette = palette;
    this.grid.setPalette(palette);
    this.confetti.setPalette(palette);
    this.zipper.setPalette(palette);
    this.hud.setPalette(palette);
    this.badge = buildSimulatedBadge(palette);
    this.waitingBanner.invalidate();
    this.introBanner.invalidate();
    this.lagBanner.invalidate();
    this.soCloseBanner.invalidate();
    this.titleBanner.invalidate();
  }

  #applyRound(payload, now) {
    this.pendingRound = undefined;
    this.round = null;
    this.confetti.clear();
    if (!payload) return;
    const samePalette =
      this.palette.length === payload.palette.length &&
      this.palette.every((color, index) => color === payload.palette[index]);
    this.#setPalette(samePalette ? this.palette : payload.palette);
    const round = createRoundState(payload, this.side);
    this.round = round;
    this.minimap.configure(this.palette, payload.mode, this.side);
    if (round.ownReplay) this.grid.snapAll(round.ownReplay.colors);
    this.barProgress = 0;
    if (this.snapshot && this.snapshot.roundId === payload.roundId) this.#applySnapshot(now);
  }

  #applySnapshot(now) {
    const round = this.round;
    const snapshot = this.snapshot;
    if (!round.seenSnapshot && isRevealPhase(snapshot.phase) && snapshot.revealAtMs !== null) {
      // Restoring a round during the live grace window must not replay an effect that already
      // happened. Future effects still run normally from their server timestamps.
      const closeAt = snapshot.revealAtMs + ZIPPER_MS;
      if (now >= closeAt) {
        round.roarDone = true;
        round.seamBurstDone = true;
      }
      if (now >= closeAt + WAVE_MS) round.finaleDone = true;
      if (now >= closeAt + WAVE_MS + UNITE_DELAY_MS + UNITE_FIT_MS) round.uniteBurstDone = true;
    }
    if (round.ownReplay) {
      const progress = snapshot.sides[this.side].progress;
      const result = round.ownReplay.seek(stepsToShow(round.ownPlan, progress, false));
      if (result !== SEEK_NONE) {
        round.miniDirty = true;
        // The first snapshot of a round (fresh load or reconnect) snaps; later ones animate.
        const animate = round.seenSnapshot && this.stand !== 'down' && result !== SEEK_REBUILT;
        this.#pushBase(now, animate);
      }
    }
    for (let s = 0; s < 2; s += 1) {
      const replay = round.miniReplays[s];
      if (!replay) continue;
      const progress = snapshot.sides[SIDE_KEYS[s]].progress;
      if (replay.seek(stepsToShow(replay.plan, progress, false)) !== SEEK_NONE) {
        round.miniDirty = true;
      }
    }
    if (snapshot.phase === 'timed-out' && round.timedOutSeenAt === null) {
      // With delayMs the stage clock lags the server: hold SO CLOSE until the delayed
      // countdown has actually reached the deadline.
      round.timedOutSeenAt =
        snapshot.deadlineAtMs === null ? now : Math.max(now, snapshot.deadlineAtMs);
    }
    round.seenSnapshot = true;
  }

  /** Moves the grid to the replay's base colors, rippling flips out from each split center. */
  #pushBase(now, animate) {
    const round = this.round;
    const replay = round.ownReplay;
    const steps = round.ownPlan.steps;
    const grid = this.grid;
    const batch = Math.max(1, replay.applied - replay.batchStart);
    const spacing = Math.min(STEP_SPACING_MS, BATCH_SPREAD_MS / batch);
    for (let i = 0; i < CARD_COUNT; i += 1) {
      const column = i % COLS;
      if (column < round.flippedCols) continue; // the reveal wave already owns this column
      const color = replay.colors[i];
      if (!animate) {
        if (grid.to[i] !== color) grid.snap(i, color);
        continue;
      }
      const stepIndex = replay.touchedBy[i];
      if (stepIndex < 0) continue;
      // Every card under a new split flips (even if its color holds), so each new person
      // visibly ripples the stand outward from the split's center.
      const parent = steps[stepIndex].parent;
      const row = (i - column) / COLS;
      const dx = round.regionX + column + 0.5 - (parent.x + parent.w / 2);
      const dy = row + 0.5 - (parent.y + parent.h / 2);
      const ripple = Math.min(RIPPLE_MAX_MS, Math.sqrt(dx * dx + dy * dy) * RIPPLE_MS_PER_CARD);
      grid.flip(i, color, now + (stepIndex - replay.batchStart) * spacing + ripple, now, false);
    }
  }

  #startDrop(now) {
    if (this.stand === 'down' || this.stand === 'dropping') return;
    this.stand = 'dropping';
    this.standAt = now;
  }

  #roundSnapshot() {
    const round = this.round;
    const snapshot = this.snapshot;
    if (!round || !snapshot || snapshot.roundId !== round.payload.roundId) return null;
    return snapshot;
  }

  #timedOutFade(snapshot, now) {
    if (snapshot.phase !== 'timed-out') return 1;
    const base = snapshot.deadlineAtMs ?? this.round.timedOutSeenAt ?? now;
    return 1 - clamp01((now - base - TIMEOUT_HOLD_MS) / TIMEOUT_FADE_MS);
  }

  /** Whether the stand should be up right now. */
  #shouldShow(now) {
    const snapshot = this.#roundSnapshot();
    if (!snapshot || !this.round.ownReplay || snapshot.phase === 'idle') return false;
    if (snapshot.startedAtMs !== null && now < snapshot.startedAtMs) return false;
    if (this.linkLost) return false;
    if (!this.hold && snapshot.phase === 'complete' && snapshot.revealAtMs !== null) {
      const titleDelay = this.#usesUnite() ? UNITE_DELAY_MS + UNITE_FIT_MS + 300 : 0;
      const retireAt =
        snapshot.revealAtMs +
        ZIPPER_MS +
        WAVE_MS +
        titleDelay +
        this.#titleHoldMs() +
        TITLE_FADE_MS +
        4_000;
      if (now >= retireAt) return false;
    }
    if (
      snapshot.phase === 'active' &&
      snapshot.deadlineAtMs !== null &&
      now > snapshot.deadlineAtMs + STALE_ACTIVE_MS
    ) {
      return false;
    }
    return this.#timedOutFade(snapshot, now) > 0;
  }

  /**
   * Whether the countdown still runs at stage time `now`. With delayMs the server may already
   * report `timed-out` while the delayed stream still shows the last seconds ticking down.
   */
  #counting(snapshot, now) {
    if (snapshot.phase === 'active') return true;
    return (
      snapshot.phase === 'timed-out' &&
      snapshot.deadlineAtMs !== null &&
      now < snapshot.deadlineAtMs
    );
  }

  /** Advances all state for stage time `now` (server ms − delayMs). Allocation-free. */
  update(now, dtMs) {
    const show = this.#shouldShow(now);
    if (this.stand === 'down' && show) {
      this.stand = this.reducedMotion ? 'up' : 'rising';
      this.standAt = now;
    } else if (this.stand === 'rising' && now - this.standAt >= RISE_TOTAL_MS) {
      this.stand = 'up';
    } else if (
      this.stand === 'dropping' &&
      (this.reducedMotion || now - this.standAt >= DROP_TOTAL_MS)
    ) {
      this.stand = 'down';
      if (this.pendingRound !== undefined) this.#applyRound(this.pendingRound, now);
    }
    if ((this.stand === 'up' || this.stand === 'rising') && !show) {
      const snapshot = this.#roundSnapshot();
      if (snapshot && snapshot.phase === 'timed-out') this.stand = 'down';
      else this.#startDrop(now);
    }

    const snapshot = this.#roundSnapshot();
    if (snapshot && isRevealPhase(snapshot.phase) && snapshot.revealAtMs !== null) {
      this.#updateReveal(snapshot, now);
    }
    if (this.stand !== 'down') {
      this.grid.update(now);
      this.#updateMinimap(snapshot, now);
    }
    this.confetti.update(dtMs);
    this.#updateChrome(snapshot, now, dtMs);
  }

  #updateReveal(snapshot, now) {
    const round = this.round;
    const revealAt = snapshot.revealAtMs;
    const perColumn = WAVE_MS / round.payload.cols;
    const visible = this.stand !== 'down';

    // Wave: global column c flips at revealAt + 600 + c × (2400 / cols), crossing A → B.
    if (round.ownFinal) {
      while (round.flippedCols < COLS) {
        const at = revealAt + ZIPPER_MS + (round.regionX + round.flippedCols) * perColumn;
        if (now < at) break;
        const live = visible && now - at < FLIP_MS;
        for (let row = 0; row < ROWS; row += 1) {
          const i = row * COLS + round.flippedCols;
          if (live) this.grid.flip(i, round.ownFinal[i], at, now, true);
          else this.grid.snap(i, round.ownFinal[i]);
        }
        round.flippedCols += 1;
      }
    }

    // One-shots: only when observed live, so reconnects never replay them.
    const closeAt = revealAt + ZIPPER_MS;
    if (!round.roarDone && now >= closeAt) {
      round.roarDone = true;
      if (visible && now - closeAt < LIVE_GRACE_MS) {
        this.audio.roar();
        round.captionUntil = closeAt + CAPTION_MS;
      }
    }
    if (!round.seamBurstDone && now >= closeAt) {
      round.seamBurstDone = true;
      if (visible && !this.reducedMotion && now - closeAt < LIVE_GRACE_MS) {
        if (round.payload.mode === 'crossover') {
          const right = this.side === 'A';
          this.confetti.burst(
            110,
            right ? WIDTH - 6 : 6,
            HEIGHT * 0.15,
            right ? WIDTH - 6 : 6,
            HEIGHT,
            right ? -Math.PI * 0.78 : -Math.PI * 0.22,
            0.32,
            700,
            1250,
          );
        }
      }
    }
    const uniteSince = this.#uniteSince(snapshot, now);
    if (uniteSince >= 0) {
      if (!round.uniteLayer) this.#buildUnite();
      if (!round.uniteBurstDone && uniteSince >= UNITE_FIT_MS) {
        round.uniteBurstDone = true;
        if (visible && !this.reducedMotion && uniteSince - UNITE_FIT_MS < LIVE_GRACE_MS)
          this.confetti.burst(
            90,
            WIDTH / 2,
            HEIGHT / 2,
            WIDTH / 2,
            HEIGHT / 2,
            -Math.PI / 2,
            0.8,
            400,
            800,
          );
      }
    }
    const finaleAt = closeAt + WAVE_MS;
    if (!round.finaleDone && now >= finaleAt) {
      round.finaleDone = true;
      if (visible && !this.reducedMotion && now - finaleAt < LIVE_GRACE_MS) {
        this.confetti.burst(190, 0, HEIGHT + 10, WIDTH, HEIGHT + 10, -Math.PI / 2, 0.42, 900, 1700);
      }
    }
  }

  #titleHoldMs() {
    return this.#usesUnite() ? UNITE_TITLE_HOLD_MS : TITLE_HOLD_MS;
  }

  #usesUnite() {
    return this.unite && this.round?.payload.mode === 'crossover';
  }

  #uniteSince(snapshot, now) {
    if (
      !this.#usesUnite() ||
      !snapshot ||
      !isRevealPhase(snapshot.phase) ||
      snapshot.revealAtMs === null
    )
      return -1;
    return now - snapshot.revealAtMs - ZIPPER_MS - WAVE_MS - UNITE_DELAY_MS;
  }

  /** Built once per round from final plan colours; never from chatter data. */
  #buildUnite() {
    const round = this.round;
    const layer = createCanvas(WIDTH, HEIGHT / 2);
    const ctx = layer.getContext('2d');
    for (let side = 0; side < 2; side += 1) {
      const plan = round.miniReplays[side].plan;
      const colors = round.miniFinals[side];
      for (let y = 0; y < ROWS; y += 1)
        for (let x = 0; x < COLS; x += 1) {
          ctx.fillStyle = this.palette[colors[y * COLS + x]];
          roundRectPath(ctx, (plan.region.x + x) * 20 + 1, y * 20 + 1, 18, 18, 3);
          ctx.fill();
        }
    }
    round.uniteLayer = layer;
  }

  #drawUnite(ctx, since) {
    const layer = this.round.uniteLayer;
    if (!layer) return;
    const t = this.reducedMotion ? 1 : clamp01(since / UNITE_FIT_MS);
    const own = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const other = this.reducedMotion ? 1 : easeOutCubic(clamp01((since - 200) / 700));
    if (t >= 1) ctx.drawImage(layer, 0, HEIGHT / 4);
    else {
      ctx.save();
      ctx.translate(this.side === 'A' ? 0 : (WIDTH / 2) * own, (HEIGHT / 4) * own);
      ctx.scale(1 - 0.5 * own, 1 - 0.5 * own);
      ctx.drawImage(this.grid.layer, 0, 0);
      ctx.restore();
      if (other > 0)
        ctx.drawImage(
          layer,
          this.side === 'A' ? WIDTH / 2 : 0,
          0,
          WIDTH / 2,
          HEIGHT / 2,
          this.side === 'A' ? WIDTH - (WIDTH / 2) * other : (-WIDTH / 2) * (1 - other),
          HEIGHT / 4,
          WIDTH / 2,
          HEIGHT / 2,
        );
    }
    if (!this.reducedMotion && since >= UNITE_FIT_MS && since < UNITE_FIT_MS + 400) {
      ctx.globalAlpha = 1 - (since - UNITE_FIT_MS) / 400;
      ctx.fillStyle = this.palette[ROLE.paper];
      ctx.fillRect(WIDTH / 2 - 3, HEIGHT / 4, 6, HEIGHT / 2);
      ctx.globalAlpha = 1;
    }
  }

  #updateMinimap(snapshot, now) {
    const round = this.round;
    if (!round) return;
    const cols = round.payload.cols;
    let flipped = 0;
    if (snapshot && isRevealPhase(snapshot.phase) && snapshot.revealAtMs !== null) {
      const since = now - snapshot.revealAtMs - ZIPPER_MS;
      if (since >= 0) flipped = Math.min(cols, Math.floor(since / (WAVE_MS / cols)) + 1);
    }
    if (!round.miniDirty && flipped === round.miniFlipped) return;
    round.miniDirty = false;
    round.miniFlipped = flipped;
    for (let s = 0; s < 2; s += 1) {
      const replay = round.miniReplays[s];
      if (!replay) continue;
      const final = round.miniFinals[s];
      const { x: x0, w } = replay.region;
      for (let gy = 0; gy < ROWS; gy += 1) {
        for (let lx = 0; lx < w; lx += 1) {
          const gx = x0 + lx;
          const local = gy * w + lx;
          this.minimap.paint(gx, gy, gx < flipped ? final[local] : replay.colors[local]);
        }
      }
    }
  }

  #team(side) {
    return this.palette[side === 'A' ? ROLE.teamA : ROLE.teamB];
  }

  /** Syncs text sprites and eases chrome alphas. Sprite builds happen only on change. */
  #updateChrome(snapshot, now, dtMs) {
    if (!snapshot || this.stand === 'down') {
      this.hudAlpha = 0;
      this.waitAlpha = 0;
      this.chipAlpha = 0;
      return;
    }
    const round = this.round;
    const mode = round.payload.mode;
    const own = snapshot.sides[this.side];
    const other = snapshot.sides[this.other];
    const fadeRate = this.reducedMotion ? 1 : 1 / 260;
    const counting = this.#counting(snapshot, now);

    const beforeReveal =
      counting ||
      (snapshot.phase === 'revealing' &&
        (snapshot.revealAtMs === null || now < snapshot.revealAtMs));
    this.hudAlpha = approach(this.hudAlpha, beforeReveal ? 1 : 0, dtMs, fadeRate);
    if (this.hudAlpha > 0) {
      let seconds = -1;
      if (counting && snapshot.deadlineAtMs !== null) {
        const shownDeadline = snapshot.deadlineAtMs - this.countdownLeadMs;
        seconds = Math.max(0, Math.ceil((shownDeadline - now) / 1000));
      }
      this.hudSeconds = seconds;
      this.hud.sync(
        this.labels[this.side],
        own.participants,
        own.quorum,
        seconds,
        own.ready,
        this.#team(this.side),
      );
      const target = own.progress;
      this.barProgress = this.reducedMotion
        ? target
        : this.barProgress + (target - this.barProgress) * (1 - Math.exp(-dtMs / 140));
    }

    const crossover = mode === 'crossover';
    const waiting = crossover && counting && own.ready && !other.ready;
    if (waiting && this.waitAlpha === 0) this.waitSince = now;
    this.waitAlpha = approach(this.waitAlpha, waiting ? 1 : 0, dtMs, fadeRate);
    if (this.waitAlpha > 0)
      this.waitingBanner.sync(
        this.labels[this.other],
        this.#team(this.other),
        Math.max(0, other.quorum - other.participants),
      );

    const theirTurn = crossover && counting && other.ready && !own.ready;
    this.chipAlpha = approach(this.chipAlpha, theirTurn ? 1 : 0, dtMs, fadeRate);
    if (this.chipAlpha > 0)
      this.lagBanner.sync(this.labels[this.other], Math.max(0, own.quorum - own.participants));
    if (counting) {
      this.introBanner.sync(mode, this.labels.A, this.labels.B);
      this.hud.otherReady.sync();
    }

    if (crossover) {
      const full =
        isRevealPhase(snapshot.phase) &&
        snapshot.revealAtMs !== null &&
        now >= snapshot.revealAtMs + ZIPPER_MS;
      this.minimap.syncLabels(
        other.participants,
        other.quorum,
        other.ready,
        full,
        this.labels[this.side],
        this.#team(this.other),
      );
    } else {
      this.minimap.syncLabels(0, 0, false, false, '', '');
    }

    if (snapshot.phase === 'timed-out') {
      this.soCloseBanner.sync(
        mode,
        own.participants,
        own.quorum,
        snapshot.sides.A.participants,
        snapshot.sides.A.quorum,
        snapshot.sides.B.participants,
        snapshot.sides.B.quorum,
        this.labels,
      );
    }
    if (isRevealPhase(snapshot.phase)) {
      const total =
        mode === 'crossover'
          ? snapshot.sides.A.participants + snapshot.sides.B.participants - snapshot.crossovers
          : snapshot.sides.A.participants;
      this.titleBanner.sync(mode, total, snapshot.crossovers, this.labels.A, this.labels.B);
    }
    if (this.debugText) this.debugSprite.sync(this.debugText);
  }

  #buildIntro(mode, a, b) {
    const p = this.palette;
    return buildBanner(
      p,
      p[ROLE.highlight],
      `STUNT! \u00b7 ${mode === 'single' ? a : `${a} + ${b}`}`,
      p[ROLE.highlight],
      ['TYPE ANYTHING ', p[ROLE.paper], 'IN CHAT', p[ROLE.highlight]],
      "EVERY NEW PERSON SHARPENS THE PICTURE \u00b7 SPAM DOESN'T COUNT",
      p[ROLE.paper],
    );
  }

  #buildLagging(label, remaining) {
    const p = this.palette;
    return buildBanner(
      p,
      p[ROLE.alert],
      `${label} IS READY \u2713`,
      p[ROLE.highlight],
      ["THEY'RE WAITING ON ", p[ROLE.paper], 'YOU', p[ROLE.highlight]],
      `TYPE ANYTHING \u00b7 ${remaining} MORE ${remaining === 1 ? 'PERSON' : 'PEOPLE'}`,
      p[ROLE.paper],
    );
  }

  #buildWaiting(label, color, remaining) {
    const palette = this.palette;
    return buildBanner(
      palette,
      color,
      'YOUR SIDE IS READY  ✓',
      shade(palette[ROLE.ready], 0.3),
      ['WAITING FOR ', palette[ROLE.paper], label, shade(color, 0.1)],
      `ONE PICTURE \u00b7 BOTH CHATS NEEDED \u00b7 ${remaining} MORE`,
      withAlpha(palette[ROLE.paper], 0.7),
    );
  }

  /** `labels` is the immutable labels object, so a meta update also rebuilds the banner. */
  /**
   * Single: `SO CLOSE · 9/12` (own numbers). Crossover: both sides on the sub line, because
   * "SO CLOSE · 10/10" on the side that did make it would read as a contradiction.
   */
  #buildSoClose(mode, p, q, pA, qA, pB, qB, labels) {
    const palette = this.palette;
    const { A: labelA, B: labelB } = labels;
    const alert = shade(palette[ROLE.alert], 0.2);
    const tick = (count, quorum) => (quorum > 0 && count >= quorum ? ' ✓' : '');
    const parts =
      mode === 'crossover'
        ? ['SO CLOSE', palette[ROLE.paper]]
        : [
            'SO CLOSE',
            palette[ROLE.paper],
            ' · ',
            withAlpha(palette[ROLE.paper], 0.5),
            `${p}/${q}`,
            alert,
          ];
    const sub =
      mode === 'crossover'
        ? `${labelA} ${pA}/${qA}${tick(pA, qA)}   ·   ${labelB} ${pB}/${qB}${tick(pB, qB)}`
        : 'THE PICTURE STAYS HIDDEN — NEXT TIME!';
    return buildBanner(
      palette,
      palette[ROLE.alert],
      "TIME'S UP",
      shade(palette[ROLE.alert], 0.25),
      parts,
      sub,
      palette[ROLE.paper],
    );
  }

  #buildTitle(mode, total, crossovers, labelA, labelB) {
    const palette = this.palette;
    const people = `${total} ${total === 1 ? 'PERSON' : 'PEOPLE'}`;
    if (mode === 'single') {
      return buildBanner(
        palette,
        palette[ROLE.highlight],
        labelA,
        palette[ROLE.highlight],
        [people, palette[ROLE.highlight], ' MADE THIS', palette[ROLE.paper]],
        'CARD STUNT COMPLETE',
        withAlpha(palette[ROLE.paper], 0.75),
      );
    }
    return buildBanner(
      palette,
      palette[ROLE.highlight],
      this.occlusion && this.unite ? '' : `${labelA}  +  ${labelB}`,
      palette[ROLE.highlight],
      [people, palette[ROLE.highlight], ' · 2 STREAMS', palette[ROLE.paper]],
      crossovers > 0
        ? `${crossovers} CROSSED OVER TO HELP THE OTHER SIDE`
        : 'NEITHER CHAT COULD DO IT ALONE',
      withAlpha(palette[ROLE.paper], 0.75),
      this.unite ? 76 : 92,
    );
  }

  /** Stand visibility 0..1 (rise/drop progress) used to fade chrome with the cards. */
  #standVisibility(now) {
    if (this.stand === 'up') return 1;
    if (this.stand === 'rising') return clamp01((now - this.standAt) / RISE_TOTAL_MS);
    if (this.stand === 'dropping') return 1 - clamp01((now - this.standAt) / DROP_TOTAL_MS);
    return 0;
  }

  #drawStand(ctx, now) {
    const layer = this.grid.layer;
    if (this.stand === 'up' || this.reducedMotion) {
      ctx.drawImage(layer, 0, 0);
      return;
    }
    const elapsed = now - this.standAt;
    for (let row = 0; row < ROWS; row += 1) {
      const travel = HEIGHT - row * PITCH;
      let offset;
      if (this.stand === 'rising') {
        // Top row leads so rows never cross: the stand unfurls upward from the bottom edge.
        const t = clamp01((elapsed - row * ROW_LAG_MS) / ROW_RISE_MS);
        offset = travel * (1 - easeOutCubic(t));
      } else {
        // Bottom row leads on the way down for the same reason.
        const t = clamp01((elapsed - (ROWS - 1 - row) * ROW_LAG_MS) / ROW_DROP_MS);
        offset = travel * easeInCubic(t);
      }
      if (offset >= travel) continue;
      ctx.drawImage(layer, 0, row * PITCH, WIDTH, PITCH, 0, row * PITCH + offset, WIDTH, PITCH);
    }
  }

  /** Banner alpha/scale for this frame, written into `out` (no allocation). */
  #planBanners(snapshot, now, visibility, out) {
    out.waitAlpha = this.waitAlpha * visibility;
    out.waitScale = this.#bannerScale(now - this.waitSince);
    out.soCloseAlpha = 0;
    out.soCloseScale = 1;
    out.titleAlpha = 0;
    out.titleScale = 1;
    out.introAlpha = 0;
    out.introScale = 1;
    out.ctaChipAlpha = 0;
    out.lagScale = this.reducedMotion ? 1 : 1.015 + 0.015 * Math.sin((now / 1300) * Math.PI * 2);
    if (!snapshot) return;
    const sinceStart = snapshot.startedAtMs === null ? -1 : now - snapshot.startedAtMs;
    const counting = this.#counting(snapshot, now);
    const needsPeople = !snapshot.sides[this.side].ready;
    if (counting && needsPeople && sinceStart >= 0) {
      if (sinceStart < CTA_MS && this.chipAlpha < 0.01) {
        out.introAlpha = visibility;
        out.introScale = this.#bannerScale(sinceStart);
      } else if (sinceStart >= CTA_MS) out.ctaChipAlpha = visibility;
    }
    if (snapshot.phase === 'timed-out' && this.round) {
      const since = now - (this.round.timedOutSeenAt ?? now);
      out.soCloseAlpha = clamp01(since / 250) * visibility;
      out.soCloseScale = this.#bannerScale(since);
    }
    if (isRevealPhase(snapshot.phase) && snapshot.revealAtMs !== null) {
      const titleDelay = this.#usesUnite() ? UNITE_DELAY_MS + UNITE_FIT_MS + 300 : 0;
      const since = now - (snapshot.revealAtMs + ZIPPER_MS + WAVE_MS + titleDelay);
      const end = this.#titleHoldMs() + TITLE_FADE_MS;
      if (since >= 0 && since < end) {
        out.titleAlpha =
          Math.min(clamp01(since / 300), clamp01((end - since) / TITLE_FADE_MS)) * visibility;
        out.titleScale = this.#bannerScale(since);
      }
    }
  }

  /** Writes one frame-key entry; returns whether it differed from the previous frame. */
  #key(index, value) {
    if (this.frameKey[index] === value) return false;
    this.frameKey[index] = value;
    return true;
  }

  /**
   * Computes every parameter that affects the pixels of this frame into `this.plan`. Returns
   * false when they all match the previous frame, so an unchanged stand costs no canvas work
   * (and no re-raster in OBS) at all.
   */
  #planFrame(now) {
    const plan = this.plan;
    const snapshot = this.#roundSnapshot() ?? this.snapshot;
    const round = this.round;
    plan.fade = snapshot && round ? this.#timedOutFade(snapshot, now) : 1;
    plan.visibility = this.#standVisibility(now) * plan.fade;
    plan.uniteSince = this.#uniteSince(snapshot, now);
    plan.pulse = 0;
    if (this.waitAlpha > 0) {
      const wave = this.reducedMotion
        ? 0.5
        : 0.5 + 0.5 * Math.sin(((now - this.waitSince) / 1300) * Math.PI * 2);
      plan.pulse = this.waitAlpha * (0.05 + 0.13 * wave) * plan.fade;
    }
    plan.zipper = -1;
    if (
      round &&
      snapshot &&
      round.payload.mode === 'crossover' &&
      snapshot.revealAtMs !== null &&
      isRevealPhase(snapshot.phase) &&
      !this.reducedMotion
    ) {
      const elapsed = now - snapshot.revealAtMs;
      if (elapsed >= 0 && elapsed <= ZIPPER_TOTAL_MS) plan.zipper = elapsed;
    }
    plan.caption =
      round && now < round.captionUntil
        ? Math.min(1, (round.captionUntil - now) / 300) * plan.fade
        : 0;
    plan.barReady = snapshot !== null && snapshot.sides[this.side].ready;
    plan.simulated = snapshot !== null && snapshot.simulated;
    this.#planBanners(snapshot, now, plan.visibility, plan);

    // Quantize alphas/scales so float noise never forces a redraw; `|` keeps every check.
    const animating = this.stand === 'rising' || this.stand === 'dropping';
    let changed = this.#key(0, STAND_CODES[this.stand]);
    changed = this.#key(1, animating ? now - this.standAt : 0) || changed;
    changed = this.#key(2, this.grid.version) || changed;
    changed = this.#key(3, this.minimap.version) || changed;
    changed = this.#key(4, spriteBuildCount()) || changed;
    changed = this.#key(5, quantize(plan.fade)) || changed;
    changed = this.#key(6, quantize(plan.visibility)) || changed;
    changed = this.#key(7, quantize(plan.pulse)) || changed;
    changed = this.#key(8, quantize(this.hudAlpha)) || changed;
    changed = this.#key(9, quantize(this.barProgress)) || changed;
    changed = this.#key(10, plan.barReady ? 1 : 0) || changed;
    changed = this.#key(11, quantize(this.chipAlpha)) || changed;
    changed = this.#key(12, plan.zipper) || changed;
    changed = this.#key(13, this.confetti.count > 0 ? now : -1) || changed;
    changed = this.#key(14, quantize(plan.caption)) || changed;
    changed = this.#key(15, quantize(plan.waitAlpha)) || changed;
    changed = this.#key(16, quantize(plan.waitScale)) || changed;
    changed = this.#key(17, quantize(plan.soCloseAlpha)) || changed;
    changed = this.#key(18, quantize(plan.soCloseScale)) || changed;
    changed = this.#key(19, quantize(plan.titleAlpha)) || changed;
    changed = this.#key(20, quantize(plan.titleScale)) || changed;
    changed = this.#key(21, plan.simulated ? 1 : 0) || changed;
    changed = this.#key(22, quantize(plan.introAlpha)) || changed;
    changed = this.#key(23, quantize(plan.introScale)) || changed;
    changed = this.#key(24, quantize(plan.ctaChipAlpha)) || changed;
    changed = this.#key(25, this.chipAlpha > 0 ? quantize(plan.lagScale) : 0) || changed;
    changed = this.#key(26, Math.min(1300, plan.uniteSince)) || changed;
    return changed;
  }

  /** Renders one frame. Draws nothing (and clears once) while the stand is down. */
  draw(ctx, now) {
    if (this.stand === 'down') {
      // Idle: transparent. Clear once, then skip all drawing (debug readout excepted).
      if (!this.cleared || this.debugText) {
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        this.cleared = true;
        this.frameKey.fill(Number.NaN);
      }
      if (this.debugText) this.#drawDebug(ctx);
      return;
    }
    if (!this.#planFrame(now)) return;
    this.cleared = false;
    const plan = this.plan;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    ctx.globalAlpha = plan.fade;
    if (plan.uniteSince >= 0) {
      ctx.save();
      if (this.stand === 'dropping')
        ctx.translate(0, HEIGHT * easeInCubic(clamp01((now - this.standAt) / DROP_TOTAL_MS)));
      this.#drawUnite(ctx, plan.uniteSince);
      ctx.restore();
    } else this.#drawStand(ctx, now);
    if (plan.pulse > 0) {
      // Brightness pulse on our own cards only (source-atop keeps the gaps transparent).
      ctx.globalCompositeOperation = 'source-atop';
      ctx.globalAlpha = plan.pulse;
      ctx.fillStyle = this.palette[ROLE.paper];
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
    if (plan.zipper >= 0) this.zipper.draw(ctx, plan.zipper, this.side === 'A' ? 'right' : 'left');

    if (plan.uniteSince < 0) {
      this.minimap.draw(ctx, plan.visibility);
      this.hud.draw(
        ctx,
        this.hudAlpha * plan.visibility,
        this.barProgress,
        plan.barReady ? this.palette[ROLE.ready] : this.#team(this.side),
      );
      this.hud.drawChip(ctx, plan.ctaChipAlpha);
    }
    // Confetti flies behind banners and captions so the text always stays legible.
    ctx.save();
    if (plan.uniteSince >= 0) {
      ctx.beginPath();
      ctx.rect(0, HEIGHT / 4, WIDTH, HEIGHT / 2);
      ctx.clip();
    }
    this.confetti.draw(ctx);
    ctx.restore();
    const cx = WIDTH / 2;
    // Catch-up snapshots can jump directly past the wave: retire participation cues immediately.
    if (plan.uniteSince < 0) {
      drawCentered(
        ctx,
        this.introBanner.canvas,
        cx,
        this.#bannerY(this.introBanner.canvas, HEIGHT / 2),
        plan.introAlpha,
        plan.introScale,
      );
      drawCentered(
        ctx,
        this.lagBanner.canvas,
        cx,
        this.#bannerY(this.lagBanner.canvas, BANNER_Y),
        this.chipAlpha * plan.visibility,
        plan.lagScale,
      );
      drawCentered(
        ctx,
        this.waitingBanner.canvas,
        cx,
        this.#bannerY(this.waitingBanner.canvas, BANNER_Y),
        plan.waitAlpha,
        plan.waitScale,
      );
      drawCentered(
        ctx,
        this.soCloseBanner.canvas,
        cx,
        this.#bannerY(this.soCloseBanner.canvas, BANNER_Y),
        plan.soCloseAlpha,
        plan.soCloseScale,
      );
    }
    drawCentered(
      ctx,
      this.titleBanner.canvas,
      cx,
      this.#bannerY(
        this.titleBanner.canvas,
        plan.uniteSince >= 0 ? 920 : BANNER_Y,
        plan.uniteSince >= 0,
      ),
      plan.titleAlpha,
      plan.titleScale,
    );
    drawCentered(ctx, this.caption, cx, CAPTION_Y, plan.caption, 1);
    if (plan.simulated) {
      ctx.globalAlpha = plan.visibility;
      const snapshot = this.#roundSnapshot();
      let badgeX = 18;
      let badgeY = 18;
      if (plan.uniteSince >= 0) {
        // Full-bleed text uses the band edge: keep the simulation label above the artwork.
        badgeY = HEIGHT / 4 - this.badge.height - 12;
      } else if (
        snapshot &&
        isRevealPhase(snapshot.phase) &&
        snapshot.revealAtMs !== null &&
        now >= snapshot.revealAtMs + ZIPPER_MS + WAVE_MS
      ) {
        badgeY = HEIGHT - this.badge.height - 18;
        if (this.occlusion && this.occlusion.x < WIDTH / 2) badgeX = WIDTH - this.badge.width - 18;
      }
      ctx.drawImage(this.badge, badgeX, badgeY);
      ctx.globalAlpha = 1;
    }
    if (this.debugText) this.#drawDebug(ctx);
  }

  #bannerY(sprite, preferred, united = false) {
    const hole = this.occlusion;
    if (!hole || !sprite) return preferred;
    // Include the banner's 3% pulse and glow in the exclusion bounds.
    const halfW = sprite.width * 0.52,
      halfH = sprite.height * 0.52;
    if (WIDTH / 2 + halfW <= hole.x || WIDTH / 2 - halfW >= hole.x + hole.w) return preferred;
    if (this.#bannerClear(preferred, halfH, hole)) return preferred;
    const candidates = united ? UNITE_TITLE_ALTERNATES : BANNER_ALTERNATES;
    for (let i = 0; i < candidates.length; i += 1)
      if (this.#bannerClear(candidates[i], halfH, hole)) return candidates[i];
    return preferred;
  }

  #bannerClear(y, halfH, hole) {
    return (
      y - halfH >= 8 &&
      y + halfH <= HEIGHT - 8 &&
      (y + halfH <= hole.y || y - halfH >= hole.y + hole.h)
    );
  }

  #bannerScale(sinceMs) {
    if (this.reducedMotion) return 1;
    return 0.86 + 0.14 * easeOutBack(clamp01(sinceMs / 450));
  }

  #drawDebug(ctx) {
    const sprite = this.debugSprite.canvas;
    if (sprite) ctx.drawImage(sprite, 12, HEIGHT - sprite.height - 12);
  }

  /** Read-only state for tests and `debug=1` (copies, never live references). */
  inspect() {
    const round = this.round;
    return {
      stand: this.stand,
      roundId: round ? round.payload.roundId : null,
      stepsShown: round && round.ownReplay ? round.ownReplay.applied : 0,
      flippedColumns: round ? round.flippedCols : 0,
      linkLost: this.linkLost,
      hudAlpha: this.hudAlpha,
      hudSeconds: this.hudSeconds,
      soCloseAlpha: this.plan.soCloseAlpha,
      introAlpha: this.plan.introAlpha,
      introScale: this.plan.introScale,
      ctaChipAlpha: this.plan.ctaChipAlpha,
      lagAlpha: this.plan.uniteSince >= 0 ? 0 : this.chipAlpha * this.plan.visibility,
      lagScale: this.plan.lagScale,
      waitingRemaining: this.waitingBanner.c ?? 0,
      uniteSince: this.plan.uniteSince,
      lagCenterY: this.#bannerY(this.lagBanner.canvas, BANNER_Y),
      lagHeight: this.lagBanner.canvas?.height ?? 0,
      titleCenterY: this.#bannerY(
        this.titleBanner.canvas,
        this.plan.uniteSince >= 0 ? 920 : BANNER_Y,
        this.plan.uniteSince >= 0,
      ),
      titleHeight: this.titleBanner.canvas?.height ?? 0,
      cards: Array.from(this.grid.to),
      confetti: this.confetti.count,
    };
  }
}
