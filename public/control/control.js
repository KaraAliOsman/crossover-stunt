/**
 * Crossover Stunt control panel (local only, never exposed through the tunnel).
 *
 * Polls GET /api/state (ControlState in src/shared/protocol.ts) every second and renders it.
 * Every action is a JSON POST; failures are shown inline next to the control that caused them.
 * The hidden picture is built in the browser (artwork.js) and sent with CALL as palette indices.
 */
import {
  GRID_ROWS,
  PALETTE,
  PALETTE_NAMES,
  SIDE_COLS,
  coverFitRect,
  fullCols,
  imageDataToArtwork,
  isValidArtwork,
  presetArtwork,
  presetTitle,
  textArtwork,
} from './artwork.js';

const POLL_INTERVAL_MS = 1_000;
const CLOCK_INTERVAL_MS = 250;
const RESET_CONFIRM_MS = 4_000;
const FLASH_MS = 1_600;
const PREVIEW_CARD_PX = 10;
const THUMB_CARD_PX = 2;
/** Source pixels averaged per card (per axis) when an uploaded image is reduced to the grid. */
const IMAGE_SUPERSAMPLE = 8;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const DURATIONS_MS = [30_000, 45_000, 60_000];
const SIDES = ['A', 'B'];
/** Twitch login rules: 1–25 letters, digits or underscores. */
const LOGIN_PATTERN = /^[A-Za-z0-9_]{1,25}$/;
const GAP_COLOR = '#06080c';
const EMPTY_CARD_COLOR = '#161c29';
const SEAM_COLOR = '#f5f5f0';

const PHASE_LABELS = {
  idle: 'Idle',
  active: 'Live',
  revealing: 'Revealing',
  complete: 'Complete',
  'timed-out': 'Timed out',
};

/** TwitchStatus → [chip text, tone]. */
const TWITCH_STATUS = {
  demo: ['Demo · no Twitch', 'warn'],
  'signed-out': ['Signed out', 'muted'],
  authorizing: ['Waiting for approval', 'info'],
  connecting: ['Connecting', 'info'],
  connected: ['Connected', 'ok'],
  reconnecting: ['Reconnecting', 'warn'],
  error: ['Error', 'error'],
};

const SHARE_STATUS = {
  off: ['Off', 'muted'],
  starting: ['Starting…', 'info'],
  on: ['Sharing', 'ok'],
  error: ['Error', 'error'],
};

const SHOWCASE_NAMES = { crossover: 'Crossover', 'so-close': 'So close', single: 'Single' };

// ---------------------------------------------------------------------------------------------
// DOM

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`control: missing #${id}`);
  return element;
}

const el = {
  phaseChip: byId('phase-chip'),
  serverStatus: byId('server-status'),
  demoBanner: byId('demo-banner'),
  serverBanner: byId('server-banner'),
  announcer: byId('announcer'),
  // stunt
  roundMode: byId('round-mode'),
  countdown: byId('countdown'),
  clockCaption: byId('clock-caption'),
  roundSummary: byId('round-summary'),
  stuntForm: byId('stunt-form'),
  minQuorum: byId('min-quorum'),
  quorumRatio: byId('quorum-ratio'),
  callBtn: byId('call-btn'),
  callSub: byId('call-sub'),
  callBlocker: byId('call-blocker'),
  resetBtn: byId('reset-btn'),
  stuntError: byId('stunt-error'),
  stuntStatus: byId('stunt-status'),
  // picture
  gridSize: byId('grid-size'),
  panels: { preset: byId('panel-preset'), text: byId('panel-text'), image: byId('panel-image') },
  presetVersusName: byId('preset-versus-name'),
  textLine1: byId('text-line-1'),
  textLine2: byId('text-line-2'),
  fgSwatches: byId('fg-swatches'),
  bgSwatches: byId('bg-swatches'),
  textWarning: byId('text-warning'),
  imageFile: byId('image-file'),
  dropzone: byId('dropzone'),
  imageName: byId('image-name'),
  capA: byId('cap-a'),
  capB: byId('cap-b'),
  previewCaptions: byId('preview-captions'),
  preview: byId('preview'),
  pictureError: byId('picture-error'),
  // twitch
  twitchChip: byId('twitch-chip'),
  twitchDemo: byId('twitch-demo'),
  twitchAccount: byId('twitch-account'),
  twitchLogin: byId('twitch-login'),
  twitchAuth: byId('twitch-auth'),
  twitchVerifyLink: byId('twitch-verify-link'),
  twitchCode: byId('twitch-code'),
  twitchCopyCode: byId('twitch-copy-code'),
  twitchRevealCode: byId('twitch-reveal-code'),
  twitchServerError: byId('twitch-server-error'),
  twitchConnect: byId('twitch-connect'),
  twitchSignout: byId('twitch-signout'),
  twitchError: byId('twitch-error'),
  twitchLastChat: byId('twitch-last-chat'),
  // channels
  labelsForm: byId('labels-form'),
  labelA: byId('label-a'),
  labelB: byId('label-b'),
  labelsSave: byId('labels-save'),
  labelsError: byId('labels-error'),
  labelsStatus: byId('labels-status'),
  channelsForm: byId('channels-form'),
  channelA: byId('channel-a'),
  channelB: byId('channel-b'),
  channelBField: byId('channel-b-field'),
  channelACurrent: byId('channel-a-current'),
  channelBCurrent: byId('channel-b-current'),
  channelsSave: byId('channels-save'),
  channelsError: byId('channels-error'),
  channelsStatus: byId('channels-status'),
  // overlays
  urlA: byId('url-A'),
  urlB: byId('url-B'),
  urlRowB: byId('url-row-B'),
  urlPartner: byId('url-partner'),
  partnerReveal: byId('partner-reveal'),
  shareStart: byId('share-start'),
  shareStop: byId('share-stop'),
  shareChip: byId('share-chip'),
  shareError: byId('share-error'),
  copyStatus: byId('copy-status'),
  // simulator
  simulator: byId('simulator'),
  simBoth: byId('sim-both'),
  simError: byId('sim-error'),
  simStatus: byId('sim-status'),
};

