// Text and chrome: HUD pill, SIMULATED badge, minimap, banners, caption and debug readout.
// Every piece of text is rasterized into a sprite only when its content changes (compared by
// primitive arguments, so checking costs no allocation); frames just blit the sprites.
import {
  HEIGHT,
  ROLE,
  WIDTH,
  createCanvas,
  ellipsize,
  fitFont,
  font,
  roundRectPath,
  setTracking,
  shade,
  withAlpha,
} from './draw.js';

const GLOW = 28;

/** Total sprite rebuilds; the stage uses it to detect that something on screen changed. */
let spriteBuilds = 0;

export function spriteBuildCount() {
  return spriteBuilds;
}

/**
 * Sprite cache keyed by up to eight primitive arguments. `sync()` rebuilds only when an
 * argument changed; fixed arity avoids allocating a rest-args array every frame.
 */
export class CachedSprite {
  constructor(build) {
    this.build = build;
    this.canvas = null;
    this.a = this.b = this.c = this.d = this.e = this.f = this.g = this.h = undefined;
  }

  sync(a, b, c, d, e, f, g, h) {
    if (
      this.canvas &&
      a === this.a &&
      b === this.b &&
      c === this.c &&
      d === this.d &&
      e === this.e &&
      f === this.f &&
      g === this.g &&
      h === this.h
    ) {
      return this.canvas;
    }
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
    this.g = g;
    this.h = h;
    this.canvas = this.build(a, b, c, d, e, f, g, h);
    spriteBuilds += 1;
    return this.canvas;
  }

  invalidate() {
    this.canvas = null;
  }
}

