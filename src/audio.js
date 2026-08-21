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

// The default engine: the BAC Mono set, a turbo-ish four that suits the
// Alpine. A car can bring its own via `sounds` in cars.js.
//
// refRpm is the rpm the sample was RECORDED at, and it matters more than it
// looks: pitch is `(rpm - refRpm) * pitchPerRpm` in cents, so a set labelled
// with the wrong reference is pitched wrong everywhere except at one point.
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
  constructor(sounds = null) {
    // A car's own engine, or the shared one. Merged per layer rather than
    // wholesale, so a car can replace the four it has recordings for and still
    // inherit the limiter, which almost no sample set ships.
    this.samples = {};
    for (const [key, def] of Object.entries(SAMPLES)) {
      this.samples[key] = sounds?.[key] ? { ...def, ...sounds[key] } : def;
    }
    this.ctx = null;
    this.nodes = {};
    this.ready = false;
    this.failed = false;
    this._muted = false;
    this._throttle = 0;
    this._rpm = 0;
    this._popFor = 0;      // seconds of crackle still owed
    this._popNext = 0;     // countdown to the next one
    this._prevPedal = 0;
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
      //
      // The exhaust gets its OWN bus rather than sharing the engine's, and it
      // has to. Both come out of the same pipe in real life, but here they are
      // balanced against each other: making room for the bangs means turning
      // the engine down, and on a shared bus that turns the bangs down by
      // exactly as much. Two things you want to trade off cannot live on one
      // fader.
      this.buses = {};
      for (const name of ['engine', 'exhaust', 'tyre', 'road', 'music']) {
        const bus = this.ctx.createGain();
        bus.gain.value = TUNING.audio[`${name}Volume`] ?? 1;
        bus.connect(this.master);
        this.buses[name] = bus;
      }

      await Promise.all(Object.entries(this.samples).map(async ([key, def]) => {
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

      // One second of white noise, shared by every pop. Each pop reads a
      // random slice of it, so they never sound like the same click repeated.
      const n = Math.floor(this.ctx.sampleRate);
      this._noise = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const data = this._noise.getChannelData(0);
      for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;

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
    for (const name of ['engine', 'exhaust', 'tyre', 'road', 'music']) {
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
        // Where the note sits, plus how fast it climbs.
        node.source.detune.value = finite(
          (a.pitchOffset ?? 0) + (rpm - node.refRpm) * a.pitchPerRpm, 0,
        );
      }
      // setTargetAtTime avoids the clicks that assigning .value directly
      // produces when a gain jumps between frames.
      node.gain.gain.setTargetAtTime(
        finite(gains[key] * node.volume, 0), this.ctx.currentTime,
        Math.max(finite(a.smoothing, 0.02), 0.001),
      );
    }

    this._updatePops(dt, rpm, pedalIn, e);
  }

  /**
   * Crackle on the overrun.
   *
   * Charged by CLOSING the throttle at rpm, not by holding it closed: a pop is
   * unburnt fuel reaching a hot pipe, and what sends it there is the sudden
   * mismatch between an engine still spinning fast and a throttle that has
   * just shut. So the burst is spent down over the following half second and
   * the car goes quiet again, rather than crackling all the way down a long
   * off-throttle section.
   *
   * How much you get scales with how far up the rev range the lift happened,
   * which is the other half of why it reads as real -- lifting at 3500 gives a
   * couple of ticks and lifting at the limiter gives a volley.
   */
  _updatePops(dt, rpm, pedal, e) {
    const x = TUNING.audio.exhaust;
    if (!x || !this._noise || !(x.pops > 0)) { this._prevPedal = pedal; return; }

    // A lift is "the throttle was recently open and is now shut", not "it was
    // open last frame and is shut this one".
    //
    // The one-frame edge is the obvious way to write this and it never fires.
    // A gamepad trigger can snap shut, but a keyboard ramps the virtual pedal
    // down at 4.5 per second -- about 0.075 a frame -- so by the time the
    // pedal is under 0.12 the previous frame's value is around 0.20, and the
    // two halves of the test are never true together. Measured in the running
    // game: a real lift from 5802 rpm fired exactly zero pops.
    //
    // A decaying peak fixes it for both. It remembers the throttle was open
    // for 400 ms, which is long enough to cover any release rate a human or a
    // ramp produces, and consuming it on use stops one lift retriggering.
    // 0.7 s of memory rather than 0.4. The keyboard takes about 220 ms to ramp
    // the pedal shut, so the window has to outlast that with room to spare --
    // and on a machine dropping frames a single step can be a quarter second,
    // which ate most of a 0.4 s window before the pedal had finished closing.
    this._pedalHigh = Math.max(pedal, (this._pedalHigh ?? 0) - dt / 0.7);
    const lifted = this._pedalHigh > 0.35 && pedal < 0.12;
    if (lifted) this._pedalHigh = 0;
    this._prevPedal = pedal;
    if (lifted && rpm > x.fromRpm) {
      const hot = ratio(rpm, x.fromRpm, e.redlineRpm);
      this._popFor = Math.max(this._popFor, x.burst * (0.35 + 0.65 * hot) * x.pops);
      this._popNext = 0;
    }

    // Back on the throttle and it stops immediately: the fuel now has
    // somewhere better to burn.
    if (pedal > 0.2 || rpm < e.idleRpm * 1.2) this._popFor = 0;
    if (this._popFor <= 0) return;

    this._popFor -= dt;
    this._popNext -= dt;
    if (this._popNext > 0) return;
    this._popNext = x.rateMin + Math.random() * (x.rateMax - x.rateMin);
    this._firePop(x, Math.min(1, this._popFor / Math.max(x.burst, 1e-3)));
  }

  /**
   * One bang: two voices, because a backfire is two sounds.
   *
   * The THUMP is the pipe ringing -- low, resonant, and what you feel. The
   * CRACK is the detonation itself -- short, high and broad, and what you
   * actually hear. Built with only the thump, this effect measured 0.42 at the
   * output and still got lost under an engine at 0.10, because all of its
   * energy sat at 250 Hz where small speakers give up.
   */
  _firePop(x, strength) {
    const t = this.ctx.currentTime;
    const voice = (loHz, hiHz, decayBase, level) => {
      const src = this.ctx.createBufferSource();
      src.buffer = this._noise;

      // Randomised so a volley is a series of different bangs. The bandpass IS
      // the exhaust here: a pipe rings at its own frequency whatever excites it.
      const band = this.ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = loHz + Math.random() * (hiHz - loHz);
      band.Q.value = 2 + Math.random() * 5;

      // Makeup gain, and without it this effect is inaudible rather than quiet.
      //
      // A bandpass fed white noise throws almost all of it away: it passes a
      // band about f0/Q wide out of the whole spectrum, so the power that
      // survives is that fraction of Nyquist and the amplitude is its square
      // root. At 250 Hz and Q 4 that is 5% of what went in. Measured through an
      // OfflineAudioContext, the pops came out at 0.0010 RMS against engine
      // samples sitting near 0.10 -- a hundred times down, which is silence.
      //
      // Derived rather than fitted to a constant, because f0 and Q are
      // randomised per pop: a fixed makeup would make every bang a different
      // loudness depending on which filter it drew. This keeps them level.
      const makeup = Math.sqrt((this.ctx.sampleRate / 2) * band.Q.value / band.frequency.value);

      // NOT scaled by x.pops, and that is the point of the parameter. It used
      // to be, which double-counted: a car with pops at 0.95 got both a longer
      // volley AND a louder bang out of one number. It also is not what
      // happens -- a rally car does not detonate HARDER than a road car, it
      // does it more often. `pops` now buys burst length only.
      const gain = this.ctx.createGain();
      const peak = x.volume * level * makeup
        * (0.45 + 0.55 * Math.random()) * (0.3 + 0.7 * strength);
      const decay = decayBase * (0.6 + 0.8 * Math.random());
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.004 + decay);

      src.connect(band).connect(gain).connect(this.buses.exhaust || this.buses.engine);
      src.start(t, Math.random() * 0.8, 0.004 + decay + 0.02);
      src.onended = () => { src.disconnect(); band.disconnect(); gain.disconnect(); };
    };

    voice(x.toneLow, x.toneHigh, x.decay, 1);
    voice(x.crackLow, x.crackHigh, x.crackDecay, x.crackMix);
  }


  dispose() { if (this.ctx) this.ctx.close(); }
}
