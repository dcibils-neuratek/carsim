// MINI Cooper S (2024 facelift) -- the only front-driven car here.
//
// Data only, and every figure stated rather than inherited -- a car that leans
// on the shared defaults reports whatever was last written there. applyCarTuning()
// lays `tuning` over TUNING before the Vehicle is built, so anything in it reaches
// the simulation, wheel positions included.

export const mini = {
  id: 'mini',
  image: './assets/cars/minicooper.png',
  name: 'MINI Cooper S',
  file: './assets/cars/mini_cooper_s_facelift-optimized.glb',
  tagline: 'Front-driven and short. Pulls itself out of a corner instead of pushing.',
  badge: 'HOT HATCH',
  drive: 'Front FWD',
  // The model arrives in black. British racing green is the point of this car,
  // and the material has to be named because guessing at "body" or "base"
  // would repaint the rims -- their material is called Koleso_mat_Base.
  paint: { match: 'kuzov', color: 0x0a4d2e },
  // Authored nose-first along the axis the loader lines up to point backwards.
  // Scale and axis are both measurable from the bounding box; which END is the
  // front is not, and this one arrived facing the camera.
  modelYaw: Math.PI,
  tuning: {
    // 3.876 x 1.744 x 1.414 m: the shortest car here and the tallest, which is
    // most of why it feels like a different kind of thing to drive.
    //
    // comZ is POSITIVE, and it is the only one that is. Everything else here
    // carries its engine amidships or behind the rear axle; this one has a
    // transverse four over the front wheels, so the weight sits forward. That
    // single sign is what puts the load on the tyres that are also doing the
    // driving.
    chassis: {
      mass: 1276, comY: -0.22, comZ: 0.14, inertiaScale: 0.95,
      halfLength: 1.938, halfWidth: 0.872, halfHeight: 0.46,
    },
    suspension: { stiffness: 92, compression: 5.6, relaxation: 8.0 },
    // BMW B48, 2.0 turbo four. The UK figures, which describe the shape rather
    // than just its peaks: 300 Nm held flat from 1450 all the way to 4500, and
    // 201 bhp held flat from 5000 to 6500.
    //
    // Those two plateaus are the whole character and they constrain each other.
    // Holding 150 kW from 5000 to 6500 means the torque MUST fall through that
    // stretch, and by exactly the right amount -- 287 Nm at 5000 down to 221 at
    // 6500 -- or the power curve is not flat, it is a peak. A turbo four is
    // shaped nothing like the naturally aspirated engines here: it is all done
    // by 4500 and then just holds on.
    engine: {
      peakTorque: 300,
      curve: [
        [1000, 220], [1450, 300], [2500, 300], [3500, 300], [4500, 300],
        [5000, 287], [5500, 261], [6000, 239], [6500, 221], [6750, 205],
      ],
      redlineRpm: 6750, maxRpm: 7000,
    },
    // Road tyres on a heavy-nosed hatch: still the least grip in the garage,
    // where a hot hatch belongs, but by much less than it first was.
    //
    // It started at 1.30/1.20 and read as a car sliding around among cars that
    // were glued down -- braking into a corner it simply would not turn.
    // Measured against the Alpine in the same brake-and-steer manoeuvre it
    // pulled 1.21 g laterally against 1.51 and rotated 36% slower.
    //
    // Brake bias, centre of mass and yaw inertia were all suspected first and
    // all three are innocent: swept across their whole plausible range they
    // move the rotation by under 2%. Grip is the only term that does anything.
    //
    // Worth knowing WHY the number had to move, because the fault is not
    // really this car's. Real skidpad figures run about 0.90 g for a Cooper S
    // against 0.98 for an F1 and 1.1 for a GT3 RS -- a 22% spread. This garage
    // was running 1.20 to 1.86, a 55% spread, so the simulation was
    // exaggerating the gap by about two and a half times and this car sat at
    // the bottom of it. 1.45/1.34 brings it back to roughly 12% off the F1,
    // which is near the real gap.
    //
    // It still does not rotate like the A110 and it should not: 136 kg more,
    // the weight over the nose, and the tyres that steer are also the ones
    // driving. That part is a Mini, not a mistake.
    //
    // NOT YET CHECKED AGAINST THE REAL CAR'S 6.4 s TO 60. One run measured
    // 0-100 in 5.2 s, which is well quick, and the obvious suspect is that two
    // front tyres also doing the steering should be running out of grip on the
    // launch. It could not be confirmed: the machine it was measured on fell to
    // a few frames a second, and a fixed-timestep sim read through a stalled
    // renderer reports whatever it likes. Worth re-running on a machine that
    // holds frame rate before anyone concludes anything from it.
    //
    // The front is the higher of the two on purpose: it has to steer and drive
    // at once, and levelling them made the car plough wide of everything.
    wheels: {
      frictionFront: 1.45, frictionRear: 1.34,
      // The model's own hubs, per docs/car-models.md, read AFTER the yaw flip
      // above -- turning the car around swaps which pair is the front one, and
      // taking them before it puts every wheel on the wrong axle.
      //
      // They measure a 2.489 m wheelbase against the real car's 2.495, and the
      // overhangs come out 769 mm front against 618 rear. That asymmetry is
      // the check that the flip went the right way: a Mini really does carry
      // more nose than tail, and had it been backwards the numbers would have
      // read the other way round.
      trackHalf: 0.739, frontZ: 1.169, rearZ: 1.320, radius: 0.308,
    },
    transmission: {
      // FRONT WHEEL DRIVE, and the reason driveFront exists at all. A Mini
      // simulated as rear-drive is not a compromise, it is the opposite car.
      driveFront: 1,
      // The real Getrag GS6-59BG six-speed, with its tall overdrive fifth and
      // sixth. Six gears, like the F1, against the seven everything else runs.
      gears: [3.62, 1.95, 1.24, 0.97, 0.81, 0.68],
      final: 3.42, autoUpshiftRpm: 6500, autoDownshiftRpm: 2700,
    },
    // Front bias further forward than anything else here, because the weight
    // is already there before you touch the pedal.
    brakes: { maxBrakeForce: 15500, frontBias: 0.68 },
    // Solved from the real 242 km/h the same way the F1's was: sixth is only
    // turning 4845 rpm there, still on the torque plateau at 291 Nm, which is
    // 1977 N at the contact patch, and the drag that balances it is 0.433.
    // Worth noting it lands close to the paper figure -- 0.5 * rho * Cd * A on
    // a 0.33 Cd over about 2.05 m^2 is 0.414 -- which the F1's did not.
    //
    // Downforce is the lowest here and should be: it is a hatchback.
    aero: { dragCoeff: 0.433, downforce: 1.0 },
    // A four, so it keeps the default four-cylinder recordings rather than the
    // procar V12 set the Porsche and the Lamborghini borrow. The blend points
    // move down to suit an engine that is finished at 6750.
    // Turbocharged, and a modern hot hatch is TUNED to crackle -- it is half
    // of what the sports exhaust is sold on.
    audio: {
      blendLowRpm: 2200, blendHighRpm: 5400,
      exhaust: { pops: 0.55 },
    },
  },
};
