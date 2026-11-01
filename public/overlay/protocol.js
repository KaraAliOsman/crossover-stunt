// Runtime validation of src/shared/protocol.ts messages (PROTOCOL_VERSION 2). Network JSON is
// untrusted: every reader returns a fresh whitelisted object or null, so the renderer never
// sees unexpected fields, out-of-range rectangles or palette indices.

export const PROTOCOL_VERSION = 2;

const SIDE_COLS = 48;
const GRID_ROWS = 27;
const MAX_PALETTE = 32;
const MAX_LABEL = 40;
const PHASES = new Set(['idle', 'active', 'revealing', 'complete', 'timed-out']);
const MODES = new Set(['crossover', 'single']);
const HEX = /^#[0-9a-f]{6}$/i;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIndex(value, limit) {
  return Number.isInteger(value) && value >= 0 && value < limit;
}

function nullableTime(value) {
  if (value === null) return null;
  return isFiniteNumber(value) ? value : undefined;
}

function readSide(value) {
  if (!isRecord(value)) return null;
  const { participants, quorum, progress, ready } = value;
  if (!Number.isInteger(participants) || participants < 0) return null;
  if (!Number.isInteger(quorum) || quorum < 0) return null;
  if (!isFiniteNumber(progress) || typeof ready !== 'boolean') return null;
  return { participants, quorum, progress: Math.min(1, Math.max(0, progress)), ready };
}

export function readSnapshot(value) {
  if (!isRecord(value)) return null;
  const { revision, mode, phase, roundId, serverNowMs, revealDurationMs, simulated } = value;
  if (!isFiniteNumber(revision) || !MODES.has(mode) || !PHASES.has(phase)) return null;
  if (roundId !== null && typeof roundId !== 'string') return null;
  if (!isFiniteNumber(serverNowMs) || typeof simulated !== 'boolean') return null;
  const startedAtMs = nullableTime(value.startedAtMs ?? null);
  const deadlineAtMs = nullableTime(value.deadlineAtMs ?? null);
  const revealAtMs = nullableTime(value.revealAtMs ?? null);
  if (startedAtMs === undefined || deadlineAtMs === undefined || revealAtMs === undefined) {
    return null;
  }
  if (!isRecord(value.sides)) return null;
  const a = readSide(value.sides.A);
  const b = readSide(value.sides.B);
  if (!a || !b) return null;
  return {
    revision,
    mode,
    phase,
    roundId,
    serverNowMs,
    startedAtMs,
    deadlineAtMs,
    revealAtMs,
    revealDurationMs: isFiniteNumber(revealDurationMs) ? revealDurationMs : 0,
    simulated,
    crossovers: Number.isInteger(value.crossovers) && value.crossovers > 0 ? value.crossovers : 0,
    sides: { A: a, B: b },
  };
}

function readLabel(value, fallback) {
  if (typeof value !== 'string') return fallback;
  // Collapse whitespace/control characters; labels are broadcaster names, never chat text.
  const clean = value
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim()
    .slice(0, MAX_LABEL);
  return clean.length > 0 ? clean : fallback;
}

export function readMeta(value) {
  if (!isRecord(value) || !isRecord(value.labels)) return null;
  return {
    labels: {
      A: readLabel(value.labels.A, 'SIDE A'),
      B: readLabel(value.labels.B, 'SIDE B'),
    },
  };
}

function readRect(value) {
  if (!isRecord(value)) return null;
  const { x, y, w, h } = value;
  if (![x, y, w, h].every(Number.isInteger) || w < 1 || h < 1 || x < 0 || y < 0) return null;
  return { x, y, w, h };
}

