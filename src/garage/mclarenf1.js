// McLaren F1 -- a 6.1 V12, a centre seat, and no assistance of any kind.
//
// Data only, and every figure stated rather than inherited -- a car that leans
// on the shared defaults reports whatever was last written there. applyCarTuning()
// lays `tuning` over TUNING before the Vehicle is built, so anything in it reaches
// the simulation, wheel positions included.

export const mclarenf1 = {
  id: 'mclarenf1',
  name: 'McLaren F1',
  file: './assets/cars/mclaren_f1-optimized.glb',
  tagline: 'A 6.1 V12 behind a centre seat and no help of any kind. Still the benchmark.',
  badge: 'ICON',
  drive: 'Mid RWD',
  tuning: {
    // 4.287 x 1.820 x 1.140 m -- shorter than the Alpine and lower than
    // anything else here. halfHeight is the collider slab rather than the
    // roof, scaled from the Alpine's by the ratio of the real heights.
    chassis: {
      mass: 1140, comY: -0.30, comZ: -0.16, inertiaScale: 0.96,
      halfLength: 2.14, halfWidth: 0.91, halfHeight: 0.38,
    },
    suspension: { stiffness: 95, compression: 6.0, relaxation: 8.4 },
    // 650 Nm at 5600 and 618 hp at 7400 -- both real, and like the SC18 they
    // only agree if the curve keeps pulling well past the torque peak.
    // Backed out of the power figure: 461 kW at 7400 rpm needs 595 Nm still
    // there, so this gives up 8.5% over the 1800 rpm above its peak. The
    // shape then has to fall away again by 7500 or peak power lands at the
    // limiter instead of where BMW put it.
    //
    // DELIBERATELY FATTER THAN THE REAL CURVE BELOW 4000, and this is a
    // choice, not an oversight -- do not "correct" it against a dyno plot.
    // The published S70/2 curve was fitted here and then rejected: read off
    // it, the real engine makes 393 Nm at 2000 rpm and 504 at 3000, against
    // 520 and 580 below. That is 127 Nm missing at 2000, and what it costs
    // is the shove out of a slow corner, which is where the car is being
    // driven from rather than admired.
    //
    // Above 4000 the two agree inside 10 Nm, so the top end, the peak power
    // figure and the gearing are all still the real car's. Only the part you
    // feel with the throttle open at low revs is ours.
    engine: {
      peakTorque: 650,
      curve: [
        [1000, 430], [2000, 520], [3000, 580], [4000, 620], [5000, 643],
        [5600, 650], [6200, 640], [6800, 620], [7400, 595], [7500, 583],
      ],
      redlineRpm: 7500, maxRpm: 7700,
    },
    // Period tyres, and narrower at the front than the rear by 80 mm -- so
    // less grip than the modern cars here and biased to the back, which is
    // the half of the F1's reputation that is not about speed.
    wheels: {
      frictionFront: 1.62, frictionRear: 1.70,
      // The model's own hubs, per docs/car-models.md. They measure a 2.709 m
      // wheelbase against the real F1's 2.718, so the mesh is trustworthy.
      // Front track is wider than rear here exactly as on the real car
      // (1.622 against 1.549 measured, 1.568 against 1.472 quoted), and
      // trackHalf is the mean of the two.
      //
      // Note how far back the wheelbase sits in the body -- 1.166 forward
      // against 1.543 back -- which is the F1's long tail, and the reason
      // typing a wheelbase and halving it puts every wheel in the wrong
      // place.
      trackHalf: 0.79, frontZ: 1.166, rearZ: 1.543, radius: 0.344,
    },
    transmission: {
      // The real six-speed Weismann transaxle, and the only six here. Very
      // tall: 0.93 on a 2.37 final is 53 km/h per 1000 rpm in sixth.
      gears: [3.23, 2.19, 1.71, 1.39, 1.16, 0.93],
      final: 2.37, autoUpshiftRpm: 7300, autoDownshiftRpm: 3000,
    },
    // No servo and no ABS on the real car. Strong, but it is stopping the
    // lightest thing in the garage.
    brakes: { maxBrakeForce: 16000, frontBias: 0.62 },
    // The slipperiest car here and the one with the least downforce -- no
    // wing at all, which is exactly why it went as fast as it did in a
    // straight line and why it is busier than the SC18 in a corner.
    //
    // dragCoeff is NOT the car's Cd, which trips everyone including me: the
    // model is F = dragCoeff * v^2 in newtons, so this is 0.5 * rho * Cd * A
    // and carries the frontal area with it. The F1's real 0.32 over about
    // 1.76 m^2 lands near 0.35 on paper.
    //
    // Solved rather than typed, the same way the SC18's was: at 386 km/h
    // (240 mph) sixth gear is turning 6560 rpm, which is 628 Nm and 3621 N
    // at the contact patch, and the drag that balances it is 0.313. The car
    // is therefore drag-limited a little under its geared maximum, which is
    // what the real one is too. Solved against the curve above, so the two
    // move together -- change one and this needs re-solving.
    aero: { dragCoeff: 0.313, downforce: 1.8 },
    // A V12, so the procar recordings again rather than the four-cylinder
    // default -- but one that stops at 7500 where the SC18 runs to 8500, so
    // it crosses over lower and sits a little under it.
    audio: {
      blendLowRpm: 3000, blendHighRpm: 6400,
      pitchOffset: 330, pitchPerRpm: 0.22,
      // Naturally aspirated, and a 1993 road car besides.
      exhaust: { pops: 0.1 },
    },
  },
  sounds: {
    on_low:   { url: './assets/audio/procar/on_low.wav',   refRpm: 3200, volume: 0.55 },
    on_high:  { url: './assets/audio/procar/on_high.wav',  refRpm: 8000, volume: 0.55 },
    off_low:  { url: './assets/audio/procar/off_low.wav',  refRpm: 3400, volume: 0.50 },
    off_high: { url: './assets/audio/procar/off_high.wav', refRpm: 8430, volume: 0.50 },
  },
};
