// A computer driver, fast enough to be worth watching.
//
// There has been an autopilot in the test harness for a long time, but it is a
// different animal on purpose: that one exists to prove a circuit is driveable
// and is deliberately slow and timid, asking 6 m/s2 of tyres that will give
// 13. Watching it tells you nothing about a layout except that it is not
// blocked.
//
// This one is trying. It brakes for corners from far enough out to actually
// make them, it uses the width of the road to open a corner up, and it takes
// an apex. Which makes it a design tool as well as a demo: a lap you can sit
// and watch is the fastest way to find the corner that is not working, and it
// shows you WHERE the circuit is slow rather than telling you how much of it
// is.
//
// Nothing here touches the vehicle directly. It returns the same input object
// a human produces -- steer, throttle, brake, handbrake -- so the car it
// drives is exactly the car you drive, with the same physics and the same
// limits. If it cannot make a corner, neither can you.

import * as THREE from 'three';
import { TUNING } from './tuning.js';

// Fraction of the braking it has available below which it simply lifts. A
// corner 400 m away technically starts demanding a whisker of brake the moment
// it comes into range; dragging the pedal all the way down a straight for it is
// slower than coasting and looks nothing like driving.
const BRAKE_DEADBAND = 0.12;

const _pos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _toTarget = new THREE.Vector3();

export class Autopilot {
  constructor(track) {
    this.track = track;
    // How much of the tyres it is willing to use. Below 1 because a computer
    // driving at exactly the limit spends the whole lap just past it: the
    // speed target is computed from a curvature estimate, and an estimate that
    // is 5% optimistic at the limit is a spin.
    this.commitment = 0.88;
    this.enabled = false;
  }

  /** Grip available right here, from the tyres and this circuit's surface. */
  _mu() {
    const tyre = Math.min(TUNING.wheels.frictionFront, TUNING.wheels.frictionRear);
    return tyre * (this.track.def.surface?.roadGrip ?? 1) * this.commitment;
  }

  /**
   * What the road ahead demands: the fastest we may be going right now, and
   * how hard we have to brake to still make the corner that decides it.
   *
   * Braking distance is why the lookahead is not a constant. From 300 km/h it
   * takes over 200 m to get down to a hairpin; from 80 it takes 20. Looking a
   * fixed distance ahead either brakes far too early everywhere or arrives at
   * the one fast corner still flat out, and this is the single thing that
   * separates a computer that laps from one that runs wide at the end of every
   * straight.
   *
   * `demand` is the reason this returns two numbers instead of one. The brake
   * used to be driven by how far PAST the limit the car already was, which
   * meant it applied 4% of the brakes when it was 10 km/h too fast and only
   * reached full pressure 38 km/h too fast. Measured on Forest, it arrived at a
   * corner it had itself decided needed 101 km/h doing 153, having managed
   * 0.2 g of the 1.36 g it had. The planner assumed it braked at the limit the
   * moment it was over; the pedal did nothing of the kind.
   *
   * Braking at exactly `demand` is a fixed point: under constant deceleration
   * a, v^2 = vCorner^2 + 2*a*d holds all the way down, so the demand stays put
   * and the car arrives at the corner speed rather than converging on it late.
   * It rises on its own as the corner nears, which is what makes it a schedule
   * rather than a reaction.
   */
  _speedTarget(index, speed) {
    const track = this.track;
    const n = track.points.length;
    const mu = this._mu();
    const spacing = track.length / n;
    // v^2 = u^2 + 2as, solved for the distance needed to shed the speed.
    const stopping = (speed * speed) / (2 * mu * 9.81) + 25;
    const ahead = Math.max(6, Math.min(n * 0.4, Math.round(stopping / spacing)));

    let limit = Infinity;
    let demand = 0;   // m/s^2 of braking the most urgent corner in range needs
    for (let k = 3; k < ahead; k++) {
      const c = track.curvature[(index + k) % n];
      if (c <= 1e-6) continue;
      // What the corner allows, widened by how much road there is to use: a
      // line from the outside to the apex and out again turns on a bigger
      // radius than the centreline does, and on a 12 m road that is worth
      // having.
      const radius = 1 / c + track.halfWidth * 0.8;
      const corner = Math.sqrt(mu * 9.81 * radius);
      // What we may be doing HERE and still get down to it in time.
      const distance = k * spacing;
      const allowed = Math.sqrt(corner * corner + 2 * mu * 9.81 * distance);
      limit = Math.min(limit, allowed);
      // The average deceleration that gets us from here to that corner speed
      // over the road that is left. The corner needing the most is the one
      // being braked for -- not necessarily the tightest one in range.
      if (speed > corner) {
        demand = Math.max(demand, (speed * speed - corner * corner) / (2 * distance));
      }
    }
    return { limit, demand };
  }

