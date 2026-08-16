// Tyre audio: the car's warning channel.
//
// A real sim tells you about the limit through the wheel. We have no wheel, so
// this carries it instead, and it is the largest single thing missing from how
// the car reads.
//
// Sample-based, like the engine: one looping screech recording per axle,
// pitched and filtered by what the tyre is actually doing. It replaced a
// synthesised version -- white noise through a resonant bandpass -- which was
// controllable but always sounded like what it was. A recording brings the
// grain and the rubber for free.
//
// THREE signals drive it, and they do different jobs:
//
//   utilisation  climbs 0 -> 1 as the tyre loads up, and saturates there.
//                This is the WARNING, and it arrives before the limit.
//   slide        is 0 while gripping and grows once the tyre is scrubbing or
//                locked. This is the CONFIRMATION that it has gone.
//   speed        sets how fast the rubber is being dragged, so a slide at
//                30 km/h and one at 150 km/h do not sound the same.
//
// Neither of the first two works alone. Utilisation is clamped, so it pins at
// 1.0 and says nothing about how far past the limit you are. Slide stays at
// zero until you are already sideways, which is the exact problem this exists
// to fix. Together they give a sound that rises before the limit and changes
// character after it.
//
// Front and rear are separate voices at different pitches, so understeer and
// oversteer sound different. A player who can hear which end let go can
// correct the right way.

import { TUNING } from './tuning.js';

const SQUEAL_URL = './assets/audio/tyre-screeching.m4a';

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function ratio(v, start, end) { return clamp((v - start) / (end - start), 0, 1); }
function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * What the tyres should sound like right now, as plain numbers.
 *
 * Deliberately separate from the Web Audio plumbing so the mapping from grip
 * to sound can be tested without an AudioContext -- so "does the warning
 * arrive before the limit" has a measurable answer rather than one that can
 * only be argued about by ear.
 */
export function tyreMix(vehicle, roadGrip = 1) {
  const t = TUNING.audio.tyre;
  const tel = vehicle.telemetry;

  const speed = Math.abs(vehicle.speed);
  // Below walking pace a tyre does not squeal, and an airborne one certainly
  // does not. Without this the car chirps while sitting on the grid.
  const alive = speed > t.minSpeed && !vehicle.airborne ? 1 : 0;

  // How fast the rubber is being dragged. A slide at walking pace is a chirp;
  // the same slide at speed is a howl.
  const speedFrac = ratio(speed, t.minSpeed, t.speedFull);

  // Rubber squeals on rubber-gripping surfaces. Grass, gravel and deep snow
  // scrub and rumble, and a tyre howling over a verge is one of the fastest
  // ways to make a car sound fake.
  //
  // Measured against THIS track's road grip, not an absolute: Snow's asphalt
  // is 0.55, so any fixed threshold would decide the entire circuit was grass.
  // Same test the skidmarks use, so what you hear and what you see agree here
  // too -- run wide and both stop together.
  const onRoad = (a, b) => {
    const worst = Math.min(vehicle.gripMult[a], vehicle.gripMult[b]);
    return ratio(worst, roadGrip * t.surfaceCut, roadGrip * t.surfaceFull);
  };

  const axle = (util, slide, basePitch, surface) => {
    // The warning. Starts before the limit, which is the entire point: by the
    // time a tyre is audibly past it, the useful moment has gone.
    const load = ratio(util, t.squealStart, t.squealFull);

    // Working hard and actually sliding are different sounds. A tyre at the
    // limit but still gripping MURMURS; only one that has let go squeals.
    // Scaling the pre-limit component -- rather than raising the threshold --
    // is what keeps the warning while taking away the constant noise.
    const voice = Math.max(load * t.loadVolume, slide);

    return {
      load: voice,
      slide,
      // Pitch rises as the tyre loads up, then falls as it lets go. A rising
      // tone that suddenly drops reads as losing the car without anyone
      // having to be told what it means. Speed lifts it too: the contact
      // patch is being dragged faster.
      pitch: basePitch
             * lerp(1 - t.pitchRise, 1, load)
             * lerp(1, t.slideDrop, slide)
             * lerp(1, t.speedPitch, speedFrac),
      // Timbre. A loaded tyre is a muted whine; a sliding one opens up and
      // gets harsh, so the filter lets more of the recording's top end
      // through the further past the limit it is.
      brightness: lerp(t.toneLoaded, t.toneSliding, slide),
      gain: alive * surface * t.volume * voice * lerp(1, t.slideVolume, slide)
            * lerp(t.speedFloor, 1, speedFrac),
    };
  };

  // Average surface grip stands in for the surface itself: off the tarmac this
  // drops, so grass and snow read louder and duller than asphalt.
  const surface = vehicle.gripMult.reduce((s, g) => s + g, 0) / 4;
  const rough = clamp(1 - surface, 0, 1);
  const roadFrac = ratio(speed, 0, t.road.speedFull);

  // "Has it let go" comes from telemetry, which is the single definition the
  // skidmarks use too -- so what you hear and what you see are one event.
  const front = axle(tel.frontUtil, tel.frontSlide, t.pitchFront, onRoad(0, 1));
  const rear = axle(tel.rearUtil, tel.rearSlide, t.pitchRear, onRoad(2, 3));

  return {
    front,
    rear,
    slide: Math.max(front.slide, rear.slide),
    road: {
      freq: t.road.freq * lerp(1, t.road.roughDamp, rough),
      gain: alive * t.road.volume * roadFrac * (1 + rough * t.road.roughBoost)
            * LOWPASS_MAKEUP / Math.sqrt(t.road.freq * lerp(1, t.road.roughDamp, rough)),
    },
  };
}

