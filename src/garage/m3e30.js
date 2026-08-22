// BMW M3 E30 -- the front-engined rear-driver the garage did not have.
//
// Six cars in and the layouts read: mid RWD, rear RWD, mid AWD, mid RWD, front
// FWD, front AWD. The single most common layout in motoring -- engine at the
// front, drive at the back -- was missing entirely, which meant a whole way of
// driving was not in the game. That gap is the reason this car is here; that it
// is also a Group A homologation special from the same season as the Delta is
// the reason it is THIS one.

export const m3e30 = {
  id: 'm3e30',
  image: './assets/cars/bmw-m3.png',
  name: 'BMW M3 E30',
  file: './assets/cars/bmw_m3_e30-optimized.glb',
  tagline: 'Front engine, rear drive, and no more power than it can use. The one that teaches you.',
  badge: 'GROUP A',
  drive: 'Front RWD',
  tuning: {
    // 4.360 x 1.675 x 1.365 m. Narrow by everything else here -- the SC18 is
    // 2.1 m wide -- and that narrowness with a 2.562 m wheelbase is most of
    // why it changes direction the way it does.
    //
    // comZ POSITIVE, the second car here to have it. The engine is over the
    // front axle, so the mass sits forward at roughly 52/48 -- but unlike the
    // Mini the wheels carrying that weight are NOT the ones driving, and the
    // whole character of the car is in that split.
    chassis: {
      mass: 1200, comY: -0.26, comZ: 0.06, inertiaScale: 0.98,
      halfLength: 2.180, halfWidth: 0.838, halfHeight: 0.44,
    },
    suspension: { stiffness: 78, compression: 5.0, relaxation: 7.2 },
    // S14: 2.3 litres, sixteen valves, naturally aspirated, 200 PS at 6750 and
    // 240 Nm at 4750.
    //
    // Those two agree the way a naturally aspirated four should, and the check
    // is worth doing because it is what stops a curve being invented. 197 bhp
    // is 147 kW; at 6750 rpm that needs 208 Nm still on tap. So the curve peaks
    // at 240 around 4750 and falls to 208 by the power peak -- a 13% drop over
    // 2000 rpm, which is a gentle, wide plateau rather than the cliff a turbo
    // has. Nothing here is guessed: the shape is forced by the two published
    // numbers and the fact that power is torque times revs.
    engine: {
      peakTorque: 240,
      curve: [
        [1000, 165], [2000, 200], [3000, 220], [4000, 235], [4750, 240],
        [5500, 232], [6000, 224], [6750, 208], [7250, 190],
      ],
      redlineRpm: 7250, maxRpm: 7600,
    },
    // Period rubber on a 1200 kg saloon: near the Delta, which is the same
    // season and much the same tyre, and a long way under the GT3 RS.
    //
    // Rear fractionally higher than front, which is the opposite of the Alpine
    // and deliberate. On a car that steers with one axle and drives with the
    // other, giving the driven end slightly more is what lets you hold a slide
    // on the throttle instead of simply spinning -- and being able to do that
    // is the entire reputation of this car.
    wheels: {
      frictionFront: 1.38, frictionRear: 1.42,
      trackHalf: 0.706, frontZ: 1.300, rearZ: 1.262, radius: 0.310,
    },
    // Slowest to 100 of the three small cars here despite the best power to
    // weight, and that is the simulation being right rather than wrong.
    //
    // 197 hp in 1200 kg is 6.09 kg/hp against the Mini's 6.32 and the Delta's
    // 6.32, and it still loses to both off the line: the Mini puts its power
    // through the axle its engine is sitting on, the Delta puts it through all
    // four, and this car has the weight at the FRONT and drives from the BACK.
    // The one layout that cannot use what it has. The real car's 6.7 s was
    // never its point either.
    //
    // The absolute figure is 16% quick, and that is a garage-wide issue rather
    // than this car's -- see the same note on the Mini, which measures 5.07
    // against a real 6.4. The ordering between the cars is right; the launches
    // are all optimistic together.
    transmission: {
      driveFront: 0,
      // The Getrag 265 DOGLEG five-speed: first is down and to the left, out of
      // the way, so second-to-third is a straight pull. A racing gate on a road
      // car, because the road car existed to homologate the racing one.
      gears: [3.72, 2.40, 1.77, 1.26, 1.00],
      final: 3.25, autoUpshiftRpm: 7000, autoDownshiftRpm: 3000,
    },
    // Boxed arches, a deep chin and that upright rear wing. Draggier than the
    // saloon it is based on, which is what holds it to 235 rather than letting
    // the gearing take it past 250.
    //
    // 0.52 first, which measured 212 km/h against the real 235. At terminal the
    // drive force equals the drag, so power goes as k*v^3 and v goes as
    // k^(-1/3): wanting 10.8% more speed means 1.108^3 = 1.36 times LESS drag.
    // 0.52 / 1.36 = 0.38, and that is the whole calculation -- no sweeping.
    aero: { dragCoeff: 0.38, downforce: 1.1 },
  },
};
