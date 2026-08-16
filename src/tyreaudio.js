// Tyre audio: the car's warning channel.
//
// A real sim tells you about the limit through the wheel. We have no wheel, so
// this has to carry it instead -- and it is the single largest thing missing
// from how the car reads.
//
// Synthesised rather than sampled, because a tyre squeal IS filtered noise:
// white noise through a resonant bandpass. Q is the whole trick. Narrow and
// tonal is a tyre loaded up and still gripping; broad and low is one that has
// let go. That single knob is what lets a player tell "working hard" from
// "gone" by ear, which is what the plan asks for and what a boolean
// isSliding flag can never express.
//
// TWO signals drive it, and they do different jobs:
//
//   utilisation  climbs 0 -> 1 as the tyre loads up, and saturates there.
//                This is the WARNING, and it arrives before the limit.
//   slipSpeed    is ~0 while gripping and grows once the tyre is scrubbing.
//                This is the CONFIRMATION that it has gone.
//
// Utilisation alone cannot do it: it is clamped, so it pins at 1.0 and says
// nothing about how far past the limit you are. Slip speed alone cannot do it
// either: it stays at zero until you are already sideways, which is exactly
// the problem this whole phase exists to fix. Together they give a sound that
// rises before the limit and changes character after it.
//
// Front and rear axles are separate voices at different centre frequencies, so
// understeer and oversteer sound different. A player who can hear which end
// let go can correct the right way.

import { TUNING } from './tuning.js';

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function ratio(v, start, end) { return clamp((v - start) / (end - start), 0, 1); }
function lerp(a, b, t) { return a + (b - a) * t; }

// Makeup gain for the filters, and it is not optional.
//
// A resonant bandpass throws away almost all of the noise you feed it: measured
// -20.4 dB at Q=9 / 1320 Hz, which put full squeal at 0.030 RMS against the
// engine's ~0.10. Inaudible. The first version of this file shipped without it
// and the tyres simply could not be heard.
//
// Worse, the loss depends on Q, and Q is exactly what we modulate for timbre.
// Measured: dropping Q from 9 to 2 made the output 3x LOUDER on its own, so a
// slide got most of its volume from a filter side effect rather than from
// anything deliberate.
//
// A 2-pole filter's noise bandwidth is proportional to f0/Q, so output level
// goes as sqrt(f0/Q) and sqrt(Q/f0) cancels it. With this applied, output is
// flat within 1% across Q 2..9 and f0 880..1320, which makes `volume` an
// absolute control and leaves slideVolume as the only thing deciding how loud
// a slide is. Constants are fitted to measurement, not derived.
const BANDPASS_MAKEUP = 69.6;
const LOWPASS_MAKEUP = 64.3;

function bandpassMakeup(q, freq) { return BANDPASS_MAKEUP * Math.sqrt(q / freq); }
function lowpassMakeup(freq) { return LOWPASS_MAKEUP / Math.sqrt(freq); }

/** A couple of seconds of white noise, looped. The raw material for everything here. */
function makeNoiseBuffer(ctx, seconds = 2) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * What the tyres should sound like right now, as plain numbers.
 *
 * Deliberately separate from the Web Audio plumbing so the mapping from grip
 * to sound can be tested without an AudioContext -- and so "does the warning
 * arrive before the limit" is a question with a measurable answer rather than
 * one that can only be argued about by ear.
 */
export function tyreMix(vehicle) {
  const t = TUNING.audio.tyre;
  const tel = vehicle.telemetry;

  const speed = Math.abs(vehicle.speed);
  // Below walking pace a tyre does not squeal, and an airborne one certainly
  // does not. Without this the car chirps while sitting on the grid.
  const alive = speed > t.minSpeed && !vehicle.airborne ? 1 : 0;

  // Per axle, not shared. Locking the fronts under braking while the rears
  // still grip has to sound different from losing the back end, or "which end
  // went" stops being information the player can act on.
  const axle = (util, slipSpeed, longUtil, base) => {
    // "Gone" has two forms and only one of them is a speed. Sideways scrub is
    // measurable in m/s; longitudinal loss is not (Rapier's wheels spin
    // kinematically, see telemetry.js), so a locked or spinning tyre shows up
    // as longitudinal force SATURATION instead. Take whichever is worse.
    const slide = Math.max(
      ratio(slipSpeed, t.slideStart, t.slideFull),
      ratio(longUtil, t.lockStart, t.lockFull),
    );
    // The warning, from two independent causes rather than one blended
    // number. Cornering load is the one that means "about to lose the car";
    // locking and wheelspin are a separate event with their own threshold.
    //
    // Blending them into a single combined-utilisation figure was tried and
    // made the car squeal almost constantly, because ordinary acceleration
    // spends most of a tyre's longitudinal capacity while nowhere near
    // sliding. Kept apart, each can have the threshold it actually deserves.
    const load = Math.max(
      ratio(util, t.squealStart, t.squealFull),
      ratio(longUtil, t.lockStart, t.lockFull),
    );
    // Pitch climbs as the tyre loads up, then falls as it lets go. A rising
    // tone that suddenly drops and broadens reads as losing the car without
    // anyone having to be told what it means.
    const freq = base * lerp(1 - t.freqRise, 1, load) * lerp(1, t.slideDrop, slide);
    // Timbre: narrow and tonal while gripping, broad and noisy once scrubbing.
    const q = lerp(t.qLoaded, t.qSliding, slide);
    return {
      load,
      freq,
      q,
      slide,
      // Sliding is louder than merely working hard -- and only because
      // slideVolume says so, not as a side effect of Q changing.
      gain: alive * t.volume * load * lerp(1, t.slideVolume, slide)
            * bandpassMakeup(q, freq),
    };
  };

  // Average surface grip stands in for the surface itself: off the tarmac this
  // drops, so grass and snow read louder and duller than asphalt.
  const surface = vehicle.gripMult.reduce((s, g) => s + g, 0) / 4;
  const rough = clamp(1 - surface, 0, 1);
  const speedFrac = ratio(speed, 0, t.road.speedFull);

  const longFront = Math.max(tel.wheels[0].longUtil, tel.wheels[1].longUtil);
  const longRear = Math.max(tel.wheels[2].longUtil, tel.wheels[3].longUtil);
  const front = axle(tel.frontUtil, tel.frontSlip, longFront, t.freqFront);
  const rear = axle(tel.rearUtil, tel.rearSlip, longRear, t.freqRear);

  return {
    front,
    rear,
    slide: Math.max(front.slide, rear.slide),
    road: (() => {
      const freq = t.road.freq * lerp(1, t.road.roughDamp, rough);
      return {
        freq,
        gain: alive * t.road.volume * speedFrac * (1 + rough * t.road.roughBoost)
              * lowpassMakeup(freq),
      };
    })(),
  };
}