// Road noise is still synthesised -- it is a broadband rumble, which is what
// filtered noise already is, and no recording would do it better. A lowpass
// throws away most of the noise energy, so it needs a makeup gain to reach a
// sensible level; the constant is fitted to measurement.
const LOWPASS_MAKEUP = 64.3;

/** A couple of seconds of white noise, looped. The raw material for the road. */
function makeNoiseBuffer(ctx, seconds = 2) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

export class TyreAudio {
  constructor(ctx, buses, roadGrip = 1) {
    this.ctx = ctx;
    // This track's asphalt grip, so "on the road" is judged relative to the
    // surface the circuit is actually made of.
    this.roadGrip = roadGrip;
    // Separate buses so the squeal can be balanced against the engine, and the
    // road rumble against both, from the tuning panel.
    this.tyreBus = buses?.tyre ?? null;
    this.roadBus = buses?.road ?? null;
    this.ready = false;
    this.axles = {};
    this.road = null;
    // What the mix is doing, for the debug overlay. Tuning by ear alone is
    // guesswork; seeing the squeal level next to the grip figures is how you
    // check the sound arrives WITH the loss of grip rather than after it.
    this.state = { front: 0, rear: 0, road: 0, slide: 0 };

    if (!ctx || !this.tyreBus || !this.roadBus) return;
    this._buildRoad();
  }

  /**
   * Fetch and start the squeal loop.
   *
   * Separate from the constructor and not awaited by anything: the road noise
   * and the whole rest of the game work without it, and a tyre sample that is
   * still downloading should not hold up the car.
   */
  async load() {
    if (!this.ctx || !this.tyreBus) return;
    try {
      const res = await fetch(SQUEAL_URL);
      if (!res.ok) {
        console.info(`no tyre sample at ${SQUEAL_URL} (HTTP ${res.status})`);
        return;
      }
      const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());

      for (const axle of ['front', 'rear']) {
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;

        // A lowpass rather than a bandpass: the recording already has the
        // right spectrum, so this only decides how much of its top end gets
        // through -- muted while gripping, harsh once sliding.
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = TUNING.audio.tyre.toneLoaded;
        filter.Q.value = 0.9;

        const gain = this.ctx.createGain();
        gain.gain.value = 0;

        source.connect(filter).connect(gain).connect(this.tyreBus);
        // Offset the two voices into the loop so they do not play in lockstep;
        // identical copies phase-lock and read as one louder sound rather than
        // as a front and a rear.
        source.start(0, axle === 'front' ? 0 : Math.min(0.37, buffer.duration * 0.5));

        this.axles[axle] = { source, filter, gain };
      }
      this.ready = true;
    } catch (err) {
      console.warn('tyre audio unavailable:', err);
    }
  }

  _buildRoad() {
    try {
      const ctx = this.ctx;
      const source = ctx.createBufferSource();
      source.buffer = makeNoiseBuffer(ctx);
      source.loop = true;
      source.playbackRate.value = 0.6;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 400;
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(this.roadBus);
      source.start(0.11);
      this.road = { source, filter, gain };
    } catch (err) {
      console.warn('road noise unavailable:', err);
    }
  }

  update(vehicle) {
    if (!this.road && !this.ready) return;
    const mix = tyreMix(vehicle, this.roadGrip);
    const now = this.ctx.currentTime;
    const smoothing = TUNING.audio.tyre.smoothing;

    if (this.ready) {
      for (const name of ['front', 'rear']) {
        const axle = this.axles[name];
        const m = mix[name];
        axle.gain.gain.setTargetAtTime(m.gain, now, smoothing);
        axle.filter.frequency.setTargetAtTime(m.brightness, now, smoothing);
        // playbackRate rather than detune: it drags the whole recording,
        // which is what a contact patch moving faster actually does.
        axle.source.playbackRate.setTargetAtTime(m.pitch, now, smoothing);
      }
    }
    if (this.road) {
      this.road.gain.gain.setTargetAtTime(mix.road.gain, now, smoothing);
      this.road.filter.frequency.setTargetAtTime(mix.road.freq, now, smoothing);
    }

    this.state = {
      front: mix.front.load, rear: mix.rear.load,
      road: mix.road.gain, slide: mix.slide,
    };
  }

  dispose() {
    for (const axle of Object.values(this.axles)) axle.source.stop();
    this.road?.source.stop();
    this.ready = false;
  }
}
