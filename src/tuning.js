// Every number that decides how the car feels lives here.
//
// TUNING is a live object: the lil-gui panel mutates it in place and the
// vehicle re-reads it each physics step, so edits take effect instantly.
// Setups are persisted to localStorage so a reload doesn't lose an hour of
// feel-tuning. `dumpTuning()` prints the current setup to promote into DEFAULTS.

// Modelled on an Alpine A110 S: 1140 kg, 300 hp / 340 Nm turbo four,
// mid-engine RWD, 7-speed dual clutch, 250 km/h.
// 4.20 m long x 1.80 m wide x 1.25 m tall, 2.40 m wheelbase.
export const DEFAULTS = {
  chassis: {
    mass: 1140,          // kg
    halfWidth: 0.90,     // x -> 1.80 m wide
    // The COLLISION box is deliberately shorter and higher than the visible
    // shell: it spans roughly 0.46-1.30 m above the road, while the mesh draws
    // the real 1.25 m silhouette down to the sills. Ground clearance has to
    // exceed the suspension travel *plus* the nose-dive under braking, or the
    // front corner digs into the asphalt and the car stops as if it hit a wall.
    // There is nothing to clip into on this circuit, so the trade is free.
    halfHeight: 0.42,    // y
    halfLength: 2.10,    // z -> 4.20 m long (forward is +Z)
    colliderOffsetY: 0.10,
    comY: -0.28,         // center of mass offset below body origin. The single
                         // biggest factor in whether this corners or capsizes.
    comZ: -0.12,         // mid-engine: mass sits behind the middle (~44/56)
    inertiaScale: 1.0,   // <1 = darty, >1 = lazy in yaw
    linearDamping: 0.02,
    angularDamping: 0.35,
  },

  suspension: {
    // Short, stiff and well damped -- a sports car, not a rally raid truck.
    //
    // Static sag has a closed form: Rapier's suspension force is
    // stiffness * compression * mass, so equilibrium 4kxm = mg gives x = g/4k,
    // independent of mass. At stiffness 80 that's 31 mm, which is about right
    // for a road-going sports car (28 was 88 mm, and rode like it).
    restLength: 0.20,
    stiffness: 80.0,

    // DAMPING IS RELATIVE, not absolute. Bullet's convention, which Rapier
    // inherits, is damping = ratio * 2 * sqrt(stiffness), so the useful scale
    // moves with the spring rate. Here 2*sqrt(80) = 17.9, making these ratios
    // 0.28 compression and 0.42 rebound -- firm and settled.
    //
    // Getting this wrong is what makes a car pogo: the previous 0.82 against a
    // stiffness of 28 was a damping ratio of 0.077, essentially undamped, so
    // every bump rang like a bell.
    compression: 5.0,
    relaxation: 7.5,    // rebound damps harder than bump, as on a real damper

    // Grip scales with suspension load, and a wheel pinned against its bump
    // stop loses most of it. Cutting travel to buy ground clearance cost ~80%
    // of the braking force once already -- raise chassis.colliderOffsetY
    // instead, which is free. 0.13 still leaves ~100 mm of bump travel.
    maxTravel: 0.13,
    maxForce: 24000,
  },

  wheels: {
    radius: 0.325,       // 235/40 R18
    width: 0.24,
    trackHalf: 0.78,     // x offset of wheel from centerline
    frontZ: 1.20,        // wheelbase = frontZ + rearZ = 2.40 m
    rearZ: 1.20,
    connectionY: -0.22,  // where the suspension attaches on the chassis
    // Front grip must EXCEED rear here, not trail it.
    //
    // "Rear >= front stops it snapping loose" is true but was overdone: with
    // the mass sitting rearward (comZ) the front is already the lightly-loaded
    // axle, and giving it less grip on top of that made the car plough. At full
    // lock it was running ~2x the radius the steering asked for, with 15 deg of
    // front slip against 1 deg at the rear. More front grip restores turn-in;
    // the rearward weight bias still keeps the back end honest.
    // Scaled down together, keeping the front bias.
    //
    // At 2.55/2.25 the car pulled ~2.0 g laterally. Its rollover threshold is
    // (track/2) / comHeight = 0.78 / 0.44 = 1.77 g, so the tyres could out-grip
    // the chassis' ability to stay flat: it tipped onto two wheels, which reads
    // as the car floating and skating rather than gripping. A real A110 does
    // about 1.1 g, so these now sit safely under the roll limit.
    frictionFront: 1.55,
    frictionRear: 1.35,
    sideFrictionStiffness: 1.0,
    // Tyre grip rises less than linearly with vertical load, so the loaded
    // outside wheel gains less than the unloaded inside wheel gives up. This is
    // what makes weight transfer produce real understeer and oversteer.
    // 0 = load-independent (arcade), 0.2-0.3 is roughly road-tyre behaviour.
    loadSensitivity: 0.22,
  },

  engine: {
    // [rpm, torque Nm]. Turbo four: a flat 340 Nm plateau from 2400-6000, with
    // peak power at 6400 (340 Nm x 6400 rpm ~= 224 kW = 300 hp).
    curve: [
      [1000, 190], [1500, 265], [2000, 320], [2400, 340], [3000, 340],
      [4000, 340], [5000, 340], [6000, 340], [6400, 334], [6800, 300], [7000, 250],
    ],
    idleRpm: 850,
    redlineRpm: 6800,
    maxRpm: 7000,
    engineBrakeTorque: 40,  // Nm of drag off-throttle, gives lift-off deceleration
    revSpeed: 6.0,          // how fast rpm chases its target (1/s)
  },

  transmission: {
    // Real Alpine A110 ratios (Getrag 7DCT300). Final drive and aero.dragCoeff
    // are chosen alongside them so the car tops out around 250 km/h in 7th.
    gears: [3.615, 2.368, 1.515, 1.156, 0.926, 0.843, 0.707],
    reverse: 3.246,
    final: 4.00,
    efficiency: 0.90,
    autoUpshiftRpm: 6400,   // shift at the power peak
    autoDownshiftRpm: 2600,
    shiftTime: 0.14,        // seconds of torque cut -- a DCT is quick
    automatic: true,
  },

  brakes: {
    // Service brakes are a force in NEWTONS, applied through the wheel-force
    // path. Rapier's own brake takes a per-step impulse whose effect is
    // non-monotonic in its magnitude, so it is used only where locking is
    // wanted. See Vehicle._applyBrakes.
    // On a real car the brakes can always out-muscle the tyres -- you lock the
    // wheels, you don't run out of braking. At 12 kN on 1140 kg the pedal
    // capped out at 1.07 g, BELOW what the tyres could take, so stops were
    // force-limited and felt soft. 18 kN is comfortably past the grip limit,
    // which puts the tyres back in charge of how quickly it stops.
    // Measured: 12 kN -> 1.18 g (soft), 18 kN -> 1.73 g and a 26 m stop, which
    // is quicker than the real car manages. 14 kN sits at ~1.35 g / ~31 m.
    maxBrakeForce: 14000,
    frontBias: 0.62,
    holdBrake: 90,            // Rapier brake impulse, only to hold it at rest
    handbrake: 240,           // rear-only Rapier brake impulse: locks the rears
    handbrakeGripMult: 0.32,  // rear friction while the handbrake is pulled
  },

  steering: {
    maxAngleLow: 0.60,    // rad (~34deg) at a standstill
    maxAngleHigh: 0.16,   // rad (~9deg) at speed
    falloffSpeed: 52,     // m/s at which maxAngleHigh is reached
    rateLimit: 3.4,       // rad/s -- stops a stick flick snapping the wheels
    returnRate: 6.0,      // faster back to center than away from it
    inputExponent: 0.6,   // stick curve: x*|x|^e, finer control near center
    deadzone: 0.09,
    counterSteerAssist: 0.0,  // 0 = pure, raise for a more forgiving slide
  },

  aero: {
    // Chosen so drive force in 7th balances drag at ~69 m/s (250 km/h).
    dragCoeff: 0.49,      // F = dragCoeff * v^2, newtons
    downforce: 2.9,       // F = downforce * v^2, newtons, applied at COM
    rollingResistance: 22,
  },

  surfaces: {
    grassGripMult: 0.45,
    grassDrag: 6.0,
    edgeBlend: 0.6,       // metres of soft transition at the track edge
  },

  audio: {
    volume: 0.6,
    // Cents of pitch shift per rpm. The samples are recorded around their
    // reference rpm; 1200 cents is an octave.
    pitchPerRpm: 0.19,
    blendLowRpm: 2400,    // below this, only the "low" samples are heard
    blendHighRpm: 5200,   // above this, only the "high" ones
    responsiveness: 14,   // how fast rpm/throttle tracking follows the physics
    smoothing: 0.02,      // gain ramp time, keeps crossfades from clicking
  },

  skidmarks: {
    enabled: true,
    opacity: 0.55,
    lift: 0.015,        // metres above the road, to avoid z-fighting
    minSpeed: 2.0,      // m/s below which nothing is laid down
    slipStart: 0.10,    // rad of axle slip where marks begin (~6 deg)
    slipFull: 0.30,     // ~17 deg: fully black
    brakeStartG: 0.55,  // deceleration where the tyres start to protest
    brakeFullG: 1.05,
  },

  world: {
    gravity: -9.81,
    fixedStep: 1 / 120,
    maxStepsPerFrame: 6,
  },

  camera: {
    distance: 6.6,
    height: 2.35,
    lookAhead: 9.0,
    lookHeight: 0.85,
    stiffness: 7.5,       // spring rate of the chase cam
    fovBase: 62,
    fovGain: 20,          // extra fov at top speed
    velocityBlend: 0.35,  // how much the cam follows velocity vs. car heading
  },
};

