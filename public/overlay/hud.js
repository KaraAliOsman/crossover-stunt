// Broadcast chrome. Text and glyph atlases are cached on content changes; drawing never measures text.
import { HEIGHT, ROLE, WIDTH, createCanvas, ellipsize, roundRectPath } from './draw.js';
import { type } from './typography.js';
import { EASE_OUT, MOTION } from './motion.js';
export const UI = Object.freeze({
  text: '#F4F5F7',
  secondary: '#B7BAC0',
  tertiary: '#989DA5',
  glass: 'rgba(11,13,16,0.80)',
  line: 'rgba(255,255,255,0.10)',
});
let spriteBuilds = 0;
export function spriteBuildCount() {
  return spriteBuilds;
}
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
    const previous = this.canvas;
    if (previous) previous.previous = null;
    this.canvas = this.build(a, b, c, d, e, f, g, h);
    this.canvas.previous = previous;
    this.canvas.changedAt = performance.now();
    spriteBuilds += 1;
    return this.canvas;
  }

  invalidate() {
    this.canvas = null;
  }
}

export function drawCentered(ctx, sprite, cx, cy, alpha, scale = 1, reduced = false) {
  if (!sprite || alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy + (reduced ? 0 : (1 - alpha) * 16));
  ctx.scale(scale, scale);
  const t = EASE_OUT((performance.now() - sprite.changedAt) / MOTION.content);
  if (sprite.previous && t < 1) {
    ctx.globalAlpha = alpha * (1 - t);
    if (!reduced && 'filter' in ctx) ctx.filter = `blur(${2 * t}px)`;
    ctx.drawImage(sprite.previous, -sprite.previous.width / 2, -sprite.previous.height / 2);
    ctx.globalAlpha = alpha * t;
    if (!reduced && 'filter' in ctx) ctx.filter = `blur(${2 * (1 - t)}px)`;
  }
  ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
  ctx.restore();
}
export function paintPanel(ctx, x, y, w, h, radius = 16) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 12;
  roundRectPath(ctx, x, y, w, h, radius);
  ctx.fillStyle = UI.glass;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineWidth = 1;
  ctx.strokeStyle = UI.line;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + radius, y + 1);
  ctx.lineTo(x + w - radius, y + 1);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.stroke();
  ctx.restore();
}
export function brandMark(ctx, x, y, size, palette) {
  const half = (size - 2) / 2;
  ctx.fillStyle = palette[ROLE.teamA];
  ctx.fillRect(x, y, half, size);
  ctx.fillStyle = palette[ROLE.teamB];
  ctx.fillRect(x + half + 2, y, half, size);
}
function textFit(ctx, text, role, max, minimum) {
  let size = role === 'display' ? 72 : role === 'label' ? 16 : 20;
  type(ctx, role, size);
  while (size > minimum && ctx.measureText(text).width > max) {
    size -= 1;
    type(ctx, role, size);
  }
  if (role === 'display' && 'fontStretch' in ctx) {
    for (const stretch of ['semi-expanded', 'normal']) {
      if (ctx.measureText(text).width <= max) break;
      ctx.fontStretch = stretch;
    }
  }
  return [size, ellipsize(ctx, text, max)];
}
function drawParts(ctx, parts, cx, y, shown) {
  let total = 0;
  for (let i = 0; i < parts.length; i += 2) total += ctx.measureText(parts[i]).width;
  if (shown) {
    ctx.textAlign = 'center';
    ctx.fillStyle = UI.text;
    ctx.fillText(shown, cx, y);
    return;
  }
  let x = cx - total / 2;
  ctx.textAlign = 'left';
  for (let i = 0; i < parts.length; i += 2) {
    ctx.fillStyle = parts[i + 1];
    ctx.fillText(parts[i], x, y);
    x += ctx.measureText(parts[i]).width;
  }
}
// A single lower-third vocabulary for intro, waiting, urgency and timeout.
export function buildBanner(
  palette,
  accent,
  kicker,
  kickerColor,
  parts,
  sub,
  subColor,
  compositionScale = 1,
) {
  const w = 1240,
    h = 184,
    inset = 64,
    max = w - 80;
  const canvas = createCanvas(w + inset * 2, h + inset * 2);
  const ctx = canvas.getContext('2d');
  paintPanel(ctx, inset, inset, w, h);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const intro = kicker.startsWith('STUNT');
  type(ctx, 'label', Math.min(32, 16 / compositionScale));
  ctx.fillStyle = UI.secondary;
  const eyebrow = ellipsize(
    ctx,
    intro ? kicker.replace('STUNT!', 'CROSSOVER STUNT') : kicker,
    max - 32,
  );
  const eyebrowW = ctx.measureText(eyebrow).width;
  if (intro) brandMark(ctx, canvas.width / 2 - eyebrowW / 2 - 28, inset + 25, 16, palette);
  else {
    ctx.fillStyle = kicker.includes('YOUR SIDE') ? palette[ROLE.ready] : accent;
    ctx.beginPath();
    ctx.arc(canvas.width / 2 - eyebrowW / 2 - 16, inset + 34, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = UI.secondary;
  ctx.fillText(eyebrow, canvas.width / 2, inset + (compositionScale < 1 ? 36 : 34));
  const main = parts.filter((_, i) => i % 2 === 0).join('');
  const [, shown] = textFit(ctx, main, 'display', max, 40);
  drawParts(ctx, parts, canvas.width / 2, inset + 91, shown === main ? null : shown);
  let metaSize = Math.min(40, 20 / compositionScale);
  type(ctx, 'meta', metaSize);
  while (metaSize > 18 && ctx.measureText(sub).width > max) {
    metaSize -= 1;
    type(ctx, 'meta', metaSize);
  }
  const meta = ellipsize(ctx, sub, max);
  type(ctx, 'meta', metaSize);
  ctx.textAlign = 'center';
  ctx.fillStyle = UI.secondary;
  if (kicker === "TIME'S UP") type(ctx, 'data', 22);
  ctx.fillText(meta, canvas.width / 2, inset + 148);
  return canvas;
}
export function buildSimulatedBadge(palette) {
  const canvas = createCanvas(356, 184),
    ctx = canvas.getContext('2d');
  paintPanel(ctx, 64, 64, 228, 56, 28);
  ctx.save();
  roundRectPath(ctx, 64, 64, 228, 56, 28);
  ctx.clip();
  roundRectPath(ctx, 64, 64, 6, 56, 3);
  ctx.clip();
  ctx.strokeStyle = palette[ROLE.highlight];
  ctx.lineWidth = 3;
  for (let y = 50; y < 142; y += 8) {
    ctx.beginPath();
    ctx.moveTo(63, y);
    ctx.lineTo(73, y - 10);
    ctx.stroke();
  }
  ctx.restore();
  type(ctx, 'data', 20);
  ctx.font = '600 20px "Geist Mono", monospace';
  ctx.fillStyle = UI.text;
  ctx.textBaseline = 'middle';
  ctx.fillText('SIMULATED', 86, 84);
  type(ctx, 'label', 12);
  ctx.fillStyle = UI.secondary;
  ctx.fillText('VIRTUAL CROWD \u00b7 DEMO', 86, 106);
  return canvas;
}
export function buildCaption(text) {
  const scratch = createCanvas(1, 1).getContext('2d');
  type(scratch, 'caption');
  const canvas = createCanvas(scratch.measureText(text).width + 40, 52);
  const ctx = canvas.getContext('2d');
  roundRectPath(ctx, 0, 0, canvas.width, canvas.height, 4);
  ctx.fillStyle = 'rgba(0,0,0,0.82)';
  ctx.fill();
  type(ctx, 'caption');
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, 27);
  return canvas;
}
export function buildDebug(text) {
  const c = createCanvas(900, 30),
    ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,.8)';
  ctx.fillRect(0, 0, 900, 30);
  type(ctx, 'data', 14);
  ctx.fillStyle = '#b7bac0';
  ctx.fillText(text, 10, 21);
  return c;
}
// Fixed-width atlas: changed digits roll without text rasterization or layout work per frame.
class RollingText {
  constructor(size = 34, color = UI.text) {
    this.size = size;
    this.cell = Math.ceil(size * 0.62);
    this.height = Math.ceil(size * 1.45);
    this.chars = '0123456789/: READYVL-';
    this.text = '';
    this.previous = '';
    this.at = -Infinity;
    this.atlas = createCanvas(this.chars.length * this.cell, this.height);
    const ctx = this.atlas.getContext('2d');
    type(ctx, 'data', size);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    // A zero has no descender: its lower ink edge is the count's alphabetic baseline.
    this.baselineOffset = ctx.measureText('0').actualBoundingBoxDescent;
    this.readyInset = this.cell / 2 - ctx.measureText('R').actualBoundingBoxLeft;
    for (let i = 0; i < this.chars.length; i += 1)
      ctx.fillText(this.chars[i], i * this.cell + this.cell / 2, this.height / 2);
  }
  set(text, now) {
    if (text === this.text) return;
    this.previous = this.text || text;
    this.text = text;
    this.at = now;
  }
  active(now) {
    return now - this.at < MOTION.roll;
  }
  draw(ctx, cx, cy, now, reduced) {
    const t = reduced ? 1 : EASE_OUT((now - this.at) / MOTION.roll);
    const n = this.text.length,
      w = n * this.cell;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - w / 2, cy - this.height / 2, w, this.height);
    ctx.clip();
    for (let i = 0; i < n; i += 1) {
      const x = cx - w / 2 + i * this.cell;
      const index = this.chars.indexOf(this.text[i]);
      const previous = this.previous[this.previous.length - n + i] ?? this.text[i];
      const oldIndex = this.chars.indexOf(previous);
      const changed = previous !== this.text[i] && t < 1;
      if (changed && oldIndex >= 0)
        ctx.drawImage(
          this.atlas,
          oldIndex * this.cell,
          0,
          this.cell,
          this.height,
          x,
          cy - this.height / 2 - t * this.height,
          this.cell,
          this.height,
        );
      if (index >= 0)
        ctx.drawImage(
          this.atlas,
          index * this.cell,
          0,
          this.cell,
          this.height,
          x,
          cy - this.height / 2 + (changed ? (1 - t) * this.height : 0),
          this.cell,
          this.height,
        );
    }
    ctx.restore();
  }
}
function clock(seconds, revealing) {
  return seconds < 0
    ? revealing
      ? 'REVEAL'
      : ''
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export class HudPill {
  constructor(compositionScale = 1) {
    this.scale = compositionScale;
    this.compact = compositionScale < 0.65;
    this.palette = null;
    this.left = 0;
    this.panel = new CachedSprite((labels, mode, side) => this.build(labels, mode, side));
    this.otherReady = new CachedSprite(() => this.chip());
    this.refresh();
  }
  refresh() {
    this.seconds =
      this.lastPA =
      this.lastQA =
      this.lastPB =
      this.lastQB =
      this.readyA =
      this.readyB =
      this.revealing =
        undefined;
    this.countA = new RollingText();
    this.countB = new RollingText();
    this.time = new RollingText();
    this.urgentTime = new RollingText(34, '#f0e442');
    this.bars = [
      [0, 0, 0],
      [0, 0, 0],
    ];
    this.panel.invalidate();
    this.otherReady.invalidate();
  }
  setPalette(palette) {
    this.palette = palette;
    this.refresh();
  }
  sync(labels, mode, side, a, b, seconds, now, reduced, revealing = false) {
    this.panel.sync(labels, mode, side);
    this.mode = mode;
    this.side = side;
    this.now = now;
    this.reduced = reduced;
    if (seconds !== this.seconds || revealing !== this.revealing) {
      this.time.set(clock(seconds, revealing), now);
      this.urgentTime.set(clock(seconds, revealing), now);
      this.seconds = seconds;
      this.revealing = revealing;
    }
    if (a.participants !== this.lastPA || a.quorum !== this.lastQA || a.ready !== this.readyA) {
      this.countA.set(
        a.ready
          ? 'READY'
          : `${String(a.participants).padStart(String(a.quorum).length, ' ')}/${a.quorum}`,
        now,
      );
      this.lastPA = a.participants;
      this.lastQA = a.quorum;
    }
    if (b.participants !== this.lastPB || b.quorum !== this.lastQB || b.ready !== this.readyB) {
      this.countB.set(
        b.ready
          ? 'READY'
          : `${String(b.participants).padStart(String(b.quorum).length, ' ')}/${b.quorum}`,
        now,
      );
      this.lastPB = b.participants;
      this.lastQB = b.quorum;
    }
    this.readyA = a.ready;
    this.readyB = b.ready;
    for (let i = 0; i < 2; i += 1) {
      const bar = this.bars[i],
        target = i === 0 ? a.progress : b.progress;
      if (target !== bar[1]) {
        bar[0] += (bar[1] - bar[0]) * EASE_OUT((now - bar[2]) / MOTION.progress);
        bar[1] = target;
        bar[2] = now;
      }
    }
  }
  animating(now) {
    return (
      !this.reduced &&
      (this.countA.active(now) ||
        this.countB.active(now) ||
        this.time.active(now) ||
        now - this.bars[0][2] < MOTION.progress ||
        now - this.bars[1][2] < MOTION.progress)
    );
  }
  buildCompact(labels, mode) {
    const w = Math.max(480, Math.min(mode === 'single' ? 640 : 928, 1920 * this.scale - 128));
    const c = createCanvas(w + 128, 208),
      ctx = c.getContext('2d');
    paintPanel(ctx, 64, 64, w, 80, 36);
    const central = 152,
      half = (w - central) / (mode === 'single' ? 1 : 2);
    this.aX = 64 + half / 2;
    this.bX = 64 + w - half / 2;
    this.timeX = mode === 'single' ? 64 + w - central / 2 : 64 + w / 2;
    this.countY = 114;
    this.timeY = 104;
    this.barY = 136;
    const team = (key, x) => {
      type(ctx, 'label', 20);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = this.palette[key === 'A' ? ROLE.teamA : ROLE.teamB];
      ctx.fillText(ellipsize(ctx, labels[key], half - 40), x, 82);
    };
    team('A', this.aX);
    if (mode === 'crossover') team('B', this.bX);
    ctx.fillStyle = UI.line;
    ctx.fillRect(64 + half, 84, 1, 40);
    if (mode === 'crossover') ctx.fillRect(64 + half + central, 84, 1, 40);
    return c;
  }
  build(labels, mode, side) {
    if (this.compact) return this.buildCompact(labels, mode);
    this.countY = 100;
    this.timeY = 100;
    this.barY = 126;
    const w = mode === 'single' ? 640 : 928,
      canvas = createCanvas(w + 128, 200),
      ctx = canvas.getContext('2d');
    this.left = WIDTH / 2 - canvas.width / 2;
    this.w = w;
    ctx.translate(44, 52);
    paintPanel(ctx, 20, 12, w, 72, 36);
    ctx.textBaseline = 'middle';
    const team = (key, x, align) => {
      ctx.globalAlpha = 1;
      type(ctx, 'label', 18);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.textAlign = align;
      ctx.fillStyle = this.palette[key === 'A' ? ROLE.teamA : ROLE.teamB];
      ctx.fillText(ellipsize(ctx, labels[key], 144), x, 48);
      ctx.beginPath();
      ctx.arc(align === 'left' ? x - 15 : x + 15, 48, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    if (mode === 'single') {
      team('A', 56, 'left');
      this.aX = 386;
      this.timeX = 624;
    } else {
      team('A', 56, 'left');
      team('B', w - 16, 'right');
      this.aX = 352;
      this.bX = w - 224;
      this.timeX = canvas.width / 2;
    }
    ctx.strokeStyle = UI.line;
    ctx.lineWidth = 1;
    const separators = mode === 'single' ? [496] : [414, 554];
    for (const x of separators) {
      ctx.beginPath();
      ctx.moveTo(x, 32);
      ctx.lineTo(x, 64);
      ctx.stroke();
    }
    return canvas;
  }
  chip() {
    const c = createCanvas(528, 172),
      ctx = c.getContext('2d');
    paintPanel(ctx, 64, 64, 400, 44, 22);
    type(ctx, 'label', 16);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = UI.secondary;
    ctx.fillText('TYPE ANYTHING IN CHAT', 264, 86);
    return c;
  }
  draw(ctx, alpha, cx = WIDTH / 2, top = 64) {
    this.left = cx - (this.panel.canvas?.width ?? 0) / 2;
    this.top = top - 64;
    if (!this.panel.canvas || alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(this.panel.canvas, this.left, this.top);
    const drawTeam = (key, text, x, ready, index) => {
      ctx.globalAlpha = alpha * (this.side === key ? 1 : 0.64);
      text.draw(ctx, this.left + x, this.top + this.countY, this.now, this.reduced);
      if (ready) {
        // Six clear pixels between the stroke edge and READY's cached leading ink.
        const right = this.left + x - (text.text.length * text.cell) / 2 + text.readyInset - 7;
        const baseline = this.top + this.countY + text.baselineOffset;
        ctx.strokeStyle = this.palette[ROLE.ready];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(right - 11, baseline - 5);
        ctx.lineTo(right - 7, baseline - 1);
        ctx.lineTo(right, baseline - 10);
        ctx.stroke();
      }
      const bar = this.bars[index];
      const progress = this.reduced
        ? bar[1]
        : bar[0] + (bar[1] - bar[0]) * EASE_OUT((this.now - bar[2]) / MOTION.progress);
      ctx.fillStyle = 'rgba(255,255,255,.08)';
      ctx.fillRect(this.left + x - 49, this.top + this.barY, 98, 3);
      ctx.fillStyle = this.palette[key === 'A' ? ROLE.teamA : ROLE.teamB];
      ctx.fillRect(this.left + x - 49, this.top + this.barY, 98 * progress, 3);
    };
    drawTeam('A', this.countA, this.aX, this.readyA, 0);
    if (this.mode === 'crossover') drawTeam('B', this.countB, this.bX, this.readyB, 1);
    ctx.globalAlpha = alpha;
    (this.revealing || (this.seconds >= 0 && this.seconds <= 10)
      ? this.urgentTime
      : this.time
    ).draw(ctx, this.left + this.timeX, this.top + this.timeY, this.now, this.reduced);
    ctx.restore();
  }
  drawChip(ctx, alpha, cx = WIDTH / 2, cy = 166) {
    drawCentered(ctx, this.otherReady.canvas, cx, cy, alpha, 1, this.reduced);
  }
}
export class Minimap {
  constructor() {
    this.version = 0;
    this.labels = new CachedSprite((p, q, ready, full, own) =>
      this.buildLabels(p, q, ready, full, own),
    );
  }
  configure(palette, mode, side) {
    this.palette = palette;
    this.mode = mode;
    this.side = side;
    this.cols = mode === 'crossover' ? 96 : 48;
    this.rows = 27;
    this.cell = 4;
    this.grid = createCanvas(this.cols * this.cell, this.rows * this.cell);
    this.gridCtx = this.grid.getContext('2d');
    this.shown = new Uint8Array(this.cols * this.rows).fill(255);
    this.x = WIDTH - 64 - this.grid.width;
    this.y = 64;
    this.gridX = this.x;
    this.gridY = this.y;
    this.labels.invalidate();
    this.version += 1;
  }
  paint(x, y, color) {
    const i = y * this.cols + x;
    if (this.shown[i] === color) return;
    this.shown[i] = color;
    this.version += 1;
    this.gridCtx.fillStyle = this.palette[color];
    this.gridCtx.fillRect(x * this.cell, y * this.cell, this.cell, this.cell);
  }
  syncLabels(p, q, ready, full, own) {
    this.full = full;
    this.labels.sync(p, q, ready, full, own);
  }
  buildLabels(p, q, ready, full, own) {
    const c = createCanvas(this.grid.width, 44),
      ctx = c.getContext('2d');
    roundRectPath(ctx, 0, 0, c.width, 40, 8);
    ctx.fillStyle = UI.glass;
    ctx.fill();
    ctx.translate(8, 0);
    type(ctx, 'label', 15);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '.5px';
    ctx.fillStyle = UI.secondary;
    ctx.textBaseline = 'middle';
    if (full || this.mode === 'single') {
      ctx.fillText(full ? 'THE FULL PICTURE' : 'WHOLE PICTURE', 0, 19);
      return c;
    }
    const half = c.width / 2,
      ownX = this.side === 'A' ? 0 : half,
      theirX = this.side === 'A' ? half : 0;
    ctx.textAlign = 'left';
    ctx.fillText(ellipsize(ctx, `YOU \u00b7 ${own}`, half - 16), ownX, 19);
    ctx.fillText(ellipsize(ctx, `THEIR SIDE ${p}/${q}`, half - 16), theirX, 19);
    return c;
  }
  draw(ctx, alpha) {
    if (!this.grid || alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    roundRectPath(ctx, this.x, this.y, this.grid.width, this.grid.height, 10);
    ctx.clip();
    ctx.drawImage(this.grid, this.x, this.y);
    if (this.mode === 'crossover' && !this.full) {
      const half = this.grid.width / 2;
      const x = this.side === 'A' ? this.x + half : this.x;
      ctx.fillStyle = 'rgba(11,13,16,.22)';
      ctx.fillRect(x, this.y, half, this.grid.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, this.y, half, this.grid.height);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,.10)';
      ctx.lineWidth = 1;
      for (let d = -this.grid.height; d < half; d += 10) {
        ctx.beginPath();
        ctx.moveTo(x + d, this.y + this.grid.height);
        ctx.lineTo(x + d + this.grid.height, this.y);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = alpha;
    roundRectPath(ctx, this.x, this.y, this.grid.width, this.grid.height, 10);
    ctx.strokeStyle = UI.line;
    ctx.lineWidth = 1;
    ctx.stroke();
    if (this.mode === 'crossover') {
      ctx.fillStyle = 'rgba(255,255,255,.6)';
      ctx.fillRect(this.x + this.grid.width / 2, this.y, 1, this.grid.height);
    }
    if (this.labels.canvas)
      ctx.drawImage(this.labels.canvas, this.x, this.y + this.grid.height + 4);
    ctx.restore();
  }
}
// Finale numbers use a ten-glyph atlas, built once per cached end card, then count without measureText.
export function buildFinale(
  palette,
  mode,
  total,
  crossovers,
  labelA,
  labelB,
  compact = false,
  compositionScale = 1,
) {
  const w = compact ? 1080 : 1120,
    h = compositionScale < 1 ? 200 : 180,
    pad = 64,
    c = createCanvas(w + 128, h + 128),
    ctx = c.getContext('2d');
  paintPanel(ctx, pad, pad, w, h, 16);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  type(ctx, 'label', Math.min(32, 16 / compositionScale));
  ctx.fillStyle = UI.secondary;
  const eyebrow = mode === 'single' ? labelA : `${labelA} \u00d7 ${labelB} \u00b7 ONE PICTURE`;
  ctx.fillText(
    ellipsize(ctx, eyebrow, w - 120),
    c.width / 2,
    pad + (compositionScale < 1 ? 36 : 32),
  );
  const values = mode === 'single' ? [total] : crossovers > 0 ? [total, 2, crossovers] : [total, 2];
  const labels =
    mode === 'single'
      ? ['PEOPLE']
      : crossovers > 0
        ? ['PEOPLE', 'STREAMS', 'CROSSED OVER']
        : ['PEOPLE', 'STREAMS'];
  const columns = mode === 'single' ? 2 : 3;
  const colW = (w - 64) / columns;
  const xs = [];
  const statLabels = [];
  for (let i = 0; i < columns; i += 1) {
    const x = pad + 32 + colW * (i + 0.5);
    xs.push(x);
    if (i > 0) {
      ctx.fillStyle = UI.line;
      ctx.fillRect(pad + 32 + colW * i, pad + 58, 1, 96);
    }
    type(ctx, 'label', 16);
    ctx.fillStyle = UI.secondary;
    if (labels[i]) {
      const label = createCanvas(colW, compositionScale < 1 ? 64 : 32),
        l = label.getContext('2d');
      let labelPx = Math.min(40, 16 / compositionScale);
      type(l, 'label', labelPx);
      while (labelPx > 16 && l.measureText(labels[i]).width > colW - 48) {
        labelPx -= 1;
        type(l, 'label', labelPx);
      }
      l.fillStyle = UI.secondary;
      l.textAlign = 'center';
      l.textBaseline = 'middle';
      l.fillText(labels[i], colW / 2, label.height / 2);
      statLabels.push(label);
    }
  }
  if (values.length < columns) {
    const x = xs[columns - 1];
    let linePx = Math.min(32, 18 / compositionScale);
    type(ctx, 'meta', linePx);
    const shortZero = mode !== 'single' && compositionScale < 0.65;
    if (shortZero) linePx = 40;
    type(ctx, 'meta', linePx);
    const line =
      mode === 'single' ? 'CARD STUNT' : shortZero ? 'NEITHER CHAT' : 'NEITHER CHAT COULD';
    while (linePx > 18 && ctx.measureText(line).width > colW - 48) {
      linePx -= 1;
      type(ctx, 'meta', linePx);
    }
    ctx.fillStyle = UI.secondary;
    if (mode === 'single') {
      ctx.fillText('CARD STUNT', x, pad + 94);
      ctx.fillText('COMPLETE', x, pad + 120);
    } else if (shortZero) {
      ctx.fillText('NEITHER CHAT', x, pad + 79);
      ctx.fillText('COULD DO IT', x, pad + 110);
      ctx.fillText('ALONE', x, pad + 141);
    } else {
      ctx.fillText('NEITHER CHAT COULD', x, pad + 94);
      ctx.fillText('DO IT ALONE', x, pad + 120);
    }
  }
  const glyphW = 64,
    glyphH = 116,
    atlas = createCanvas(glyphW * 10, glyphH),
    a = atlas.getContext('2d');
  type(a, 'stat');
  a.textAlign = 'center';
  a.textBaseline = 'middle';
  a.fillStyle = UI.text;
  for (let d = 0; d < 10; d += 1) a.fillText(String(d), d * glyphW + glyphW / 2, 58);
  c.finale = {
    values,
    xs,
    atlas,
    glyphW,
    glyphH,
    numberY: pad + 41,
    labelY: pad + (compositionScale < 1 ? 128 : 132),
    statLabels,
  };
  return c;
}
export function drawFinaleNumbers(ctx, sprite, cx, cy, since, alpha, scale, reduced) {
  if (!sprite?.finale || alpha <= 0) return;
  const f = sprite.finale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(
    cx - (sprite.width * scale) / 2,
    cy - (sprite.height * scale) / 2 + (reduced ? 0 : (1 - alpha) * 16),
  );
  ctx.scale(scale, scale);
  for (let i = 0; i < f.values.length; i += 1) {
    const t = reduced ? 1 : EASE_OUT((since - i * MOTION.stagger) / MOTION.count);
    const entrance = reduced ? 1 : EASE_OUT((since - i * MOTION.stagger) / MOTION.enter);
    const dy = reduced ? 0 : (1 - entrance) * 16;
    ctx.globalAlpha = alpha * entrance;
    if (f.statLabels[i])
      ctx.drawImage(f.statLabels[i], f.xs[i] - f.statLabels[i].width / 2, f.labelY + dy);
    const value = Math.round(f.values[i] * t);
    let digits = 1;
    for (let n = value; n >= 10; n = Math.floor(n / 10)) digits += 1;
    let rest = value;
    for (let d = digits - 1; d >= 0; d -= 1) {
      const digit = rest % 10;
      rest = Math.floor(rest / 10);
      ctx.drawImage(
        f.atlas,
        digit * f.glyphW,
        0,
        f.glyphW,
        f.glyphH,
        f.xs[i] - (digits * f.glyphW) / 2 + d * f.glyphW,
        f.numberY + dy,
        f.glyphW,
        f.glyphH,
      );
    }
  }
  ctx.restore();
}
export const CAPTION_Y = HEIGHT - 90;
