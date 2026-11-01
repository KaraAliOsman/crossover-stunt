// Reveal effects: a pooled confetti system (struct-of-arrays, no per-frame allocation) and the
// seam zipper glow, whose gradients are rendered once into sprites.
import { HEIGHT, WIDTH, createCanvas, roundRectPath, withAlpha } from './draw.js';

export const MAX_CONFETTI = 140;

const GRAVITY = 1500; // px/s²
const DRAG = 0.55; // velocity kept per second (air resistance)
const LIFETIME_S = 4.2;

/** Fixed pool of confetti pieces; dead pieces are recycled by the next burst. */
export class Confetti {
  constructor() {
    this.x = new Float32Array(MAX_CONFETTI);
    this.y = new Float32Array(MAX_CONFETTI);
    this.vx = new Float32Array(MAX_CONFETTI);
    this.vy = new Float32Array(MAX_CONFETTI);
    this.angle = new Float32Array(MAX_CONFETTI);
    this.spin = new Float32Array(MAX_CONFETTI);
    this.flutter = new Float32Array(MAX_CONFETTI);
    this.size = new Float32Array(MAX_CONFETTI);
    this.age = new Float32Array(MAX_CONFETTI);
    this.color = new Uint8Array(MAX_CONFETTI);
    this.alive = new Uint8Array(MAX_CONFETTI);
    this.count = 0;
    this.colors = ['#e69f00', '#56b4e9', '#f5f5f0'];
  }

  setPalette(palette) {
    // Bright palette entries only (skip ink and the deep blue, which vanish on dark streams).
    const bright = [2, 3, 1].filter((index) => index < palette.length);
    if (bright.length > 0) this.colors = bright.map((index) => palette[index]);
  }

  clear() {
    this.alive.fill(0);
    this.count = 0;
  }

  /**
   * Emits up to `amount` pieces from a line segment (x0,y0)→(x1,y1), launched around `angle`
   * (radians, 0 = right, -π/2 = up) with ±`spread`.
   */
  burst(amount, x0, y0, x1, y1, angle, spread, speedMin, speedMax) {
    let emitted = 0;
    for (let i = 0; i < MAX_CONFETTI && emitted < amount; i += 1) {
      if (this.alive[i] === 1) continue;
      const t = Math.random();
      const direction = angle + (Math.random() * 2 - 1) * spread;
      const speed = speedMin + Math.random() * (speedMax - speedMin);
      this.x[i] = x0 + (x1 - x0) * t;
      this.y[i] = y0 + (y1 - y0) * t;
      this.vx[i] = Math.cos(direction) * speed;
      this.vy[i] = Math.sin(direction) * speed;
      this.angle[i] = Math.random() * Math.PI * 2;
      this.spin[i] = (Math.random() * 2 - 1) * 9;
      this.flutter[i] = Math.random() * Math.PI * 2;
      this.size[i] = 5 + Math.random() * 6;
      this.age[i] = 0;
      this.color[i] = Math.floor(Math.random() * this.colors.length);
      this.alive[i] = 1;
      emitted += 1;
    }
    this.count += emitted;
  }

  update(dtMs) {
    if (this.count === 0) return;
    const dt = Math.min(dtMs, 50) / 1000;
    const drag = DRAG ** dt;
    let count = 0;
    for (let i = 0; i < MAX_CONFETTI; i += 1) {
      if (this.alive[i] === 0) continue;
      this.age[i] += dt;
      this.vy[i] += GRAVITY * dt * 0.45;
      this.vx[i] *= drag;
      this.vy[i] *= drag;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.angle[i] += this.spin[i] * dt;
      this.flutter[i] += dt * 11;
      if (this.age[i] > LIFETIME_S || this.y[i] > HEIGHT + 40) {
        this.alive[i] = 0;
      } else {
        count += 1;
      }
    }
    this.count = count;
  }

