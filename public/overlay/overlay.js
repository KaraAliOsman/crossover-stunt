// Crossover Stunt overlay entry: OBS browser source, 1920×1080, transparent background.
// Plain ES modules, no build step. Incoming data is aggregate-only (see src/shared/protocol.ts);
// nothing here ever renders chat text or chatter identities.
import { createAudio } from './audio.js';
import { OverlayLink, ServerClock } from './net.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { Stage } from './stage.js';
import { loadBroadcastFonts } from './typography.js';
import { readLayout } from './layout.js';
import { roundRectPath } from './draw.js';

const MAX_DELAY_MS = 60_000;
const MAX_LATENCY_MS = 10_000;

/**
 * Query params: room, reducedMotion=1|0, mute=1, delayMs=<n>, latencyMs=<n>, debug=1. `latencyMs`
 * (0–10000) makes the on-stream countdown hit 0:00 that long before the server deadline, so
 * viewers watching a delayed stream never type "in time" and miss. The side comes from the
 * path alias (/overlay/a, /overlay/b) with `?side=` as a fallback for other paths.
 * `reducedMotion` is tri-state: 1 forces reduced motion, 0 forces full motion (the OS setting
 * of the encoding PC does not speak for the viewers), absent follows prefers-reduced-motion.
 */
function readParams() {
  const query = new URLSearchParams(location.search);
  const flag = (name) => {
    const value = query.get(name);
    return value !== null && value !== '0' && value.toLowerCase() !== 'false';
  };
  const motion = query.get('reducedMotion');
  const path = location.pathname.replace(/\/+$/, '').toLowerCase();
  let side = (query.get('side') ?? 'A').toUpperCase() === 'B' ? 'B' : 'A';
  if (path.endsWith('/overlay/a')) side = 'A';
  if (path.endsWith('/overlay/b')) side = 'B';
  const delay = Number(query.get('delayMs') ?? 0);
  const latency = Number(query.get('latencyMs') ?? 0);
  return {
    side,
    ...readLayout(query),
    room: query.get('room') || null,
    reducedMotion: motion === null ? null : flag('reducedMotion'),
    mute: flag('mute'),
    hold: flag('hold'),
    unite: query.get('unite') !== '0' && query.get('fit') !== 'seam',
    debug: flag('debug'),
    delayMs: Number.isFinite(delay) ? Math.min(MAX_DELAY_MS, Math.max(0, delay)) : 0,
    latencyMs: Number.isFinite(latency) ? Math.min(MAX_LATENCY_MS, Math.max(0, latency)) : 0,
  };
}

const params = readParams();
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d', { alpha: true });
// A single fixed native canvas keeps every cached sprite/particle in the same seam transform.
// Full layout uses the original direct path, preserving its pixels and redraw cache.
const nativeCanvas = params.fit === 'seam' ? document.createElement('canvas') : canvas;
if (nativeCanvas !== canvas) {
  nativeCanvas.width = 1920;
  nativeCanvas.height = 1080;
}
const nativeCtx = nativeCanvas === canvas ? ctx : nativeCanvas.getContext('2d', { alpha: true });
const statusNode = document.getElementById('status');
const root = document.documentElement;

const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const resolveReducedMotion = () => params.reducedMotion ?? motionQuery.matches;
const audio = createAudio({ mute: params.mute, chip: document.getElementById('sound-chip') });
const clock = new ServerClock();
const stage = new Stage({
  side: params.side,
  compositionScale: params.fit === 'seam' ? params.scale : 1,
  reducedMotion: resolveReducedMotion(),
  audio,
  unite: params.unite,
  hold: params.hold,
  occlusion:
    params.cutout === null
      ? null
      : {
          x:
            (params.cutout.x -
              (params.fit === 'seam' && params.side === 'A' ? 1920 * (1 - params.scale) : 0)) /
            params.scale,
          y:
            (params.cutout.y - (params.fit === 'seam' ? (1080 * (1 - params.scale)) / 2 : 0)) /
            params.scale,
          w: params.cutout.w / params.scale,
          h: params.cutout.h / params.scale,
        },
  countdownLeadMs: params.latencyMs,
});
loadBroadcastFonts()
  .then(() => stage.refreshTypography())
  .catch(() => {
    /* System fallbacks remain usable offline. */
  });
motionQuery.addEventListener('change', () => {
  stage.setReducedMotion(resolveReducedMotion());
});

root.dataset.side = params.side;
root.dataset.phase = 'idle';

/** Stage time: estimated server time minus the optional local alignment delay. */
function stageNow() {
  return clock.now(performance.now()) - params.delayMs;
}

let lastPhase = '';
let warnedProtocol = false;

/** Accessible text per phase (the canvas itself is aria-hidden). */
function describePhase(snapshot) {
  const own = snapshot.sides[params.side];
  switch (snapshot.phase) {
    case 'active':
      return `Card stunt live: ${own.participants} of ${own.quorum} people on this side.`;
    case 'revealing':
      return 'Every side reached its goal. Revealing the picture.';
    case 'complete':
      return 'Picture revealed.';
    case 'timed-out':
      return `Time is up: ${own.participants} of ${own.quorum} people on this side.`;
    default:
      return '';
  }
}

