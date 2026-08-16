// Per-wheel tyre telemetry.
//
// This exists because of one awkward fact about the physics engine: Rapier's
// raycast vehicle has no tyre slip curve. It solves a lateral impulse that
// cancels sideways velocity, clamped at `frictionSlip * suspensionForce`. So a
// tyre here has full grip right up to saturation and is saturated after it --
// there is no peak, no falloff, no progressive region.
//
// The consequence matters for everything we are about to build: SLIP ANGLE IS
// NEAR ZERO UNTIL THE TYRE HAS ALREADY LET GO. Driving tyre audio, or camera,
// or any warning channel from slip angle would fire only once the car is
// already sideways, which is precisely the problem we are trying to fix.
//
// What works instead is FRICTION UTILISATION: how much of the grip available
// at a wheel is currently being spent.
//
//     utilisation = |impulse| / (frictionSlip * suspensionForce)
//
// Both terms are exposed by Rapier per wheel. The ratio runs continuously from
// 0 to 1 as the tyre loads up, reaches 1 exactly at saturation, and is
// readable long BEFORE the limit. That is the warning channel the car is
// missing, and it is what the tyre audio, camera and assists should all key
// off rather than slip angle.
//
// Nothing here writes to the simulation. It only reads.

import { TUNING } from './tuning.js';

export const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'];

// Utilisation this close to 1 counts as "at the limit". Not 1.0 exactly: the
// impulse solver overshoots and undershoots by a percent or two between steps,
// so a strict comparison flickers.
export const AT_LIMIT = 0.97;

function makeWheel() {
  return {
    contact: false,
    load: 0,            // N, vertical force through the tyre
    lateral: 0,         // N, cornering force (signed, + to the car's right)
    longitudinal: 0,    // N, drive/brake force (signed, + forward)
    capacity: 0,        // N, the most this tyre could give in any direction
    utilisation: 0,     // 0..1, THE warning channel (== latUtil, see below)
    latUtil: 0,         // 0..1 of capacity, lateral. Clamped by the solver.
    longUtil: 0,        // of capacity, longitudinal. Exceeds 1 on wheelspin.
    combined: 0,        // friction-ellipse magnitude. For reading, not driving.
    atLimit: false,
    slipAngle: 0,       // rad, only meaningful once past the limit
  };
}

export class Telemetry {
  constructor() {
    this.wheels = [makeWheel(), makeWheel(), makeWheel(), makeWheel()];

    // Axle and car-wide roll-ups, which is what audio and camera actually
    // want -- per-wheel is for the overlay and for the assists.
    this.frontUtil = 0;
    this.rearUtil = 0;
    this.peakUtil = 0;       // the busiest tyre on the car
    this.slipSpeed = 0;      // m/s of sideways travel at the contact patches

    this.headingError = 0;   // rad between where it points and where it goes
    this.yawRate = 0;        // rad/s
    this.steerRaw = 0;       // stick before the response curve
    this.steerCurved = 0;    // after the curve, before the rate limiter
  }

  /**
   * Sample the controller after a physics step.
   *
   * `dt` is needed because Rapier reports IMPULSES (N.s) while suspension is a
   * FORCE (N); dividing by dt puts both in newtons so the ratio is meaningful
   * and the overlay can show real force figures.
   */
  sample(vehicle, dt) {
    const c = vehicle.controller;
    const w = TUNING.wheels;

    let front = 0;
    let rear = 0;
    let peak = 0;

    for (let i = 0; i < 4; i++) {
      const t = this.wheels[i];
      t.contact = c.wheelIsInContact(i);

      if (!t.contact) {
        t.load = 0; t.lateral = 0; t.longitudinal = 0; t.capacity = 0;
        t.utilisation = 0; t.latUtil = 0; t.longUtil = 0; t.combined = 0;
        t.atLimit = false;
        continue;
      }

      t.load = c.wheelSuspensionForce(i) || 0;
      t.lateral = (c.wheelSideImpulse(i) || 0) / dt;
      t.longitudinal = (c.wheelForwardImpulse(i) || 0) / dt;

      // What the tyre could deliver in total. This is the same product Rapier
      // clamps against internally, so utilisation of 1 is exactly saturation.
      t.capacity = (c.wheelFrictionSlip(i) || 0) * t.load;

      if (t.capacity > 1) {
        t.latUtil = Math.abs(t.lateral) / t.capacity;
        t.longUtil = Math.abs(t.longitudinal) / t.capacity;
        // Combined, via the friction ellipse -- a tyre spending everything on
        // braking has nothing left to corner with, and this is the number that
        // says so. Useful to look at; not the signal to drive anything from.
        t.combined = Math.hypot(t.lateral, t.longitudinal) / t.capacity;
      } else {
        t.latUtil = 0; t.longUtil = 0; t.combined = 0;
      }

      // THE warning channel is LATERAL utilisation specifically, not the
      // combined figure.
      //
      // Bullet (and so Rapier) budgets the two directions separately: the side
      // impulse is genuinely clamped at mu * load * dt, while drive torque
      // goes through a rolling-friction path that is not held to the same
      // limit. Measured under full throttle in first gear, the rears report
      // ~120% longitudinal -- that is wheelspin, and it is real, but it means
      // the combined number is not a clean 0..1 and cannot be used as "how
      // close is this tyre to letting go".
      //
      // Lateral is clamped, so it runs 0..1 and saturates at exactly the point
      // the tyre starts to slide. That is the one to drive audio and camera
      // from. longUtil above 1 stays available as a wheelspin/lock indicator.
      t.utilisation = t.latUtil;
      t.atLimit = t.latUtil >= AT_LIMIT;

      const isFront = i === 0 || i === 1;
      if (isFront) front = Math.max(front, t.utilisation);
      else rear = Math.max(rear, t.utilisation);
      peak = Math.max(peak, t.utilisation);
    }

    this.frontUtil = front;
    this.rearUtil = rear;
    this.peakUtil = peak;

    // --- chassis ------------------------------------------------------------
    const vel = vehicle.body.linvel();
    const fwd = vehicle.forward();
    const right = vehicle.right();
    this.yawRate = vehicle.body.angvel().y;

    const speed = Math.hypot(vel.x, vel.z);
    if (speed > 1.5) {
      const forwardV = vel.x * fwd.x + vel.z * fwd.z;
      const lateralV = vel.x * right.x + vel.z * right.z;
      this.headingError = Math.atan2(lateralV, Math.abs(forwardV));

      // Sideways speed at each axle, including yaw. This is what a tyre is
      // actually scrubbing, and it is what tyre audio pitch should follow once
      // the car is genuinely sliding.
      const latFront = lateralV - this.yawRate * w.frontZ;
      const latRear = lateralV + this.yawRate * w.rearZ;
      this.slipSpeed = Math.max(Math.abs(latFront), Math.abs(latRear));
    } else {
      this.headingError = 0;
      this.slipSpeed = 0;
    }
  }

  /** Raw and post-curve steering, so the input pipeline is visible. */
  setSteerTrace(raw, curved) {
    this.steerRaw = raw;
    this.steerCurved = curved;
  }
}
