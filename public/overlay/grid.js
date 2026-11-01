// The 48×27 "stand" of flip cards. Card faces are pre-rendered once per palette into an atlas;
// the stand itself lives on an offscreen layer where only cards that changed or are mid-flip
// are redrawn, so a settled stand costs one drawImage per frame.
import { HEIGHT, WIDTH, createCanvas, roundRectPath, shade } from './draw.js';
import { wavePose } from './motion.js';

export const COLS = 48;
export const ROWS = 27;
export const CARD_COUNT = COLS * ROWS;
/** Card pitch: 36 px face + 4 px transparent gap (2 px inset on every side of the cell). */
export const PITCH = 40;
export const FACE = 36;
export const INSET = 2;
export const FLIP_MS = 280;

const RADIUS = 5;
const SETTLED = -Infinity;

/**
 * Builds one 40×40 atlas slot per palette color, plus two masks used to light the flip:
 * a dark one (card turning edge-on) and a light one (reveal flash after the color swap).
 */
function buildAtlas(palette) {
  const slots = palette.length + 2;
  const atlas = createCanvas(slots * PITCH, PITCH);
  const ctx = atlas.getContext('2d');
  const face = (slot, fill) => {
    const x = slot * PITCH + INSET;
    const y = INSET;
    ctx.save();
    roundRectPath(ctx, x, y, FACE, FACE, RADIUS);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.clip();
    return { x, y };
  };

  palette.forEach((color, slot) => {
    const { x, y } = face(slot, color);
    // Matte paper: a restrained top light and seeded grain baked once, never per frame.
    const sheen = ctx.createLinearGradient(0, y, 0, y + FACE * 0.4);
    sheen.addColorStop(0, 'rgba(255,255,255,0.08)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(x, y, FACE, FACE * 0.4);
    ctx.fillStyle = shade(color, -0.18);
    ctx.fillRect(x, y + FACE - 1, FACE, 1);
    let seed = 17 + slot * 101;
    for (let grain = 0; grain < FACE * FACE; grain += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const gx = grain % FACE,
        gy = Math.floor(grain / FACE);
      if ((seed & 7) !== 0) continue;
      // Card-centre reference pixels remain exact palette values for seam verification.
      if (Math.abs(gx - 18) < 3 && Math.abs(gy - 18) < 3) continue;
      ctx.fillStyle = seed & 8 ? 'rgba(255,255,255,.025)' : 'rgba(0,0,0,.025)';
      ctx.fillRect(x + gx, y + gy, 1, 1);
    }
    ctx.restore();
  });
  face(palette.length, '#000000');
  ctx.restore();
  face(palette.length + 1, '#ffffff');
  ctx.restore();
  return { atlas, shadeSlot: palette.length, lightSlot: palette.length + 1 };
}

export class CardGrid {
  constructor() {
    this.layer = createCanvas(WIDTH, HEIGHT);
    this.ctx = this.layer.getContext('2d');
    this.atlas = null;
    this.shadeSlot = 0;
    this.lightSlot = 0;
    this.flipMs = FLIP_MS;
    /** Color shown before the flip midpoint. */
    this.from = new Uint8Array(CARD_COUNT);
    /** Color shown after the flip midpoint (the card's target). */
    this.to = new Uint8Array(CARD_COUNT);
    /** Flip start (stage ms); SETTLED when idle. May lie in the future (staggered flips). */
    this.start = new Float64Array(CARD_COUNT).fill(SETTLED);
    /** 1 when the flip should end with a light flash (reveal wave). */
    this.flash = new Uint8Array(CARD_COUNT);
    this.dirty = new Uint8Array(CARD_COUNT);
    this.busy = false;
    /** Bumped whenever the layer changes (lets the stage skip identical frames). */
    this.version = 0;
    this.waveColumns = 0;
  }

  setPalette(palette) {
    const built = buildAtlas(palette);
    this.atlas = built.atlas;
    this.shadeSlot = built.shadeSlot;
    this.lightSlot = built.lightSlot;
    this.dirty.fill(1);
  }

  setReducedMotion(reduced) {
    this.reduced = reduced;
    this.flipMs = reduced ? 180 : FLIP_MS;
  }

  /** Palette index visible on card `i` at stage time `now`. */
  visibleColor(i, now) {
    return now < this.start[i] + this.flipMs / 2 ? this.from[i] : this.to[i];
  }

  /** Immediately shows `color` (catch-up after reconnect, new round, reduced motion). */
  snap(i, color) {
    this.from[i] = color;
    this.to[i] = color;
    this.start[i] = SETTLED;
    this.flash[i] = 0;
    this.dirty[i] = 1;
  }

  snapAll(colors) {
    for (let i = 0; i < CARD_COUNT; i += 1) this.snap(i, colors[i]);
  }

  /** Schedules a flip to `color` starting at `at` (stage ms); `now` resolves in-flight flips. */
  flip(i, color, at, now, flash) {
    this.from[i] = this.visibleColor(i, now);
    this.to[i] = color;
    this.start[i] = at;
    this.flash[i] = flash ? 1 : 0;
    this.dirty[i] = 1;
  }

  /** Advances flips and repaints changed cards on the layer. Allocation-free. */
  update(now) {
    if (!this.atlas) return;
    let busy = false;
    const flipMs = this.flipMs;
    for (let i = 0; i < CARD_COUNT; i += 1) {
      const start = this.start[i];
      if (start !== SETTLED) {
        if (now >= start + flipMs + (this.flash[i] ? 90 : 0)) {
          this.from[i] = this.to[i];
          this.start[i] = SETTLED;
          this.flash[i] = 0;
          this.dirty[i] = 1;
        } else {
          busy = true;
          if (now >= start) this.dirty[i] = 1;
        }
      }
      if (this.dirty[i] === 1) {
        this.dirty[i] = 0;
        this.#drawCard(i, now);
        this.version += 1;
      }
    }
    this.busy = busy;
  }

  #drawCard(i, now) {
    const ctx = this.ctx;
    const column = i % COLS;
    const row = (i - column) / COLS;
    const cellX = column * PITCH;
    const cellY = row * PITCH;
    ctx.clearRect(cellX, cellY, PITCH, PITCH);

    const start = this.start[i];
    let color = this.to[i];
    let scale = 1;
    let t = 1;
    if (start !== SETTLED) {
      if (now < start) {
        color = this.from[i];
      } else if (this.flipMs > 0) {
        t = Math.min(1, (now - start) / this.flipMs);
        // Projected height of a card rotating about its horizontal axis.
        scale = this.reduced ? 1 : Math.abs(Math.cos(Math.PI * t));
        color = t < 0.5 ? this.from[i] : this.to[i];
      }
    }
    const height = FACE * scale;
    if (height < 0.75) return;
    const x = cellX + INSET;
    const y = cellY + INSET + (FACE - height) / 2;
    if (this.reduced && start !== SETTLED && now >= start && t < 1) {
      ctx.drawImage(
        this.atlas,
        this.from[i] * PITCH + INSET,
        INSET,
        FACE,
        FACE,
        x,
        y,
        FACE,
        height,
      );
      ctx.globalAlpha = t;
      color = this.to[i];
    }
    ctx.drawImage(this.atlas, color * PITCH + INSET, INSET, FACE, FACE, x, y, FACE, height);
    ctx.globalAlpha = 1;
    if (scale < 1) {
      // Darken as the card turns away from the "light" so the flip reads as 3D.
      ctx.globalAlpha = (1 - scale) * 0.55;
      ctx.drawImage(
        this.atlas,
        this.shadeSlot * PITCH + INSET,
        INSET,
        FACE,
        FACE,
        x,
        y,
        FACE,
        height,
      );
      ctx.globalAlpha = 1;
    }
    if (
      this.flash[i] === 1 &&
      !this.reduced &&
      now >= start + this.flipMs &&
      now < start + this.flipMs + 90
    ) {
      ctx.globalAlpha = 0.35 * (1 - (now - start - this.flipMs) / 90);
      ctx.drawImage(
        this.atlas,
        this.lightSlot * PITCH + INSET,
        INSET,
        FACE,
        FACE,
        x,
        y,
        FACE,
        height,
      );
      ctx.globalAlpha = 1;
    }
  }
  /** Only the crest window is repainted: at most 18 columns of the 48-column stand. */
  drawWave(ctx, now, revealAt, regionX, totalCols, reduced) {
    const perColumn = 2400 / totalCols;
    const elapsed = now - revealAt - 600;
    const window = reduced ? 400 : 420;
    const first = Math.max(0, Math.ceil((elapsed - window) / perColumn) - regionX);
    const last = Math.min(COLS - 1, Math.floor(elapsed / perColumn) - regionX);
    if (last < first) {
      this.waveColumns = 0;
      return;
    }
    this.waveColumns = last - first + 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(first * PITCH, 0, (last - first + 1) * PITCH, HEIGHT);
    ctx.clip();
    ctx.clearRect(first * PITCH, 0, (last - first + 1) * PITCH, HEIGHT);
    for (let column = first; column <= last; column += 1) {
      const since = elapsed - (regionX + column) * perColumn;
      const pose = wavePose(since, reduced);
      const scale = reduced ? 1 : 1 + 0.06 * Math.max(0, pose);
      const lift = reduced ? 0 : -10 * pose;
      // Batch one source texture at a time. Faces remain disjoint, so this preserves pixels
      // while avoiding two texture switches per card (only two per crest column).
      for (let row = 0; row < ROWS; row += 1) {
        const sx = column * PITCH + INSET,
          sy = row * PITCH + INSET;
        const dx = sx - (FACE * (scale - 1)) / 2,
          dy = sy + lift - (FACE * (scale - 1)) / 2;
        ctx.drawImage(this.layer, sx, sy, FACE, FACE, dx, dy, FACE * scale, FACE * scale);
      }
      if (pose > 0) {
        const alpha = ctx.globalAlpha;
        ctx.globalAlpha = alpha * pose * 0.14;
        for (let row = 0; row < ROWS; row += 1) {
          const i = row * COLS + column,
            start = this.start[i];
          const t = start === SETTLED ? 1 : Math.min(1, Math.max(0, (now - start) / this.flipMs));
          const flip = reduced ? 1 : Math.abs(Math.cos(Math.PI * t));
          const dx = column * PITCH + INSET - (FACE * (scale - 1)) / 2;
          const dy = row * PITCH + INSET + lift - (FACE * (scale - 1)) / 2;
          ctx.drawImage(
            this.atlas,
            this.lightSlot * PITCH + INSET,
            INSET,
            FACE,
            FACE,
            dx,
            dy + (FACE * scale * (1 - flip)) / 2,
            FACE * scale,
            FACE * scale * flip,
          );
        }
        ctx.globalAlpha = alpha;
      }
    }

    ctx.restore();
  }
}
