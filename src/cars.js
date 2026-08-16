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
    tagline: 'Light, mid-engined and honest. The one everything else is tuned against.',
    badge: 'BALANCED',
    // Shown on the card. Free text, so a car can say what it is rather than
    // being forced into a column that does not suit it.
    stats: { power: '300 hp', weight: '1140 kg', drive: 'Mid RWD' },
    tuning: {},          // the baseline: TUNING's own defaults
  },

  {
    id: 'alfa',
    name: 'Alfa Romeo GTV-6',
    file: './assets/Cars/1986_alfa_romeo_gtv-6.glb',
    tagline: 'Soft, tail-happy and eighties. Rolls onto its outside wheel and stays there.',
    badge: 'CLASSIC',
    stats: { power: '160 hp', weight: '1250 kg', drive: 'Front RWD' },
    tuning: {
      chassis: { mass: 1250, comY: -0.22, comZ: 0.10, inertiaScale: 1.15 },
      // The softest springs here, and the point of the car: it leans, and you
      // can see and feel where the load has gone.
      suspension: { stiffness: 52, compression: 3.4, relaxation: 5.0 },
      engine: { peakTorque: 210, redlineRpm: 6200, maxRpm: 6500 },
      // Shift points belong WITH the rev range, not inherited from a car
      // that revs higher. See the clamp in Vehicle._updateGearbox.
      wheels: { frictionFront: 1.20, frictionRear: 1.10 },
      transmission: { final: 3.55, autoUpshiftRpm: 5800, autoDownshiftRpm: 2300 },
      aero: { dragCoeff: 0.62, downforce: 1.1 },
    },
  },

  {
    id: 'charger',
    name: 'Dodge Charger R/T',
    file: './assets/Cars/1970_dodge_charger_rt_fast_and_furious_edition.glb',
    tagline: 'Two tonnes of torque and not enough tyre. Terrifying on tarmac, perfect on dirt.',
    badge: 'MUSCLE',
    stats: { power: '425 hp', weight: '1750 kg', drive: 'Front RWD' },
    tuning: {
      chassis: { mass: 1750, comY: -0.20, comZ: 0.16, inertiaScale: 1.45 },
      suspension: { stiffness: 58, compression: 3.8, relaxation: 5.6 },
      // Enormous torque low down, running out of breath early -- which is what
      // a big lazy V8 is, and what makes it light the rears up at any speed.
      engine: { peakTorque: 620, redlineRpm: 5400, maxRpm: 5800 },
      // Deliberately the least grip in the garage. On Dirt that is barely a
      // handicap, since the surface is the limit rather than the tyre.
      wheels: { frictionFront: 1.15, frictionRear: 1.05 },
      transmission: { final: 3.23, autoUpshiftRpm: 5000, autoDownshiftRpm: 1700 },
      brakes: { maxBrakeForce: 15000, frontBias: 0.66 },
      aero: { dragCoeff: 0.78, downforce: 0.6 },
    },
  },

  {
    id: 'ferrari',
    name: 'Ferrari 296',
    file: './assets/Cars/2026_ferrari_296_speciale_a.glb',
    tagline: 'Downforce, grip and far too much power. Wants Mediterranean and nothing else.',
    badge: 'HYPER',
    stats: { power: '830 hp', weight: '1470 kg', drive: 'Mid RWD' },
    tuning: {
      chassis: { mass: 1470, comY: -0.32, comZ: -0.14, inertiaScale: 0.92 },
      suspension: { stiffness: 105, compression: 6.2, relaxation: 9.0 },
      engine: { peakTorque: 740, redlineRpm: 8000, maxRpm: 8500 },
      wheels: { frictionFront: 1.72, frictionRear: 1.58 },
      transmission: { final: 4.20, autoUpshiftRpm: 7600, autoDownshiftRpm: 3200 },
      brakes: { maxBrakeForce: 18000 },
      // The only car here with real downforce, which is why it is the one that
      // rewards Mediterranean's long fast corners.
      aero: { dragCoeff: 0.52, downforce: 6.4 },
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