const sideEls = Object.fromEntries(
  SIDES.map((side) => [
    side,
    {
      meter: byId(`meter-${side}`),
      label: byId(`label-${side}`),
      flag: byId(`flag-${side}`),
      count: byId(`count-${side}`),
      quorum: byId(`quorum-${side}`),
      bar: byId(`bar-${side}`),
      fill: /** @type {HTMLElement} */ (byId(`bar-${side}`).querySelector('.meter-fill')),
      overrideOn: /** @type {HTMLInputElement} */ (byId(`override-${side}-on`)),
      override: /** @type {HTMLInputElement} */ (byId(`override-${side}`)),
      simLabel: byId(`sim-label-${side}`),
    },
  ]),
);

// ---------------------------------------------------------------------------------------------
// State

const ui = {
  /** Last valid ControlState, or null until the first successful poll. */
  state: null,
  /** serverNowMs − Date.now() at receipt: lets the countdown run smoothly between polls. */
  clockOffsetMs: 0,
  /** Settings are copied from the server once; afterwards the form is the operator's. */
  hydrated: false,
  mode: 'crossover',
  pollTimer: 0,
  polling: false,
  pollQueued: false,
  /** True while GET /api/state fails; the last state stays on screen but CALL is blocked. */
  serverDown: false,
  lastPhase: null,
  labelsKey: '',
  /** Names of actions with a request in flight. */
  busy: new Set(),
  resetArmedUntil: 0,
  resetTimer: 0,
  /** Code returned by POST /api/auth/start, shown until /api/state catches up. */
  authFromStart: null,
  channelsDirty: false,
  labelsDirty: false,
  revealPartner: false,
  /**
   * Device Code shown masked: on a screen-shared/streamed panel a viewer could redeem it first
   * and link THEIR account. `userCode` keeps the real value for Copy code.
   */
  revealCode: false,
  userCode: '',
  shareActionError: '',
  urls: { A: '', B: '', partner: '' },
  layout: 'full',
  /** Virtual-crowd seeds: a fresh seed per click means fresh virtual people. */
  nextSeed: Date.now(),
};

const picture = {
  source: 'preset',
  preset: 'versus',
  presetsByMode: { crossover: 'versus', single: 'heart' },
  fg: 5,
  bg: 6,
  /** Decoded upload; re-quantized when the mode (grid width) changes. */
  bitmap: null,
  /** Current artwork `{ cols, rows, pixels }` or null when unavailable. */
  artwork: null,
  /** Why CALL cannot use the current picture (null when it can). */
  problem: null,
  description: '',
};

