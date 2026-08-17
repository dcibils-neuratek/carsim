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
      // 4.18 x 1.80 x 1.25 m. Stated rather than inherited even though the
      // shared defaults were written for this car, so that every car declares
      // its own size and none of them is special.
      chassis: { halfLength: 2.09, halfWidth: 0.90, halfHeight: 0.42 },
      // Measured off the model, so the simulated wheels sit in the arches the
      // artist drew.
      wheels: { trackHalf: 0.84, frontZ: 1.19, rearZ: 1.26, radius: 0.311 },
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
  const saved = JSON.parse(JSON.stringify({
    chassis: TUNING.chassis, engine: TUNING.engine, transmission: TUNING.transmission,
  }));
  applyCarTuning(TUNING, car);
  const hp = Math.round(peakPowerHp());
  const out = {
    power: `${hp} hp`,
    torque: `${Math.round(TUNING.engine.peakTorque)} Nm`,
    weight: `${TUNING.chassis.mass} kg`,
    redline: `${(TUNING.engine.redlineRpm / 1000).toFixed(1)}k rpm`,
    drive: car.drive,
  };
  Object.assign(TUNING.chassis, saved.chassis);
  Object.assign(TUNING.engine, saved.engine);
  Object.assign(TUNING.transmission, saved.transmission);
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
