// The car: Rapier chassis body + raycast vehicle controller, with the
// drivetrain, steering and aero layered on top.
//
// Rapier's vehicle controller handles suspension raycasts and puts forces at
// the contact patch. Everything that gives the car its character -- torque
// curve, gearing, weight-sensitive steering, brake bias, surface grip -- is
// computed here and fed into it each fixed step.
//
// Axis convention: forward is +Z, up is +Y. These are Rapier's defaults for
// the vehicle controller and we deliberately leave them alone: the JS binding
// misnames the forward-axis setter (`set setIndexForwardAxis`), so assigning
// `controller.indexForwardAxis` silently does nothing.

import * as THREE from 'three';
import { TUNING, torqueAt } from './tuning.js';
import { Telemetry } from './telemetry.js';

export const WHEEL = { FL: 0, FR: 1, RL: 2, RR: 3 };
const FRONT_WHEELS = [WHEEL.FL, WHEEL.FR];
const REAR_WHEELS = [WHEEL.RL, WHEEL.RR];

// Speed below which first gear is treated as a slipping clutch, so the engine
// can idle and rev instead of being dragged down to zero rpm at a standstill.
const CLUTCH_SPEED = 5.0;

export class Vehicle {
  constructor(world, RAPIER, spawn) {
    this.world = world;
    this.RAPIER = RAPIER;
    this.spawn = spawn;

    this.gear = 1;
    this.rpm = TUNING.engine.idleRpm;
    this.steerAngle = 0;        // radians, positive = wheels turned left
    this.shiftTimer = 0;
    this.speed = 0;             // signed, m/s along forward
    this.gripMult = [1, 1, 1, 1];
    this.slip = [0, 0, 0, 0];
    this.engineTorque = 0;
    this.driveForce = 0;
    this._wheelForce = [0, 0, 0, 0];
    // Telemetry, read by the HUD.
    this.gLong = 0;          // +forward accel, -braking, in g
    this.gLat = 0;           // + = pushed to the driver's right, in g
    this.slipFront = 0;      // front axle slip angle, radians
    this.slipRear = 0;       // rear axle slip angle, radians
    this.balance = 0;        // <0 understeer, >0 oversteer
    this._prevVel = new THREE.Vector3();
    this.airborne = false;
    // Per-wheel tyre telemetry. Read-only on the simulation; everything that
    // needs to know how hard a tyre is working goes through this.
    this.telemetry = new Telemetry();
    this.lastAccel = 0;
    this._prevSpeed = 0;

    // What the driver is asking for, mirrored for the audio and the HUD.
    //
    // Initialised HERE and not only at the end of _applyBrakes, because a
    // renderer frame can land before the first physics step has run. They were
    // undefined until then, and `undefined - 0` is NaN -- which the engine
    // audio smooths into its running throttle and never recovers from, since
    // NaN + (x - NaN) * k stays NaN forever. That poisoned every gain it set,
    // and the exception took the whole frame -- including the render -- with
    // it. The game simply froze.
    this.braking = false;
    this.throttleInput = 0;
    this.brakeInput = 0;
    this.handbrakeInput = 0;
    this.driveForce = 0;
    this.holding = false;

    // Two snapshots of the render-relevant state so frames can interpolate
    // between physics steps.
    this.prev = makeSnapshot();
    this.curr = makeSnapshot();

    this._build();
  }

