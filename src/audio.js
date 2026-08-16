// Engine audio, sample-based.
//
// The technique is the one used by markeasting/engine (and by most racing
// sims): rather than synthesising a note, take four looping recordings of a
// real engine -- on/off throttle, low/high rpm -- pitch them to the current
// rpm, and crossfade between them. Two equal-power crossfades do the blending:
// one on rpm (low <-> high) and one on throttle (off <-> on). A fifth sample
// fades in against the limiter.
//
// Samples are BAC Mono, from markeasting/engine (MIT). Because they're real
// recordings, the character -- the hard-edged induction howl of a naturally
// aspirated race four -- comes for free; nothing here tries to model it.
//
// The pitch comes from `detune`, in cents: 1200 cents is one octave, so a
// sample recorded at its reference rpm is shifted by how far the engine is
// from it. Everything is driven from the physics: rpm, throttle, gear.

import { TUNING } from './tuning.js';

const SAMPLES = {
  on_low:   { url: './assets/audio/on_low.wav',   refRpm: 1000, volume: 0.55 },
  on_high:  { url: './assets/audio/on_high.wav',  refRpm: 1000, volume: 0.55 },
  off_low:  { url: './assets/audio/off_low.wav',  refRpm: 1000, volume: 0.45 },
  off_high: { url: './assets/audio/off_high.wav', refRpm: 1000, volume: 0.45 },
  limiter:  { url: './assets/audio/limiter.wav',  refRpm: 8000, volume: 0.40, noPitch: true },
};