// ---------------------------------------------------------------------------------------------
// Helpers

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shows `text` in a message element, or hides the element when text is empty. */
function setMessage(element, text) {
  const value = text ?? '';
  if (element.textContent !== value) element.textContent = value;
  element.hidden = value === '';
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

/** Updates an input without disturbing a selection the operator is making. */
function setValue(input, value) {
  if (input.value !== value) input.value = value;
}

function announce(text) {
  el.announcer.textContent = '';
  window.setTimeout(() => {
    el.announcer.textContent = text;
  }, 50);
}

/** m:ss, rounding up so the clock shows 0:01 until the deadline actually passes. */
function formatClock(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatAgo(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** A channel label worth showing next to its side letter, or null when it is just "A"/"B". */
function distinctLabel(side, label) {
  return typeof label === 'string' && label.trim() !== '' && label.trim().toUpperCase() !== side
    ? label
    : null;
}

/** Only https links from the server become clickable (defence in depth). */
function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Hides the room token in the partner URL so a screen-shared control panel does not leak it. */
function maskRoomToken(url) {
  return url.replace(/([?&]room=)[^&#]*/, '$1••••••••');
}

function selectedDurationMs() {
  const checked = el.stuntForm.querySelector('input[name="duration"]:checked');
  const value = Number(checked?.value);
  return DURATIONS_MS.includes(value) ? value : 45_000;
}

// ---------------------------------------------------------------------------------------------
// HTTP

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Field validation failure: shown inline and focuses the offending input. */
class FieldError extends Error {
  constructor(input, message) {
    super(message);
    this.input = input;
  }
}

/**
 * POST JSON and return the parsed body. Throws ApiError with a readable message; `messages`
 * overrides the text for specific HTTP statuses.
 */
async function postJson(path, body, messages = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('Cannot reach the server. Is it still running?', 0);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    // `{ error, detail? }` from the server; detail carries e.g. the Twitch-side reason.
    const parts = isObject(data) ? [data.error, data.detail] : [];
    const detail = parts
      .filter((part) => typeof part === 'string' && part !== '')
      .join(' — ')
      .slice(0, 300);
    const preset = messages[response.status];
    const fallback =
      response.status === 404
        ? 'Not available on this server.'
        : response.status === 501
          ? 'Not implemented on this server yet.'
          : `Request failed (HTTP ${response.status}).`;
    throw new ApiError(preset ?? (detail || fallback), response.status);
  }
  return data;
}

function errorText(error) {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/**
 * Runs one operator action: marks `buttons` busy, clears/sets the inline error, re-renders and
 * polls immediately afterwards so the panel reflects the new server state.
 */
async function runAction(name, buttons, errorElement, task) {
  if (ui.busy.has(name)) return;
  ui.busy.add(name);
  for (const button of buttons) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }
  setMessage(errorElement, '');
  try {
    await task();
  } catch (error) {
    if (error instanceof FieldError) {
      error.input.setAttribute('aria-invalid', 'true');
      error.input.focus();
    }
    setMessage(errorElement, errorText(error));
  } finally {
    ui.busy.delete(name);
    for (const button of buttons) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
    render();
    refreshNow();
  }
}

// ---------------------------------------------------------------------------------------------
// Polling

/** Minimal runtime check of GET /api/state before anything is rendered from it. */
function parseControlState(value) {
  if (!isObject(value) || value.protocol !== 2 || typeof value.demo !== 'boolean') return null;
  const { twitch, channels, config, snapshot, meta, overlayUrls, share } = value;
  if (![twitch, channels, config, snapshot, meta, overlayUrls, share].every(isObject)) return null;
  if (!isObject(snapshot.sides) || !SIDES.every((side) => isObject(snapshot.sides[side])))
    return null;
  if (!isObject(meta.labels) || typeof snapshot.serverNowMs !== 'number') return null;
  return value;
}

async function poll() {
  if (ui.polling) {
    ui.pollQueued = true;
    return;
  }
  window.clearTimeout(ui.pollTimer);
  ui.polling = true;
  try {
    const response = await fetch('/api/state', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? 'This server has no control API (GET /api/state → 404). Update and restart it.'
          : `GET /api/state failed (HTTP ${response.status}). Retrying…`,
      );
    }
    const state = parseControlState(await response.json());
    if (!state)
      throw new Error('Unexpected /api/state response. Reload after updating the server.');
    ui.clockOffsetMs = state.snapshot.serverNowMs - Date.now();
    ui.state = state;
    ui.serverDown = false;
    if (!ui.hydrated) hydrate(state);
    el.serverStatus.dataset.state = 'ok';
    setText(el.serverStatus, 'Server connected');
    setMessage(el.serverBanner, '');
    render();
  } catch (error) {
    ui.serverDown = true;
    el.serverStatus.dataset.state = 'down';
    setText(el.serverStatus, 'Server unreachable');
    setMessage(
      el.serverBanner,
      error instanceof TypeError
        ? 'Cannot reach the server. Is pnpm demo / pnpm dev still running? Retrying every second…'
        : errorText(error),
    );
    updateCallButton();
  } finally {
    ui.polling = false;
    const delay = ui.pollQueued ? 0 : POLL_INTERVAL_MS;
    ui.pollQueued = false;
    ui.pollTimer = window.setTimeout(poll, delay);
  }
}

function refreshNow() {
  void poll();
}

/** Copies the server's settings into the form once, so a reload shows what is configured. */
function hydrate(state) {
  ui.hydrated = true;
  const { config } = state;
  const duration = DURATIONS_MS.includes(config.durationMs) ? config.durationMs : 45_000;
  for (const radio of el.stuntForm.querySelectorAll('input[name="duration"]')) {
    radio.checked = Number(radio.value) === duration;
  }
  if (Number.isInteger(config.minQuorum)) el.minQuorum.value = String(config.minQuorum);
  if (typeof config.quorumRatio === 'number') {
    el.quorumRatio.value = String(Math.round(config.quorumRatio * 100));
  }
  for (const side of SIDES) {
    const value = isObject(config.quorumOverride) ? config.quorumOverride[side] : undefined;
    const { overrideOn, override } = sideEls[side];
    overrideOn.checked = typeof value === 'number';
    if (typeof value === 'number') override.value = String(value);
  }
  setMode(config.mode === 'single' ? 'single' : 'crossover');
}

// ---------------------------------------------------------------------------------------------
// Rendering

function render() {
  const state = ui.state;
  if (state) {
    el.demoBanner.hidden = !state.demo;
    syncLabels(state.meta.labels);
    renderPhase(state.snapshot.phase);
    renderScoreboard(state);
    renderTwitch(state);
    renderChannels(state);
    renderOverlayUrls(state);
    renderSimulator(state);
  }
  renderOverrides();
  renderClock();
  updateCallButton();
}

/** Demo rounds are SIMULATED: never call them "Live" (nothing reaches Twitch). */
function phaseLabel(phase) {
  if (phase === 'active' && ui.state?.demo) return 'Running';
  return PHASE_LABELS[phase] ?? phase;
}

function renderPhase(phase) {
  el.phaseChip.dataset.phase = phase;
  setText(el.phaseChip, phaseLabel(phase));
  if (ui.lastPhase !== null && ui.lastPhase !== phase) {
    announce(`Stunt phase: ${phaseLabel(phase)}`);
  }
  ui.lastPhase = phase;
}

function renderScoreboard(state) {
  const { snapshot, meta } = state;
  const single = snapshot.mode === 'single';
  const idle = snapshot.phase === 'idle';
  setText(
    el.roundMode,
    idle
      ? 'No round running'
      : `${single ? 'Single' : 'Crossover'} round${snapshot.simulated ? ' · SIMULATED' : ''}`,
  );
  for (const side of SIDES) {
    const data = snapshot.sides[side];
    const parts = sideEls[side];
    const unused = single && side === 'B';
    const other = snapshot.sides[side === 'A' ? 'B' : 'A'];
    parts.meter.dataset.unused = String(unused);
    parts.meter.dataset.ready = String(!unused && data.ready);
    setText(parts.label, distinctLabel(side, meta.labels[side]) ?? `Side ${side}`);
    setText(parts.count, unused ? '–' : String(data.participants));
    setText(parts.quorum, unused || idle ? '–' : String(data.quorum));
    const progress = unused || idle ? 0 : Math.min(1, Math.max(0, data.progress));
    parts.fill.style.transform = `scaleX(${progress})`;
    parts.bar.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    let flag = '';
    if (unused) flag = 'Not used in single mode';
    else if (!idle && data.ready) {
      flag = snapshot.phase === 'active' && !single && !other.ready ? 'Ready · waiting' : 'Ready';
    }
    setMessage(parts.flag, flag);
  }
  setText(el.roundSummary, roundSummary(state));
}

function roundSummary({ snapshot, meta }) {
  const { A, B } = snapshot.sides;
  const single = snapshot.mode === 'single';
  const total = single ? A.participants : A.participants + B.participants - snapshot.crossovers;
  const crossed = single ? '' : ` · ${snapshot.crossovers} in both chats`;
  switch (snapshot.phase) {
    case 'idle':
      return 'No round running. Pick a picture, then CALL.';
    case 'active':
      if (!single && A.ready !== B.ready) {
        const [done, waiting] = A.ready ? ['A', 'B'] : ['B', 'A'];
        const name = (side) => distinctLabel(side, meta.labels[side]) ?? `Side ${side}`;
        return `${name(done)} is ready — waiting for ${name(waiting)}.`;
      }
      return `${plural(total, 'person', 'people')} so far${crossed}.`;
    case 'revealing':
      return single
        ? 'Quorum reached — the picture is being revealed.'
        : 'Both sides reached quorum — joint reveal on both overlays.';
    case 'complete':
      return single
        ? `${plural(total, 'person', 'people')} made this.`
        : `${plural(total, 'person', 'people')} from 2 communities made this${crossed}.`;
    case 'timed-out':
      return single
        ? `So close — ${A.participants}/${A.quorum}.`
        : `So close — ${meta.labels.A} ${A.participants}/${A.quorum} · ${meta.labels.B} ${B.participants}/${B.quorum}.`;
    default:
      return '';
  }
}

function renderClock() {
  const snapshot = ui.state?.snapshot;
  const now = Date.now() + ui.clockOffsetMs;
  let main = formatClock(selectedDurationMs());
  let caption = 'Ready to CALL';
  let kind = 'idle';
  if (!ui.state) caption = 'Waiting for the server';
  else if (snapshot.phase === 'active' && snapshot.deadlineAtMs !== null) {
    const remaining = snapshot.deadlineAtMs - now;
    main = formatClock(remaining);
    caption = 'left to chat';
    kind = remaining <= 10_000 ? 'urgent' : 'live';
  } else if (snapshot.phase === 'revealing') {
    const until = (snapshot.revealAtMs ?? now) - now;
    main = 'REVEAL';
    caption = until > 0 ? `starts in ${(until / 1000).toFixed(1)} s` : 'playing on the overlays';
    kind = 'word';
  } else if (snapshot.phase === 'complete') {
    main = 'DONE';
    caption = 'RESET or CALL again';
    kind = 'word';
  } else if (snapshot.phase === 'timed-out') {
    main = '0:00';
    caption = "time's up";
    kind = 'over';
  }
  setText(el.countdown, main);
  setText(el.clockCaption, caption);
  el.countdown.dataset.kind = kind;
  const phase = snapshot?.phase ?? 'idle';
  const title =
    phase === 'active'
      ? `${ui.state?.demo ? 'RUNNING' : 'LIVE'} ${main} — Crossover Stunt`
      : phase === 'idle'
        ? 'Crossover Stunt — Control'
        : `${PHASE_LABELS[phase] ?? phase} — Crossover Stunt`;
  if (document.title !== title) document.title = title;
}

/** `WDJB-MJHT` → `••••-••••` (keeps the shape so it still reads as a code). */
function maskUserCode(code) {
  return code.replace(/[A-Za-z0-9]/g, '•');
}

function renderTwitch(state) {
  const { twitch, demo } = state;
  const [text, tone] = demo
    ? TWITCH_STATUS.demo
    : (TWITCH_STATUS[twitch.status] ?? ['Unknown', 'muted']);
  setText(el.twitchChip, text);
  el.twitchChip.dataset.tone = tone;
  el.twitchDemo.hidden = !demo;

  const signedIn = !demo && typeof twitch.login === 'string' && twitch.login.length > 0;
  el.twitchAccount.hidden = !signedIn;
  if (signedIn) setText(el.twitchLogin, twitch.login);

  // The device code comes from /api/state while authorizing; right after "Connect" the POST
  // response is used until the next poll reflects it.
  if (twitch.status !== 'signed-out' || twitch.error) ui.authFromStart = null;
  if (ui.authFromStart && Date.now() - ui.authFromStart.atMs > 15_000) ui.authFromStart = null;
  const code =
    !demo && twitch.status === 'authorizing' && typeof twitch.userCode === 'string'
      ? { userCode: twitch.userCode, verificationUri: twitch.verificationUri }
      : ui.authFromStart;
  el.twitchAuth.hidden = !code;
  if (!code) {
    ui.revealCode = false;
    ui.userCode = '';
  }
  if (code) {
    ui.userCode = code.userCode;
    setText(el.twitchCode, ui.revealCode ? code.userCode : maskUserCode(code.userCode));
    el.twitchRevealCode.setAttribute('aria-pressed', String(ui.revealCode));
    setText(el.twitchRevealCode, ui.revealCode ? 'Hide' : 'Show');
    const url =
      typeof code.verificationUri === 'string' ? safeHttpsUrl(code.verificationUri) : null;
    el.twitchVerifyLink.href = url ? url.href : 'https://www.twitch.tv/activate';
    setText(el.twitchVerifyLink, url ? `${url.host}${url.pathname}` : 'twitch.tv/activate');
  }

  setMessage(el.twitchServerError, demo ? '' : (twitch.error ?? ''));
  const canConnect =
    !demo && !code && (twitch.status === 'signed-out' || twitch.status === 'error');
  el.twitchConnect.hidden = !canConnect;
  el.twitchConnect.disabled = !canConnect || ui.busy.has('auth') || ui.busy.has('signout');
  el.twitchSignout.hidden = demo || !(signedIn || code || twitch.status === 'connecting');
  setText(el.twitchSignout, code && !signedIn ? 'Cancel' : 'Sign out');

  const last = state.lastChat;
  if (!demo && isObject(last)) {
    const ago = formatAgo(Date.now() + ui.clockOffsetMs - last.atMs);
    setMessage(
      el.twitchLastChat,
      last.ok
        ? `Last chat message sent ${ago}.`
        : `Last chat message was not delivered (${last.reason ?? 'unknown reason'}) ${ago}.`,
    );
    el.twitchLastChat.dataset.tone = last.ok ? 'ok' : 'warn';
  } else setMessage(el.twitchLastChat, '');
}

function renderChannels(state) {
  const { channels, meta, demo } = state;
  if (!ui.labelsDirty && !el.labelsForm.contains(document.activeElement)) {
    setValue(el.labelA, meta.labels.A);
    setValue(el.labelB, meta.labels.B);
  }
  const describe = (side) => {
    const info = channels[side];
    if (isObject(info) && typeof info.login === 'string') {
      const name = typeof info.displayName === 'string' ? info.displayName : info.login;
      return name.toLowerCase() === info.login.toLowerCase()
        ? `Using ${name}.`
        : `Using ${name} (${info.login}).`;
    }
    if (demo) return `Demo label: ${meta.labels[side]}.`;
    return side === 'A' ? 'Defaults to the signed-in account.' : 'No partner yet.';
  };
  setText(el.channelACurrent, describe('A'));
  const single = ui.mode === 'single';
  el.channelBField.dataset.dim = String(single);
  setText(
    el.channelBCurrent,
    single ? `${describe('B')} Not needed in single mode.` : describe('B'),
  );
  const editing = el.channelsForm.contains(document.activeElement);
  if (!ui.channelsDirty && !editing) {
    setValue(el.channelA, isObject(channels.A) ? channels.A.login : '');
    setValue(el.channelB, isObject(channels.B) ? channels.B.login : '');
  }
}

function layoutUrl(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  const url = new URL(raw);
  for (const key of ['fit', 'scale', 'cutout']) url.searchParams.delete(key);
  if (ui.layout === 'seam') {
    url.searchParams.set('fit', 'seam');
    url.searchParams.set('scale', '0.62');
  } else if (ui.layout === 'facecam-right') url.searchParams.set('cutout', '1440,700,440,340');
  else if (ui.layout === 'facecam-left') url.searchParams.set('cutout', '40,700,440,340');
  return url.toString();
}

function renderOverlayUrls(state) {
  const { overlayUrls, share } = state;
  ui.urls.A = layoutUrl(overlayUrls.A);
  ui.urls.B = layoutUrl(overlayUrls.B);
  ui.urls.partner = layoutUrl(overlayUrls.partnerB);
  setValue(el.urlA, ui.urls.A);
  setValue(el.urlB, ui.urls.B);
  el.urlRowB.dataset.dim = String(ui.mode === 'single');

  const hasPartner = ui.urls.partner !== '';
  if (!hasPartner) ui.revealPartner = false;
  setValue(
    el.urlPartner,
    hasPartner
      ? ui.revealPartner
        ? ui.urls.partner
        : maskRoomToken(ui.urls.partner)
      : share.status === 'starting'
        ? 'Starting tunnel…'
        : 'Not sharing',
  );
  el.partnerReveal.disabled = !hasPartner;
  el.partnerReveal.setAttribute('aria-pressed', String(ui.revealPartner));
  setText(el.partnerReveal, ui.revealPartner ? 'Hide' : 'Show');
  const copyPartner = el.urlPartner.parentElement?.querySelector('[data-copy="partner"]');
  if (copyPartner) copyPartner.disabled = !hasPartner;

  const [text, tone] = SHARE_STATUS[share.status] ?? ['Unknown', 'muted'];
  setText(el.shareChip, text);
  el.shareChip.dataset.tone = tone;
  const running = share.status === 'on' || share.status === 'starting';
  if (!ui.busy.has('share')) {
    el.shareStart.hidden = running;
    el.shareStop.hidden = !running;
  }
  if (share.status === 'on') ui.shareActionError = '';
  setMessage(
    el.shareError,
    withShareHint(
      ui.shareActionError || (share.status === 'error' ? (share.error ?? 'Sharing failed.') : ''),
    ),
  );
}

/**
 * The server looks cloudflared up on the PATH it started with: after installing it, a server
 * started from an old terminal still cannot see it.
 */
function withShareHint(text) {
  if (!text.startsWith('cloudflared not installed')) return text;
  return (
    `${text}. Install it (PowerShell: winget install Cloudflare.cloudflared), then restart ` +
    'this server from a NEW terminal so it sees the updated PATH.'
  );
}

function renderSimulator(state) {
  el.simulator.hidden = !state.demo;
  for (const side of SIDES) {
    const label = distinctLabel(side, state.meta.labels[side]);
    setText(sideEls[side].simLabel, label ? `${side} · ${label}` : `Side ${side}`);
    for (const button of el.simulator.querySelectorAll(`[data-sim-side="${side}"]`)) {
      const count = Number(button.dataset.simCount);
      const people = plural(count, 'SIMULATED person', 'SIMULATED people');
      button.setAttribute('aria-label', `Add ${people} to ${side}${label ? ` (${label})` : ''}`);
    }
  }
}

/** The B override only applies to crossover rounds; inputs follow their checkboxes. */
function renderOverrides() {
  for (const side of SIDES) {
    const { overrideOn, override } = sideEls[side];
    const applies = side === 'A' || ui.mode === 'crossover';
    overrideOn.disabled = !applies;
    override.disabled = !applies || !overrideOn.checked;
  }
}

/**
 * Live CALLs need EventSub reading chat: otherwise the prompt goes out, nobody is counted and
 * the round ends in SO CLOSE 0/q on both chats (the server refuses it too, with 409).
 */
const TWITCH_CALL_BLOCKERS = {
  'signed-out': 'Connect Twitch first: CALL needs to read your chat.',
  authorizing: 'Finish the Twitch sign-in first: CALL needs to read your chat.',
  connecting: 'Twitch chat is connecting… CALL unlocks when the Twitch card shows Connected.',
  reconnecting: 'Twitch chat is reconnecting… CALL unlocks when the Twitch card shows Connected.',
  error: 'Twitch chat is not being read (see the Twitch card). Fix that, then CALL.',
};

function callBlocker() {
  if (!ui.state) return 'Waiting for the server…';
  if (ui.serverDown) return 'The server is unreachable. CALL comes back when it reconnects.';
  const { phase } = ui.state.snapshot;
  if (phase === 'active') return 'A stunt is running. RESET stops it early.';
  if (phase === 'revealing')
    return 'The reveal is playing. CALL is available again when it completes.';
  const twitchStatus = ui.state.twitch?.status;
  if (!ui.state.demo && twitchStatus !== 'connected') {
    return TWITCH_CALL_BLOCKERS[twitchStatus] ?? TWITCH_CALL_BLOCKERS.error;
  }
  return picture.problem;
}

function updateCallButton() {
  const blocker = callBlocker();
  el.callBtn.disabled = blocker !== null || ui.busy.has('call');
  setMessage(el.callBlocker, blocker ?? '');
  const seconds = selectedDurationMs() / 1000;
  const demo = ui.state?.demo === true;
  const where =
    ui.mode === 'crossover' ? (demo ? 'both sides' : 'both chats') : demo ? 'side A' : 'your chat';
  setText(el.callSub, `${seconds} s · ${where}`);
  el.resetBtn.disabled = !ui.state || ui.busy.has('reset');
}

/** Labels feed the scoreboard, captions and the "A + B" preset; redraw only when they change. */
function syncLabels(labels) {
  const key = `${labels.A}\u0000${labels.B}`;
  if (key === ui.labelsKey) return;
  ui.labelsKey = key;
  setText(el.presetVersusName, presetTitle('versus', labels));
  renderCaptions();
  drawThumbnails();
  if (picture.source === 'preset' && picture.preset === 'versus') rebuildPicture();
}

// ---------------------------------------------------------------------------------------------
// Picture builder

function currentLabels() {
  const labels = ui.state?.meta.labels;
  return isObject(labels) ? labels : { A: 'A', B: 'B' };
}

function setMode(mode) {
  ui.mode = mode;
  picture.preset = picture.presetsByMode[mode];
  for (const radio of document.querySelectorAll('input[name="preset"]')) {
    radio.checked = radio.value === picture.preset;
  }
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.checked = radio.value === mode;
  }
  document.body.dataset.mode = mode;
  setText(el.gridSize, `${fullCols(mode)} × ${GRID_ROWS} cards · ${mode}`);
  renderCaptions();
  drawThumbnails();
  rebuildPicture();
  render();
}

function renderCaptions() {
  const labels = currentLabels();
  const single = ui.mode === 'single';
  const name = (side) => {
    const label = distinctLabel(side, labels[side]);
    return label ? `${side} · ${label}` : side;
  };
  setText(el.capA, `${name('A')} · ${single ? 'whole picture' : 'left half'}`);
  setText(el.capB, `${name('B')} · right half`);
  el.capB.parentElement.hidden = single;
}

function setSource(source) {
  picture.source = source;
  for (const [name, panel] of Object.entries(el.panels)) panel.hidden = name !== source;
  rebuildPicture();
}

/** Recomputes the artwork from the current source and redraws the preview. */
function rebuildPicture() {
  const mode = ui.mode;
  picture.problem = null;
  let notice = '';
  switch (picture.source) {
    case 'preset': {
      picture.artwork = presetArtwork(picture.preset, mode, currentLabels());
      picture.description = `${presetTitle(picture.preset, currentLabels())} preset`;
      break;
    }
    case 'text': {
      const lines = [el.textLine1.value, el.textLine2.value];
      const result = textArtwork({ mode, lines, fg: picture.fg, bg: picture.bg });
      picture.artwork = result.artwork;
      picture.description = `Text: ${lines.filter(Boolean).join(' / ')}`;
      if (result.error) picture.problem = result.error;
      else if (result.layout && result.layout.items.length === 0) {
        picture.problem = 'Type the text for the picture.';
      }
      const notes = [];
      if (picture.problem) notes.push(picture.problem);
      if (result.unsupported.length > 0) {
        notes.push(`Not in the pixel font, left out: ${result.unsupported.join(' ')}`);
      }
      if (picture.fg === picture.bg) {
        notes.push('Text and background are the same colour, so the picture would be blank.');
        picture.problem ??= 'Pick different text and background colours.';
      }
      notice = notes.join(' ');
      break;
    }
    case 'image': {
      if (!picture.bitmap) {
        picture.artwork = null;
        picture.problem = 'Choose an image, or switch to a preset or text.';
        picture.description = 'No image chosen';
      } else {
        picture.artwork = bitmapToArtwork(picture.bitmap, mode);
        picture.description = `Image: ${el.imageName.textContent}`;
      }
      break;
    }
    default:
      picture.artwork = null;
  }
  if (picture.artwork && !isValidArtwork(picture.artwork, mode)) {
    picture.artwork = null;
    picture.problem = 'The picture could not be built for this grid. Try another source.';
  }
  setMessage(el.textWarning, picture.source === 'text' ? notice : '');
  drawPreview();
  updateCallButton();
}

/** Decoded image → artwork: composite on ink, cover-crop, supersample, box-filter, quantize. */
function bitmapToArtwork(bitmap, mode) {
  const cols = fullCols(mode);
  const width = cols * IMAGE_SUPERSAMPLE;
  const height = GRID_ROWS * IMAGE_SUPERSAMPLE;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = PALETTE[0]; // transparent areas read as ink
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  const crop = coverFitRect(bitmap.width, bitmap.height, cols, GRID_ROWS);
  context.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
  return imageDataToArtwork(context.getImageData(0, 0, width, height).data, width, height, mode);
}

async function loadImage(file) {
  setMessage(el.pictureError, '');
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    setMessage(el.pictureError, `${file.name} is not an image. Choose a PNG, JPEG, WebP or GIF.`);
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    setMessage(el.pictureError, `${file.name} is larger than 30 MB. Choose a smaller image.`);
    return;
  }
  try {
    // createImageBitmap needs no blob:/data: URL, so it works under the page's strict CSP.
    const bitmap = await createImageBitmap(file);
    picture.bitmap?.close();
    picture.bitmap = bitmap;
    setText(el.imageName, `${file.name} · ${bitmap.width} × ${bitmap.height} px`);
  } catch {
    setMessage(el.pictureError, `Could not read ${file.name}. Try a PNG or JPEG.`);
  }
  rebuildPicture();
}

/**
 * Draws an artwork (or an empty grid) at `cardPx` CSS pixels per card with `gapPx` between
 * cards, sharp on high-DPI screens. Returns the context and CSS size for overlays like the seam.
 */
function drawGrid(canvas, artwork, cardPx, gapPx) {
  const dpr = Math.max(1, Math.min(3, Math.round(window.devicePixelRatio || 1)));
  const cols = artwork ? artwork.cols : fullCols(ui.mode);
  const rows = artwork ? artwork.rows : GRID_ROWS;
  const width = cols * cardPx;
  const height = rows * cardPx;
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = GAP_COLOR;
  context.fillRect(0, 0, width, height);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      context.fillStyle = artwork ? PALETTE[artwork.pixels[y * cols + x]] : EMPTY_CARD_COLOR;
      context.fillRect(x * cardPx, y * cardPx, cardPx - gapPx, cardPx - gapPx);
    }
  }
  return { context, width, height };
}