  _build() {
    const { RAPIER, world } = this;
    const t = TUNING;
    const c = t.chassis;

    const m = c.mass;
    const w = c.halfWidth * 2, h = c.halfHeight * 2, l = c.halfLength * 2;
    // Box inertia is a decent stand-in for a car: yaw around 2000 kg·m^2,
    // roll around 400. inertiaScale lets you make it darty or lazy.
    const inertia = {
      x: (m / 12) * (h * h + l * l) * c.inertiaScale,
      y: (m / 12) * (w * w + l * l) * c.inertiaScale,
      z: (m / 12) * (w * w + h * h) * c.inertiaScale,
    };

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(this.spawn.position.x, this.spawn.position.y, this.spawn.position.z)
      .setRotation(this.spawn.rotation)
      .setLinearDamping(c.linearDamping)
      .setAngularDamping(c.angularDamping)
      .setCcdEnabled(true)
      // The vehicle controller's impulses don't count as activity, so a car
      // left idling gets put to sleep and then ignores the throttle entirely.
      .setCanSleep(false)
      .setAdditionalMassProperties(
        m,
        { x: 0, y: c.comY, z: c.comZ },
        inertia,
        { x: 0, y: 0, z: 0, w: 1 },
      );
    this.body = world.createRigidBody(desc);

    // Density 0: all mass comes from the explicit properties above, so the
    // centre of mass stays exactly where we put it.
    const colliderDesc = RAPIER.ColliderDesc
      .cuboid(c.halfWidth, c.halfHeight, c.halfLength)
      .setTranslation(0, c.colliderOffsetY, 0)
      .setDensity(0)
      .setFriction(0.35)
      .setRestitution(0.05);
    this.collider = world.createCollider(colliderDesc, this.body);

    this.controller = world.createVehicleController(this.body);

    // Rapier's vehicle controller defaults to forward = X, up = Y. Our chassis
    // is built forward = +Z, so this MUST be set or every newton of engine
    // force is applied sideways -- and currentVehicleSpeed() reads along the
    // same wrong axis, so the car reports ~0 km/h while creeping sideways.
    //
    // Note the assignment target: the JS binding declares the setter as
    // `set setIndexForwardAxis(v)` while `indexForwardAxis` is getter-only, so
    // assigning the obvious name silently does nothing.
    this.controller.setIndexForwardAxis = 2; // +Z
    this.controller.indexUpAxis = 1;         // +Y
    if (this.controller.indexForwardAxis !== 2) {
      console.error('vehicle: forward axis is', this.controller.indexForwardAxis, 'expected 2 (+Z)');
    }

    const wcfg = t.wheels;
    const positions = [
      { x:  wcfg.trackHalf, y: wcfg.connectionY, z:  wcfg.frontZ }, // FL
      { x: -wcfg.trackHalf, y: wcfg.connectionY, z:  wcfg.frontZ }, // FR
      { x:  wcfg.trackHalf, y: wcfg.connectionY, z: -wcfg.rearZ  }, // RL
      { x: -wcfg.trackHalf, y: wcfg.connectionY, z: -wcfg.rearZ  }, // RR
    ];
    this.wheelPositions = positions;

    for (const p of positions) {
      this.controller.addWheel(
        p,
        { x: 0, y: -1, z: 0 },  // suspension points down
        { x: -1, y: 0, z: 0 },  // axle
        wcfg.restLength ?? t.suspension.restLength,
        wcfg.radius,
      );
    }

    this._applyWheelTuning();
    this._snapshot();
    this.prev = { ...this.curr, wheels: this.curr.wheels.map((w2) => ({ ...w2 })) };
  }

  /** Push tuning values into the controller. Called every step so GUI edits are live. */
  _applyWheelTuning() {
    const s = TUNING.suspension;
    const w = TUNING.wheels;
    for (let i = 0; i < 4; i++) {
      this.controller.setWheelSuspensionRestLength(i, s.restLength);
      this.controller.setWheelSuspensionStiffness(i, s.stiffness);
      this.controller.setWheelSuspensionCompression(i, s.compression);
      this.controller.setWheelSuspensionRelaxation(i, s.relaxation);
      this.controller.setWheelMaxSuspensionTravel(i, s.maxTravel);
      this.controller.setWheelMaxSuspensionForce(i, s.maxForce);
      this.controller.setWheelRadius(i, w.radius);
      this.controller.setWheelSideFrictionStiffness(i, w.sideFrictionStiffness);
    }
  }

  get gearRatio() {
    const tx = TUNING.transmission;
    if (this.gear === -1) return -tx.reverse;
    if (this.gear === 0) return 0;
    return tx.gears[Math.min(this.gear, tx.gears.length) - 1];
  }

  get gearLabel() {
    if (this.gear === -1) return 'R';
    if (this.gear === 0) return 'N';
    return String(this.gear);
  }

  get speedKmh() { return Math.abs(this.speed) * 3.6; }

  /**
   * One fixed physics step.
   * @param {number} dt fixed timestep
   * @param {object} input from Input.update()
   * @param {(point: THREE.Vector3) => number} surfaceGripAt returns 0..1 grip multiplier
   */
  update(dt, input, surfaceGripAt) {
    this.prev = this.curr;

    this._applyWheelTuning();

    this.speed = this.controller.currentVehicleSpeed();
    this.lastAccel = (Math.abs(this.speed) - Math.abs(this._prevSpeed)) / dt;
    this._prevSpeed = this.speed;

    const pedals = this._resolvePedals(input);
    // Before anything else touches the body, so the render snapshot taken at
    // the end of this step shows the held position rather than the drifted one.
    this._applyHillHold(pedals, input);
    this._updateSteering(dt, input);
    this._updateSurfaceGrip(surfaceGripAt, input);
    this._updateGearbox(dt, pedals, input);
    this._updateEngine(dt, pedals);
    this._applyDrive(pedals);
    this._applyBrakes(pedals, input);
    this._applyAero();

    this.controller.updateVehicle(dt);
    this._updateTelemetry(dt);
    // After updateVehicle, so the impulses sampled are this step's.
    this.telemetry.sample(this, dt);
    this.telemetry.setSteerTrace(input.steerRaw ?? input.steer, input.steer);
    this._snapshot();
  }

