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
    tuning: {},          // the baseline: TUNING's own defaults
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
      wheels: { frictionFront: 1.36, frictionRear: 1.52 },
      transmission: { final: 3.32, autoUpshiftRpm: 6400, autoDownshiftRpm: 2800 },
      aero: { dragCoeff: 0.55, downforce: 1.8 },
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