function drawPreview() {
  const { context, width, height } = drawGrid(el.preview, picture.artwork, PREVIEW_CARD_PX, 1);
  // Never upscale the preview past 10 px per card; narrower windows scale it down.
  el.preview.style.maxWidth = `${width}px`;
  if (ui.mode === 'crossover') {
    // The seam: A's overlay ends here and B's begins (a light line in a dark channel).
    const x = SIDE_COLS * PREVIEW_CARD_PX - 1;
    context.fillStyle = GAP_COLOR;
    context.fillRect(x - 1, 0, 4, height);
    context.fillStyle = SEAM_COLOR;
    context.fillRect(x, 0, 2, height);
  }
  const where =
    ui.mode === 'crossover'
      ? `${fullCols('crossover')} by ${GRID_ROWS} cards; the left half is side A, the right half side B`
      : `${SIDE_COLS} by ${GRID_ROWS} cards, all on side A`;
  el.preview.setAttribute(
    'aria-label',
    `Preview of the hidden picture. ${picture.description || 'Nothing selected'}; ${where}.`,
  );
}

function drawThumbnails() {
  const labels = currentLabels();
  for (const canvas of document.querySelectorAll('canvas.preset-thumb')) {
    drawGrid(canvas, presetArtwork(canvas.dataset.preset, ui.mode, labels), THUMB_CARD_PX, 0);
  }
}

