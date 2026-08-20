// Alpine A110 -- the light one, and the baseline the others are read against.
//
// Data only, and every figure stated rather than inherited -- a car that leans
// on the shared defaults reports whatever was last written there. applyCarTuning()
// lays `tuning` over TUNING before the Vehicle is built, so anything in it reaches
// the simulation, wheel positions included.

export const alpine = {
  id: 'alpine',
  image: './assets/cars/alpine.png',
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
    // From the model's own hubs, like the GT3 RS. Its wheelbase measures
    // 2.421 m against the real A110's 2.42, so the mesh is trustworthy and
    // the hand-typed 0.84 half-track was simply 6 cm too wide -- enough to
    // stand the wheels outside their arches.
    //
    // trackHalf is one number for a car whose front and rear tracks differ
    // (0.789 and 0.757 here, as on the real thing), so it is the mean. The
    // 3 cm either way is invisible; a whole-car error was not.
    wheels: {
      frictionFront: 1.55, frictionRear: 1.35,
      trackHalf: 0.773, frontZ: 1.18, rearZ: 1.241, radius: 0.311,
    },
  },
};