  // In reverse the pedals swap, which is the convention that feels right on a
  // pad: the trigger you were braking with becomes the one that backs you up.
  _resolvePedals(input) {
    if (this.gear === -1) {
      return { drive: input.brake, braking: input.throttle };
    }
    return { drive: input.throttle, braking: input.brake };
  }

  /**
   * Hill hold: brake to a stop on a slope and STAY there.
   *
   * The service brake opposes travel, so it has to know which way you are
   * travelling -- and within a deadband either side of zero there is no answer,
   * only jitter. _applyBrakes therefore drops to no brake force at all below
   * 0.15 m/s, which left nothing but Rapier's own weak brake impulse holding
   * the car. On any gradient gravity beat it, the car rolled, and the moment it
   * passed the deadband the brake nipped it and let go again. That stutter is
   * the "it keeps moving backwards" -- not one slide but hundreds of tiny ones.
   *
   * No amount of brake force fixes this, because the bug is the deadband, not
   * the strength. A stopped car with the pedal down is not doing dynamics at
   * all: it is pinned by static friction. So pin it -- kill the horizontal
   * velocity and put the body back where it was.
   *
   * Restoring the POSITION is what makes it exact. Zeroing velocity alone still
   * creeps, because within each step gravity accelerates the body to g*dt and
   * it travels half a millimetre before the next step zeroes it again -- about
   * 8 cm/s of drift that never shows up in the velocity you are watching.
   * Re-anchoring cannot accumulate: every step puts it back on the same spot.
   */
  _applyHillHold(pedals, input) {
    const b = TUNING.brakes;

    let grounded = 0;
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) grounded++;

    // The handbrake holds too -- that is what a parking brake is for. Any
    // request to GO releases the hold, in either gear: the pedals swap in
    // reverse, and asking about pedals.drive rather than the raw input means
    // this does not have to care which way round they are.
    // The trigger is simply "stopped and not asking to go anywhere". Keying it
    // on the brake pedal was too narrow: the car rolled away just as happily
    // sitting in first with no pedal touched at all -- 2.2 m in six seconds --
    // because in neutral, at idle, or coasting to rest there is nothing holding
    // it either. Asking about pedals.drive covers every one of those at once,
    // and works in reverse too, where the pedals swap.
    //
    // A real automatic creeps forward against the slope; this is the arcade
    // version of the same promise, which is that a stopped car stays stopped.
    const hold = pedals.drive < 0.05 && grounded >= 3
                 && Math.abs(this.speed) < b.holdSpeed;

    if (!hold) {
      this._holdAnchor = null;
      this.holding = false;
      return;
    }

    const p = this.body.translation();
    if (!this._holdAnchor) this._holdAnchor = { x: p.x, z: p.z };

