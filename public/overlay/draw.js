// Small Canvas2D helpers shared by the overlay modules. Everything here is either called once
// per sprite build or is allocation-free, so it is safe to use from the frame loop.

/** OBS browser source size; the canvas backing store never changes. */
export const WIDTH = 1920;
export const HEIGHT = 1080;

/** Self-hosted broadcast face; a system fallback keeps the first OBS frame usable. */
export const FONT_STACK = '"Archivo", system-ui, sans-serif';

/** Fallback colors (same order as PALETTE in src/engine/artwork.ts) until a round arrives. */
export const DEFAULT_PALETTE = Object.freeze([
  '#101820',
  '#f5f5f0',
  '#e69f00',
  '#56b4e9',
  '#009e73',
  '#f0e442',
  '#0072b2',
  '#d55e00',
]);

/** Semantic roles mapped onto palette indices so the UI always matches the artwork palette. */
export const ROLE = Object.freeze({
  ink: 0,
  paper: 1,
  teamA: 2,
  teamB: 3,
  ready: 4,
  highlight: 5,
  deep: 6,
  alert: 7,
});

export function font(weight, sizePx) {
  return `${weight} ${sizePx}px ${FONT_STACK}`;
}

export function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

/** Path-only rounded rectangle (avoids ctx.roundRect, missing in older OBS CEF builds). */
export function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Letter spacing is a Chromium 99+ canvas feature; older CEF simply renders without it. */
export function setTracking(ctx, px) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`;
}

/** Shrinks the font until `text` fits `maxWidth` (or minSize is reached). Sprite builds only. */
export function fitFont(ctx, text, weight, size, maxWidth, minSize = 12) {
  let current = size;
  ctx.font = font(weight, current);
  while (current > minSize && ctx.measureText(text).width > maxWidth) {
    current -= 2;
    ctx.font = font(weight, current);
  }
  return current;
}

/** Truncates with an ellipsis so a streamer-provided label can never blow up a layout. */
export function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** `#rrggbb` + alpha → `rgba()`; used when building sprites, never per frame. */
export function withAlpha(hex, alpha) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/** Mixes a `#rrggbb` color toward white (amount > 0) or black (amount < 0). */
export function shade(hex, amount) {
  const value = Number.parseInt(hex.slice(1), 16);
  const target = amount >= 0 ? 255 : 0;
  const t = Math.abs(amount);
  const mix = (channel) => Math.round(channel + (target - channel) * t);
  const r = mix((value >> 16) & 255);
  const g = mix((value >> 8) & 255);
  const b = mix(value & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function easeOutCubic(t) {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

export function easeInCubic(t) {
  return t * t * t;
}

/** Moves `current` toward `target` at `perMs` units per millisecond (frame-rate independent). */
export function approach(current, target, dtMs, perMs) {
  const step = dtMs * perMs;
  if (current < target) return Math.min(target, current + step);
  return Math.max(target, current - step);
}
