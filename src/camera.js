// Chase / hood / free-orbit cameras.
//
// The chase camera is a critically-damped spring toward a point behind the car,
// with the follow yaw blended between where the car points and where it is
// actually going. That blend is what makes a slide legible: at full car-heading
// the camera swings with the drift and you lose the road; at full velocity it
// feels detached. Somewhere around 0.35 reads best.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TUNING } from './tuning.js';

export const CAMERA_MODES = ['chase', 'hood', 'orbit'];

export class CarCamera {
  constructor(camera, domElement, groundHeightAt) {
    this.camera = camera;
    this.groundHeightAt = groundHeightAt || (() => -Infinity);
    this.mode = 'chase';
    // Right stick look-around, in radians off the chase camera's own heading.
    // Kept separate from `mode` so it layers on top of normal following rather
    // than replacing it: let go and the view eases back behind the car.
    this.lookYaw = 0;
    this.lookPitch = 0;

    this.position = new THREE.Vector3(0, 5, -10);
    this.lookAt = new THREE.Vector3();
    this._initialised = false;

    this.orbit = new OrbitControls(camera, domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.enabled = false;

    this._v = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._view = new THREE.Vector3();

    // Impact shake, and the vertical velocity it is differenced from.
    this._shake = 0;
    this._prevVy = 0;
    // Smoothed camera-distance offset from longitudinal g.
    this._pull = 0;
  }

  cycle() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
    this.orbit.enabled = this.mode === 'orbit';
    this._initialised = this.mode !== 'chase' && this._initialised;
    return this.mode;
  }

  /**
   * Right-stick look, applied on top of the chase camera.
   *
   * Held, it swings the view around the car for a proper walk-around; released,
   * it returns, because a camera that stays where you left it is one you have
   * to keep tidying up mid-corner.
   */
  look(dt, x, y) {
    const c = TUNING.camera;
    const dead = c.lookDeadzone;
    const ax = Math.abs(x) > dead ? x : 0;
    const ay = Math.abs(y) > dead ? y : 0;

    if (ax !== 0 || ay !== 0) {
      this.lookYaw += ax * c.lookSpeed * dt;
      this.lookPitch = THREE.MathUtils.clamp(
        this.lookPitch + ay * c.lookSpeed * 0.5 * dt, -0.45, 1.15,
      );
      // Wrap so a full circle keeps going instead of winding up a big number.
      if (this.lookYaw > Math.PI) this.lookYaw -= Math.PI * 2;
      if (this.lookYaw < -Math.PI) this.lookYaw += Math.PI * 2;
    } else {
      const k = Math.min(c.lookReturn * dt, 1);
      this.lookYaw += (0 - this.lookYaw) * k;
      this.lookPitch += (0 - this.lookPitch) * k;
    }
  }

