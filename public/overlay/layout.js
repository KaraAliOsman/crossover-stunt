// Native 1920x1080 composition. Pure parsing, shared with boundary/property tests.
const WIDTH = 1920,
  HEIGHT = 1080;

export function parseCutout(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.length !== 4 || parts.some((part) => !/^-?\d+$/.test(part))) return null;
  const [x, y, w, h] = parts.map(Number);
  if (![x, y, w, h].every(Number.isSafeInteger) || w <= 0 || h <= 0) return null;
  const left = Math.max(0, x),
    top = Math.max(0, y);
  const right = Math.min(WIDTH, x + w),
    bottom = Math.min(HEIGHT, y + h);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function readLayout(query) {
  const fit = query.get('fit') === 'seam' ? 'seam' : 'full';
  const raw = query.get('scale');
  const value = raw === null || raw.trim() === '' ? NaN : Number(raw);
  const scale =
    fit === 'seam' ? (Number.isFinite(value) ? Math.max(0.4, Math.min(0.9, value)) : 0.62) : 1;
  return { fit, scale, cutout: parseCutout(query.get('cutout')) };
}
