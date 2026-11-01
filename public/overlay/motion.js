// Shared broadcast motion. Curves are solved once into LUTs, never in the frame loop.
export const MOTION = Object.freeze({
  enter: 320,
  exit: 180,
  content: 200,
  roll: 180,
  progress: 240,
  count: 900,
  stagger: 60,
});
export function bezierLut(x1, y1, x2, y2) {
  const values = new Float32Array(257);
  const axis = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
  for (let i = 0; i <= 256; i += 1) {
    const x = i / 256;
    let lo = 0,
      hi = 1;
    for (let j = 0; j < 22; j += 1) {
      const t = (lo + hi) / 2;
      if (axis(t, x1, x2) < x) lo = t;
      else hi = t;
    }
    values[i] = axis((lo + hi) / 2, y1, y2);
  }
  values[0] = 0;
  values[256] = 1;
  return (t) => {
    const x = Math.max(0, Math.min(1, t)) * 256;
    const i = Math.floor(x);
    return i === 256 ? 1 : values[i] + (values[i + 1] - values[i]) * (x - i);
  };
}
export const EASE_OUT = bezierLut(0.23, 1, 0.32, 1);
export const EASE_IN_OUT = bezierLut(0.77, 0, 0.175, 1);
// One crest and a single 1.6px settling overshoot. Window is bounded to 420ms per column.
export function wavePose(elapsed, reduced = false) {
  if (elapsed < 0 || elapsed >= (reduced ? 400 : 420)) return 0;
  return reduced
    ? Math.sin((Math.PI * elapsed) / 400)
    : elapsed < 280
      ? Math.sin((Math.PI * elapsed) / 280)
      : -0.16 * Math.sin((Math.PI * (elapsed - 280)) / 140);
}