  update(dt, carGroup, vehicle) {
    const c = TUNING.camera;
    const carPos = carGroup.position;

    if (this.mode === 'orbit') {
      this.orbit.target.copy(carPos);
      this.orbit.update();
      return;
    }

    if (this.mode === 'hood') {
      this._desired.set(0, 0.62, 0.20).applyQuaternion(carGroup.quaternion).add(carPos);
      this.camera.position.copy(this._desired);
      this._fwd.set(0, 0, 1).applyQuaternion(carGroup.quaternion);
      this._target.copy(carPos).addScaledVector(this._fwd, 40).setY(carPos.y + 1.0);
      this.camera.up.set(0, 1, 0).applyQuaternion(carGroup.quaternion);
      this.camera.lookAt(this._target);
      this._setFov(c.fovBase + 4, vehicle, dt);
      return;
    }

    // --- chase ---
    this._fwd.set(0, 0, 1).applyQuaternion(carGroup.quaternion);

    // Blend the follow direction toward the velocity vector so the camera
    // trails the car's actual path rather than its nose.
    const vel = vehicle.body.linvel();
    this._v.set(vel.x, 0, vel.z);
    const speed = this._v.length();
    let dirX = this._fwd.x, dirZ = this._fwd.z;
    this.driftAngle = 0;
    if (speed > 4) {
      this._v.divideScalar(speed);
      const alignment = this._v.x * this._fwd.x + this._v.z * this._fwd.z;

      // Fade the lead out only once the car is genuinely going BACKWARDS.
      //
      // This used to be a hard `alignment > 0.2` cutoff, which meant the lead
      // vanished the instant the slide passed 78 degrees -- the camera
      // snapping back to the nose at the exact moment the car was most
      // sideways and you most needed to see where you were going. The cap
      // already prevents the view swinging away, so the only case still worth
      // guarding is reverse, where velocity is near-opposite to the nose and
      // the drift angle flips sign across +/-180 degrees. That flip is what
      // would spin the view, and this band is placed to be over well before
      // it can happen.
      const engaged = THREE.MathUtils.clamp((alignment + 0.35) / 0.30, 0, 1);
      if (engaged > 0) {
        // The drift angle: how far the car's PATH is off its NOSE.
        //
        // Worked out as an ANGLE and then rotated, rather than lerping the two
        // direction vectors. A vector lerp has no angle in it to cap, and it
        // also shortens toward nothing as the two directions separate -- so
        // the effect quietly changed character exactly when the car was most
        // sideways. Rotating by a clamped angle behaves the same for small
        // slip and stays sane at large.
        const cross = this._fwd.x * this._v.z - this._fwd.z * this._v.x;
        const drift = Math.atan2(cross, alignment);
        this.driftAngle = drift;

        const lead = engaged * THREE.MathUtils.clamp(
          drift * c.velocityBlend * Math.min((speed - 4) / 12, 1),
          -c.slideYawMax, c.slideYawMax,
        );
        const cs = Math.cos(lead), sn = Math.sin(lead);
        dirX = this._fwd.x * cs - this._fwd.z * sn;
        dirZ = this._fwd.x * sn + this._fwd.z * cs;
      }
    }
    const len = Math.hypot(dirX, dirZ) || 1;
    dirX /= len; dirZ /= len;

    // Swing the follow direction by the look angle. Rotating the DIRECTION
    // rather than the finished camera position means the spring, the
    // look-ahead and the velocity blend all keep working while you look
    // around -- the camera orbits the car instead of detaching from it.
    if (this.lookYaw !== 0) {
      const cs = Math.cos(this.lookYaw);
      const sn = Math.sin(this.lookYaw);
      const rx = dirX * cs - dirZ * sn;
      const rz = dirX * sn + dirZ * cs;
      dirX = rx; dirZ = rz;
    }

    // Being shoved. The car pulls away from the camera under power and runs
    // back at it under braking -- bounded and smoothed, so it is a sensation
    // rather than the camera surging about.
    const pullTarget = THREE.MathUtils.clamp(
      vehicle.lastAccel * c.accelPull, -c.accelPullMax, c.accelPullMax,
    );
    this._pull += (pullTarget - this._pull) * Math.min(c.accelPullRate * dt, 1);
    const distance = c.distance + this._pull;

    this._desired.set(
      carPos.x - dirX * distance,
      carPos.y + c.height + this.lookPitch * distance,
      carPos.z - dirZ * distance,
    );

    // Cancel the follow lag.
    //
    // Easing toward a point behind the car is a first-order lag, so it settles
    // with a steady-state error of velocity / stiffness -- the camera trails
    // further the faster you go (3.4 m at 100 km/h), and the car shrinks away
    // toward the horizon. Feeding the velocity forward puts the target where
    // the car is *heading*, which cancels that error exactly while leaving the
    // spring free to smooth direction changes.
    this._desired.x += vel.x / c.stiffness;
    this._desired.z += vel.z / c.stiffness;

    // Never let the camera sink into a hill behind the car.
    const ground = this.groundHeightAt(this._desired.x, this._desired.z);
    if (Number.isFinite(ground)) this._desired.y = Math.max(this._desired.y, ground + 0.9);

    if (!this._initialised) {
      this.position.copy(this._desired);
      this.lookAt.copy(carPos);
      this._initialised = true;
    }

    // Frame-rate independent exponential smoothing.
    const k = 1 - Math.exp(-c.stiffness * dt);
    this.position.lerp(this._desired, k);

    this._target.set(
      carPos.x + dirX * c.lookAhead,
      carPos.y + c.lookHeight,
      carPos.z + dirZ * c.lookAhead,
    );
    this.lookAt.lerp(this._target, Math.min(k * 1.35, 1));

    this.camera.position.copy(this.position);

    // Roll the horizon with the chassis, at a fraction of it. The car leaning
    // on its outside springs is the clearest picture of where the load has
    // gone, and copying a little of it puts that in the frame itself rather
    // than only in the car.
    this._up.set(0, 1, 0);
    if (c.rollFactor !== 0) {
      this._right.set(1, 0, 0).applyQuaternion(carGroup.quaternion);
      const roll = Math.asin(THREE.MathUtils.clamp(this._right.y, -1, 1));
      this._view.copy(this.lookAt).sub(this.position);
      if (this._view.lengthSq() > 1e-6) {
        this._view.normalize();
        // Sign verified by measurement, not by reasoning about handedness:
        // at rollFactor 1 a banked car must render UPRIGHT, the camera roll
        // exactly cancelling the chassis roll. The other sign doubles the
        // apparent lean instead -- 36.6 degrees where 0 was wanted.
        this._up.applyAxisAngle(this._view, roll * c.rollFactor);
      }
    }
    this.camera.up.copy(this._up);

    this.camera.lookAt(this.lookAt);

    // Shake goes on AFTER lookAt, so a jolt moves the camera without also
    // swinging where it is pointed -- shaking the aim as well reads as the
    // whole world wobbling rather than as the car being hit.
    this._updateShake(dt, vehicle);
    if (this._shake > 0) {
      const s = this._shake;
      this.camera.position.x += (Math.random() * 2 - 1) * s;
      this.camera.position.y += (Math.random() * 2 - 1) * s;
      this.camera.position.z += (Math.random() * 2 - 1) * s;
    }

    this._setFov(c.fovBase, vehicle, dt);
  }

