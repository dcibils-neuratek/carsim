// Tyre smoke.
//
// The visual half of the same event the squeal and the skidmarks report: a
// tyre that has stopped rolling and started scrubbing. All three read from
// telemetry's slide figure, so what you hear, what you see on the road and
// what you see in the air are one thing seen three ways -- and they start and
// stop together.
//
// Deliberately NOT a constant emitter. Density and lifetime both scale with
// how hard the tyre is working, because a puff at the exit of a corner and a
// cloud from a held drift should not look the same. An emitter that runs at a
// fixed rate whenever a flag is set tells you only that something happened;
// this tells you how much.
//
// One Points draw call over a fixed pool. Particles are recycled oldest-first
// once the budget is used up, so a long drift costs no allocation and cannot
// grow without bound.

import * as THREE from 'three';
import { TUNING } from './tuning.js';

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export class TyreSmoke {
  constructor(scene, max = 700, trackDef = null) {
    // Same "is this the road" test the skidmarks and the squeal use, measured
    // against THIS circuit's grip: Snow's tarmac is only 0.55, so an absolute
    // threshold would decide the whole track was grass and never smoke at all.
    this.roadGrip = trackDef?.surface?.roadGrip ?? 1;

    // What the tyres throw up here. Tarmac gives grey rubber smoke; dirt and
    // sand give dust the colour of the ground they came off, which is the
    // difference between a rally stage and a race track with brown paint on
    // it. Falls back to the shared default when a circuit says nothing.
    this.color = new THREE.Color(trackDef?.palette?.dust ?? TUNING.smoke.color);

    this.max = max;
    this.head = 0;
    this.live = 0;

    // Parallel arrays rather than objects: this is walked in full every frame.
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.alpha0 = new Float32Array(max);

    // What the shader reads.
    this.aSize = new Float32Array(max);
    this.aAlpha = new Float32Array(max);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1));
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,          // puffs must not carve holes in each other
      uniforms: {
        uColor: { value: this.color },
        // Point size is in pixels, so it has to be scaled by the drawing
        // buffer height or the smoke changes size with the window.
        uScale: { value: 300 },
      },
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        uniform float uScale;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // Perspective: near puffs are big, far ones small.
          gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.002) discard;
          // Soft round puff: falls off toward the edge so the quad never shows.
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d);
          if (r > 0.5) discard;
          float soft = 1.0 - smoothstep(0.16, 0.5, r);
          gl_FragColor = vec4(uColor, vAlpha * soft);
        }`,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;      // over the skidmarks, under the HUD
    scene.add(this.points);

    // Fractional spawn budget per wheel, so a rate of 3.7 puffs a second
    // actually produces 3.7 rather than 3 -- and so the rate is independent
    // of frame time.
    this._carry = [0, 0, 0, 0];
    this._contact = new THREE.Vector3();
  }

  clear() {
    this.live = 0;
    this.head = 0;
    this.aAlpha.fill(0);
    this.geometry.setDrawRange(0, 0);
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  /**
   * How hard a wheel is scrubbing, 0..1, or 0 if it should not smoke at all.
   *
   * Shares telemetry's slide figure with the audio and the marks rather than
   * forming a second opinion -- the point of one definition is that the three
   * channels cannot disagree about whether the car has let go.
   */
  _intensity(vehicle, wheel) {
    const s = TUNING.smoke;
    const speed = Math.abs(vehicle.speed);
    if (speed < s.minSpeed) return 0;
    if (!vehicle.controller.wheelIsInContact(wheel)) return 0;
    // Rubber only smokes on rubber-gripping surfaces. Off the tarmac a tyre
    // throws dust and grass, which is a different effect and not this one.
    if (vehicle.gripMult[wheel] <= this.roadGrip * 0.85) return 0;

    const isRear = wheel >= 2;
    let slide = isRear ? vehicle.telemetry.rearSlide : vehicle.telemetry.frontSlide;
    if (isRear) slide = Math.max(slide, (vehicle.handbrakeInput || 0) * 0.95);
    if (slide <= s.slideStart) return 0;

    // Load matters as much as slip. A tyre carrying the car's weight through a
    // loaded corner burns; an unloaded inside wheel spinning in the air does
    // not, however fast it is turning.
    const load = clamp01((vehicle.telemetry.wheels[wheel].load || 0) / s.loadFull);
    const slip = clamp01((slide - s.slideStart) / (1 - s.slideStart));
    return slip * (s.loadFloor + (1 - s.loadFloor) * load);
  }

  update(dt, vehicle) {
    const s = TUNING.smoke;
    if (s.enabled) this._emit(dt, vehicle);
    this._advance(dt);
  }

  _emit(dt, vehicle) {
    const s = TUNING.smoke;
    const speed = Math.abs(vehicle.speed);
    const vel = vehicle.body.linvel();

    for (let i = 0; i < 4; i++) {
      const intensity = this._intensity(vehicle, i);
      if (intensity <= 0) { this._carry[i] = 0; continue; }

      // Faster scrubbing puts more rubber in the air, but with diminishing
      // returns -- past a point the tyre is already smoking as hard as it can.
      const speedFrac = Math.min(speed / s.speedFull, 1);
      const rate = s.rate * intensity * (s.speedFloor + (1 - s.speedFloor) * speedFrac);

      this._carry[i] += rate * dt;
      let n = Math.floor(this._carry[i]);
      this._carry[i] -= n;
      if (n > s.burstMax) n = s.burstMax;      // never let one long frame flood the pool

      const c = vehicle.controller.wheelContactPoint(i);
      if (!c) continue;
      this._contact.set(c.x, c.y, c.z);
      for (let k = 0; k < n; k++) this._spawn(this._contact, vel, intensity);
    }
  }

  _spawn(at, carVel, intensity) {
    const s = TUNING.smoke;
    const idx = this.head;
    this.head = (this.head + 1) % this.max;
    if (this.live < this.max) this.live++;

    const o = idx * 3;
    const r = () => Math.random() * 2 - 1;
    this.pos[o] = at.x + r() * s.spread;
    this.pos[o + 1] = at.y + 0.05;
    this.pos[o + 2] = at.z + r() * s.spread;

    // Thrown backward out of the contact patch, then it rises and spreads.
    // Carrying a fraction of the car's own velocity is what makes the cloud
    // hang where the car WAS rather than travelling along with it.
    this.vel[o] = -carVel.x * s.drag + r() * s.scatter;
    this.vel[o + 1] = s.rise * (0.6 + Math.random() * 0.8);
    this.vel[o + 2] = -carVel.z * s.drag + r() * s.scatter;

    // Both lifetime and size scale with how hard the tyre is working. This is
    // the difference between a puff and a cloud.
    this.age[idx] = 0;
    this.life[idx] = s.life * (0.55 + 0.9 * intensity);
    this.size0[idx] = s.size * (0.6 + 0.8 * intensity);
    this.alpha0[idx] = s.opacity * intensity;
  }

  _advance(dt) {
    const s = TUNING.smoke;
    const { pos, vel, age, life, size0, alpha0, aSize, aAlpha } = this;
    const drift = Math.exp(-s.slow * dt);       // air resistance on the puff

    for (let i = 0; i < this.live; i++) {
      const a = age[i] + dt;
      if (a >= life[i]) { aAlpha[i] = 0; age[i] = life[i]; continue; }
      age[i] = a;

      const o = i * 3;
      pos[o] += vel[o] * dt;
      pos[o + 1] += vel[o + 1] * dt;
      pos[o + 2] += vel[o + 2] * dt;
      vel[o] *= drift;
      vel[o + 1] = vel[o + 1] * drift + s.buoyancy * dt;
      vel[o + 2] *= drift;

      const t = a / life[i];
      // Puffs expand as they age and fade out over the back half of their
      // life, so they thin away instead of blinking out.
      aSize[i] = size0[i] * (1 + s.growth * t);
      aAlpha[i] = alpha0[i] * (1 - t * t);
    }

    this.geometry.setDrawRange(0, this.live);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  /** Point size is in pixels, so it has to follow the drawing buffer. */
  setViewportHeight(px) {
    this.material.uniforms.uScale.value = px * 0.42;
  }

  dispose() {
    this.points.parent?.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}