function buildSwatches(container, name, selected, onPick) {
  PALETTE.forEach((hex, index) => {
    const label = document.createElement('label');
    label.className = 'swatch';
    label.title = PALETTE_NAMES[index];
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = String(index);
    input.checked = index === selected;
    input.setAttribute('aria-label', PALETTE_NAMES[index]);
    const chip = document.createElement('span');
    chip.className = 'swatch-chip';
    chip.style.backgroundColor = hex;
    label.append(input, chip);
    container.append(label);
  });
  container.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.name === name) onPick(Number(target.value));
  });
}

// ---------------------------------------------------------------------------------------------
// Actions

function readInt(input, min, max, name) {
  input.removeAttribute('aria-invalid');
  const value = Number(input.value);
  if (input.value.trim() === '' || !Number.isInteger(value) || value < min || value > max) {
    throw new FieldError(input, `${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/** CallRequest (src/shared/protocol.ts) from the form and the current picture. */
function buildCallRequest() {
  const minQuorum = readInt(el.minQuorum, 1, 1000, 'Minimum people');
  const percent = readInt(el.quorumRatio, 1, 100, 'Share of recent chatters');
  // Overrides persist in the server config between rounds, so "off" is sent as an explicit null.
  const quorumOverride = {};
  for (const side of SIDES) {
    const { overrideOn, override } = sideEls[side];
    const applies = side === 'A' || ui.mode === 'crossover';
    quorumOverride[side] =
      applies && overrideOn.checked ? readInt(override, 1, 1000, `Fixed quorum for ${side}`) : null;
  }
  if (!picture.artwork || !isValidArtwork(picture.artwork, ui.mode)) {
    throw new Error(picture.problem ?? 'Choose a picture first.');
  }
  return {
    artwork: {
      cols: picture.artwork.cols,
      rows: picture.artwork.rows,
      pixels: picture.artwork.pixels,
    },
    mode: ui.mode,
    durationMs: selectedDurationMs(),
    minQuorum,
    quorumRatio: percent / 100,
    quorumOverride,
  };
}

function onCall(event) {
  event.preventDefault();
  if (callBlocker() !== null) return;
  setMessage(el.stuntStatus, '');
  void runAction('call', [el.callBtn], el.stuntError, async () => {
    const request = buildCallRequest();
    await postJson('/api/call', request, {
      409: 'A stunt is already running. Wait for it to finish or RESET first.',
    });
    const seconds = request.durationMs / 1000;
    if (ui.state?.demo) {
      // Demo never posts to Twitch: say so instead of claiming a chat prompt went out.
      setMessage(
        el.stuntStatus,
        `SIMULATED round started — nothing is sent to Twitch. ${seconds} s on the clock.`,
      );
      return;
    }
    const chats = request.mode === 'crossover' ? 'both chats' : 'your chat';
    setMessage(el.stuntStatus, `CALL sent to ${chats}. ${seconds} s on the clock.`);
  });
}

function disarmReset() {
  window.clearTimeout(ui.resetTimer);
  ui.resetArmedUntil = 0;
  delete el.resetBtn.dataset.armed;
  setText(el.resetBtn, 'RESET');
}

function onReset() {
  const phase = ui.state?.snapshot.phase;
  const running = phase === 'active' || phase === 'revealing';
  // Stopping a live stunt takes a second, deliberate click.
  if (running && Date.now() > ui.resetArmedUntil) {
    ui.resetArmedUntil = Date.now() + RESET_CONFIRM_MS;
    el.resetBtn.dataset.armed = 'true';
    setText(el.resetBtn, 'Confirm RESET');
    setMessage(el.stuntStatus, 'A stunt is running. Click RESET again within 4 s to stop it.');
    ui.resetTimer = window.setTimeout(disarmReset, RESET_CONFIRM_MS);
    return;
  }
  disarmReset();
  setMessage(el.stuntStatus, '');
  void runAction('reset', [el.resetBtn], el.stuntError, async () => {
    await postJson('/api/reset', {});
    setMessage(el.stuntStatus, 'Reset. Overlays are idle.');
  });
}

function onConnectTwitch() {
  void runAction('auth', [el.twitchConnect], el.twitchError, async () => {
    const result = await postJson('/api/auth/start', {});
    if (isObject(result) && typeof result.userCode === 'string') {
      ui.authFromStart = {
        userCode: result.userCode,
        verificationUri: typeof result.verificationUri === 'string' ? result.verificationUri : null,
        atMs: Date.now(),
      };
    }
  });
}

function onSignOut() {
  void runAction('signout', [el.twitchSignout], el.twitchError, async () => {
    ui.authFromStart = null;
    await postJson('/api/auth/signout', {});
  });
}

function onSaveChannels(event) {
  event.preventDefault();
  setMessage(el.channelsStatus, '');
  void runAction('channels', [el.channelsSave], el.channelsError, async () => {
    const body = {};
    const a = el.channelA.value.trim();
    const b = el.channelB.value.trim();
    for (const [input, value] of [
      [el.channelA, a],
      [el.channelB, b],
    ]) {
      input.removeAttribute('aria-invalid');
      if (value && !LOGIN_PATTERN.test(value)) {
        throw new FieldError(
          input,
          `"${value}" is not a Twitch login: use 1–25 letters, digits or underscores.`,
        );
      }
    }
    if (a) body.a = a;
    body.b = b || null;
    await postJson('/api/channels', body);
    ui.channelsDirty = false;
    setMessage(el.channelsStatus, b ? 'Channels saved.' : 'Saved. No partner channel set.');
  });
}

function onSaveLabels(event) {
  event.preventDefault();
  void runAction('labels', [el.labelsSave], el.labelsError, async () => {
    const A = el.labelA.value.trim(),
      B = el.labelB.value.trim();
    for (const [input, label] of [
      [el.labelA, A],
      [el.labelB, B],
    ]) {
      if (label.length > 24)
        throw new FieldError(input, 'Team labels can have at most 24 characters.');
    }
    await postJson('/api/labels', { A, B });
    ui.labelsDirty = false;
    setMessage(el.labelsStatus, 'Team labels saved.');
  });
}

function onShare(start) {
  const button = start ? el.shareStart : el.shareStop;
  // The share error line also mirrors /api/state's share.error; a failed request wins over it.
  ui.shareActionError = '';
  void runAction('share', [button], el.shareError, async () => {
    try {
      await postJson(
        start ? '/api/share/start' : '/api/share/stop',
        {},
        {
          501: 'Sharing is not available on this server yet.',
        },
      );
    } catch (error) {
      ui.shareActionError = errorText(error);
      throw error;
    }
  });
}

async function copyText(text, button, what, input) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
    el.copyStatus.textContent = `${what} copied to the clipboard.`;
  } catch {
    // Clipboard API refused (permissions, focus): select the text for a manual copy.
    if (input) {
      input.value = text;
      input.focus();
      input.select();
    }
    button.textContent = 'Ctrl+C';
    el.copyStatus.textContent = `Copy blocked by the browser. ${what} is selected: press Ctrl+C.`;
  }
  window.setTimeout(() => {
    button.textContent = original;
  }, FLASH_MS);
}

function onCopyUrl(button) {
  const key = button.dataset.copy;
  const text = ui.urls[key] ?? '';
  if (!text) return;
  const input = key === 'A' ? el.urlA : key === 'B' ? el.urlB : el.urlPartner;
  const what = key === 'partner' ? 'Partner overlay URL' : `Overlay ${key} URL`;
  void copyText(text, button, what, input);
}

function onSimulate(sides, count) {
  const seed = ui.nextSeed;
  ui.nextSeed += 1;
  const buttons = [...el.simulator.querySelectorAll('[data-sim-side], #sim-both')];
  void runAction('sim', buttons, el.simError, async () => {
    for (const side of sides) {
      await postJson(
        '/dev/chat',
        { side, count, seed },
        {
          404: 'The simulator only runs with pnpm demo.',
        },
      );
    }
    const people = plural(count, 'virtual person', 'virtual people');
    const where = sides.length === 2 ? 'both chats (the same people)' : sides[0];
    setMessage(el.simStatus, `SIMULATED: +${people} on ${where}.`);
  });
}

function onShowcase(scenario) {
  const buttons = [...el.simulator.querySelectorAll('[data-showcase]')];
  void runAction('showcase', buttons, el.simError, async () => {
    await postJson(
      '/dev/showcase',
      { scenario },
      {
        404: 'Showcase rounds only run with pnpm demo.',
        409: 'A stunt is running. RESET first, then start the showcase.',
      },
    );
    setMessage(
      el.simStatus,
      `SIMULATED showcase started: ${SHOWCASE_NAMES[scenario] ?? scenario}.`,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Wiring

function wire() {
  for (const radio of document.querySelectorAll('input[name="layout"]'))
    radio.addEventListener('change', () => {
      ui.layout = radio.value;
      if (ui.state) renderOverlayUrls(ui.state);
    });
  el.stuntForm.addEventListener('submit', onCall);
  el.stuntForm.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) target.removeAttribute('aria-invalid');
    render();
  });
  el.resetBtn.addEventListener('click', onReset);

  for (const radio of document.querySelectorAll('input[name="source"]')) {
    radio.addEventListener('change', () => setSource(radio.value));
  }
  for (const radio of document.querySelectorAll('input[name="preset"]')) {
    radio.addEventListener('change', () => {
      picture.preset = radio.value;
      picture.presetsByMode[ui.mode] = radio.value;
      rebuildPicture();
    });
  }
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', () => setMode(radio.value));
  }
  el.textLine1.addEventListener('input', rebuildPicture);
  el.textLine2.addEventListener('input', rebuildPicture);
  buildSwatches(el.fgSwatches, 'text-fg', picture.fg, (index) => {
    picture.fg = index;
    rebuildPicture();
  });
  buildSwatches(el.bgSwatches, 'text-bg', picture.bg, (index) => {
    picture.bg = index;
    rebuildPicture();
  });

  el.imageFile.addEventListener('change', () => void loadImage(el.imageFile.files?.[0]));
  el.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    el.dropzone.dataset.over = 'true';
  });
  el.dropzone.addEventListener('dragleave', () => delete el.dropzone.dataset.over);
  el.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    delete el.dropzone.dataset.over;
    void loadImage(event.dataTransfer?.files?.[0]);
  });

  el.twitchConnect.addEventListener('click', onConnectTwitch);
  el.twitchSignout.addEventListener('click', onSignOut);
  el.twitchCopyCode.addEventListener('click', () => {
    const code = ui.userCode;
    if (code) void copyText(code, el.twitchCopyCode, 'Activation code', null);
  });
  el.twitchRevealCode.addEventListener('click', () => {
    ui.revealCode = !ui.revealCode;
    render();
  });

  el.labelsForm.addEventListener('submit', onSaveLabels);
  el.labelsForm.addEventListener('input', () => {
    ui.labelsDirty = true;
    setMessage(el.labelsStatus, '');
  });
  el.channelsForm.addEventListener('submit', onSaveChannels);
  el.channelsForm.addEventListener('input', () => {
    ui.channelsDirty = true;
  });

  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', () => onCopyUrl(button));
  }
  el.partnerReveal.addEventListener('click', () => {
    ui.revealPartner = !ui.revealPartner;
    render();
  });
  el.shareStart.addEventListener('click', () => onShare(true));
  el.shareStop.addEventListener('click', () => onShare(false));

  for (const button of el.simulator.querySelectorAll('[data-sim-side]')) {
    button.addEventListener('click', () =>
      onSimulate([button.dataset.simSide], Number(button.dataset.simCount)),
    );
  }
  el.simBoth.addEventListener('click', () => onSimulate(['A', 'B'], 5));
  for (const button of el.simulator.querySelectorAll('[data-showcase]')) {
    button.addEventListener('click', () => onShowcase(button.dataset.showcase));
  }
}

wire();
setMode('crossover');
window.setInterval(renderClock, CLOCK_INTERVAL_MS);
refreshNow();
