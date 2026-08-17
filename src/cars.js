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

export const CARS = [
  {
    id: 'alpine',
    name: 'Alpine A110',
    file: './assets/car.glb',
    tagline: 'Light, mid-engined and honest. Turns in exactly where you point it.',
    badge: 'BALANCED',
    // Shown on the card. Free text, so a car can say what it is rather than
    // being forced into a column that does not suit it.
    stats: { power: '300 hp', weight: '1140 kg', drive: 'Mid RWD' },
    tuning: {
      // Measured off the model, so the simulated wheels sit in the arches the
      // artist drew. TUNING's shared defaults are close here because they were
      // written for this car in the first place.
      wheels: { trackHalf: 0.84, frontZ: 1.19, rearZ: 1.26, radius: 0.311 },
    },
  },

  {
    id: 'porsche',
    name: 'Porsche 930 Turbo',
    file: './assets/cars/1975_porsche_911_930_turbo-optimized.glb',
    tagline: 'Engine behind the back axle and a turbo that arrives late. Respect it.',
    badge: 'WIDOWMAKER',
    stats: { power: '260 hp', weight: '1195 kg', drive: 'Rear RWD' },
    tuning: {
      // The 930's whole character is one number: the engine hangs BEHIND the
      // rear axle. comZ is strongly rearward, which loads the rear tyres under
      // power -- enormous traction out of a corner -- and takes weight off the
      // nose, so it runs wide on entry and snaps if you lift mid-corner. That
      // pendulum is the car, and it is why this one is the interesting choice
      // rather than just a second Alpine.
      chassis: { mass: 1195, comY: -0.26, comZ: -0.30, inertiaScale: 1.10 },
      suspension: { stiffness: 74, compression: 4.6, relaxation: 7.0 },
      // Turbo lag, expressed as a torque curve that does almost nothing until
      // it does everything. peakTorque is high but arrives late; below the
      // threshold the car is ordinary, and above it the rear steps out.
      engine: { peakTorque: 430, redlineRpm: 6800, maxRpm: 7000 },
      // Front grip below rear, unlike every other car here: the nose is light,
      // and understeer on entry is the honest consequence of that.
      // A 930 is a SMALL car -- 2.27 m of wheelbase against the Alpine's 2.40
      // and noticeably narrower. Stating it here is what puts the rendered
      // wheels inside the arches instead of proud of them, and it is honest
      // physics too: a shorter wheelbase is part of why the car is nervous.
      //
      // These are the real car's proportions rather than the raw measurement
      // off the mesh. The automatic probe read this model at 0.58 half-track
      // and a 1.75 m wheelbase, which is far too small for any 911 -- its
      // wheel groups survive the roundness filter as rims rather than whole
      // tyres, so the cluster centres sit inboard. Trusting that number would
      // have tucked the wheels under the car instead of fixing them.
      wheels: {
        frictionFront: 1.36, frictionRear: 1.52,
        trackHalf: 0.72, frontZ: 1.13, rearZ: 1.14, radius: 0.33,
      },
      transmission: { final: 3.32, autoUpshiftRpm: 6400, autoDownshiftRpm: 2800 },
      aero: { dragCoeff: 0.55, downforce: 1.8 },
    },
  },
  {
    id: 'gt3rs',
    name: 'Porsche GT3 RS',
    file: './assets/cars/2019_porsche_911_991.2_gt3_rs-optimized.glb',
    tagline: 'The same engine placement, forty years of learning to live with it. Revs to nine.',
    badge: 'TRACK',
    stats: { power: '520 hp', weight: '1430 kg', drive: 'Rear RWD' },
    tuning: {
      // Rear-engined like the 930 and deliberately so -- the pair is the point.
      // Same basic layout, but comZ is pulled back toward the middle and the
      // springs are twice as stiff, which is exactly what forty years of
      // engineering that problem looks like. It still rotates on lift; it just
      // gives you far more warning first.
      chassis: { mass: 1430, comY: -0.30, comZ: -0.22, inertiaScale: 0.98 },
      suspension: { stiffness: 118, compression: 7.0, relaxation: 10.0 },
      // Naturally aspirated: less torque than the turbo car and all of it
      // available, spinning to 9000. Where the 930 waits and then hits, this
      // just builds -- so peakTorque is LOWER than the 930's 430 while the car
      // is far quicker, which is the honest shape of the difference.
      engine: { peakTorque: 470, redlineRpm: 9000, maxRpm: 9200 },
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
      transmission: { final: 3.97, autoUpshiftRpm: 8600, autoDownshiftRpm: 3600 },
      brakes: { maxBrakeForce: 19000 },
      // That wing is not decoration.
      aero: { dragCoeff: 0.60, downforce: 7.2 },
    },
  },
];

export const DEFAULT_CAR = 'alpine';

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
