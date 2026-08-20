// Porsche 911 GT3 RS -- the engine in the wrong place, sorted out over forty years.
//
// Data only, and every figure stated rather than inherited -- a car that leans
// on the shared defaults reports whatever was last written there. applyCarTuning()
// lays `tuning` over TUNING before the Vehicle is built, so anything in it reaches
// the simulation, wheel positions included.

export const gt3rs = {
  id: 'gt3rs',
  image: './assets/cars/porsche.png',
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
    // Taken from the model's OWN hub positions, which are the only thing
    // that can put a simulated wheel inside the arch that was drawn for it.
    //
    // These replace hand-typed figures that pulled the wheelbase in to
    // 2.26 m and the track to 1.50 -- about 10 cm short at each end, which
    // is exactly the "wheels look off" you can see from the side: too much
    // overhang in front, too much behind, wheels sitting inboard of their
    // arches. The model's hubs give 2.454 m, and a real 991 GT3 RS is
    // 2.45 -- so the mesh was accurate and the numbers over it were not.
    wheels: {
      frictionFront: 1.78, frictionRear: 1.70,
      trackHalf: 0.78, frontZ: 1.217, rearZ: 1.237, radius: 0.336,
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
    // Flat-six: three firings a revolution, so it sits a fifth BELOW where
    // the same recording would put a V12, and climbs more gently. The result
    // is the flatter, harder-edged note a 911 makes.
    audio: {
      blendLowRpm: 3600, blendHighRpm: 7600,
      pitchOffset: -260, pitchPerRpm: 0.17,
    },
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
};
