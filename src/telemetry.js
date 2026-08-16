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

// Grip capacity below which a wheel is treated as not meaningfully loaded, in
// newtons. About 2% of the car's weight. See the note where it is used.
const MIN_MEANINGFUL_LOAD = 220;

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

    // How fast the rubber is moving across the road, in m/s. This is what a
    // tyre actually squeals and marks about, and it does not care which
    // direction the sliding is in -- a locked wheel under straight-line
    // braking is scrubbing exactly as hard as one sliding sideways.
    slipLong: 0,        // + spinning up, - locking
    slipLat: 0,
    slipSpeed: 0,       // magnitude of the two
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
    this.slipSpeed = 0;      // m/s, worst contact patch on the car, any direction
    this.frontSlip = 0;      // m/s, worst front tyre
    this.rearSlip = 0;       // m/s, worst rear tyre
    this._prevRotation = [0, 0, 0, 0];
    this._haveRotation = false;

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

    // Needed before the per-wheel loop: the load share decides how much of the
    // car's longitudinal acceleration each tyre is responsible for.
    let totalLoad = 0;
    for (let i = 0; i < 4; i++) {
      if (c.wheelIsInContact(i)) totalLoad += c.wheelSuspensionForce(i) || 0;
    }
    const longAccel = vehicle.gLong * 9.81;

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

      // Rapier reports the DRIVE path here but not the brake path: measured at
      // exactly zero through a full-brake stop. So longitudinal force is taken
      // as the larger of what it reports and what the car's own deceleration
      // implies, shared out by how much load each tyre is carrying. Without
      // this a threshold stop looks, to every downstream consumer, like a tyre
      // doing nothing at all.
      const reported = (c.wheelForwardImpulse(i) || 0) / dt;
      const share = totalLoad > 1 ? t.load / totalLoad : 0.25;
      const implied = vehicle.body.mass() * longAccel * share;
      t.longitudinal = Math.abs(implied) > Math.abs(reported) ? implied : reported;

      // What the tyre could deliver in total. This is the same product Rapier
      // clamps against internally, so utilisation of 1 is exactly saturation.
      t.capacity = (c.wheelFrictionSlip(i) || 0) * t.load;

      // A wheel carrying almost nothing has almost no capacity, so a few
      // newtons of noise divides into a huge ratio. Under hard braking the
      // rears unload enough for that to peg utilisation at 1 and make the car
      // scream when the rear tyres are barely touching the road. Anything
      // under ~2% of the car's weight is not meaningfully in contact.
      if (t.capacity > MIN_MEANINGFUL_LOAD) {
        t.latUtil = Math.abs(t.lateral) / t.capacity;
        t.longUtil = Math.abs(t.longitudinal) / t.capacity;
        // Combined, via the friction ellipse -- a tyre spending everything on
        // braking has nothing left to corner with, and this is the number that
        // says so. Useful to look at; not the signal to drive anything from.
        t.combined = Math.hypot(t.lateral, t.longitudinal) / t.capacity;
      } else {
        t.latUtil = 0; t.longUtil = 0; t.combined = 0;
      }

      // The warning channel is LATERAL utilisation, and deliberately not the
      // combined figure.
      //
      // Combining them seems right -- a tyre at its limit is at its limit
      // whichever direction it is being pushed -- but it makes the car squeal
      // almost constantly. Ordinary acceleration spends a large fraction of a
      // tyre's longitudinal capacity without being anywhere near sliding, so a
      // combined number sits high during perfectly normal driving and the
      // warning stops meaning anything.
      //
      // Lateral is the one that maps to "about to lose the car". Locking and
      // wheelspin are real too, but they are a different event with a
      // different threshold, and the audio treats them separately via longUtil.
      t.combined = Math.min(t.combined, 1);
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
    const forwardV = vel.x * fwd.x + vel.z * fwd.z;
    const lateralV = vel.x * right.x + vel.z * right.z;
    this.headingError = speed > 1.5 ? Math.atan2(lateralV, Math.abs(forwardV)) : 0;

    // Sideways speed at each axle, including the contribution from yaw.
    const latFront = lateralV - this.yawRate * w.frontZ;
    const latRear = lateralV + this.yawRate * w.rearZ;

    // --- contact patch slip -------------------------------------------------
    //
    // Only the LATERAL component is real here, and that is a limitation of the
    // engine rather than a choice.
    //
    // Longitudinal slip would be the difference between how fast the tyre's
    // surface is turning and how fast the car is going -- a locked wheel is
    // scrubbing at the full road speed, which is why it howls. But Rapier
    // spins its wheels KINEMATICALLY from ground speed: there is no wheel
    // rotational dynamics, so a locked wheel keeps "rotating" in the model.
    // Measured under full brakes from 30 m/s: omega * radius came to 27.0 m/s
    // against a car doing 27.2, i.e. no slip at all, all the way to a stop.
    //
    // So longitudinal loss of grip has to be read from FORCE saturation
    // (longUtil, which is measurable) rather than from speed difference. See
    // how the audio combines the two.
    let worst = 0;
    let worstFront = 0;
    let worstRear = 0;

    for (let i = 0; i < 4; i++) {
      const t = this.wheels[i];
      const isFront = i === 0 || i === 1;
      t.slipLong = 0;                       // not observable, see above
      t.slipLat = t.contact ? (isFront ? latFront : latRear) : 0;
      t.slipSpeed = Math.abs(t.slipLat);

      if (t.slipSpeed > worst) worst = t.slipSpeed;
      if (isFront) worstFront = Math.max(worstFront, t.slipSpeed);
      else worstRear = Math.max(worstRear, t.slipSpeed);
    }

    // Below walking pace everything is noise: a stationary car has wheels that
    // are not turning against a body that is not moving, and rounding makes
    // that look like slip.
    const live = speed > 1.0;
    this.slipSpeed = live ? worst : 0;
    this.frontSlip = live ? worstFront : 0;
    this.rearSlip = live ? worstRear : 0;
  }

  /** Raw and post-curve steering, so the input pipeline is visible. */
  setSteerTrace(raw, curved) {
    this.steerRaw = raw;
    this.steerCurved = curved;
  }
}