/** Equal-power crossfade: the pair's gains sum in power, not amplitude. */
function crossFade(value, start, end) {
  const x = clamp((value - start) / (end - start), 0, 1);
  return { high: Math.cos((1 - x) * 0.5 * Math.PI), low: Math.cos(x * 0.5 * Math.PI) };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function ratio(v, start, end) { return clamp((v - start) / (end - start), 0, 1); }

/** Web Audio throws on a non-finite value, and a throw here stops the frame. */
function finite(v, fallback) { return Number.isFinite(v) ? v : fallback; }

export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.nodes = {};
    this.ready = false;
    this.failed = false;
    this._muted = false;
    this._throttle = 0;
    this._rpm = 0;
  }

  get muted() { return this._muted; }

  /**
   * Must be called from a user gesture -- browsers refuse to start an
   * AudioContext otherwise. The boot screen's "press any button" is exactly
   * that moment.
   */
  async start() {
    if (this.ctx || this.failed) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = TUNING.audio.volume;
      this.master.connect(this.ctx.destination);

      // Sub-buses hanging off the master, so each source can be balanced
      // against the others rather than everything moving together. Tyre and
      // road are handed to TyreAudio; music is wired but unfed.
      this.buses = {};
      for (const name of ['engine', 'tyre', 'road', 'music']) {
        const bus = this.ctx.createGain();
        bus.gain.value = TUNING.audio[`${name}Volume`] ?? 1;
        bus.connect(this.master);
        this.buses[name] = bus;
      }

      await Promise.all(Object.entries(SAMPLES).map(async ([key, def]) => {
        const buffer = await this.ctx.decodeAudioData(
          await (await fetch(def.url)).arrayBuffer(),
        );
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const gain = this.ctx.createGain();
        gain.gain.value = 0;
        source.connect(gain).connect(this.buses.engine);
        source.start();
        this.nodes[key] = { source, gain, ...def };
      }));

      // The graph is built and live regardless of whether the context is
      // actually running -- those are different problems and conflating them
      // is what made audio die permanently.
      this.ready = true;
      this._installUnlockHandlers();
      await this.resumeIfPossible();
    } catch (err) {
      // Audio is a nicety; never let it stop the game.
      this.failed = true;
      console.warn('engine audio unavailable:', err);
    }
  }

  /** True when the graph exists but the browser has not let it start. */
  get suspended() {
    return Boolean(this.ctx) && this.ctx.state !== 'running';
  }

  /**
   * Try to start the context. Safe to call as often as you like.
   *
   * A rejection here is NOT a failure -- it means the browser has not seen a
   * user gesture yet. Treating it as one is what broke this: `resume()`
   * rejected, the catch marked audio permanently failed, and `start()` then
   * returned early forever after. Silence for the rest of the session.
   */
  async resumeIfPossible() {
    if (!this.ctx || this.ctx.state === 'running') return;
    try {
      await this.ctx.resume();
    } catch { /* no user gesture yet; the unlock handlers will retry */ }
  }

  /**
   * Resume on the first real user gesture.
   *
   * GAMEPAD INPUT DOES NOT COUNT AS USER ACTIVATION in Chrome. Once the track
   * menu became pad-navigable it was possible to reach the car having only
   * ever touched the pad, at which point the page has no activation at all and
   * the browser refuses to start any audio. Only a key, click or touch lifts
   * it, so those are what we listen for.
   */
  _installUnlockHandlers() {
    if (this._unlockBound) return;
    this._unlockBound = true;
    const unlock = () => {
      this.resumeIfPossible().then(() => {
        if (!this.suspended) {
          window.removeEventListener('pointerdown', unlock);
          window.removeEventListener('keydown', unlock);
          window.removeEventListener('touchstart', unlock);
        }
      });
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock);
  }

  setMuted(muted) {
    this._muted = muted;
    this.applyLevels();
  }

  /**
   * Push TUNING.audio levels into the graph. Called every frame so the tuning
   * panel's sliders are live, which is the only way to balance a mix.
   */
  applyLevels() {
    if (!this.master) return;
    this.master.gain.value = this._muted ? 0 : TUNING.audio.volume;
    if (!this.buses) return;
    for (const name of ['engine', 'tyre', 'road', 'music']) {
      const bus = this.buses[name];
      if (bus) bus.gain.value = TUNING.audio[`${name}Volume`] ?? 1;
    }
  }

  update(vehicle, dt) {
    if (!this.ready) return;
    this.applyLevels();
    if (this._muted) return;
    const a = TUNING.audio;
    const e = TUNING.engine;

    // Smooth the inputs a little. Raw per-step rpm makes the pitch grainy, and
    // throttle steps between 0 and 1 on a keyboard.
    // Guarded, because these are SMOOTHED values: a single non-finite sample
    // does not cause a single bad frame, it sticks forever, since
    // NaN + (x - NaN) * k is NaN for every subsequent frame. One glitch used
    // to silence the engine permanently AND throw out of setTargetAtTime every
    // frame after, which killed the render call further down the same
    // function. An audio hiccup must never be able to stop the picture.
    const k = Math.min(dt * a.responsiveness, 1) || 0;
    const rpmIn = finite(vehicle.rpm, e.idleRpm);
    const pedalIn = vehicle.brakeInput > 0.05 ? 0 : finite(vehicle.throttleInput, 0);
    if (!Number.isFinite(this._rpm)) this._rpm = rpmIn;
    if (!Number.isFinite(this._throttle)) this._throttle = pedalIn;
    this._rpm += (rpmIn - this._rpm) * k;
    this._throttle += (pedalIn - this._throttle) * k;

    const rpm = this._rpm;
    const band = crossFade(rpm, a.blendLowRpm, a.blendHighRpm);
    const pedal = crossFade(this._throttle, 0, 1);

    const gains = {
      on_low:   pedal.high * band.low,
      on_high:  pedal.high * band.high,
      off_low:  pedal.low * band.low,
      off_high: pedal.low * band.high,
      // Only against the limiter, and only under power.
      limiter:  ratio(rpm, e.redlineRpm * 0.94, e.maxRpm) * pedal.high,
    };

    for (const [key, node] of Object.entries(this.nodes)) {
      if (!node.noPitch) {
        // detune is in cents; scale how far the engine is from the sample's
        // reference rpm.
        node.source.detune.value = finite((rpm - node.refRpm) * a.pitchPerRpm, 0);
      }
      // setTargetAtTime avoids the clicks that assigning .value directly
      // produces when a gain jumps between frames.
      node.gain.gain.setTargetAtTime(
        finite(gains[key] * node.volume, 0), this.ctx.currentTime,
        Math.max(finite(a.smoothing, 0.02), 0.001),
      );
    }
  }

  dispose() { if (this.ctx) this.ctx.close(); }
}