    const v = this.body.linvel();
    // Vertical is left alone below zero so the suspension can still settle,
    // but not above it, or a compressed spring bounces the car off its anchor.
    this.body.setLinvel({ x: 0, y: Math.min(v.y, 0), z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setTranslation({ x: this._holdAnchor.x, y: p.y, z: this._holdAnchor.z }, true);
    this.holding = true;
  }

  _updateSteering(dt, input) {
    const st = TUNING.steering;
    const speedFrac = Math.min(Math.abs(this.speed) / st.falloffSpeed, 1);
    const maxAngle = st.maxAngleLow + (st.maxAngleHigh - st.maxAngleLow) * speedFrac;

    // Sign convention, derived once so it stops being re-guessed:
    // three.js views along -Z with +X to the right, so a car whose forward is
    // +Z has its right-hand side at -X. Rotating a wheel by +angle about +Y
    // maps forward (0,0,1) to (sin a, 0, cos a) -- toward +X, i.e. the car's
    // LEFT. Steer input is +1 for right, so the wheel angle is its negation.
    let steerInput = input.steer;
    if (st.counterSteerAssist > 0) {
      steerInput = THREE.MathUtils.clamp(
        steerInput + this._counterSteerHint() * st.counterSteerAssist, -1, 1,
      );
    }
    const target = -steerInput * maxAngle;

    const returningToCenter = Math.abs(target) < Math.abs(this.steerAngle);
    const rate = returningToCenter ? st.returnRate : st.rateLimit;
    this.steerAngle = approach(this.steerAngle, target, rate * dt);

    for (const i of FRONT_WHEELS) this.controller.setWheelSteering(i, this.steerAngle);
  }

  // Sign of the chassis slip angle, in steer-input space (+1 = right).
  // If the car's velocity points right of its nose the rear has stepped out,
  // and the correction is to steer right -- into the slide -- so the hint
  // carries the same sign as the lateral velocity.
  _counterSteerHint() {
    const v = this.body.linvel();
    const speed = Math.hypot(v.x, v.z);
    if (speed < 3) return 0;
    const fwd = this.forward();
    const right = this.right();
    const lateral = v.x * right.x + v.z * right.z;
    const forward = v.x * fwd.x + v.z * fwd.z;
    if (forward < 1) return 0;
    return THREE.MathUtils.clamp(lateral / speed, -1, 1);
  }

  _updateSurfaceGrip(surfaceGripAt, input) {
    const w = TUNING.wheels;
    const s = TUNING.surfaces;
    const point = new THREE.Vector3();

    for (let i = 0; i < 4; i++) {
      let mult = 1;
      if (surfaceGripAt) {
        const cp = this.controller.wheelContactPoint(i);
        if (cp) {
          point.set(cp.x, cp.y, cp.z);
        } else {
          // Not touching anything: use where the wheel hangs, so grip is
          // already correct on the step it lands.
          const wp = this.wheelWorldPosition(i, point);
          point.copy(wp);
        }
        mult = surfaceGripAt(point);
      }
      this.gripMult[i] = mult;

      const isRear = i === WHEEL.RL || i === WHEEL.RR;
      let base = isRear ? w.frictionRear : w.frictionFront;

      // Load sensitivity: a real tyre's grip rises less than linearly with the
      // load on it, so the heavily-loaded outside wheel gives back less than
      // the unloaded inside wheel loses. That is what turns weight transfer
      // into understeer on turn-in and oversteer on a lifted throttle, instead
      // of the car behaving identically at every attitude.
      if (w.loadSensitivity > 0) {
        const load = this.controller.wheelSuspensionForce(i) || 0;
        const nominal = (TUNING.chassis.mass * 9.81) / 4;
        if (load > 1 && nominal > 1) {
          const ratio = load / nominal;
          base *= Math.pow(ratio, -w.loadSensitivity);
        }
      }

      if (isRear && input.handbrake > 0.1) {
        // Breaking the rears loose is what makes the handbrake a steering
        // input rather than just a brake.
        base *= THREE.MathUtils.lerp(1, TUNING.brakes.handbrakeGripMult, input.handbrake);
      }
      this.controller.setWheelFrictionSlip(i, Math.max(0.05, base * mult));
    }
  }

  _updateGearbox(dt, pedals, input) {
    const tx = TUNING.transmission;
    if (this.shiftTimer > 0) this.shiftTimer -= dt;

    if (input.toggleGearbox) tx.automatic = !tx.automatic;

    if (input.shiftUp) this._shift(this.gear + 1);
    if (input.shiftDown) this._shift(this.gear - 1);

    // Coming to a stop under braking drops the car into NEUTRAL, never straight
    // into reverse -- braking hard for a corner and finding yourself in R is
    // both surprising and wrong. Reverse then needs a deliberate, fresh press:
    // the brake has to be released first, which is what _reverseArmed tracks.
    const nearlyStopped = Math.abs(this.speed) < 0.6;
    if (this.gear > 0 && nearlyStopped && input.brake > 0.4 && input.throttle < 0.1) {
      this._shift(0);
      this._reverseArmed = false;
    }
    if (this.gear === 0) {
      if (input.brake < 0.15) this._reverseArmed = true;      // pedal released
      if (this._reverseArmed && nearlyStopped && input.brake > 0.4 && input.throttle < 0.1) {
        this._shift(-1);
      } else if (input.throttle > 0.3) {
        this._shift(1);                                       // pull away again
      }
    } else if (this.gear === -1 && this.speed > -0.6 && input.throttle > 0.4) {
      this._shift(1);
    }

    if (!tx.automatic || this.shiftTimer > 0 || this.gear <= 0) return;

    if (this.rpm > tx.autoUpshiftRpm && this.gear < tx.gears.length) {
      this._shift(this.gear + 1);
    } else if (this.rpm < tx.autoDownshiftRpm && this.gear > 1 && pedals.drive < 0.9) {
      this._shift(this.gear - 1);
    }
  }

  _shift(next) {
    const tx = TUNING.transmission;
    const clamped = THREE.MathUtils.clamp(next, -1, tx.gears.length);
    if (clamped === this.gear) return;
    // Don't let a downshift into reverse happen at speed.
    if (clamped === -1 && this.speed > 1.0) return;
    if (clamped === 0 && this.gear === -1 && this.speed < -1.0) return;
    this.gear = clamped;
    this.shiftTimer = tx.shiftTime;
  }

  _updateEngine(dt, pedals) {
    const e = TUNING.engine;
    const tx = TUNING.transmission;

    let target;
    const ratio = Math.abs(this.gearRatio) * tx.final;
    if (this.gear === 0 || ratio === 0) {
      target = e.idleRpm + pedals.drive * (e.redlineRpm - e.idleRpm);
    } else {
      const wheelAngVel = Math.abs(this.speed) / TUNING.wheels.radius; // rad/s
      const geared = (wheelAngVel * ratio * 60) / (Math.PI * 2);
      // Below CLUTCH_SPEED the clutch is slipping, so blend toward a free-revving
      // engine. Without this the engine reads 0 rpm at a standstill and makes
      // no torque, and the car can never pull away.
      const clutch = THREE.MathUtils.clamp(Math.abs(this.speed) / CLUTCH_SPEED, 0, 1);
      const free = e.idleRpm + pedals.drive * (e.redlineRpm * 0.62 - e.idleRpm);
      target = THREE.MathUtils.lerp(Math.max(free, geared), geared, clutch);
    }

    target = THREE.MathUtils.clamp(target, e.idleRpm, e.maxRpm);
    this.rpm += (target - this.rpm) * (1 - Math.exp(-e.revSpeed * dt));

    const overRev = this.rpm >= e.redlineRpm;
    const cutting = this.shiftTimer > 0 || overRev;

    let torque = cutting ? 0 : torqueAt(this.rpm) * pedals.drive;

    // Engine braking: real lift-off deceleration, scaled by how hard it's
    // spinning. It must fade out as the car stops, because it is applied as a
    // wheel force: held at a standstill, that negative force is indistinguishable
    // from reverse drive and the car creeps backwards off the throttle.
    // A drag torque can only ever oppose motion, never cause it.
    const fade = Math.min(Math.abs(this.speed) / 3, 1);
    torque -= e.engineBrakeTorque * (1 - pedals.drive) * (this.rpm / e.redlineRpm) * fade;
    this.engineTorque = torque;
  }

  _applyDrive(pedals) {
    const tx = TUNING.transmission;
    const ratio = this.gearRatio * tx.final;

    // Clear FIRST, every step, whatever happens next.
    //
    // _wheelForce is a per-step accumulator: this method writes drive into it
    // and _applyBrakes subtracts braking from it. Any path that leaves it
    // holding the previous step's value turns it into a running total, and a
    // running total of brake force diverges within seconds.
    //
    // The neutral branch below used to return without doing this -- it zeroed
    // the CONTROLLER instead, which _applyBrakes then overwrote anyway, so the
    // stale force survived. Braking to a stop drops the gearbox into neutral,
    // so every hard stop wound the rear wheel force up without bound: measured
    // at 183 kN against a 2.7 kN cap, which launched the car off the map.
    this._wheelForce[WHEEL.FL] = 0;
    this._wheelForce[WHEEL.FR] = 0;
    this._wheelForce[WHEEL.RL] = 0;
    this._wheelForce[WHEEL.RR] = 0;

    if (this.gear === 0 || ratio === 0) {
      this.driveForce = 0;
      return;
    }

    // Torque at the crank -> force at the contact patch.
    const force = (this.engineTorque * ratio * tx.efficiency) / TUNING.wheels.radius;
    this.driveForce = force;

    // Rear-wheel drive: the drive torque goes to the rears only.
    // Written to _wheelForce rather than the controller, because _applyBrakes
    // combines drive and braking into a single longitudinal force per wheel.
    this._wheelForce[WHEEL.RL] = force / 2;
    this._wheelForce[WHEEL.RR] = force / 2;
  }

  /**
   * Service brakes are applied as negative wheel force, in newtons, sharing
   * units with the drive. Rapier's own setWheelBrake takes a per-step impulse
   * whose effect is non-monotonic in its magnitude -- measured 0.42 g at 420
   * but only 0.15 g at 1000, because large values fight the friction-circle
   * clamp. Engine force is linear and predictable, so brakes ride that path and
   * setWheelBrake is reserved for the handbrake, where locking is the point.
   */
  _applyBrakes(pedals, input) {
    const b = TUNING.brakes;
    const speed = this.speed;

    // A pulled handbrake has to cut rear DRIVE, not just add rear brake.
    //
    // Rapier inherits Bullet's rolling-friction rule, which reads roughly:
    //
    //     if (engineForce != 0) rollingFriction = engineForce * dt;
    //     else                  rollingFriction = -brake ...;
    //
    // The brake is consulted ONLY when engine force is zero, so any throttle
    // at all made setWheelBrake a no-op and the handbrake did nothing while
    // accelerating -- which is exactly the moment you want it for a
    // handbrake turn. Releasing the rear drive lets the brake path run, and
    // is what a real locked wheel does anyway: it puts no power down.
    //
    // Applied here rather than in _applyDrive because at this point
    // _wheelForce still holds drive alone; the service brake is subtracted
    // below, and must not be scaled away with it.
    const handRelease = 1 - Math.min(input.handbrake, 1);
    this._wheelForce[WHEEL.RL] *= handRelease;
    this._wheelForce[WHEEL.RR] *= handRelease;

    const total = pedals.braking * b.maxBrakeForce;
    const perFront = (total * b.frontBias) / 2;
    const perRear = (total * (1 - b.frontBias)) / 2;

    // Oppose whichever way the car is actually travelling.
    const dir = Math.abs(speed) < 0.15 ? 0 : Math.sign(speed);
    this._wheelForce[WHEEL.FL] -= dir * perFront;
    this._wheelForce[WHEEL.FR] -= dir * perFront;
    this._wheelForce[WHEEL.RL] -= dir * perRear;
    this._wheelForce[WHEEL.RR] -= dir * perRear;

    for (let i = 0; i < 4; i++) this.controller.setWheelEngineForce(i, this._wheelForce[i]);

    // Rapier's brake still does two jobs well: holding the car still at a
    // standstill, and locking the rears for the handbrake.
    const holding = pedals.braking > 0.05 && Math.abs(speed) < 0.5 ? b.holdBrake : 0;
    const hand = input.handbrake * b.handbrake;
    this.controller.setWheelBrake(WHEEL.FL, holding);
    this.controller.setWheelBrake(WHEEL.FR, holding);
    this.controller.setWheelBrake(WHEEL.RL, holding + hand);
    this.controller.setWheelBrake(WHEEL.RR, holding + hand);

    this.braking = pedals.braking > 0.02 || input.handbrake > 0.1;
    this.handbrakeInput = input.handbrake;
    this.brakeInput = pedals.braking;
    this.throttleInput = pedals.drive;
  }

  /**
   * Slip angles per axle, the g-meter, and the resulting balance.
   *
   * Understeer and oversteer are emergent here, not scripted: they come from
   * how much the front and rear axles are sliding relative to where they point.
   * `balance` is just the difference, so it reads negative when the front is
   * giving up first (understeer, car runs wide) and positive when the rear lets
   * go (oversteer, car rotates in).
   */
  _updateTelemetry(dt) {
    const vel = this.body.linvel();
    const fwd = this.forward();
    const right = this.right();

    // Accelerations in the car's own frame, in g.
    const ax = (vel.x - this._prevVel.x) / dt;
    const az = (vel.z - this._prevVel.z) / dt;
    this._prevVel.set(vel.x, vel.y, vel.z);
    this.gLong = (ax * fwd.x + az * fwd.z) / 9.81;
    this.gLat = (ax * right.x + az * right.z) / 9.81;

    const speed = Math.hypot(vel.x, vel.z);
    if (speed < 2.5) {
      this.slipFront = 0;
      this.slipRear = 0;
      this.balance = 0;
      return;
    }

    const forwardV = vel.x * fwd.x + vel.z * fwd.z;
    const lateralV = vel.x * right.x + vel.z * right.z;
    const yaw = this.body.angvel().y;
    const w = TUNING.wheels;

    // Velocity at each axle includes the yaw rate about the centre of mass.
    // Yaw is about +Y and the car's right is -X, hence the sign on the term.
    const latFront = lateralV - yaw * w.frontZ;
    const latRear = lateralV + yaw * w.rearZ;

    // Front slip is measured against where the steered wheels point.
    this.slipFront = Math.atan2(latFront, Math.abs(forwardV)) + this.steerAngle;
    this.slipRear = Math.atan2(latRear, Math.abs(forwardV));
    this.balance = Math.abs(this.slipRear) - Math.abs(this.slipFront);
  }

  _applyAero() {
    const a = TUNING.aero;

    // Rapier's addForce is PERSISTENT -- it accumulates until explicitly
    // cleared, unlike an impulse. Without this reset, every step piles another
    // helping of drag and downforce onto the last, so within a few seconds the
    // car is pinned under several times its own weight and decelerates to a
    // halt at full throttle: it reads exactly like driving into a wall.
    this.body.resetForces(false);
    this.body.resetTorques(false);

    const v = this.body.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);

    let contacts = 0;
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) contacts++;
    this.airborne = contacts === 0;

