// Headlights.
//
// Two spot lights bolted to the car's group, so they inherit its position and
// heading for free and always point where the nose points.
//
// Neither one casts a shadow, deliberately. A shadow-casting spot is a second
// and third shadow map rendered every frame on top of the sun's, which is the
// single most expensive thing this scene could ask for, and it buys almost
// nothing: both lights sit at the front of the car pointing away from it, so
// the only thing they would shadow is the car itself, from behind, where you
// cannot see it. What you actually want from headlights is the pool of light
// on the road ahead, and that needs no shadow at all.
//
// They work on every circuit at any hour. At noon they are close to invisible,
// which is correct and is also what real ones do -- the point is that at dusk,
// on Snow at blue hour, or on anything genuinely dark, you can switch them on.

import * as THREE from 'three';

const COLOR = 0xfff0d4;

/**
 * The layer headlights light, and only that layer.
 *
 * Every lit material in the scene pays for every spot light in its fragment
 * shader, whether or not the beam reaches it -- so a tree 400 m off the racing
 * line, behind the car, in fog, is still running the cone test twice a frame
 * for every pixel it covers. Layers cut that: a light only illuminates objects
 * sharing one of its layers.
 *
 * What earns a place on it is the surface you drive on and the car itself. The
 * scatter -- trees, marker posts, advertising boards, all instanced -- does
 * not, and neither does the skyline, which is unlit MeshBasic anyway. The
 * camera has to be able to see the layer or the renderer culls the lights
 * outright, which looks identical to them not working.
 */
export const HEADLIGHT_LAYER = 3;

/**
 * Candela, not the 0-3 the sun and sky use.
 *
 * Spot and point lights in three are physical since r155: their intensity is
 * luminous intensity and falls off with distance squared, while a directional
 * light's is plain irradiance. The two scales are unrelated, so a spot set to
 * "2" like the sun is invisible. A real dipped beam is tens of thousands of
 * candela; this is tuned by eye against a road at blue hour rather than to a
 * datasheet, because the exposure here is not physical either.
 */
// Settled by eye on the night circuit, and the ceiling is set by CLIPPING
// rather than by taste. The renderer runs NoToneMapping, so anything over 1.0
// goes flat white with no roll-off -- and two beams that overlap add, so the
// middle saturates long before either one does on its own. That is what the
// bright blob where they meet actually was. Keeping each beam under half the
// budget means the overlap lands just under white instead of on top of it.
const MAIN_INTENSITY = 950;

export class Headlights {
  /**
   * @param {THREE.Object3D} carGroup  the car's root, forward = +Z
   * @param {object} tuning            TUNING, for the chassis dimensions
   * @param {THREE.Material[]} [frontLampMats] the front lamps' own materials,
   *   already separated from the rear ones by src/carmodel.js
   * @param {object} [world]  { scene, camera } -- when given, the beams are
   *   restricted to HEADLIGHT_LAYER and the driving surfaces are put on it.
   */
  constructor(carGroup, tuning, frontLampMats = [], world = null) {
    const c = tuning.chassis;
    const x = c.halfWidth * 0.80;
    const y = 0.56;
    const z = c.halfLength * 0.9;

    this.group = new THREE.Group();
    carGroup.add(this.group);
    this.lights = [];

    // One beam per lamp, and getting them to LOOK like two took three tries.
    //
    // Aimed near-parallel they merge into a single smear with a blown-out core.
    // Aimed steeply apart with hard edges they stop being headlights and become
    // two stage spotlights parked on the tarmac -- a car does not throw two
    // circles. What a real dipped beam throws is a long, wide, soft-edged wedge
    // that starts a few metres out and tapers away down the road.
    //
    // The control that produces the wedge is not the cone angle, it is where
    // the beam is AIMED: at a point far ahead and only a little below lamp
    // height, so the cone grazes the tarmac along its length instead of hitting
    // it head-on and stamping an ellipse. 80 m out and 0.9 m down does it.
    for (const side of [-1, 1]) {
      this.lights.push(this._beam(
        new THREE.Vector3(side * x, y, z),
        new THREE.Vector3(side * 3.0, -0.32, z + 80),
        { angle: 0.42, penumbra: 0.95, distance: 210, intensity: MAIN_INTENSITY, decay: 0.62 },
      ));
    }
    // There used to be a third, wide, weak light across the nose to stop the car
    // floating over a black hole. It is gone: a third light is a third of the
    // per-fragment lighting cost of this whole feature, paid on every lit
    // surface on screen, to fill an area the two beams can be widened slightly
    // to cover themselves. Two lights, one per lamp, is also what a car has.

    // The lamp housings themselves. Same trick as the brake lights: drive the
    // existing material's emissive rather than bolting glowing boxes onto the
    // bodywork, which reads as exactly what it is. Front only -- carmodel.js
    // splits them by which end of the car they sit on, because the rear ones
    // have to come up red, not warm white.
    this.lampMats = frontLampMats;

    if (world?.scene && world?.camera) this._restrictTo(world.scene, world.camera, carGroup);

    this.on = false;
    this.setOn(false);
  }

  /**
   * Put the beams on their own layer, and the things worth lighting on it too.
   *
   * Instanced meshes are the scatter, every one of them -- trees, posts,
   * boards. That is a more reliable test than any name, and it happens to be
   * exactly the split that matters: the road, curbs, centre line and terrain
   * are plain meshes and are what a headlight is for.
   */
  _restrictTo(scene, camera, carGroup) {
    camera.layers.enable(HEADLIGHT_LAYER);
    for (const l of this.lights) {
      l.layers.set(HEADLIGHT_LAYER);
      l.target.layers.enable(HEADLIGHT_LAYER);
    }
    scene.traverse((o) => {
      if (o.isMesh && !o.isInstancedMesh) o.layers.enable(HEADLIGHT_LAYER);
    });
    carGroup.traverse((o) => { if (o.isMesh) o.layers.enable(HEADLIGHT_LAYER); });
  }

  /**
   * `decay` is under 1 on purpose.
   *
   * Physical decay is 2, and at 2 a beam bright enough to read the road at 20 m
   * is gone by 60 -- which is honest and unplayable, because at 200 km/h you
   * cover 60 m in a second. The brief here is that the lights have to make
   * driving POSSIBLE, so the falloff is flattened until the far end of the beam
   * still shows you a corner in time to take it. The scene's exposure is not
   * physical either, so nothing is being betrayed.
   */
  _beam(pos, targetPos, { angle, penumbra, distance, intensity, decay = 1.1 }) {
    const light = new THREE.SpotLight(COLOR, intensity, distance, angle, penumbra, decay);
    light.position.copy(pos);
    light.castShadow = false;
    // The target has to be IN the graph or three leaves it at the origin, which
    // aims every beam at the middle of the car.
    light.target.position.copy(targetPos);
    this.group.add(light);
    this.group.add(light.target);
    return light;
  }

  setOn(on) {
    this.on = !!on;
    for (const l of this.lights) l.visible = this.on;
    for (const m of this.lampMats) {
      m.emissive?.setHex(COLOR);
      m.emissiveIntensity = this.on ? 1.4 : 0.0;
    }
    return this.on;
  }

  toggle() { return this.setOn(!this.on); }

  dispose() {
    for (const l of this.lights) {
      l.dispose?.();
      this.group.remove(l.target);
      this.group.remove(l);
    }
    this.group.parent?.remove(this.group);
  }
}
