// Synthesized crowd roar (Web Audio, no audio assets) and the browser audio-unlock chip.
// OBS browser sources may autoplay; a normal browser needs one user gesture first.

const ROAR_SECONDS = 2.6;
/** Hard ceiling from docs/DESIGN.md: master gain never exceeds 0.5. */
const MASTER_GAIN = 0.45;

/** Pink-ish noise (Paul Kellet's economy filter) — a fuller "crowd" than white noise. */
function makeNoise(context, seconds) {
  const length = Math.ceil(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < length; i += 1) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.2;
  }
  return buffer;
}

/** Sets an attack/hold/release envelope on a gain param starting at `t0`. */
function envelope(param, t0, peak, attack, hold, release) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0.0001, t0);
  param.exponentialRampToValueAtTime(peak, t0 + attack);
  param.setValueAtTime(peak, t0 + attack + hold);
  param.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
}

class SilentAudio {
  get enabled() {
    return false;
  }

  roar() {}
}

class WebAudioRoar {
  #context;
  #noise = null;
  #chip;
  #isObs;

  constructor(context, chip, isObs) {
    this.#context = context;
    this.#chip = chip;
    this.#isObs = isObs;
    context.addEventListener('statechange', () => this.#syncChip());
    if (context.state !== 'running') void context.resume().catch(() => {});
    const unlock = () => {
      void context.resume().then(
        () => this.#syncChip(),
        () => {},
      );
    };
    // Any gesture unlocks audio; the chip is just the visible hint.
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    chip?.addEventListener('click', unlock);
    // Give OBS/autoplay a moment to start the context before showing the hint.
    setTimeout(() => this.#syncChip(), 400);
  }

  get enabled() {
    return this.#context.state === 'running';
  }

  #syncChip() {
    if (!this.#chip) return;
    // OBS has no pointer to click, so never show the hint there.
    this.#chip.hidden = this.#isObs || this.#context.state === 'running';
  }

  /** ~2.5 s swell: band-passed crowd hiss + low body + sub rumble, with cheering wobble. */
  roar() {
    const context = this.#context;
    if (context.state !== 'running') return;
    this.#noise ??= makeNoise(context, ROAR_SECONDS + 0.2);
    const t0 = context.currentTime + 0.02;
    const end = t0 + ROAR_SECONDS;

    const master = context.createGain();
    master.gain.value = MASTER_GAIN;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 6;
    master.connect(limiter).connect(context.destination);

    // Crowd hiss: noise through a band-pass whose center rises as the crowd gets louder.
    const crowd = context.createBufferSource();
    crowd.buffer = this.#noise;
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.7;
    band.frequency.setValueAtTime(700, t0);
    band.frequency.exponentialRampToValueAtTime(1500, t0 + 0.9);
    band.frequency.exponentialRampToValueAtTime(900, end);
    const crowdGain = context.createGain();
    envelope(crowdGain.gain, t0, 0.9, 0.55, 0.9, 1.1);
    // Cheering texture: a slow amplitude wobble (LFO added onto a unity gain) on the hiss.
    const wobbleMix = context.createGain();
    wobbleMix.gain.value = 1;
    crowd.connect(band).connect(crowdGain).connect(wobbleMix).connect(master);
    const wobble = context.createOscillator();
    wobble.frequency.value = 4.3;
    const wobbleDepth = context.createGain();
    wobbleDepth.gain.value = 0.18;
    wobble.connect(wobbleDepth).connect(wobbleMix.gain);

    // Body: low-passed noise for the chest of the roar.
    const body = context.createBufferSource();
    body.buffer = this.#noise;
    body.playbackRate.value = 0.6;
    const low = context.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 420;
    const bodyGain = context.createGain();
    envelope(bodyGain.gain, t0, 0.7, 0.4, 0.8, 1.3);
    body.connect(low).connect(bodyGain).connect(master);

    // Rumble: detuned low oscillators (stadium stomp).
    const rumbleGain = context.createGain();
    envelope(rumbleGain.gain, t0, 0.32, 0.25, 0.7, 1.4);
    const rumbleFilter = context.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 160;
    rumbleFilter.connect(rumbleGain).connect(master);
    const oscillators = [48, 61, 73].map((frequency, index) => {
      const oscillator = context.createOscillator();
      oscillator.type = index === 1 ? 'triangle' : 'sine';
      oscillator.frequency.value = frequency;
      oscillator.connect(rumbleFilter);
      return oscillator;
    });

    for (const source of [crowd, body, wobble, ...oscillators]) {
      source.start(t0);
      source.stop(end + 0.05);
    }
    crowd.onended = () => {
      master.disconnect();
      limiter.disconnect();
    };
  }
}

/**
 * Creates the audio engine. `mute` returns a silent stub (captions still appear). Outside OBS
 * the chip stays visible until the AudioContext is running.
 */
export function createAudio({ mute, chip }) {
  const isObs = typeof window.obsstudio === 'object' && window.obsstudio !== null;
  if (mute) return new SilentAudio();
  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextClass) return new SilentAudio();
  try {
    return new WebAudioRoar(new AudioContextClass({ latencyHint: 'interactive' }), chip, isObs);
  } catch {
    return new SilentAudio();
  }
}