  draw(ctx) {
    if (this.count === 0) return;
    for (let colorIndex = 0; colorIndex < this.colors.length; colorIndex += 1) {
      ctx.fillStyle = this.colors[colorIndex];
      for (let i = 0; i < MAX_CONFETTI; i += 1) {
        if (this.alive[i] === 0 || this.color[i] !== colorIndex) continue;
        const fade = Math.min(1, (LIFETIME_S - this.age[i]) / 0.6);
        const cos = Math.cos(this.angle[i]);
        const sin = Math.sin(this.angle[i]);
        // The flutter term squashes one axis so pieces appear to tumble in 3D.
        const squash = Math.cos(this.flutter[i]);
        ctx.globalAlpha = fade;
        ctx.setTransform(cos * squash, sin * squash, -sin, cos, this.x[i], this.y[i]);
        const size = this.size[i];
        ctx.fillRect(-size / 2, -size * 0.3, size, size * 0.6);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }
}

const ZIPPER_TRAVEL_MS = 600;
const ZIPPER_FADE_MS = 900;
/** Zipper lifetime after revealAtMs: travel down the seam, then fade. */
export const ZIPPER_TOTAL_MS = ZIPPER_TRAVEL_MS + ZIPPER_FADE_MS;
const GLOW_WIDTH = 44;
const HEAD_SIZE = 96;
const TOOTH_PITCH = 20;
const CORE_WIDTH = 2;

/**
 * Seam zipper: a bright head travels down the seam edge during the first 600 ms of the reveal,
 * leaving a lit, toothed trail that fades while the wave sweeps across the picture.
 * `edge` is 'right' for side A and 'left' for side B (the shared seam).
 */
export class Zipper {
  constructor() {
    this.trail = null;
    this.head = null;
    this.teeth = null;
    this.core = '#f5f5f0';
  }

  setPalette(palette) {
    const glowColor = palette[1] ?? '#f4f5f7';
    const coreColor = palette[1] ?? '#f5f5f0';
    const ink = palette[0] ?? '#101820';
    this.core = coreColor;

    // Horizontal glow profile, brightest at x = 0 (the seam), stretched vertically when drawn.
    this.trail = createCanvas(GLOW_WIDTH, 4);
    const trailCtx = this.trail.getContext('2d');
    const gradient = trailCtx.createLinearGradient(0, 0, GLOW_WIDTH, 0);
    gradient.addColorStop(0, withAlpha(glowColor, 0.95));
    gradient.addColorStop(0.15, withAlpha(glowColor, 0.6));
    gradient.addColorStop(0.45, withAlpha(glowColor, 0.18));
    gradient.addColorStop(1, withAlpha(glowColor, 0));
    trailCtx.fillStyle = gradient;
    trailCtx.fillRect(0, 0, GLOW_WIDTH, 4);

    this.head = createCanvas(HEAD_SIZE, HEAD_SIZE);
    const headCtx = this.head.getContext('2d');
    const half = HEAD_SIZE / 2;
    const radial = headCtx.createRadialGradient(half, half, 0, half, half, half);
    radial.addColorStop(0, withAlpha(coreColor, 1));
    radial.addColorStop(0.12, withAlpha(coreColor, 0.95));
    radial.addColorStop(0.3, withAlpha(glowColor, 0.7));
    radial.addColorStop(0.65, withAlpha(glowColor, 0.18));
    radial.addColorStop(1, withAlpha(glowColor, 0));
    headCtx.fillStyle = radial;
    headCtx.fillRect(0, 0, HEAD_SIZE, HEAD_SIZE);

    // Interlocking teeth tile (two card rows tall), seam on the left edge of the tile:
    // a long tooth from this side, then the short tip of the partner's tooth.
    this.teeth = createCanvas(30, TOOTH_PITCH * 2);
    const teethCtx = this.teeth.getContext('2d');
    teethCtx.lineWidth = 2;
    teethCtx.strokeStyle = ink;
    teethCtx.fillStyle = glowColor;
    roundRectPath(teethCtx, -6, 4, 32, 12, 3);
    teethCtx.fill();
    teethCtx.stroke();
    teethCtx.fillStyle = coreColor;
    roundRectPath(teethCtx, -6, TOOTH_PITCH + 4, 16, 12, 3);
    teethCtx.fill();
    teethCtx.stroke();
  }

  /** Draws the zipper `elapsed` ms after revealAtMs. Returns false once fully faded. */
  draw(ctx, elapsed, edge) {
    if (!this.trail || elapsed < 0 || elapsed > ZIPPER_TRAVEL_MS + ZIPPER_FADE_MS) return false;
    const travel = Math.min(1, elapsed / ZIPPER_TRAVEL_MS);
    // Ease-in-out so the head accelerates out of the top and settles at the bottom.
    const eased = travel < 0.5 ? 2 * travel * travel : 1 - (-2 * travel + 2) ** 2 / 2;
    const headY = eased * HEIGHT;
    const fade =
      elapsed <= ZIPPER_TRAVEL_MS ? 1 : 1 - (elapsed - ZIPPER_TRAVEL_MS) / ZIPPER_FADE_MS;

    ctx.save();
    // Draw in "seam on the left" space; mirror for side A whose seam is the right edge.
    if (edge === 'right') ctx.setTransform(-1, 0, 0, 1, WIDTH, 0);
    ctx.globalAlpha = fade;
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.trail, 0, 0, GLOW_WIDTH, headY);
    ctx.globalCompositeOperation = 'source-over';
    for (let y = 0; y < headY - TOOTH_PITCH; y += TOOTH_PITCH * 2) {
      ctx.drawImage(this.teeth, 0, y);
    }
    ctx.fillStyle = this.core;
    ctx.fillRect(0, 0, CORE_WIDTH, headY);
    if (elapsed <= ZIPPER_TRAVEL_MS) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(this.head, -HEAD_SIZE / 2, headY - HEAD_SIZE / 2);
    }
    ctx.restore();
    return true;
  }
}
