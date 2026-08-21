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
    // How strong the engine is. The curve below is only a SHAPE: torqueAt()
    // normalises it so its peak is exactly peakTorque, which makes this one
    // number the whole engine's output and something a slider can drive.
    peakTorque: 340,      // Nm

    // [rpm, torque Nm]. Turbo four: a flat 340 Nm plateau from 2400-6000, with
    // peak power at 6400 (340 Nm x 6400 rpm ~= 224 kW = 300 hp). Absolute
    // values here no longer matter -- only the shape does.
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

    // Kickdown. autoDownshiftRpm above is an ANTI-BOG rule -- it drops a gear
    // when the engine is about to fall on its face -- and on its own it leaves
    // the car a gear or two too tall out of every corner, because 2600 rpm in
    // fourth is somewhere around 60 km/h and no corner is that slow. Measured
    // out of a 88 km/h corner at full throttle, the car sat in fourth the whole
    // way and took 3.8 s to 120 km/h; the third gear it refused to select did
    // it in 3.1.
    //
    // The old rule also carried `drive < 0.9`, so flooring the throttle was the
    // one condition under which it was FORBIDDEN to drop a gear -- backwards
    // from every automatic ever built, where the pedal on the floor is the
    // kickdown signal. Both rules are kept, split by the pedal: lift and it
    // avoids bogging, floor it and it goes looking for a gear.
    // Which axle the power goes to: 0 is rear, 1 is front, 0.5 is an even
    // four-wheel-drive split. It was rear-wheel drive and nothing else until a
    // front-drive car needed adding, and a front-drive car simulated as
    // rear-drive is not a compromise, it is the opposite car -- a Mini is
    // famous for pulling itself out of a corner and running wide when you ask
    // for too much, and driving the rear turns that into oversteer.
    //
    // Nothing else has to change for it to behave: grip is already solved per
    // wheel and the steering is already on the front pair, so power understeer
    // falls out of the friction circle on its own. The handbrake still cuts
    // REAR drive, which on a front-driven car is nothing to cut -- also
    // correct, since locking the undriven rear axle is exactly how you rotate
    // one of these.
    driveFront: 0,

    kickdownThrottle: 0.85, // pedal past this asks for a gear, not just torque
    // How close to the upshift point a kickdown is allowed to land. Without a
    // margin the gearbox drops a gear, immediately passes its own upshift point
    // and shifts straight back -- one hunt per corner, audible and slower than
    // doing nothing.
    kickdownHeadroom: 0.92,

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
    // Below this, a braked car is pinned outright rather than being pushed
    // around by forces it cannot win against. 0.4 m/s is 1.4 km/h -- slow
    // enough that being snapped to a stop is invisible, fast enough that the
    // hold catches the car before it can start rolling. See _applyHillHold.
    holdSpeed: 0.4,           // m/s
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
    // Per-source levels, each its own GainNode. One master volume could only
    // ever turn everything down together, which is useless when the thing you
    // want is the tyres over the engine.
    volume: 0.6,        // master
    // Down from 1.0 to make room for the exhaust. The bangs are the event you
    // want to hear on a lift, and the engine is what is masking them -- the
    // 2 dB it gives up buys the pops 2 dB of relative level, which the ear
    // notices far more than the amplitude it frees.
    engineVolume: 0.8,
    // Its own fader, and its own bus. See audio.js: sharing the engine's would
    // make this trade impossible.
    exhaustVolume: 1.0,
    tyreVolume: 1.0,
    roadVolume: 1.0,
    musicVolume: 0.6,   // reserved: the bus exists, nothing feeds it yet
    // Cents of pitch shift per rpm. The samples are recorded around their
    // reference rpm; 1200 cents is an octave.
    pitchPerRpm: 0.19,
    // A constant shift in cents, on top of the per-rpm slope.
    //
    // The slope alone cannot voice one engine against another, because it only
    // says how fast the note CLIMBS. What separates a V12 from a flat-six is
    // where the note sits: a V12 fires six times a revolution against a
    // flat-six's three, so at the same rpm its note is an octave -- 1200 cents
    // -- higher. With both cars sharing one recording, this is the only lever
    // that can put them in different registers at all.
    pitchOffset: 0,
    blendLowRpm: 2400,    // below this, only the "low" samples are heard
    blendHighRpm: 5200,   // above this, only the "high" ones
    responsiveness: 14,   // how fast rpm/throttle tracking follows the physics
    smoothing: 0.02,      // gain ramp time, keeps crossfades from clicking

    // Overrun pops, and the reason they are an EVENT rather than a filter.
    //
    // The engine's note is a recording, and a recording already contains the
    // exhaust it came out of. What a crossfade between an on-throttle and an
    // off-throttle loop cannot produce is the crackle on a lift, because that
    // is not the engine making a different noise -- it is a separate
    // combustion happening somewhere else. Fuel that did not burn in the
    // cylinder reaches a hot exhaust and goes off in the PIPE.
    //
    // Which is why the trigger is what it is: the throttle closing, at rpm,
    // with the engine on overrun. And why the amount belongs to the car rather
    // than to the game. A turbocharged rally car with a hot manifold does it
    // constantly; a naturally aspirated V12 barely does it at all. Each car
    // states its own `pops`.
    exhaust: {
      pops: 0.25,       // 0 silent, 1 rally car. Overridden per car.
      fromRpm: 3500,    // a lift below this is just a lift
      burst: 0.55,      // seconds of crackle a full-rev lift buys
      // Spaced further apart than they were, and that is what buys the volume
      // below. With a 0.22 s thump and a 35 ms gap, three bangs could be
      // ringing at once and their peaks summed -- so the level had to be held
      // down for a worst case that sounded like one loud bang rather than a
      // volley. Wider gaps mean each one stands alone and can be louder.
      rateMin: 0.06,    // gap between pops, seconds
      rateMax: 0.17,
      toneLow: 110,     // bandpass centre, Hz -- the pipe's voice
      toneHigh: 420,

      // The CRACK, and the reason the bang was inaudible rather than quiet.
      //
      // A backfire is two sounds. The detonation itself is a sharp broadband
      // crack; the pipe it happens in rings low underneath it. The low ring
      // was all this had, and a 250 Hz burst is the part of the spectrum a
      // laptop speaker reproduces worst -- so a pop measuring 0.42 at the
      // output could be lost under an engine measuring 0.10.
      //
      // The crack is short and high and does the cutting through. It is the
      // half you hear; the thump is the half you feel.
      crackLow: 1200,   // Hz
      crackHigh: 3600,
      crackDecay: 0.035,
      crackMix: 0.7,    // relative to the thump
      // Both raised after listening. A pop peaked at 0.59 against engine
      // samples at 0.10, and still read as quiet -- because a peak is not
      // loudness when the sound is 100 ms long. Its RMS was 0.016, a sixth of
      // the engine's, so the ear had almost nothing to hold on to.
      //
      // decay does more here than volume: lengthening the bang puts energy
      // under the peak instead of just making the spike taller, which is what
      // turns a click into a bang.
      // decay does more than volume here: lengthening the bang puts energy
      // under the peak instead of making the spike taller, which is what turns
      // a click into a bang. It went from 0.12 to 0.17 for that reason.
      //
      // volume is capped by headroom rather than by taste. One bang measures
      // about 0.42 at the output; two overlapping make 0.67, and the engine on
      // the overrun has to fit under 1.0 alongside them.
      decay: 0.22,      // how long the low thump takes to die
      // Set against the ceiling, from levels measured in the running game
      // rather than assumed -- and the assumption was wrong twice.
      //
      // The engine was taken to drop away on the overrun. It does not: metered
      // on its own bus it goes 0.588 under power to 0.545 off it, barely a
      // move, because the off-throttle samples are nearly as loud as the
      // on-throttle ones. That left far more headroom than the guess allowed
      // -- engine 0.33 and pop 0.44 at the output summed to 0.76, so a quarter
      // of the scale was going unused while the bangs were still too quiet.
      //
      // 0.95 puts one bang at about 0.61 at the output against the engine's
      // 0.33, for 0.94 together. That is the scale full, and it is where this
      // knob stops.
      volume: 0.95,     // every bang the same size -- `pops` sets how MANY
    },

    // Tyre audio. This is the car's warning channel -- with no force feedback
    // through a wheel, it is the only thing that can tell you the limit is
    // coming rather than that it has already arrived. See src/tyreaudio.js.
    tyre: {
      // Absolute, thanks to the filter makeup gain in tyreaudio.js: output RMS
      // is about 0.32 * volume regardless of Q or pitch. The engine samples sit
      // around 0.10, so this puts a full squeal comfortably on top of them.
      volume: 0.36,
      minSpeed: 2.5,      // m/s below which tyres are silent

      // The warning window. squealStart is the important number in this whole
      // block: it is how much notice you get. At 0.60 the tyre starts talking
      // when it still has 40% of its grip in hand. Raise it and the car goes
      // quiet until it is too late; lower it and it squeals constantly and the
      // signal stops meaning anything.
      // How much notice you get, and the number this whole file exists to set.
      //
      // Raised from 0.58 twice, by measurement, after the car was reported as
      // squealing through ordinary turns. A moderate autopilot lap spends 10%
      // of its time above 0.82 of lateral capacity, which is not "about to
      // lose the car" -- it is just cornering.
      //
      // 0.91 is close to the practical floor. The cost is warning time, and
      // at this value there is 458 ms between becoming audible and
      // saturating, against a design target of 400. Going higher buys quiet
      // by spending the warning the sound exists to give, so raise it only if
      // it still speaks too readily by ear.
      squealStart: 0.88,

      // How loud a tyre gets from LOAD alone, before it is actually sliding.
      //
      // The reason the car sounded like it squealed constantly: being at the
      // limit and having gone past it produced the same volume, so every hard
      // corner was as loud as a slide. At 0.3 a loaded tyre murmurs and a
      // sliding one squeals, which is both what a real car does and what makes
      // the sound worth listening to.
      loadVolume: 0.3,
      squealFull: 1.0,

      // Playback rate of the screech recording, per axle. Deliberately far
      // apart: this is what lets you hear WHICH end let go, and so which way
      // to correct.
      pitchFront: 1.18,
      pitchRear: 0.82,
      pitchRise: 0.12,    // how far pitch climbs as the tyre loads up
      speedPitch: 1.25,   // and how much road speed lifts it on top

      // Lowpass cutoff, in Hz. A loaded tyre is a muted whine; a sliding one
      // opens up and gets harsh, so more of the recording's top end comes
      // through the further past the limit it is.
      toneLoaded: 1500,
      toneSliding: 7000,

      // A slide at walking pace is a chirp, not a howl. This is how much of
      // full volume remains at the slowest speed that makes any sound at all.
      speedFloor: 0.45,
      speedFull: 32,      // m/s at which speed stops adding

      // Where the squeal fades out as the tyre leaves the asphalt, as a
      // FRACTION of this track's own road grip. Below surfaceCut it is silent;
      // above surfaceFull it is fully on the road.
      surfaceCut: 0.7,
      surfaceFull: 0.92,

      // Past the limit, driven by scrub speed rather than utilisation, which
      // is clamped and so says nothing about how far gone you are.
      slideVolume: 1.7,   // sliding is louder than working hard
      slideDrop: 0.72,    // and lower: pitch falls to 72% when properly sideways

      road: {
        volume: 0.10,     // background texture, deliberately well under the tyres
        freq: 430,        // lowpass corner on tarmac
        speedFull: 55,    // m/s at which road noise is at full volume
        roughBoost: 1.4,  // extra gain off-surface (grass, snow, gravel)
        roughDamp: 0.55,  // and duller: corner drops to 55% off-surface
      },

      smoothing: 0.035,   // ramp time; longer than the engine's, tyres swell
    },
  },

  // What counts as a tyre losing grip, shared by the audio and the skidmarks.
  //
  // These used to live in two places with two different definitions: the audio
  // keyed on friction utilisation while the marks keyed on brake pedal g and
  // axle slip angle. They disagreed constantly -- you would see rubber with no
  // sound, or hear a slide that left nothing on the road. One definition means
  // what you hear and what you see are the same event.
  tyres: {
    // m/s of sideways scrub at the axle. A car merely cornering at 1 g carries
    // ~0.5 m/s from its own slip angle, so anything near that fires through
    // ordinary turns. 2.0 m/s at road speed is about 5 degrees of slip.
    slideStart: 2.0,
    slideFull: 6.0,

    // Locking, from longitudinal force saturation rather than from speed:
    // Rapier spins its wheels kinematically, so a locked wheel keeps rotating
    // and slip speed can never see it. A threshold stop measures 86-88% of
    // longitudinal capacity.
    lockStart: 0.86,
    lockFull: 1.00,

    // Wheelspin needs a higher bar than locking. Accelerating out of a corner
    // reaches the high 80s at moderate throttle while gripping perfectly well;
    // only genuine spin exceeds capacity outright.
    spinStart: 1.02,
    spinFull: 1.25,
  },

  // How much further the shell leans than the springs really move.
  //
  // The angles are honest but small, and a chase camera flattens them further.
  // The outside front tyre is the one about to give up, and the body rolling
  // onto it is the clearest picture of that -- so it is drawn a little larger
  // than life. Mesh only; the collider never sees this.
  visual: {
    leanScale: 1.45,     // 1.0 = exactly what the physics does
    leanMax: 0.10,       // rad (~5.7 deg) of ADDED lean, so a big hit cannot
                         // fold the body through its own wheels
  },

  // Tyre smoke. The visual half of the event the squeal and the marks report,
  // driven from the same telemetry slide figure so the three cannot disagree.
  smoke: {
    enabled: true,
    minSpeed: 4.0,       // m/s below which a scrubbing tyre just chirps
    slideStart: 0.35,    // of telemetry's 0..1 slide, where smoke begins
    loadFull: 4500,      // N of wheel load counted as "fully loaded"
    loadFloor: 0.35,     // how much an unloaded tyre still smokes
    rate: 90,            // puffs per second at full intensity, per wheel
    burstMax: 6,         // cap per wheel per frame, so a stutter cannot flood
    life: 1.15,          // seconds at full intensity
    size: 0.55,          // metres across at birth
    growth: 2.6,         // how much it expands over its life
    opacity: 0.30,
    color: 0xd8d5cf,     // warm grey; pure white reads as steam
    rise: 0.85,          // m/s upward off the contact patch
    buoyancy: 0.55,      // m/s^2 of continued lift
    spread: 0.14,        // m of scatter at the contact patch
    scatter: 0.7,        // m/s of random sideways drift
    drag: 0.16,          // fraction of the car's velocity the puff inherits
    slow: 1.5,           // 1/s the puff loses its initial velocity
    speedFloor: 0.4,     // smoke at minSpeed, as a fraction of full
    speedFull: 30,       // m/s at which speed stops adding
  },

  skidmarks: {
    enabled: true,
    opacity: 0.55,
    lift: 0.015,        // metres above the road, to avoid z-fighting
    minSpeed: 2.0,      // m/s below which nothing is laid down
    // What counts as sliding now lives in TUNING.tyres, shared with the audio.
    // The old slipStart/slipFull/brakeStartG/brakeFullG are gone rather than
    // left inert: config that no longer does anything is worse than none,
    // because someone will eventually turn it and wonder why nothing changes.
  },

  world: {
    gravity: -9.81,
    fixedStep: 1 / 120,
    maxStepsPerFrame: 6,
  },

  camera: {
    // Lower than it was, but not closer -- and the "not closer" is the part
    // that took a second measurement to learn.
    //
    // Bringing the eye down to 0.8 m and in to 4 m measured four times the
    // optical flow, so that is where this went first. Driven, the car was cut
    // off by the bottom of the frame; measured again WITH the car in shot, the
    // close camera was worse than the original, not better: middle-of-screen
    // flow of 0.90 against 1.57. The first measurement had placed the camera
    // on the track independently of the car, so the car was not in it.
    //
    // The reason is worth keeping: the car is a large object that does not
    // move relative to the camera, so every pixel it covers contributes
    // nothing to the sense of speed. Filling the screen with it costs exactly
    // what filling the screen with anything static costs. There is a limit to
    // how big you want your own car.
    //
    // So: height comes down, which puts the ground closer under you and does
    // not spend screen on the car; distance stays about where it was, which
    // keeps the whole car in frame -- checked by projecting its bounding box,
    // and the longest car has to fit, not the average one.
    distance: 6.8,
    height: 1.95,
    lookAhead: 12.0,
    lookHeight: 1.0,
    stiffness: 7.5,       // spring rate of the chase cam
    fovBase: 62,
    fovGain: 20,          // extra fov at top speed
    velocityBlend: 0.35,  // how much the cam follows velocity vs. car heading
    // Right-stick look-around. Held, it orbits the car for a walk-around;
    // released, it eases back behind, so you never have to put it away.
    lookSpeed: 2.6,       // rad/s at full stick
    lookReturn: 3.5,      // how fast it recentres once you let go
    lookDeadzone: 0.15,   // a resting thumb must not drift the view

    // How far the camera may lead a slide, in radians. velocityBlend decides
    // how much of the drift angle it follows; this caps the result. Without a
    // cap a big slide swings the view right off the road just as you need to
    // see it -- which is the difference between a slide being exciting and
    // being disorienting. ~15 deg is the most that stays readable.
    //
    // Tried at 0.44, and separately with a yaw-rate term that swung the view
    // through ordinary corners as well, both to put more of the car's flank in
    // view once the camera came down. Driven, both were worse: the two effects
    // COMPOUND, so any corner with a little slip in it collected both and the
    // view ended up most of the way onto the car's side. Measured at 26 deg
    // median and 71 peak, which is a replay camera rather than one you drive
    // from. Halving it was still worse than not having it. Reverted whole --
    // this number was right the first time.
    slideYawMax: 0.26,

    // Fraction of the chassis' roll the camera copies. Enough to feel the car
    // lean on its outside springs; past about a quarter it stops reading as
    // load and starts reading as nausea.
    rollFactor: 0.20,

    // Impact shake. Fed by upward acceleration at the chassis, which is what a
    // kerb, a landing or a hard bump all look like -- one signal for the lot.
    //
    // Both numbers come from measurement rather than taste. A clean 150 km/h
    // lap peaks at 17 m/s2 and never once passes 55, so the floor separates
    // real hits from the suspension simply doing its job; drops of 0.4, 1.5
    // and 5 m register 61, 119 and 402, which is the range the amount is
    // scaled against -- a big landing should nearly reach shakeMax and a kerb
    // should be felt without obscuring the road.
    shakeFloor: 55,       // m/s^2 below which it is just the suspension working
    shake: 0.52,          // shake per unit over the floor (x0.001 m/(m/s^2))
    shakeMax: 0.22,       // and never more than this, or you cannot see to drive
    shakeDecay: 18,       // 1/s: ~55 ms to 1/e, one hit gone inside 200 ms

    // The camera falls back as the car pulls away from it and closes up under
    // braking. The velocity feed-forward below deliberately cancels the steady
    // trailing error, which is right -- but it also removes the sense of being
    // shoved, so it is put back here as an explicit, bounded effect.
    accelPull: 0.085,     // metres of extra distance per m/s^2
    accelPullMax: 0.9,    // metres, either way
    accelPullRate: 3.0,   // how fast that distance change follows (1/s)
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

// ---------------------------------------------------------------------------
// Engine output.
//
// The authored curve is a SHAPE -- how the pull is distributed across the rev
// range -- and peakTorque scales it. That keeps the well-tuned A110 character
// (flat turbo plateau, tailing off past 6400) while letting one number decide
// how hard the thing actually pushes.
//
// Power is NOT a second free parameter. Power is torque times revs, so for a
// fixed shape and rev ceiling the hp figure is pinned to the Nm figure: this
// engine makes 0.88 hp per Nm and nothing in the panel can change that without
// changing the shape. peakPowerHp() therefore derives it rather than storing
// it, and setPeakPowerHp() converts back -- two views of one engine, so you can
// ask in whichever unit you happen to think in.

const WATTS_PER_HP = 745.7;
const RPM_TO_RADS = Math.PI / 30;

// The peak-normalised curve. Rebuilt only when the curve array is swapped
// (resetTuning does that) because torqueAt() runs 120 times a second and this
// scans the whole table. Nothing edits the points in place.
let _shape = { curve: null, points: null };

function shapedCurve() {
  const e = TUNING.engine;
  if (_shape.curve === e.curve) return _shape.points;

  let max = 0;
  for (const [, t] of e.curve) if (t > max) max = t;
  const points = max > 0 ? e.curve.map(([r, t]) => [r, t / max]) : e.curve;

  _shape = { curve: e.curve, points };
  return points;
}

// Interpolate the engine torque curve. Flat beyond either end.
export function torqueAt(rpm) {
  const c = shapedCurve();
  const scale = TUNING.engine.peakTorque ?? 340;
  if (rpm <= c[0][0]) return c[0][1] * scale;
  for (let i = 1; i < c.length; i++) {
    if (rpm <= c[i][0]) {
      const [r0, t0] = c[i - 1];
      const [r1, t1] = c[i];
      return (t0 + (t1 - t0) * ((rpm - r0) / (r1 - r0))) * scale;
    }
  }
  return c[c.length - 1][1] * scale;
}

/**
 * Peak power in hp, over the usable rev range.
 *
 * Derived rather than stored: power is not a free parameter, it is what the
 * torque curve and the redline come to between them. Capped at the redline
 * because revs you cannot use make no power you can use -- which is also why
 * raising the redline alone gains horsepower, exactly as on a real engine.
 */
export function peakPowerHp() {
  const redline = TUNING.engine.redlineRpm;
  let best = 0;
  for (let rpm = 1000; rpm <= redline; rpm += 25) {
    const watts = torqueAt(rpm) * rpm * RPM_TO_RADS;
    if (watts > best) best = watts;
  }
  return best / WATTS_PER_HP;
}

/**
 * Ask for a power figure and get the torque that produces it.
 *
 * Power is linear in peakTorque for a fixed shape, so this is exact in one
 * step rather than a search.
 */
export function setPeakPowerHp(hp) {
  const now = peakPowerHp();
  // Rounded, or the back-solve leaves 339.78895364399017 in the panel and in
  // the copied setup JSON. A tenth of a Nm is under a tenth of a horsepower.
  if (now > 1 && hp > 0) {
    TUNING.engine.peakTorque = Math.round(TUNING.engine.peakTorque * (hp / now) * 10) / 10;
  }
  return TUNING.engine.peakTorque;
}
