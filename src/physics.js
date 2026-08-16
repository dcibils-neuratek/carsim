// Rapier world setup, the fixed-timestep accumulator, and the debug overlay.
//
// The vehicle runs at a fixed 1/120 s regardless of frame rate. Variable-dt
// vehicle physics goes unstable in suspension and grip, so this is load-bearing,
// not a nicety. Rendering interpolates between the last two physics states.

import * as THREE from 'three';
import RAPIER from 'rapier';
import { TUNING } from './tuning.js';

export { RAPIER };

export async function initPhysics() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: TUNING.world.gravity, z: 0 });
  world.timestep = TUNING.world.fixedStep;
  return world;
}

/**
 * Drives `stepFn` at a fixed rate and reports how far between the last two
 * steps the current frame lands, so meshes can be interpolated.
 */
export class FixedStepper {
  constructor() {
    this.accumulator = 0;
    this.alpha = 0;
    this.stepsLastFrame = 0;
  }

  advance(frameDt, stepFn) {
    const dt = TUNING.world.fixedStep;
    // Clamp the frame delta before it enters the accumulator. A tab that was
    // backgrounded for 10 s must not try to simulate 1200 steps at once.
    this.accumulator += Math.min(frameDt, dt * TUNING.world.maxStepsPerFrame);

    let steps = 0;
    while (this.accumulator >= dt && steps < TUNING.world.maxStepsPerFrame) {
      stepFn(dt);
      this.accumulator -= dt;
      steps++;
    }
    // If we hit the cap we're running slower than real time; drop the backlog
    // rather than spiralling further behind.
    if (steps === TUNING.world.maxStepsPerFrame) this.accumulator = 0;

    this.stepsLastFrame = steps;
    this.alpha = this.accumulator / dt;
    return steps;
  }
}

/** Wireframe view of every collider and contact Rapier knows about. */
export class PhysicsDebug {
  constructor(scene) {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    this.mesh = new THREE.LineSegments(
      this.geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, fog: false }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 999;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  get enabled() { return this.mesh.visible; }

  toggle() {
    this.mesh.visible = !this.mesh.visible;
    return this.mesh.visible;
  }

  update(world) {
    if (!this.mesh.visible) return;
    const { vertices, colors } = world.debugRender();

    // Rapier hands back RGBA; three's vertexColors here wants RGB.
    const rgb = new Float32Array((colors.length / 4) * 3);
    for (let i = 0, j = 0; i < colors.length; i += 4, j += 3) {
      rgb[j] = colors[i];
      rgb[j + 1] = colors[i + 1];
      rgb[j + 2] = colors[i + 2];
    }

    this.geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }
}