const STORAGE_KEY = 'carsim.tuning.v1';

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Merge saved values over defaults, but only for keys that still exist.
// Keeps old saved setups usable after the defaults gain or lose a field.
function deepMerge(target, source) {
  for (const key of Object.keys(target)) {
    if (!(key in source)) continue;
    const t = target[key];
    const s = source[key];
    if (t && typeof t === 'object' && !Array.isArray(t) && s && typeof s === 'object') {
      deepMerge(t, s);
    } else if (typeof t === typeof s || (Array.isArray(t) && Array.isArray(s))) {
      target[key] = s;
    }
  }
  return target;
}

export const TUNING = deepClone(DEFAULTS);

export function loadTuning() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) deepMerge(TUNING, JSON.parse(raw));
  } catch (err) {
    console.warn('could not restore saved tuning:', err);
  }
  return TUNING;
}

export function saveTuning() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(TUNING));
  } catch (err) {
    console.warn('could not save tuning:', err);
  }
}

export function resetTuning() {
  deepMerge(TUNING, deepClone(DEFAULTS));
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* private browsing */ }
  return TUNING;
}

export function dumpTuning() {
  const json = JSON.stringify(TUNING, null, 2);
  console.log(json);
  if (navigator.clipboard) navigator.clipboard.writeText(json).catch(() => {});
  return json;
}

// Interpolate the engine torque curve. Flat beyond either end.
export function torqueAt(rpm) {
  const c = TUNING.engine.curve;
  if (rpm <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (rpm <= c[i][0]) {
      const [r0, t0] = c[i - 1];
      const [r1, t1] = c[i];
      return t0 + (t1 - t0) * ((rpm - r0) / (r1 - r0));
    }
  }
  return c[c.length - 1][1];
}
