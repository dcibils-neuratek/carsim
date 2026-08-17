// The garage.
//
// Each car is a model plus a set of TUNING overrides. The overrides are the
// car: mass, torque, grip and gearing are what you feel, and the model is what
// you look at while feeling it. Keeping them together in one file means adding
// a car is a data change, and means the four are tuned against each other
// rather than each one drifting off on its own.
//
// The spec numbers are the real cars' where the real cars have them, but they
// are TUNED FIGURES, not a simulation of those cars. What matters is that the
// four feel meaningfully different from each other and that each one suits a
// different circuit -- the Charger is a weapon on Dirt and a liability on
// Mediterranean, and that contrast is the whole point of letting you choose.

import { peakPowerHp } from './tuning.js';

export const CARS = [
  {
    id: 'alpine',
    name: 'Alpine A110',
    file: './assets/car.glb',
    tagline: 'Light, mid-engined and honest. Turns in exactly where you point it.',
    badge: 'BALANCED',
    // Shown on the card. Free text, so a car can say what it is rather than
    // being forced into a column that does not suit it.
    drive: 'Mid RWD',
    tuning: {
      // Every figure stated, none inherited.
      //
      // This car used to declare only its dimensions and take mass, torque and
      // redline from the shared defaults -- which meant its card read 1430 kg
      // and 9.0k rpm, the GT3 RS's numbers, the moment anything else touched
      // the baseline. A car that leans on the defaults is a car that reports
      // whatever was last written there. Stating the lot makes each one
      // independent of the others and of any saved setup in localStorage.
      chassis: {
        mass: 1140, comY: -0.28, comZ: -0.12, inertiaScale: 1.0,
        halfLength: 2.09, halfWidth: 0.90, halfHeight: 0.42,
      },
      suspension: { stiffness: 80, compression: 5.0, relaxation: 7.5 },
      engine: {
        peakTorque: 340,
        curve: [
          [1000, 190], [1500, 265], [2000, 320], [2400, 340], [3000, 340],
          [4000, 340], [5000, 340], [6000, 340], [6400, 334], [6800, 300],
          [7000, 250],
        ],
        redlineRpm: 6800, maxRpm: 7000,
      },
      transmission: {
        gears: [3.615, 2.368, 1.515, 1.156, 0.926, 0.843, 0.707],
        final: 4.00, autoUpshiftRpm: 6400, autoDownshiftRpm: 2600,
      },
      brakes: { maxBrakeForce: 14000, frontBias: 0.62 },
      aero: { dragCoeff: 0.49, downforce: 2.9 },
      audio: { blendLowRpm: 2400, blendHighRpm: 5200 },
      // Measured off the model, so the simulated wheels sit in the arches the
      // artist drew.
      wheels: {
        frictionFront: 1.55, frictionRear: 1.35,
        trackHalf: 0.84, frontZ: 1.19, rearZ: 1.26, radius: 0.311,
      },
    },
  },

  {
    id: 'gt3rs',
    name: 'Porsche GT3 RS',
    file: './assets/cars/2019_porsche_911_991.2_gt3_rs-optimized.glb',
    tagline: 'The same engine placement, forty years of learning to live with it. Revs to nine.',
    badge: 'TRACK',
    drive: 'Rear RWD',
    tuning: {
      // Rear-engined like the 930 and deliberately so -- the pair is the point.
      // Same basic layout, but comZ is pulled back toward the middle and the
      // springs are twice as stiff, which is exactly what forty years of
      // engineering that problem looks like. It still rotates on lift; it just
      // gives you far more warning first.
      // 4.56 x 1.90 x 1.30 m -- longer and a hand wider than the Alpine, and
      // the collider now says so instead of borrowing the Alpine's box.
      chassis: {
        mass: 1430, comY: -0.30, comZ: -0.22, inertiaScale: 0.98,
        halfLength: 2.28, halfWidth: 0.95, halfHeight: 0.44,
      },
      suspension: { stiffness: 118, compression: 7.0, relaxation: 10.0 },
      // Naturally aspirated: less torque than the turbo car and all of it
      // available, spinning to 9000. Where the 930 waits and then hits, this
      // just builds -- so peakTorque is LOWER than the 930's 430 while the car
      // is far quicker, which is the honest shape of the difference.
      // Its own torque curve, because the shared one is a turbo four: flat
      // from 2400 and finished by 6400. Run a 9000 rpm naturally aspirated
      // engine through that shape and the two headline numbers cannot both be
      // right -- 470 Nm came out as 437 hp instead of 520, because the curve
      // gave up 2600 rpm before the engine does.
      //
      // This is what a big NA flat-six actually does: builds to a peak around
      // 6250 and then HOLDS, so power keeps climbing all the way to the
      // limiter. That is why the car wants to be revved, and it is the whole
      // difference in character from a turbo motor.
      engine: {
        peakTorque: 470,
        curve: [
          [1500, 300], [2500, 375], [3500, 420], [4500, 450], [5500, 465],
          [6250, 470], [7000, 466], [7750, 455], [8250, 440], [9000, 400],
        ],
        redlineRpm: 9000, maxRpm: 9200,
      },
      // The most grip here, front and rear, and the only car with the front
      // ABOVE the rear -- a nose that actually bites, which is the thing the
      // 930 cannot do.
      // Measured off the model and trusted: this one's wheel groups come out
      // clean, all four within 10 mm, and the figures match a real 991 GT3 RS.
      // Wider track and bigger wheels than the 930 -- forty years of tyre.
      wheels: {
        frictionFront: 1.78, frictionRear: 1.70,
        trackHalf: 0.75, frontZ: 1.12, rearZ: 1.14, radius: 0.336,
      },
      transmission: {
        // 991 GT3 RS PDK. Shorter than the Alpine's throughout, which is part
        // of why it feels frantic where the Alpine feels long-legged.
        gears: [3.91, 2.29, 1.58, 1.19, 0.97, 0.82, 0.67],
        final: 3.97, autoUpshiftRpm: 8600, autoDownshiftRpm: 3600,
      },
      brakes: { maxBrakeForce: 19000 },
      // That wing is not decoration.
      aero: { dragCoeff: 0.60, downforce: 7.2 },

      // The blend points move with the engine. Crossing from the low to the
      // high recording at 2400-5200 rpm is right for a 6800 rpm four and far
      // too early for one that pulls to 9000.
      audio: { blendLowRpm: 3600, blendHighRpm: 7600 },
    },

    // Its own engine, and the reason the car sounds like a flat-six rather
    // than a pitched-up four. The reference rpms come from the recordings'
    // own configuration, not from guessing: pitch is
    // (rpm - refRpm) * pitchPerRpm, so a set labelled wrongly is out of tune
    // everywhere except at one point. These were captured at 3200 and 8000 on
    // an engine limited at 9000 -- the same redline this car runs, which is
    // why they fit it and would not fit the Alpine.
    //
    // Only four layers are stated. The limiter is inherited, because almost no
    // sample set ships one.
    sounds: {
      on_low:   { url: './assets/audio/procar/on_low.wav',   refRpm: 3200, volume: 0.55 },
      on_high:  { url: './assets/audio/procar/on_high.wav',  refRpm: 8000, volume: 0.55 },
      off_low:  { url: './assets/audio/procar/off_low.wav',  refRpm: 3400, volume: 0.50 },
      off_high: { url: './assets/audio/procar/off_high.wav', refRpm: 8430, volume: 0.50 },
    },
  },
];