    if (speed > 0.05) {
      // Drag opposes velocity and scales with v^2.
      const k = a.dragCoeff * speed;
      let fx = -v.x * k, fy = -v.y * k, fz = -v.z * k;

      if (!this.airborne) {
        const rr = a.rollingResistance / speed;
        fx -= v.x * rr; fy -= v.y * rr; fz -= v.z * rr;

        const grass = 1 - this.gripMult.reduce((s, g) => s + g, 0) / 4;
        if (grass > 0.01) {
          const gd = (TUNING.surfaces.grassDrag * grass) / Math.max(speed, 1);
          fx -= v.x * gd * speed; fz -= v.z * gd * speed;
        }
      }
      this.body.addForce({ x: fx, y: fy, z: fz }, true);
    }

    // Downforce along the car's own up axis, so it still presses the car into
    // the road when banked rather than fighting the suspension sideways.
    if (!this.airborne && speed > 1) {
      const up = this.up();
      const df = -a.downforce * speed * speed;
      this.body.addForce({ x: up.x * df, y: up.y * df, z: up.z * df }, true);
    }
  }

  // --- orientation helpers -------------------------------------------------

  forward(out = new THREE.Vector3()) {
    return out.set(0, 0, 1).applyQuaternion(this.quaternion());
  }

  /** The car's actual right-hand side. Forward is +Z, so that is -X, not +X. */
  right(out = new THREE.Vector3()) {
    return out.set(-1, 0, 0).applyQuaternion(this.quaternion());
  }

  up(out = new THREE.Vector3()) {
    return out.set(0, 1, 0).applyQuaternion(this.quaternion());
  }

  quaternion(out = new THREE.Quaternion()) {
    const r = this.body.rotation();
    return out.set(r.x, r.y, r.z, r.w);
  }

  position(out = new THREE.Vector3()) {
    const p = this.body.translation();
    return out.set(p.x, p.y, p.z);
  }

  wheelWorldPosition(i, out = new THREE.Vector3()) {
    const p = this.wheelPositions[i];
    const len = this.controller.wheelSuspensionLength(i) ?? TUNING.suspension.restLength;
    out.set(p.x, p.y - len, p.z).applyQuaternion(this.quaternion());
    const c = this.body.translation();
    return out.set(out.x + c.x, out.y + c.y, out.z + c.z);
  }

  // --- render state --------------------------------------------------------

  _snapshot() {
    const p = this.body.translation();
    const r = this.body.rotation();
    const snap = makeSnapshot();
    snap.px = p.x; snap.py = p.y; snap.pz = p.z;
    snap.qx = r.x; snap.qy = r.y; snap.qz = r.z; snap.qw = r.w;
    for (let i = 0; i < 4; i++) {
      const w = snap.wheels[i];
      w.suspension = this.controller.wheelSuspensionLength(i) ?? TUNING.suspension.restLength;
      w.steering = this.controller.wheelSteering(i) ?? 0;
      w.rotation = this.controller.wheelRotation(i) ?? 0;
      w.contact = this.controller.wheelIsInContact(i);
    }
    this.curr = snap;
  }

  /** Write interpolated physics state onto the car meshes. */
  syncMesh(group, wheelMeshes, alpha, bodyGroup = null) {
    const a = THREE.MathUtils.clamp(alpha, 0, 1);
    const A = this.prev, B = this.curr;

    group.position.set(
      lerp(A.px, B.px, a), lerp(A.py, B.py, a), lerp(A.pz, B.pz, a),
    );
    _qa.set(A.qx, A.qy, A.qz, A.qw);
    _qb.set(B.qx, B.qy, B.qz, B.qw);
    group.quaternion.copy(_qa).slerp(_qb, a);

    const susp = _susp;
    for (let i = 0; i < 4; i++) {
      const mesh = wheelMeshes[i];
      const p = this.wheelPositions[i];
      susp[i] = lerp(A.wheels[i].suspension, B.wheels[i].suspension, a);
      mesh.position.set(p.x, p.y - susp[i], p.z);
      mesh.rotation.set(0, 0, 0);
      mesh.rotateY(lerp(A.wheels[i].steering, B.wheels[i].steering, a));
      // The axle points along -X, so a positive reported rotation spins the
      // wheel backwards in mesh space.
      mesh.rotateX(-shortestLerpAngle(A.wheels[i].rotation, B.wheels[i].rotation, a));
    }

    if (bodyGroup) this._leanBody(bodyGroup, susp);
  }

  /**
   * Exaggerate how far the shell leans on its springs -- the visual mesh only,
   * never the collider.
   *
   * The point is to make load transfer VISIBLE. The outside front tyre is the
   * one about to give up, and the clearest picture of where the weight has gone
   * is the body rolling onto it. The real angles are small enough to miss from
   * a chase camera, so the shell is leant a little further than the physics.
   *
   * Derived from SUSPENSION COMPRESSION, not from the chassis' attitude in the
   * world. Using world attitude would exaggerate the terrain as well as the
   * springs: every hill would pitch the body relative to its own wheels and
   * every banked corner would roll it, permanently, with the car sitting
   * perfectly level on its suspension. Compression only moves when load moves,
   * which is the thing worth showing.
   *
   * Applied to the body alone rather than the whole car, because the wheels
   * have to stay on the road. That also happens to be what really occurs: the
   * shell leans relative to its wheels, not with them.
   */
  _leanBody(bodyGroup, susp) {
    const v = TUNING.visual;
    const extra = v.leanScale - 1;
    if (extra <= 0) { bodyGroup.rotation.set(0, 0, 0); return; }

    const w = TUNING.wheels;
    // A longer strut means the body sits FURTHER from that wheel, so that
    // corner is higher. Left wheels are at +X, front at +Z.
    const roll = ((susp[WHEEL.FL] + susp[WHEEL.RL]) - (susp[WHEEL.FR] + susp[WHEEL.RR]))
                 / (4 * w.trackHalf);
    const pitch = ((susp[WHEEL.FL] + susp[WHEEL.FR]) - (susp[WHEEL.RL] + susp[WHEEL.RR]))
                  / (2 * (w.frontZ + w.rearZ));

    // Rotating about +Z by a positive angle raises the +X side, which matches
    // the sign of `roll` above. Nose-up is a NEGATIVE rotation about +X, hence
    // the minus on pitch.
    bodyGroup.rotation.set(
      THREE.MathUtils.clamp(-pitch * extra, -v.leanMax, v.leanMax),
      0,
      THREE.MathUtils.clamp(roll * extra, -v.leanMax, v.leanMax),
    );
  }

  reset(spawn = this.spawn) {
    this.body.setTranslation(spawn.position, true);
    this.body.setRotation(spawn.rotation, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.gear = 1;
    this.rpm = TUNING.engine.idleRpm;
    this.steerAngle = 0;
    this.shiftTimer = 0;
    this.speed = 0;
    this._prevSpeed = 0;
    for (let i = 0; i < 4; i++) {
      this.controller.setWheelEngineForce(i, 0);
      this.controller.setWheelBrake(i, 0);
      this.controller.setWheelSteering(i, 0);
    }
    this._snapshot();
    this.prev = { ...this.curr, wheels: this.curr.wheels.map((w) => ({ ...w })) };
  }

  /** Tear down the Rapier objects. The controller must go before the body. */
  dispose() {
    this.world.removeVehicleController(this.controller);
    this.world.removeRigidBody(this.body); // takes its colliders with it
    this.controller = null;
    this.body = null;
  }
}

function makeSnapshot() {
  return {
    px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1,
    wheels: [0, 1, 2, 3].map(() => ({
      suspension: 0, steering: 0, rotation: 0, contact: false,
    })),
  };
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
// Interpolated strut lengths, reused every frame so syncMesh allocates nothing.
const _susp = [0, 0, 0, 0];

function lerp(a, b, t) { return a + (b - a) * t; }

// Wheel rotation accumulates without bound and wraps; interpolate the short way
// so the mesh doesn't spin backwards for one frame at the wrap.
function shortestLerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function approach(current, target, maxDelta) {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}
