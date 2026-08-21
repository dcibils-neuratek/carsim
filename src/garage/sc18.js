// Lamborghini SC18 -- a one-off V12 with a race car's wing.
//
// Data only, and every figure stated rather than inherited -- a car that leans
// on the shared defaults reports whatever was last written there. applyCarTuning()
// lays `tuning` over TUNING before the Vehicle is built, so anything in it reaches
// the simulation, wheel positions included.

export const sc18 = {
  id: 'sc18',
  image: './assets/cars/lamborghini.png',
  name: 'Lamborghini SC18',
  file: './assets/cars/2019_lamborghini_sc18_alston-optimized.glb',
  tagline: 'A one-off 6.5 V12 with a wing off a race car. Nothing here is subtle.',
  badge: 'HYPER',
  drive: 'Mid AWD',
  tuning: {
    // 5.30 x 2.10 x 1.14 m -- the longest and by far the widest car here.
    chassis: {
      mass: 1520, comY: -0.34, comZ: -0.06, inertiaScale: 1.05,
      halfLength: 2.65, halfWidth: 1.05, halfHeight: 0.42,
    },
    suspension: { stiffness: 112, compression: 6.8, relaxation: 9.6 },
    // 720 Nm at 6750 and 770 hp at 8500 -- both real figures, and they only
    // agree if the curve keeps pulling past its torque peak. Backed out of
    // the power figure: 770 hp at 8500 rpm needs 645 Nm still on tap there,
    // so this peaks at 6750 and gives up only 10% over the next 1750 rpm.
    // That long flat top is what a big naturally aspirated V12 is for.
    engine: {
      peakTorque: 720,
      curve: [
        [1500, 430], [2500, 560], [3500, 640], [4500, 690], [5500, 712],
        [6750, 720], [7500, 700], [8500, 645], [8800, 600],
      ],
      redlineRpm: 8500, maxRpm: 8800,
    },
    // The most grip in the garage, and it is no longer standing in for a
    // drivetrain this car did not have. It used to: the simulation drove the
    // rear wheels only, the card carried an asterisk, and the grip here was
    // described as giving back what four-wheel drive would have bought.
    //
    // That story does not survive measurement. This car is power-limited, not
    // traction-limited: 0-100 comes out at 2.78 s at every drive split tried,
    // and still 2.78 s with the tyre grip halved. The rear never slips on a
    // launch, so there was never any traction for the extra grip to be
    // replacing. The number is fine -- it is a hypercar on slicks -- but it is
    // grip, not compensation.
    wheels: {
      frictionFront: 1.82, frictionRear: 1.86,
      // From the model's own hubs, per docs/car-models.md. Note they are
      // NOT symmetric about the body centre -- 1.331 front against 1.552
      // rear -- which is why typing a wheelbase and halving it does not
      // work. The mesh draws a 2.883 m wheelbase.
      trackHalf: 0.92, frontZ: 1.331, rearZ: 1.552, radius: 0.375,
    },
    transmission: {
      // 7-speed ISR, tall to suit 8500 rpm and 350 km/h.
      // Four-wheel drive for real now, and 0.3 is the RESTING split -- what
      // the layout gives when neither axle is busy. The centre differential in
      // Vehicle._driveSplit moves it from there, and a rear bias at rest is
      // what this kind of car runs in the dry.
      //
      // Measured, it costs nothing and it is honest: identical 0-100 and
      // identical corner-exit speed against driving the rear alone, because
      // the differential hands it all back to the rear the moment the front
      // tyres are busy cornering. A FIXED 0.3 would have cost 21 km/h of
      // corner exit, and a fixed 0.5 nearly 40.
      driveFront: 0.3,
      gears: [3.14, 2.21, 1.65, 1.30, 1.04, 0.85, 0.69],
      final: 3.42, autoUpshiftRpm: 8200, autoDownshiftRpm: 3400,
    },
    brakes: { maxBrakeForce: 20000, frontBias: 0.60 },
    // Drag set from the real top speed rather than typed by feel. At 0.66
    // the car ran out of breath at 276 km/h, and it did so at 4600 rpm in
    // seventh -- drag was the wall, not gearing. 0.44 puts terminal velocity
    // at the electronically capped 340 km/h (211 mph), reached up near peak
    // power where a car this geared should reach it. Set to the TOP of the
    // quoted band -- 217 mph is 349 km/h -- since that is the figure the
    // car is actually capped at.
    //
    // Downforce is raised at the same time, which is the trade the real car
    // makes: that carbon wing buys cornering speed and costs straight-line
    // speed, so this has the most downforce here AND is not the fastest
    // thing in a straight line.
    aero: { dragCoeff: 0.425, downforce: 8.6 },
    // A V12 revving to 8500 -- the procar recordings suit it far better than
    // the four-cylinder default, same as the GT3 RS.
    // V12: six firings a revolution against the flat-six's three, so its
    // note sits far higher on the same recording -- and climbs harder, which
    // is the shriek a big naturally aspirated twelve makes as it goes for
    // the limiter. 640 cents above the Porsche is a little over a fifth;
    // the full octave the physics implies is too much on one sample.
    audio: {
      blendLowRpm: 3400, blendHighRpm: 7200,
      pitchOffset: 380, pitchPerRpm: 0.24,
      // A naturally aspirated V12 does this least of anything here.
      exhaust: { pops: 0.12 },
    },
  },
  sounds: {
    on_low:   { url: './assets/audio/procar/on_low.wav',   refRpm: 3200, volume: 0.55 },
    on_high:  { url: './assets/audio/procar/on_high.wav',  refRpm: 8000, volume: 0.55 },
    off_low:  { url: './assets/audio/procar/off_low.wav',  refRpm: 3400, volume: 0.50 },
    off_high: { url: './assets/audio/procar/off_high.wav', refRpm: 8430, volume: 0.50 },
  },
};
