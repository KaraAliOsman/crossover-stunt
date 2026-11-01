/**
 * SIMULATED injector page (`pnpm demo` only). Sends virtual chat to POST /dev/chat, starts
 * scripted showcase rounds with POST /dev/showcase and mirrors the round from GET /api/snapshot.
 * Nothing on this page reaches Twitch.
 */

const POLL_INTERVAL_MS = 1_000;
const PHASE_LABELS = {
  idle: 'Idle',
  active: 'Running', // the dev page only exists in the SIMULATED demo
  revealing: 'Revealing',
  complete: 'Complete',
  'timed-out': 'Timed out',
};
const SHOWCASE_NAMES = { crossover: 'Crossover', 'so-close': 'So close', single: 'Single' };

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`dev: missing #${id}`);
  return element;
}

const form = /** @type {HTMLFormElement} */ (byId('injector'));
const seedInput = /** @type {HTMLInputElement} */ (byId('inject-seed'));
const submit = /** @type {HTMLButtonElement} */ (byId('inject-submit'));
const result = byId('result');
const showcaseResult = byId('showcase-result');
const liveStatus = byId('live-status');
/** Phase from the last snapshot poll: `added` only means something while a round runs. */
let lastPhase = 'idle';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function show(element, text, tone = 'sim') {
  element.textContent = text;
  element.className = `msg msg-${tone}`;
  element.hidden = text === '';
}

/** POST JSON; resolves to `{ ok, status, data }` and never throws for HTTP errors. */
async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}

function failureText(status, data) {
  if (status === 404) return 'only available while the server runs with pnpm demo.';
  if (isObject(data) && typeof data.error === 'string') return data.error.slice(0, 300);
  return `HTTP ${status}.`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = new FormData(form);
  const side = fields.get('side');
  const count = Number(fields.get('count'));
  const seed = Number(fields.get('seed'));
  seedInput.removeAttribute('aria-invalid');
  if (!Number.isSafeInteger(seed) || seed < 0) {
    seedInput.setAttribute('aria-invalid', 'true');
    seedInput.focus();
    show(result, 'The replay seed must be a whole number of 0 or more.', 'error');
    return;
  }
  submit.disabled = true;
  try {
    const { ok, status, data } = await postJson('/dev/chat', { side, count, seed });
    if (ok) {
      const accepted = isObject(data) && typeof data.accepted === 'number' ? data.accepted : count;
      const added = isObject(data) && typeof data.added === 'number' ? data.added : null;
      let text = `SIMULATED: ${accepted} virtual chat events sent to side ${side} (seed ${seed}).`;
      if (added !== null && lastPhase === 'active') {
        const people = added === 1 ? 'person' : 'people';
        text = `SIMULATED: ${added} new virtual ${people} on side ${side} (${accepted} events, seed ${seed}).`;
        if (added === 0) {
          text += ' Nobody new: that seed was already counted, or this side is not in the round.';
        }
      }
      show(result, text);
      // The next click brings new people; type an earlier seed back to replay it on purpose.
      seedInput.value = String(seed + 1);
    } else {
      show(result, `SIMULATED injector unavailable: ${failureText(status, data)}`, 'error');
    }
  } catch {
    show(result, 'SIMULATED injector could not reach the server.', 'error');
  } finally {
    submit.disabled = false;
  }
});

for (const button of document.querySelectorAll('[data-showcase]')) {
  button.addEventListener('click', async () => {
    const scenario = button.getAttribute('data-showcase');
    const name = SHOWCASE_NAMES[scenario] ?? scenario;
    button.disabled = true;
    try {
      const { ok, status, data } = await postJson('/dev/showcase', { scenario });
      if (ok) show(showcaseResult, `SIMULATED showcase started: ${name}.`);
      else {
        const reason =
          status === 409 ? 'a stunt is running. RESET it first.' : failureText(status, data);
        show(showcaseResult, `Showcase "${name}" not started: ${reason}`, 'error');
      }
    } catch {
      show(showcaseResult, 'Showcase could not reach the server.', 'error');
    } finally {
      button.disabled = false;
    }
  });
}

/** One-line summary of the public snapshot: phase and per-side progress. */
function describe(payload) {
  if (!isObject(payload) || !isObject(payload.snapshot)) return 'Unexpected snapshot response.';
  const { snapshot } = payload;
  const labels = isObject(payload.meta) && isObject(payload.meta.labels) ? payload.meta.labels : {};
  const phase = PHASE_LABELS[snapshot.phase] ?? String(snapshot.phase);
  if (snapshot.phase === 'idle' || !isObject(snapshot.sides)) return `${phase} — no round running.`;
  const sides = snapshot.mode === 'single' ? ['A'] : ['A', 'B'];
  const parts = sides.map((side) => {
    const data = snapshot.sides[side];
    const label = typeof labels[side] === 'string' ? labels[side] : side;
    return isObject(data) ? `${label} ${data.participants}/${data.quorum}` : label;
  });
  return `${phase} · ${parts.join(' · ')}`;
}

/** Live region: only touch it when the text changes, so screen readers are not spammed. */
function setStatus(text) {
  if (liveStatus.textContent !== text) liveStatus.textContent = text;
}

async function poll() {
  try {
    const response = await fetch('/api/snapshot', { cache: 'no-store' });
    if (response.ok) {
      const payload = await response.json();
      if (isObject(payload) && isObject(payload.snapshot)) {
        lastPhase = String(payload.snapshot.phase);
      }
      setStatus(describe(payload));
    } else {
      setStatus(`Snapshot unavailable (HTTP ${response.status}).`);
    }
  } catch {
    setStatus('Server unreachable. Retrying…');
  } finally {
    window.setTimeout(poll, POLL_INTERVAL_MS);
  }
}

void poll();
