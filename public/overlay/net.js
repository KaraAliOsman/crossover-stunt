// Read-only overlay transport: WebSocket push with exponential reconnect, HTTP polling while the
// socket is down, and a server clock estimate so both overlays animate from server timestamps.
import { readServerMessage, readSnapshotResponse } from './protocol.js';

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 4_000;
const SYNC_COOLDOWN_MS = 2_000;
const CLOCK_SAMPLES = 64;
/**
 * Socket down and no successful poll for this long: report the link as lost so the stage can
 * stop showing a frozen round (server stopped, tunnel closed, or an expired partner URL).
 */
export const LOST_AFTER_MS = 15_000;

/**
 * Server clock estimate. Each message carries `serverNowMs` stamped when it was sent; it arrives
 * after a non-negative network delay d, so `serverNowMs − localReceive = trueOffset − d`.
 * The least-delayed recent sample is therefore the MAX of that difference over a sliding window
 * (the window lets the estimate follow a server clock adjustment instead of latching forever).
 */
export class ServerClock {
  #samples = new Float64Array(CLOCK_SAMPLES);
  #count = 0;
  #next = 0;
  // Before the first sample assume the local wall clock matches the server.
  #offset = Date.now() - performance.now();
  #sampled = false;

  /** Records a sample; `localMs` is performance.now() at receive time. */
  sample(serverNowMs, localMs) {
    this.#samples[this.#next] = serverNowMs - localMs;
    this.#next = (this.#next + 1) % CLOCK_SAMPLES;
    this.#count = Math.min(CLOCK_SAMPLES, this.#count + 1);
    let best = -Infinity;
    for (let i = 0; i < this.#count; i += 1) best = Math.max(best, this.#samples[i]);
    this.#offset = best;
    this.#sampled = true;
  }

  /** Estimated server epoch ms for a performance.now() reading. */
  now(localMs) {
    return localMs + this.#offset;
  }

  get sampled() {
    return this.#sampled;
  }

  /** Server clock minus local wall clock (debug display only). */
  get skewMs() {
    return this.now(performance.now()) - Date.now();
  }
}

/**
 * Connects to `/ws?side=X[&room]`, falls back to polling `/api/snapshot?round=<id>[&room]`
 * every second while the socket is down, and stops polling as soon as the socket reopens.
 * Every request carries the room token when the overlay URL has one.
 *
 * `onTransport` receives 'ws' | 'poll' while the server is reachable, then 'lost' (or
 * 'forbidden' when polls get HTTP 403, i.e. a wrong or expired room token) after
 * LOST_AFTER_MS without any contact; it switches back on the next socket open or good poll.
 */
export class OverlayLink {
  #side;
  #room;
  #clock;
  #getRoundId;
  #onMessage;
  #onTransport;
  #socket = null;
  #attempt = 0;
  #reconnectTimer = 0;
  #pollTimer = 0;
  #polling = false;
  #pollInFlight = false;
  #lastSyncMs = -Infinity;
  #stopped = false;
  /** 'ws' | 'poll' (what carries data now) and the link health on top of it. */
  #mode = 'connecting';
  #lostSince = null;
  #lost = false;
  #forbidden = false;
  #reported = '';
  /** Invalidates an in-flight HTTP snapshot when newer round/state frames arrive over WS. */
  #pushVersion = 0;

  constructor({ side, room, clock, getRoundId, onMessage, onTransport }) {
    this.#side = side;
    this.#room = room;
    this.#clock = clock;
    this.#getRoundId = getRoundId;
    this.#onMessage = onMessage;
    this.#onTransport = onTransport;
  }

  start() {
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#pollTimer);
    this.#polling = false;
    if (this.#socket) {
      this.#socket.onclose = null;
      this.#socket.close();
      this.#socket = null;
    }
  }

  /**
   * One-shot poll used when a snapshot references a round we have not received (for example a
   * dropped `round` frame); the snapshot route includes the round when our id differs.
   */
  requestSync() {
    const now = performance.now();
    if (this.#polling || now - this.#lastSyncMs < SYNC_COOLDOWN_MS) return;
    this.#lastSyncMs = now;
    void this.#pollOnce();
  }

  #url(path, params) {
    const url = new URL(path, location.href);
    if (path === '/ws') url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, value);
    }
    if (this.#room) url.searchParams.set('room', this.#room);
    return url.href;
  }