function inside(inner, outer) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function readPlan(value, side, expectedRegion, paletteSize) {
  if (!isRecord(value) || value.side !== side) return null;
  const region = readRect(value.region);
  if (
    !region ||
    region.x !== expectedRegion.x ||
    region.y !== expectedRegion.y ||
    region.w !== expectedRegion.w ||
    region.h !== expectedRegion.h
  ) {
    return null;
  }
  if (!isIndex(value.rootColor, paletteSize) || !Array.isArray(value.steps)) return null;
  // Each split adds at least one leaf, so a valid plan has fewer steps than cards.
  if (value.steps.length >= region.w * region.h) return null;
  const steps = [];
  for (const rawStep of value.steps) {
    if (!isRecord(rawStep) || !Array.isArray(rawStep.children)) return null;
    const parent = readRect(rawStep.parent);
    if (!parent || !inside(parent, region)) return null;
    if (rawStep.children.length < 2 || rawStep.children.length > 4) return null;
    const children = [];
    let area = 0;
    for (const rawChild of rawStep.children) {
      if (!isRecord(rawChild) || !isIndex(rawChild.color, paletteSize)) return null;
      const rect = readRect(rawChild.rect);
      if (!rect || !inside(rect, parent)) return null;
      area += rect.w * rect.h;
      children.push({ rect, color: rawChild.color });
    }
    if (area !== parent.w * parent.h) return null;
    steps.push({ parent, children });
  }
  const pre = value.preRevealCount;
  if (!Number.isInteger(pre) || pre < 0 || pre > steps.length) return null;
  return { side, region, rootColor: value.rootColor, steps, preRevealCount: pre };
}

/** RoundPayload validation. Region geometry must match sideRegion() in src/engine/artwork.ts. */
export function readRound(value) {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { roundId, mode, cols, rows, palette, plans } = value;
  if (typeof roundId !== 'string' || roundId.length === 0 || roundId.length > 128) return undefined;
  if (!MODES.has(mode) || rows !== GRID_ROWS) return undefined;
  if (cols !== (mode === 'crossover' ? SIDE_COLS * 2 : SIDE_COLS)) return undefined;
  if (!Array.isArray(palette) || palette.length < 2 || palette.length > MAX_PALETTE) {
    return undefined;
  }
  if (!palette.every((color) => typeof color === 'string' && HEX.test(color))) return undefined;
  if (!isRecord(plans)) return undefined;
  const regions = {
    A: { x: 0, y: 0, w: SIDE_COLS, h: GRID_ROWS },
    B: { x: SIDE_COLS, y: 0, w: SIDE_COLS, h: GRID_ROWS },
  };
  const required = mode === 'crossover' ? ['A', 'B'] : ['A'];
  const parsed = {};
  for (const side of required) {
    const plan = readPlan(plans[side], side, regions[side], palette.length);
    if (!plan) return undefined;
    parsed[side] = plan;
  }
  return { roundId, mode, cols, rows, palette: palette.map((c) => c.toLowerCase()), plans: parsed };
}

/**
 * Parses one WS frame. Returns null for anything unknown or malformed (the caller ignores it).
 * `round` messages carry `round: null` after RESET; malformed rounds are rejected entirely.
 */
export function readServerMessage(value) {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'hello':
      if (value.side !== 'A' && value.side !== 'B') return null;
      if (!isFiniteNumber(value.serverNowMs)) return null;
      return {
        type: 'hello',
        protocol: value.protocol,
        side: value.side,
        serverNowMs: value.serverNowMs,
        simulated: value.simulated === true,
      };
    case 'meta': {
      const meta = readMeta(value.meta);
      return meta ? { type: 'meta', meta } : null;
    }
    case 'round': {
      const round = readRound(value.round);
      return round === undefined ? null : { type: 'round', round };
    }
    case 'snapshot': {
      const snapshot = readSnapshot(value.snapshot);
      return snapshot ? { type: 'snapshot', snapshot } : null;
    }
    case 'error':
      return {
        type: 'error',
        code: typeof value.code === 'string' ? value.code : 'UNKNOWN',
        message: typeof value.message === 'string' ? value.message.slice(0, 200) : '',
      };
    default:
      return null;
  }
}

/** GET /api/snapshot body. `hasRound` distinguishes "round omitted" from `round: null`. */
export function readSnapshotResponse(value) {
  if (!isRecord(value) || value.protocol !== PROTOCOL_VERSION) return null;
  const snapshot = readSnapshot(value.snapshot);
  if (!snapshot) return null;
  const meta = readMeta(value.meta);
  const hasRound = Object.hasOwn(value, 'round');
  const round = hasRound ? readRound(value.round) : undefined;
  if (hasRound && round === undefined) return null;
  return { snapshot, meta, hasRound, round: round ?? null };
}
