// Lancia Delta HF Integrale Evo 2 -- the homologation special, and the only
// permanently four-wheel-driven car here.
//
// Data only, and every figure stated rather than inherited -- a car that leans
// on the shared defaults reports whatever was last written there. applyCarTuning()
// lays `tuning` over TUNING before the Vehicle is built, so anything in it reaches
// the simulation, wheel positions included.

export const delta = {
  id: 'delta',
  image: './assets/cars/lancia.png',
  name: 'Lancia Delta Integrale',
  file: './assets/cars/free_lancia_delta_hf_integrale_evo_2-optimized.glb',
  tagline: 'Built to be homologated, not to be sensible. Four driven wheels and a turbo.',
  badge: 'RALLY',
  drive: 'Front AWD',
  tuning: {
    // 3.90 x 1.70 x 1.37 m -- shorter than everything but the MINI, and the
    // model measures its 2.480 m wheelbase exactly.
    //
    // comZ positive, like the MINI and unlike the rest: a transverse four over
    // the front axle leaves it nose-heavy even with drive going rearward.
    chassis: {
      mass: 1340, comY: -0.24, comZ: 0.12, inertiaScale: 0.97,
      halfLength: 1.95, halfWidth: 0.85, halfHeight: 0.45,
    },
    suspension: { stiffness: 88, compression: 5.8, relaxation: 8.2 },
    // Garrett-blown 2.0 four: 314 Nm at 2500 and 212 bhp at 5750.
    //
    // The shape is the opposite of the naturally aspirated cars here. Peak
    // torque arrives at 2500 rpm -- lower than anything else in the garage --
    // and then the curve does nothing but fall for the next 4000 rpm. Backed
    // out of the power figure, 158 kW at 5750 rpm needs 262 Nm still there,
    // which is only 83% of peak. A turbo four is finished early and spends the
    // top of the rev range holding on.
    //
    // That is what makes it feel quick out of a slow corner and unremarkable
    // at the top of third, and it is the whole character of the engine.
    engine: {
      peakTorque: 314,
      curve: [
        [1500, 200], [2000, 280], [2500, 314], [3000, 312], [3500, 305],
        [4000, 296], [4500, 288], [5000, 278], [5750, 262], [6500, 222],
        [6800, 200],
      ],
      redlineRpm: 6800, maxRpm: 7000,
    },
    // Period road tyres on a 1992 hatchback: near the bottom of the garage,
    // and close to level front to rear because four driven wheels want grip at
    // both ends. The rear is the higher of the two, which is what stops a
    // nose-heavy four-wheel-drive car simply washing out.
    wheels: {
      frictionFront: 1.40, frictionRear: 1.44,
      // The model's own hubs, per docs/car-models.md. They measure a 2.459 m
      // wheelbase against the real car's 2.480, and the wheel itself comes out
      // 0.590 m across -- a 0.295 m radius, which is a 205/45 R16 to the
      // millimetre.
      //
      // The overhangs come out 803 mm front against 638 rear, which is a Delta
      // and is also the check that it faces the right way: reversed they would
      // read the other way round, and no modelYaw is needed here.
      trackHalf: 0.700, frontZ: 1.147, rearZ: 1.312, radius: 0.295,
    },
    transmission: {
      // PERMANENT four-wheel drive with a Torsen centre differential, which is
      // exactly what Vehicle._driveSplit models. 0.47 is the resting split the
      // real car runs -- 47 front, 53 rear -- and the differential moves it
      // from there toward whichever axle has grip to spare.
      //
      // This is the car the centre differential was built for. A fixed 0.47
      // would cost it most of its corner exit; the diff hands the torque back
      // to the rear the moment the front tyres are busy steering.
      driveFront: 0.47,
      // Five speeds, one fewer than anything else here.
      gears: [3.50, 2.18, 1.55, 1.17, 0.92],
      final: 3.11, autoUpshiftRpm: 6500, autoDownshiftRpm: 2700,
    },
    brakes: { maxBrakeForce: 16000, frontBias: 0.64 },
    // Solved from the real 220 km/h rather than typed: at terminal, fifth is
    // turning about 5660 rpm and the drag that balances what the engine makes
    // there is 0.610.
    //
    // The coefficient lands high, and it should. This is 0.5 * rho * Cd * A,
    // so it carries frontal area as well as slipperiness, and the Delta is a
    // tall square hatchback wearing a wing -- both terms are against it. It is
    // the least aerodynamic thing in the garage by a distance, which is also
    // why 212 bhp only buys 220 km/h.
    aero: { dragCoeff: 0.61, downforce: 1.4 },
    // A turbocharged four, so it keeps the default four-cylinder recordings
    // rather than the procar V12 set. Blend points suit an engine finished at
    // 6800.
    // A Garrett turbo, a hot rally manifold and a homologation exhaust.
    // This is the car the effect exists for.
    audio: {
      blendLowRpm: 2300, blendHighRpm: 5600,
      exhaust: { pops: 0.95 },
    },
  },
};
