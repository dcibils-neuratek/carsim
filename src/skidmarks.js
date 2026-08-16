// Tyre marks laid down wherever a wheel is doing something other than rolling.
//
// One mesh holds every mark. Each wheel extends its own ribbon: two triangles
// bridging the last contact point to the current one, the width of the tyre.
// Vertices live in a fixed ring buffer, so marks are never allocated at runtime
// and the oldest quietly get overwritten once the budget is used up -- no
// garbage, no unbounded growth, no frame-rate cliff after a long drift.

import * as THREE from 'three';
import { TUNING } from './tuning.js';

const VERTS_PER_SEGMENT = 6;          // two triangles
const FLOATS_PER_VERT = 3;

export class Skidmarks {
  constructor(scene, maxSegments = 2400, trackDef = null) {
    // What counts as "on the road" for this circuit. Snow's tarmac only offers
    // 0.55 grip, so an absolute threshold would treat the road itself as
    // off-track and lay no marks at all.
    this.roadGrip = trackDef?.surface?.roadGrip ?? 1;
    // Rubber on tarmac is near-black; on snow the tyres cut lighter ruts
    // through the surface rather than laying rubber down.
    this.markColor = trackDef?.palette?.skidmark ?? 0x101216;
    this.max = maxSegments;
    this.head = 0;
    this.count = 0;

    const positions = new Float32Array(maxSegments * VERTS_PER_SEGMENT * FLOATS_PER_VERT);
    const opacity = new Float32Array(maxSegments * VERTS_PER_SEGMENT);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('aOpacity', new THREE.BufferAttribute(opacity, 1));
    this.geometry.setDrawRange(0, 0);
    this.positions = positions;
    this.opacity = opacity;

    // Marks are drawn as a dark, soft-edged decal. depthWrite off with a small
    // polygon offset keeps them flush on the road without z-fighting it.
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: { uColor: { value: new THREE.Color(this.markColor) } },
      vertexShader: `
        attribute float aOpacity;
        varying float vOpacity;
        void main() {
          vOpacity = aOpacity;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vOpacity;
        void main() {
          if (vOpacity <= 0.001) discard;
          gl_FragColor = vec4(uColor, vOpacity);
        }`,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;   // one mesh spanning the whole circuit
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);

    // Per-wheel trail state.
    this.last = [0, 1, 2, 3].map(() => ({
      active: false,
      left: new THREE.Vector3(),
      right: new THREE.Vector3(),
    }));

    this._p = new THREE.Vector3();
    this._l = new THREE.Vector3();
    this._r = new THREE.Vector3();
  }

  clear() {
    this.head = 0;
    this.count = 0;
    this.opacity.fill(0);
    this.geometry.attributes.aOpacity.needsUpdate = true;
    this.geometry.setDrawRange(0, 0);
    for (const s of this.last) s.active = false;
  }

  /**
   * How hard each wheel is being abused, 0..1.
   *
   * Three separate causes, taken at their strongest:
   *   - sliding sideways (the axle's slip angle) -- covers both understeer at
   *     the front and oversteer at the rear,
   *   - locking under braking,
   *   - spinning up under power, or the handbrake dragging the rears.
   */
  _intensity(vehicle, wheel) {
    const s = TUNING.skidmarks;
    const isRear = wheel >= 2;
    const speed = Math.abs(vehicle.speed);
    if (speed < s.minSpeed) return 0;

    // Rubber goes down when the tyre is SLIDING, and that is one measurement
    // shared with the audio rather than a second opinion.
    //
    // This used to be worked out here from the brake pedal and the axle slip
    // angle, and both were wrong. brakeStartG was 0.55 against a car that
    // stops at 1.35, so merely slowing for a corner laid rubber. And slip
    // angle barely moves in this engine -- measured at 0.2 degrees across a
    // whole skidpad ramp, against a 5.7 degree threshold -- so the cornering
    // path almost never fired at all. Marks came from the pedal, with no
    // reference to whether the tyres were anywhere near their limit.
    let intensity = isRear ? vehicle.telemetry.rearSlide : vehicle.telemetry.frontSlide;

    // The handbrake locks the rears outright, so it marks regardless.
    if (isRear) {
      intensity = Math.max(intensity, (vehicle.handbrakeInput || 0) * 0.95);
    }

    // Grass and gravel don't take rubber. Measured against THIS track's road
    // grip, not an absolute -- a low-grip surface is still a road.
    const onRoad = vehicle.gripMult[wheel] > this.roadGrip * 0.85;
    return intensity * (onRoad ? 1 : 0);
  }

  update(vehicle) {
    if (!TUNING.skidmarks.enabled) return;
    const halfWidth = TUNING.wheels.width * 0.5;
    const right = vehicle.right(this._r);
    let dirty = false;

    for (let i = 0; i < 4; i++) {
      const state = this.last[i];
      const contact = vehicle.controller.wheelIsInContact(i)
        ? vehicle.controller.wheelContactPoint(i)
        : null;
      const intensity = contact ? this._intensity(vehicle, i) : 0;

      if (!contact || intensity <= 0.02) {
        state.active = false;      // break the ribbon so it doesn't leap a gap
        continue;
      }

      // Lift very slightly so the mark sits on the asphalt, not in it.
      this._p.set(contact.x, contact.y + TUNING.skidmarks.lift, contact.z);
      this._l.copy(this._p).addScaledVector(right, -halfWidth);
      const rp = new THREE.Vector3().copy(this._p).addScaledVector(right, halfWidth);

      if (state.active && state.left.distanceToSquared(this._l) > 1e-4) {
        this._pushQuad(state.left, state.right, this._l, rp, intensity);
        dirty = true;
      }

      state.left.copy(this._l);
      state.right.copy(rp);
      state.active = true;
    }

    if (dirty) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.aOpacity.needsUpdate = true;
      this.geometry.setDrawRange(0, this.count * VERTS_PER_SEGMENT);
    }
  }

  _pushQuad(a, b, c, d, intensity) {
    const seg = this.head;
    const base = seg * VERTS_PER_SEGMENT * FLOATS_PER_VERT;
    const pos = this.positions;

    // a--c   two triangles: a,b,d and a,d,c
    // |  |
    // b--d
    const write = (o, v) => { pos[o] = v.x; pos[o + 1] = v.y; pos[o + 2] = v.z; };
    write(base + 0, a); write(base + 3, b); write(base + 6, d);
    write(base + 9, a); write(base + 12, d); write(base + 15, c);

    const alpha = Math.min(intensity, 1) * TUNING.skidmarks.opacity;
    const ob = seg * VERTS_PER_SEGMENT;
    for (let k = 0; k < VERTS_PER_SEGMENT; k++) this.opacity[ob + k] = alpha;

    this.head = (this.head + 1) % this.max;
    if (this.count < this.max) this.count++;
  }
}

function smoothstep(x, edge0, edge1) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