export class TyreAudio {
  /**
   * Shares the engine's AudioContext and master gain, so muting and volume
   * stay in one place and the browser only ever has one context to unlock.
   */
  constructor(ctx, buses) {
    this.ctx = ctx;
    // Separate buses so the squeal can be balanced against the engine and the
    // road rumble against both, from the tuning panel.
    this.tyreBus = buses?.tyre ?? null;
    this.roadBus = buses?.road ?? null;
    this.ready = false;
    this.axles = {};
    this.road = null;
    // What the mix is actually doing, for the debug overlay. Tuning this by
    // ear alone is guesswork; being able to see the squeal gain while you feel
    // the car is how you find out whether the sound matches the grip.
    this.state = { front: 0, rear: 0, road: 0, slide: 0 };

    if (!ctx || !this.tyreBus || !this.roadBus) return;

    try {
      const noise = makeNoiseBuffer(ctx);

      for (const axle of ['front', 'rear']) {
        const source = ctx.createBufferSource();
        source.buffer = noise;
        source.loop = true;
        // Different playback rates decorrelate the two voices. Sharing one
        // buffer at the same rate makes them phase-lock into a single sound
        // and the front/rear distinction disappears.
        source.playbackRate.value = axle === 'front' ? 1.0 : 0.87;

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 1000;
        filter.Q.value = 8;

        const gain = ctx.createGain();
        gain.gain.value = 0;

        source.connect(filter).connect(gain).connect(this.tyreBus);
        source.start(axle === 'front' ? 0 : 0.37);   // offset, so they differ

        this.axles[axle] = { source, filter, gain };
      }

      // Road noise: a broad low rumble under everything, so the car sounds
      // like it is on a surface rather than floating over one.
      const roadSource = ctx.createBufferSource();
      roadSource.buffer = noise;
      roadSource.loop = true;
      roadSource.playbackRate.value = 0.6;
      const roadFilter = ctx.createBiquadFilter();
      roadFilter.type = 'lowpass';
      roadFilter.frequency.value = 400;
      roadFilter.Q.value = 0.7;
      const roadGain = ctx.createGain();
      roadGain.gain.value = 0;
      roadSource.connect(roadFilter).connect(roadGain).connect(this.roadBus);
      roadSource.start(0.11);
      this.road = { source: roadSource, filter: roadFilter, gain: roadGain };

      this.ready = true;
    } catch (err) {
      // Audio is a nicety; never let it stop the game.
      console.warn('tyre audio unavailable:', err);
      this.ready = false;
    }
  }

  update(vehicle) {
    if (!this.ready) return;
    const mix = tyreMix(vehicle);
    const now = this.ctx.currentTime;
    const smoothing = TUNING.audio.tyre.smoothing;

    for (const name of ['front', 'rear']) {
      const axle = this.axles[name];
      const m = mix[name];
      axle.gain.gain.setTargetAtTime(m.gain, now, smoothing);
      axle.filter.frequency.setTargetAtTime(m.freq, now, smoothing);
      axle.filter.Q.setTargetAtTime(m.q, now, smoothing);
    }
    this.road.gain.gain.setTargetAtTime(mix.road.gain, now, smoothing);
    this.road.filter.frequency.setTargetAtTime(mix.road.freq, now, smoothing);

    // `load` rather than `gain` for the overlay: gain now carries the filter
    // makeup, which is a fixed correction and says nothing about how hard the
    // tyre is working. load is the 0..1 the meter actually wants.
    this.state = {
      front: mix.front.load, rear: mix.rear.load,
      road: mix.road.gain, slide: mix.slide,
    };
  }

  dispose() {
    if (!this.ready) return;
    for (const axle of Object.values(this.axles)) axle.source.stop();
    this.road.source.stop();
    this.ready = false;
  }
}