  /**
   * Impact shake from upward acceleration at the chassis.
   *
   * A kerb, a landing and a hard bump are all the same event seen from here --
   * the suspension being compressed hard enough to throw the body upward -- so
   * one signal covers the lot without having to be told which happened.
   *
   * Only UPWARD counts. Falling is not an impact; arriving is. On a smooth
   * road the springs hold the body near equilibrium and this sits close to
   * zero however heavily loaded they are, which is what lets a threshold
   * separate a real hit from ordinary suspension work.
   */
  _updateShake(dt, vehicle) {
    const c = TUNING.camera;
    const vy = vehicle.body.linvel().y;
    const accelY = (vy - this._prevVy) / Math.max(dt, 1e-4);
    this._prevVy = vy;

    const jolt = Math.max(0, accelY - c.shakeFloor);
    if (jolt > 0) {
      this._shake = Math.min(this._shake + jolt * c.shake * 0.001, c.shakeMax);
    }
    this._shake *= Math.exp(-c.shakeDecay * dt);
    if (this._shake < 1e-4) this._shake = 0;
  }

  _setFov(base, vehicle, dt) {
    const c = TUNING.camera;
    const speedFrac = Math.min(Math.abs(vehicle.speed) / 72, 1);
    const target = base + c.fovGain * speedFrac * speedFrac;
    this.camera.fov += (target - this.camera.fov) * Math.min(3.5 * dt, 1);
    this.camera.updateProjectionMatrix();
  }

  /** Drop the smoothing so a respawn doesn't fly the camera across the map. */
  snap() {
    this._initialised = false;
    // A respawn is a teleport, not an impact. Without this the velocity step
    // it creates reads as an enormous jolt and the camera shakes on arrival.
    this._shake = 0;
    this._prevVy = 0;
    this._pull = 0;
  }
}
