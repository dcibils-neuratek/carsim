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
  }

  cycle() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
    this.orbit.enabled = this.mode === 'orbit';
    this._initialised = this.mode !== 'chase' && this._initialised;
    return this.mode;
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
    if (speed > 4) {
      this._v.divideScalar(speed);
      // Only blend when travelling forwards; reversing shouldn't spin the view.
      const alignment = this._v.x * this._fwd.x + this._v.z * this._fwd.z;
      if (alignment > 0.2) {
        const b = c.velocityBlend * Math.min((speed - 4) / 12, 1);
        dirX = THREE.MathUtils.lerp(this._fwd.x, this._v.x, b);
        dirZ = THREE.MathUtils.lerp(this._fwd.z, this._v.z, b);
      }
    }
    const len = Math.hypot(dirX, dirZ) || 1;
    dirX /= len; dirZ /= len;

    this._desired.set(
      carPos.x - dirX * c.distance,
      carPos.y + c.height,
      carPos.z - dirZ * c.distance,
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
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.lookAt);
    this._setFov(c.fovBase, vehicle, dt);
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
  }
}