/**
 * Mirrors the snapshot into data attributes (cheap, ≤ 10 Hz, never per frame) and updates the
 * screen-reader status only when the phase changes.
 */
function announce(snapshot) {
  root.dataset.phase = snapshot.phase;
  root.dataset.revision = String(snapshot.revision);
  root.dataset.round = snapshot.roundId ?? '';
  if (snapshot.phase === lastPhase) return;
  lastPhase = snapshot.phase;
  statusNode.textContent = describePhase(snapshot);
}

function handleMessage(message) {
  const now = stageNow();
  switch (message.type) {
    case 'hello':
      if (message.protocol !== PROTOCOL_VERSION && !warnedProtocol) {
        warnedProtocol = true;
        console.warn(
          `Overlay speaks protocol ${PROTOCOL_VERSION}; server sent ${message.protocol}`,
        );
      }
      break;
    case 'meta':
      stage.setMeta(message.meta);
      break;
    case 'round':
      stage.setRound(message.round, now);
      break;
    case 'snapshot':
      if (stage.setSnapshot(message.snapshot, now)) link.requestSync();
      announce(message.snapshot);
      break;
    case 'error':
      // FORBIDDEN usually means a wrong/expired room token in the partner URL.
      console.warn(`Overlay server error: ${message.code}`);
      break;
  }
}

const link = new OverlayLink({
  side: params.side,
  room: params.room,
  clock,
  getRoundId: () => stage.round?.payload.roundId ?? null,
  onMessage: handleMessage,
  onTransport: (transport) => {
    root.dataset.transport = transport;
    // 'lost' / 'forbidden': no contact for a while; hide the stand instead of freezing it.
    stage.setLinkLost(transport === 'lost' || transport === 'forbidden');
  },
});

// Frame loop. Stage update/draw are allocation-free apart from pooled particles; the debug
// readout string is rebuilt at most twice per second.
let lastFrame = performance.now();
let fpsFrames = 0;
let fpsSince = lastFrame;
let costSum = 0;
let costMax = 0;
/** Last debug window: main-thread ms spent in update+draw (average and worst frame). */
const frameCost = { averageMs: 0, worstMs: 0, fps: 0 };

function frame() {
  const local = performance.now();
  const dt = Math.min(100, Math.max(0, local - lastFrame));
  lastFrame = local;
  const now = clock.now(local) - params.delayMs;
  stage.update(now, dt);
  stage.draw(nativeCtx, now);
  if (params.fit === 'seam') {
    const s = params.scale;
    const top = (1080 * (1 - s)) / 2;
    ctx.clearRect(0, 0, 1920, 1080);
    ctx.setTransform(s, 0, 0, s, params.side === 'A' ? 1920 * (1 - s) : 0, top);
    ctx.drawImage(nativeCanvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (stage.stand === 'up' && stage.plan.visibility > 0.01) {
      // Carry the edge card through its subpixel margin so the two physical stream edges meet.
      const edge = params.side === 'A' ? 1919 : 0;
      ctx.clearRect(edge, top, 1, 1080 * s);
      ctx.drawImage(
        stage.grid.layer,
        params.side === 'A' ? 1916 : 3,
        0,
        1,
        1080,
        edge,
        top,
        1,
        1080 * s,
      );
    }
  }
  if (params.cutout && stage.stand !== 'down' && stage.plan.visibility > 0.01) {
    const { x, y, w, h } = params.cutout;
    ctx.clearRect(x, y, w, h);
    ctx.save();
    ctx.globalAlpha = stage.plan.visibility;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(244,245,247,0.24)';
    roundRectPath(ctx, x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1), 12);
    ctx.stroke();
    ctx.restore();
  }
  if (params.fit === 'seam') stage.drawExternalChrome(ctx, now);
  if (params.debug) {
    const cost = performance.now() - local;
    costSum += cost;
    costMax = Math.max(costMax, cost);
    fpsFrames += 1;
    if (local - fpsSince >= 500) {
      frameCost.fps = Math.round((fpsFrames * 1000) / (local - fpsSince));
      frameCost.averageMs = costSum / fpsFrames;
      frameCost.worstMs = costMax;
      fpsFrames = 0;
      costSum = 0;
      costMax = 0;
      fpsSince = local;
      const skew = Math.round(clock.skewMs);
      stage.setDebugText(
        `${frameCost.fps} fps · js ${frameCost.averageMs.toFixed(1)}/${frameCost.worstMs.toFixed(1)} ms · ` +
          `clock ${skew >= 0 ? '+' : ''}${skew} ms · delay ${params.delayMs} ms · ` +
          `latency ${params.latencyMs} ms · ` +
          `${root.dataset.transport ?? 'connecting'} · rev ${root.dataset.revision ?? '-'} · side ${params.side} · ` +
          `rm ${stage.reducedMotion ? 'on' : 'off'}`,
      );
    }
  }
  requestAnimationFrame(frame);
}

if (params.debug) {
  // Read-only inspection hook for local debugging and the Playwright checks.
  window.crossoverOverlay = Object.freeze({
    inspect: () => stage.inspect(),
    clockSkewMs: () => clock.skewMs,
    frameCost: () => ({ ...frameCost }),
  });
}

link.start();
requestAnimationFrame(frame);
window.addEventListener('pagehide', () => link.stop(), { once: true });