  #connect() {
    if (this.#stopped) return;
    let socket;
    try {
      socket = new WebSocket(this.#url('/ws', { side: this.#side }));
    } catch {
      this.#handleDisconnect();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      this.#attempt = 0;
      this.#stopPolling();
      this.#mode = 'ws';
      this.#contact();
    };
    socket.onmessage = (event) => this.#receive(event.data);
    socket.onerror = () => {
      // A close event always follows; reconnect logic lives there.
    };
    socket.onclose = () => {
      if (this.#socket === socket) this.#socket = null;
      this.#handleDisconnect();
    };
  }

  #handleDisconnect() {
    if (this.#stopped) return;
    this.#mode = 'poll';
    this.#lostSince ??= performance.now();
    this.#report();
    this.#startPolling();
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.#attempt);
    this.#attempt = Math.min(this.#attempt + 1, 16);
    const jitter = 0.8 + Math.random() * 0.4;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => this.#connect(), backoff * jitter);
  }

  #receive(data) {
    const receivedAt = performance.now();
    if (typeof data !== 'string' || data.length > 2_000_000) return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const message = readServerMessage(parsed);
    if (!message) return;
    if (message.type === 'round' || message.type === 'snapshot') this.#pushVersion += 1;
    if (message.type === 'hello') this.#clock.sample(message.serverNowMs, receivedAt);
    if (message.type === 'snapshot') this.#clock.sample(message.snapshot.serverNowMs, receivedAt);
    this.#onMessage(message);
  }

  /** The server answered with our credentials: the link is healthy again. */
  #contact() {
    this.#lostSince = null;
    this.#lost = false;
    this.#forbidden = false;
    this.#report();
  }

  /** A poll failed while the socket is down; flips to lost after LOST_AFTER_MS. */
  #noContact(forbidden) {
    const now = performance.now();
    this.#lostSince ??= now;
    this.#forbidden = forbidden;
    if (now - this.#lostSince >= LOST_AFTER_MS) this.#lost = true;
    this.#report();
  }

  #report() {
    const transport = this.#lost ? (this.#forbidden ? 'forbidden' : 'lost') : this.#mode;
    if (transport === this.#reported) return;
    this.#reported = transport;
    this.#onTransport(transport);
  }

  #socketOpen() {
    return this.#socket !== null && this.#socket.readyState === WebSocket.OPEN;
  }

  #startPolling() {
    if (this.#polling || this.#stopped) return;
    this.#polling = true;
    void this.#pollOnce();
  }

  #stopPolling() {
    this.#polling = false;
    clearTimeout(this.#pollTimer);
  }

  async #pollOnce() {
    if (this.#pollInFlight) return;
    this.#pollInFlight = true;
    const pushVersion = this.#pushVersion;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
    try {
      const response = await fetch(this.#url('/api/snapshot', { round: this.#getRoundId() }), {
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      const receivedAt = performance.now();
      const body = response.ok ? readSnapshotResponse(await response.json()) : null;
      // A reconnect sends a complete new state. A slower fallback response must not replace
      // its round payload before Stage can reject the stale snapshot that accompanies it.
      if (this.#stopped || pushVersion !== this.#pushVersion) return;
      if (body) {
        this.#clock.sample(body.snapshot.serverNowMs, receivedAt);
        if (body.meta) this.#onMessage({ type: 'meta', meta: body.meta });
        if (body.hasRound) this.#onMessage({ type: 'round', round: body.round });
        this.#onMessage({ type: 'snapshot', snapshot: body.snapshot });
        this.#contact();
      } else if (!this.#socketOpen()) {
        this.#noContact(response.status === 403);
      }
    } catch {
      // Offline or aborted: the next poll (or the socket) recovers.
      if (!this.#socketOpen()) this.#noContact(false);
    } finally {
      clearTimeout(timeout);
      this.#pollInFlight = false;
      if (this.#polling && !this.#stopped) {
        clearTimeout(this.#pollTimer);
        this.#pollTimer = setTimeout(() => void this.#pollOnce(), POLL_INTERVAL_MS);
      }
    }
  }
}