export const DEFAULT_CAR = 'alpine';

/**
 * The numbers on a car's card, worked out from the car's own tuning.
 *
 * Derived rather than typed, because a hand-written spec sheet drifts the
 * moment anyone touches a number and then quietly lies. The GT3 RS card said
 * 520 hp while the simulation was making 437, and nothing in the code could
 * ever have noticed. Everything here is what the car will actually do.
 */
export function carStats(TUNING, car) {
  // The whole object, because a partial snapshot leaks: restoring only
  // chassis/engine/transmission left this car's suspension, wheels, brakes,
  // aero and audio behind on the next card.
  const saved = JSON.parse(JSON.stringify(TUNING));
  applyCarTuning(TUNING, car);
  const hp = Math.round(peakPowerHp());
  const out = {
    power: `${hp} hp`,
    torque: `${Math.round(TUNING.engine.peakTorque)} Nm`,
    weight: `${TUNING.chassis.mass} kg`,
    redline: `${(TUNING.engine.redlineRpm / 1000).toFixed(1)}k rpm`,
    drive: car.drive,
  };
  for (const [k, v] of Object.entries(saved)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(TUNING[k], v);
    else TUNING[k] = v;
  }
  return out;
}

export function getCar(id) {
  return CARS.find((c) => c.id === id) || CARS[0];
}

/**
 * Lay a car's overrides onto TUNING, in place.
 *
 * In place, because TUNING is a live object that the vehicle re-reads every
 * step and the GUI mutates as you drag -- handing back a copy would leave both
 * of those pointing at the old one. Only keys the car actually states are
 * touched, so everything it says nothing about keeps the shared default.
 */
export function applyCarTuning(TUNING, car) {
  const merge = (target, source) => {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key]) {
        merge(target[key], value);
      } else {
        target[key] = value;
      }
    }
  };
  merge(TUNING, car.tuning || {});
  return TUNING;
}