  /**
   * Where to aim.
   *
   * Pure pursuit at a point down the road, offset toward the inside of
   * whatever is coming so the car arrives at an apex rather than tracking the
   * middle of the road all the way round. The offset is capped well inside the
   * kerb -- a computer that clips every apex to the millimetre looks like a
   * machine, and one that misses the road entirely looks broken.
   */
  _aim(index, speed) {
    const track = this.track;
    const n = track.points.length;
    const spacing = track.length / n;
    const lookahead = Math.max(8, Math.round((6 + speed * 0.75) / spacing));

    // Signed curvature over the stretch being aimed at, so the offset knows
    // which way the corner goes.
    let turn = 0;
    for (let k = 2; k < lookahead + 8; k++) {
      const i = (index + k) % n;
      const a = track.points[i];
      const b = track.points[(i + 2) % n];
      const t = track.tangents[i];
      const r = track.rights[i];
      turn += ((b.x - a.x) * r.x + (b.z - a.z) * r.z) * 0.02;
      void t;
    }
    const lean = THREE.MathUtils.clamp(turn * 0.35, -1, 1);

    const at = (index + lookahead) % n;
    const p = track.points[at];
    const r = track.rights[at];
    const off = -lean * (track.halfWidth - 2.0);
    _target.set(p.x + r.x * off, p.y, p.z + r.z * off);
    return _target;
  }

  /** One frame of driving. Returns the same shape the human input produces. */
  update(vehicle) {
    const track = this.track;
    vehicle.position(_pos);
    const projection = track.project(_pos);
    const speed = Math.abs(vehicle.speed);

    const aim = this._aim(projection.index, speed);
    _toTarget.subVectors(aim, _pos);

    const fwd = vehicle.forward();
    const right = vehicle.right();
    const lateral = _toTarget.x * right.x + _toTarget.z * right.z;
    const ahead = Math.max(_toTarget.x * fwd.x + _toTarget.z * fwd.z, 1);
    const steer = THREE.MathUtils.clamp((lateral / ahead) * 2.2, -1, 1);

    const mu = this._mu();
    const { limit: target, demand } = this._speedTarget(projection.index, speed);

    // A dead band, so it is not alternating throttle and brake down a straight
    // at the exact speed it wants -- which reads as a nervous driver and
    // upsets the car on the way into a corner.
    const error = target - speed;
    let throttle = error > 1.5 ? 1 : error > 0 ? 0.35 : 0;

    // Brake to the schedule. `capacity` is already commitment-scaled, so a
    // demand equal to it asks for 100% pedal while leaving the real tyres a
    // margin. The dead band keeps the brakes off for a corner so distant that
    // lifting covers it, which is most of a lap.
    const capacity = mu * 9.81;
    const brake = demand > capacity * BRAKE_DEADBAND
      ? Math.min(1, demand / capacity)
      : 0;
    if (brake > 0) throttle = 0;

    // --- traction ------------------------------------------------------------
    //
    // A tyre has one grip budget and cornering is already spending some of it.
    // Asking for full power on the way out of a corner is asking for grip that
    // is not there, and in a 770 hp car the answer is the back end. Measured on
    // the SC18 before this existed: the rear was fully loose for 13% of the
    // lap, which is not a driver, it is a passenger.
    //
    // The friction circle says what is left: if a fraction u of the grip is
    // going sideways, sqrt(1 - u^2) of it remains for driving. That is the cap.
    const lateralUse = Math.min(1, Math.abs(vehicle.gLat || 0) / (mu / 0.88));
    throttle *= Math.sqrt(Math.max(0, 1 - lateralUse * lateralUse));

    // And a direct answer to a rear that is already going: lift until it grips
    // again. A real driver does this without being able to explain it.
    const sliding = vehicle.telemetry?.rearSlide ?? 0;
    throttle *= Math.max(0.1, 1 - sliding * 1.3);

    return {
      steer,
      throttle,
      brake,
      handbrake: 0,
      shiftUp: false,
      shiftDown: false,
      reset: false,
      camera: false,
      toggleGearbox: false,
      lookX: 0,
      lookY: 0,
      source: 'autopilot',
      // Handy on the debug overlay while tuning a layout.
      telemetry: { target: target * 3.6, index: projection.index, demand },
    };
  }
}
