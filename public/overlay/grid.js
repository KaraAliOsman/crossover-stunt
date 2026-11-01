// The 48×27 "stand" of flip cards. Card faces are pre-rendered once per palette into an atlas;
// the stand itself lives on an offscreen layer where only cards that changed or are mid-flip
// are redrawn, so a settled stand costs one drawImage per frame.
import { HEIGHT, WIDTH, createCanvas, roundRectPath } from './draw.js';

export const COLS = 48;
export const ROWS = 27;
export const CARD_COUNT = COLS * ROWS;
/** Card pitch: 36 px face + 4 px transparent gap (2 px inset on every side of the cell). */
export const PITCH = 40;
export const FACE = 36;
export const INSET = 2;
export const FLIP_MS = 280;

const RADIUS = 4;
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
    // Subtle top highlight (stadium card sheen) fading out by mid-card.
    const sheen = ctx.createLinearGradient(0, y, 0, y + FACE * 0.5);
    sheen.addColorStop(0, 'rgba(255, 255, 255, 0.24)');
    sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(x, y, FACE, FACE * 0.5);
    // Crisp bevel line on the top edge.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.32)';
    ctx.fillRect(x, y, FACE, 1.5);
    // Gentle shade on the lower third so cards read as physical boards.
    const base = ctx.createLinearGradient(0, y + FACE * 0.64, 0, y + FACE);
    base.addColorStop(0, 'rgba(0, 0, 0, 0)');
    base.addColorStop(1, 'rgba(0, 0, 0, 0.16)');
    ctx.fillStyle = base;
    ctx.fillRect(x, y + FACE * 0.64, FACE, FACE * 0.36);
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
  }

  setPalette(palette) {
    const built = buildAtlas(palette);
    this.atlas = built.atlas;
    this.shadeSlot = built.shadeSlot;
    this.lightSlot = built.lightSlot;
    this.dirty.fill(1);
  }

  setReducedMotion(reduced) {
    this.flipMs = reduced ? 0 : FLIP_MS;
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
        if (now >= start + flipMs) {
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
        t = (now - start) / this.flipMs;
        // Projected height of a card rotating about its horizontal axis.
        scale = Math.abs(Math.cos(Math.PI * t));
        color = t < 0.5 ? this.from[i] : this.to[i];
      }
    }
    const height = FACE * scale;
    if (height < 0.75) return;
    const x = cellX + INSET;
    const y = cellY + INSET + (FACE - height) / 2;
    ctx.drawImage(this.atlas, color * PITCH + INSET, INSET, FACE, FACE, x, y, FACE, height);
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
    if (this.flash[i] === 1 && t >= 0.5 && t < 1) {
      ctx.globalAlpha = 0.7 * (1 - (t - 0.5) * 2);
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
}