/** Draws a sprite centered on (cx, cy) with uniform scale and alpha. */
export function drawCentered(ctx, sprite, cx, cy, alpha, scale) {
  if (!sprite || alpha <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.setTransform(scale, 0, 0, scale, cx, cy);
  ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

/** Jumbotron panel: dark glass, accent border and outer glow, faint LED scanlines. */
function paintPanel(ctx, x, y, w, h, radius, palette, accent) {
  const ink = palette[ROLE.ink];
  ctx.save();
  ctx.shadowColor = withAlpha(accent, 0.45);
  ctx.shadowBlur = GLOW;
  roundRectPath(ctx, x, y, w, h, radius);
  const body = ctx.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, withAlpha(shade(ink, 0.1), 0.94));
  body.addColorStop(1, withAlpha(ink, 0.94));
  ctx.fillStyle = body;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.clip();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
  for (let line = y + 2; line < y + h; line += 4) ctx.fillRect(x, line, w, 1);
  ctx.restore();
  ctx.save();
  roundRectPath(ctx, x + 1.5, y + 1.5, w - 3, h - 3, Math.max(0, radius - 1.5));
  ctx.lineWidth = 3;
  ctx.strokeStyle = withAlpha(accent, 0.9);
  ctx.stroke();
  ctx.restore();
}

/** Draws `parts` ([text, color] pairs, flattened) left-to-right centered on cx. */
function drawParts(ctx, parts, cx, baseline) {
  let total = 0;
  for (let i = 0; i < parts.length; i += 2) total += ctx.measureText(parts[i]).width;
  let x = cx - total / 2;
  ctx.textAlign = 'left';
  for (let i = 0; i < parts.length; i += 2) {
    ctx.fillStyle = parts[i + 1];
    ctx.fillText(parts[i], x, baseline);
    x += ctx.measureText(parts[i]).width;
  }
}

/**
 * Generic stadium banner: small tracked kicker, huge main line made of colored parts, optional
 * sub line. Built only when content changes.
 */
export function buildBanner(
  palette,
  accent,
  kicker,
  kickerColor,
  parts,
  sub,
  subColor,
  mainPx = 92,
) {
  const scratch = createCanvas(4, 4).getContext('2d');
  const maxText = WIDTH - 420;
  const mainText = parts.filter((_, i) => i % 2 === 0).join('');
  const mainSize = fitFont(scratch, mainText, 900, mainPx, maxText, 44);
  const mainWidth = scratch.measureText(mainText).width;
  scratch.font = font(800, 26);
  setTracking(scratch, 6);
  const shownKicker = kicker ? ellipsize(scratch, kicker, maxText) : '';
  const kickerWidth = shownKicker ? scratch.measureText(shownKicker).width : 0;
  setTracking(scratch, 0);
  const subSize = sub ? fitFont(scratch, sub, 800, 32, maxText, 18) : 0;
  const subWidth = sub ? scratch.measureText(sub).width : 0;

  const padX = 72;
  const w = Math.ceil(Math.max(mainWidth, kickerWidth, subWidth) + padX * 2);
  const kickerBlock = kicker ? 42 : 0;
  const subBlock = sub ? subSize + 22 : 0;
  const h = Math.ceil(34 + kickerBlock + mainSize * 1.02 + subBlock + 30);
  const canvas = createCanvas(w + GLOW * 2, h + GLOW * 2);
  const ctx = canvas.getContext('2d');
  paintPanel(ctx, GLOW, GLOW, w, h, 30, palette, accent);
  // Accent bar across the top edge.
  ctx.save();
  roundRectPath(ctx, GLOW, GLOW, w, h, 30);
  ctx.clip();
  ctx.fillStyle = accent;
  ctx.fillRect(GLOW, GLOW, w, 7);
  ctx.restore();

  const cx = GLOW + w / 2;
  let y = GLOW + 34;
  ctx.textBaseline = 'alphabetic';
  if (kicker) {
    ctx.font = font(800, 26);
    setTracking(ctx, 6);
    ctx.textAlign = 'center';
    ctx.fillStyle = kickerColor;
    ctx.fillText(shownKicker, cx, y + 24);
    setTracking(ctx, 0);
    y += kickerBlock;
  }
  ctx.font = font(900, mainSize);
  drawParts(ctx, parts, cx, y + mainSize * 0.8);
  y += mainSize * 1.02;
  if (sub) {
    ctx.font = font(800, subSize);
    ctx.textAlign = 'center';
    ctx.fillStyle = subColor;
    ctx.fillText(sub, cx, y + 14 + subSize * 0.8);
  }
  return canvas;
}

/** SIMULATED badge (top-left): loud by design; virtual crowds must never pass as real. */
export function buildSimulatedBadge(palette) {
  const yellow = palette[ROLE.highlight];
  const ink = palette[ROLE.ink];
  const stripeBand = 34;
  const textX = stripeBand + 18;
  const scratch = createCanvas(4, 4).getContext('2d');
  scratch.font = font(900, 38);
  setTracking(scratch, 2);
  const textWidth = scratch.measureText('SIMULATED').width;
  const w = Math.ceil(textX + textWidth + 22);
  const h = 86;
  const x0 = 8;
  const y0 = 6;
  const canvas = createCanvas(w + 16, h + 16);
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 3;
  roundRectPath(ctx, x0, y0, w, h, 16);
  ctx.fillStyle = yellow;
  ctx.fill();
  ctx.restore();
  // Hazard stripes confined to the left band (clip = rounded badge ∩ band).
  ctx.save();
  roundRectPath(ctx, x0, y0, w, h, 16);
  ctx.clip();
  ctx.beginPath();
  ctx.rect(x0, y0, stripeBand, h);
  ctx.clip();
  ctx.fillStyle = ink;
  for (let x = -h; x < stripeBand; x += 18) {
    ctx.beginPath();
    ctx.moveTo(x0 + x, y0 + h);
    ctx.lineTo(x0 + x + h, y0);
    ctx.lineTo(x0 + x + h + 9, y0);
    ctx.lineTo(x0 + x + 9, y0 + h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = ink;
  ctx.fillRect(x0 + stripeBand, y0, 3, h);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = font(900, 38);
  setTracking(ctx, 2);
  ctx.fillText('SIMULATED', x0 + textX, y0 + 46);
  ctx.font = font(800, 15);
  setTracking(ctx, 2.5);
  ctx.fillText('VIRTUAL CROWD · DEMO', x0 + textX + 1, y0 + 72);
  setTracking(ctx, 0);
  return canvas;
}

/** Closed-caption style sprite, readable over any stream content. */
export function buildCaption(text) {
  const scratch = createCanvas(4, 4).getContext('2d');
  scratch.font = font(700, 40);
  const textWidth = scratch.measureText(text).width;
  const w = Math.ceil(textWidth + 56);
  const h = 66;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  roundRectPath(ctx, 0, 0, w, h, 10);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
  ctx.fill();
  ctx.font = font(700, 40);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 2);
  return canvas;
}

export function buildDebug(text) {
  const scratch = createCanvas(4, 4).getContext('2d');
  scratch.font = font(600, 18);
  const w = Math.ceil(scratch.measureText(text).width + 24);
  const canvas = createCanvas(w, 34);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
  ctx.fillRect(0, 0, w, 34);
  ctx.font = font(600, 18);
  ctx.fillStyle = '#9dfc9d';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, 18);
  return canvas;
}

function formatClock(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest}`;
}

/** Digits of a non-negative integer without allocating a string (frame-loop safe). */
function digitCount(value) {
  let digits = 1;
  for (let rest = value; rest >= 10; rest = Math.floor(rest / 10)) digits += 1;
  return digits;
}

/** Widest visible pill: stays clear of the crossover minimap on the right. */
const PILL_MAX_W = 800;
const PILL_H = 96;
const PILL_TOP = 26;
const BAR_H = 10;
const SEP = '  ·  ';
/** Smallest HUD label size before a long channel name gets an ellipsis. */
const LABEL_MIN_PX = 30;

/**
 * Top-center HUD: `<label> · p/q · 0:21` plus a progress bar. The glowing panel (with label,
 * separators and bar track) is rebuilt only when the label or quorum changes; the count and
 * the countdown are tiny shadow-free text sprites, so the once-per-second tick stays cheap.
 * The bar fill is drawn live so it can ease smoothly.
 */
export class HudPill {
  constructor() {
    this.palette = null;
    this.left = 0;
    this.countX = 0;
    this.countSlot = 0;
    this.timeX = 0;
    this.timeSlot = 0;
    this.barX = 0;
    this.barY = PILL_TOP + 70;
    this.barW = 0;
    this.panel = new CachedSprite((label, digits, q, team) =>
      this.#buildPanel(label, digits, q, team),
    );
    this.count = new CachedSprite((p, q, ready, team, slot) =>
      this.#buildCount(p, q, ready, team, slot),
    );
    this.time = new CachedSprite((seconds, slot) => this.#buildTime(seconds, slot));
    this.otherReady = new CachedSprite((label, color) => this.#buildChip(label, color));
  }

  setPalette(palette) {
    this.palette = palette;
    this.panel.invalidate();
    this.count.invalidate();
    this.time.invalidate();
    this.otherReady.invalidate();
  }

  /** Syncs all HUD sprites; `seconds` < 0 means the countdown is over (reveal scheduled). */
  sync(label, p, q, seconds, ready, team) {
    // The count slot grows only when a number gains a digit (late joiners past the quorum).
    this.panel.sync(label, Math.max(digitCount(p), digitCount(q)), q, team);
    this.count.sync(p, q, ready, team, this.countSlot);
    this.time.sync(seconds, this.timeSlot);
  }

  #buildPanel(label, digits, q, team) {
    const palette = this.palette;
    const scratch = createCanvas(4, 4).getContext('2d');
    scratch.font = font(900, 42);
    const sepWidth = scratch.measureText(SEP).width;
    const countSlot = scratch.measureText(`${'8'.repeat(digits)}/${q} ✓`).width;
    const timeSlot = scratch.measureText('00:00').width;
    const padX = 40;
    // Never grow past the minimap: a label that does not fit first shrinks (down to 30 px, so
    // "RIGHT STAND · 300/400" stays whole) and only then is ellipsized.
    const labelRoom = Math.max(140, PILL_MAX_W - padX * 2 - countSlot - timeSlot - sepWidth * 2);
    const labelSize = fitFont(scratch, label, 900, 42, labelRoom, LABEL_MIN_PX);
    const shownLabel = ellipsize(scratch, label, labelRoom);
    const labelWidth = scratch.measureText(shownLabel).width;
    const w = Math.ceil(labelWidth + countSlot + timeSlot + sepWidth * 2 + padX * 2);
    const canvas = createCanvas(w + GLOW * 2, PILL_H + GLOW * 2);
    const ctx = canvas.getContext('2d');
    paintPanel(ctx, GLOW, GLOW, w, PILL_H, 30, palette, team);

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const baseline = GLOW + 54;
    let x = GLOW + padX;
    ctx.font = font(900, labelSize);
    ctx.fillStyle = palette[ROLE.paper];
    ctx.fillText(shownLabel, x, baseline);
    x += labelWidth;
    ctx.font = font(900, 42);
    ctx.fillStyle = withAlpha(palette[ROLE.paper], 0.45);
    ctx.fillText(SEP, x, baseline);
    x += sepWidth;
    const countCenter = x + countSlot / 2;
    x += countSlot;
    ctx.fillText(SEP, x, baseline);
    x += sepWidth;
    const timeCenter = x + timeSlot / 2;

    this.left = WIDTH / 2 - canvas.width / 2;
    this.countX = this.left + countCenter;
    this.countSlot = Math.floor(countSlot);
    this.timeX = this.left + timeCenter;
    this.timeSlot = Math.floor(timeSlot);
    this.barX = this.left + GLOW + padX;
    this.barW = w - padX * 2;
    // The bar track is static, so it lives in the panel sprite.
    roundRectPath(ctx, GLOW + padX, GLOW + 70, this.barW, BAR_H, BAR_H / 2);
    ctx.fillStyle = withAlpha(palette[ROLE.paper], 0.14);
    ctx.fill();
    return canvas;
  }

  /** Shadow-free text sprite sharing the panel baseline; shrinks to fit its slot. */
  #buildText(text, color, slot) {
    const scratch = createCanvas(4, 4).getContext('2d');
    const size = fitFont(scratch, text, 900, 42, Math.max(40, slot), 22);
    const canvas = createCanvas(scratch.measureText(text).width + 8, 56);
    const ctx = canvas.getContext('2d');
    ctx.font = font(900, size);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, 46);
    return canvas;
  }

  #buildCount(p, q, ready, team, slot) {
    const palette = this.palette;
    return this.#buildText(
      ready ? `${p}/${q} ✓` : `${p}/${q}`,
      ready ? shade(palette[ROLE.ready], 0.25) : team,
      slot,
    );
  }

  #buildTime(seconds, slot) {
    const palette = this.palette;
    if (seconds < 0) return this.#buildText('REVEAL!', palette[ROLE.highlight], slot);
    const color = seconds <= 10 ? shade(palette[ROLE.alert], 0.18) : palette[ROLE.paper];
    return this.#buildText(formatClock(seconds), color, slot);
  }

  #buildChip() {
    const palette = this.palette;
    const text = 'TYPE ANYTHING IN CHAT';
    const color = palette[ROLE.highlight];
    const scratch = createCanvas(4, 4).getContext('2d');
    scratch.font = font(800, 28);
    setTracking(scratch, 2);
    const w = Math.ceil(scratch.measureText(text).width + 48);
    const h = 46;
    const canvas = createCanvas(w + GLOW * 2, h + GLOW * 2);
    const ctx = canvas.getContext('2d');
    paintPanel(ctx, GLOW, GLOW, w, h, h / 2, palette, color);
    ctx.font = font(800, 28);
    setTracking(ctx, 2);
    ctx.fillStyle = shade(color, 0.3);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, GLOW + w / 2, GLOW + h / 2 + 1);
    return canvas;
  }

  /** Draws the pill; `progress` is the eased 0..1 bar fill. */
  draw(ctx, alpha, progress, fillColor) {
    const panel = this.panel.canvas;
    if (!panel || alpha <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.drawImage(panel, this.left, PILL_TOP - GLOW);
    const count = this.count.canvas;
    const time = this.time.canvas;
    // Text sprites share the panel baseline (sprite baseline 46 ↔ panel baseline 54).
    if (count) ctx.drawImage(count, this.countX - count.width / 2, PILL_TOP + 8);
    if (time) ctx.drawImage(time, this.timeX - time.width / 2, PILL_TOP + 8);
    const fill = Math.max(0, Math.min(1, progress)) * this.barW;
    if (fill > 1) {
      roundRectPath(ctx, this.barX, this.barY, Math.max(fill, BAR_H), BAR_H, BAR_H / 2);
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Small chip under the pill (e.g. "LEFT STAND IS READY"). */
  drawChip(ctx, alpha) {
    const chip = this.otherReady.canvas;
    if (!chip || alpha <= 0) return;
    drawCentered(ctx, chip, WIDTH / 2, PILL_TOP + PILL_H + 36, alpha, 1);
  }
}

/**
 * Minimap of the full image (top-right): both halves at their own progress, seam line, own
 * half outlined and partner progress under the other half. Cells are painted incrementally.
 */
export class Minimap {
  constructor() {
    this.palette = null;
    this.mode = 'crossover';
    this.side = 'A';
    this.cols = 96;
    this.rows = 27;
    this.cell = 5;
    this.grid = null;
    this.gridCtx = null;
    this.shown = new Uint8Array(96 * 27);
    /** Bumped on every visible change (cells, labels, layout). */
    this.version = 0;
    this.panel = null;
    this.frame = null;
    this.x = 0;
    this.y = 0;
    this.gridX = 0;
    this.gridY = 0;
    this.labels = new CachedSprite((p, q, ready, full, ownLabel, theirColor) =>
      this.#buildLabels(p, q, ready, full, ownLabel, theirColor),
    );
  }

  configure(palette, mode, side) {
    this.palette = palette;
    this.mode = mode;
    this.side = side;
    this.cols = mode === 'crossover' ? 96 : 48;
    // ~6 px per card; crossover uses 5 px so the 32:9 strip stays clear of the HUD pill.
    this.cell = mode === 'crossover' ? 5 : 6;
    const gridW = this.cols * this.cell;
    const gridH = this.rows * this.cell;
    this.grid = createCanvas(gridW, gridH);
    this.gridCtx = this.grid.getContext('2d');
    this.shown = new Uint8Array(this.cols * this.rows).fill(255);

    const pad = 14;
    const labelBand = 40;
    const w = gridW + pad * 2;
    const h = gridH + pad * 2 + labelBand;
    this.x = WIDTH - 26 - w - GLOW;
    this.y = 26 - GLOW;
    this.gridX = this.x + GLOW + pad;
    this.gridY = this.y + GLOW + pad;

    const accent = palette[side === 'A' ? ROLE.teamA : ROLE.teamB];
    this.panel = createCanvas(w + GLOW * 2, h + GLOW * 2);
    paintPanel(this.panel.getContext('2d'), GLOW, GLOW, w, h, 18, palette, accent);

    // Overlay frame: own-half outline and the seam line, drawn above the cells.
    this.frame = createCanvas(w + GLOW * 2, h + GLOW * 2);
    const ctx = this.frame.getContext('2d');
    const gx = GLOW + pad;
    const gy = GLOW + pad;
    if (mode === 'crossover') {
      const half = 48 * this.cell;
      const ownX = side === 'A' ? gx : gx + half;
      ctx.lineWidth = 3;
      ctx.strokeStyle = accent;
      roundRectPath(ctx, ownX - 3, gy - 3, half + 5, gridH + 6, 4);
      ctx.stroke();
      ctx.fillStyle = palette[ROLE.paper];
      ctx.fillRect(gx + half - 1, gy - 8, 2, gridH + 16);
    }
    this.labels.invalidate();
    this.version += 1;
  }

  /** Paints one full-image cell if its color changed. Allocation-free. */
  paint(gx, gy, color) {
    const index = gy * this.cols + gx;
    if (this.shown[index] === color) return;
    this.shown[index] = color;
    this.version += 1;
    const ctx = this.gridCtx;
    const size = this.cell;
    ctx.clearRect(gx * size, gy * size, size, size);
    ctx.fillStyle = this.palette[color];
    ctx.fillRect(gx * size, gy * size, size - 1, size - 1);
  }

  /**
   * Label band under the cells. Primitive arguments keep the cache check allocation-free:
   * partner participants/quorum/ready, `full` once the reveal shows the whole picture, our own
   * label and the partner's team color.
   */
  syncLabels(p, q, ready, full, ownLabel, theirColor) {
    this.labels.sync(p, q, ready, full, ownLabel, theirColor);
  }

  #buildLabels(p, q, ready, full, ownLabel, theirColor) {
    const palette = this.palette;
    const gridW = this.cols * this.cell;
    const canvas = createCanvas(gridW, 36);
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'middle';
    const y = 19;
    if (full || this.mode === 'single') {
      ctx.font = font(900, 21);
      setTracking(ctx, 3);
      ctx.textAlign = 'center';
      ctx.fillStyle = palette[ROLE.highlight];
      ctx.fillText(full ? 'THE FULL PICTURE' : 'WHOLE PICTURE', gridW / 2, y);
      setTracking(ctx, 0);
      return canvas;
    }
    const half = gridW / 2;
    const ownCenter = this.side === 'A' ? half / 2 : half + half / 2;
    const theirCenter = this.side === 'A' ? half + half / 2 : half / 2;
    ctx.font = font(800, 17);
    setTracking(ctx, 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = withAlpha(palette[ROLE.paper], 0.72);
    ctx.fillText(ellipsize(ctx, `YOU · ${ownLabel}`, half - 16), ownCenter, y);
    ctx.font = font(900, 21);
    setTracking(ctx, 1.5);
    const count = ready ? `${p}/${q} ✓` : `${p}/${q}`;
    const parts = [
      'THEIR SIDE ',
      palette[ROLE.paper],
      count,
      ready ? shade(palette[ROLE.ready], 0.25) : theirColor,
    ];
    drawParts(ctx, parts, theirCenter, y);
    setTracking(ctx, 0);
    return canvas;
  }

  draw(ctx, alpha) {
    if (!this.panel || alpha <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.drawImage(this.panel, this.x, this.y);
    ctx.drawImage(this.grid, this.gridX, this.gridY);
    ctx.drawImage(this.frame, this.x, this.y);
    const labels = this.labels.canvas;
    if (labels) ctx.drawImage(labels, this.gridX, this.gridY + this.rows * this.cell + 12);
    ctx.globalAlpha = 1;
  }
}

/** Caption position helper (bottom center, above the lower safe margin). */
export const CAPTION_Y = HEIGHT - 70;
