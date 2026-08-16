// The 3D preview.
//
// Builds the REAL Track -- same class, same terrain, same curbs, same tree
// scatter as the game -- into its own scene with an orbit camera. Nothing here
// is a simplified stand-in, because a preview that approximates the road is a
// preview that will eventually lie to you about the thing you are trying to
// judge.
//
// The cost of that fidelity is a full rebuild per edit (terrain heightfield,
// swept ribbon, a few hundred trees), which is a few hundred milliseconds. So
// it rebuilds on a debounce after edits settle rather than during a drag, and
// the plan view carries the live feedback.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { initPhysics, RAPIER } from '../physics.js';
import { Track } from '../track.js';
import { createScene } from '../scene.js';

export class Preview3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 6000);
    this.camera.position.set(240, 220, 240);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;   // never below the horizon

    this.world = null;
    this.scene = null;
    this.track = null;
    this.marker = null;
    this.running = false;
    this.ready = false;
  }

  async init() {
    // The Track constructor builds Rapier colliders, so a world has to exist
    // even though nothing is ever stepped in it here.
    this.world = await initPhysics();
    this.ready = true;
  }

  /** Tear down the previous world and build this definition from scratch. */
  rebuild(def) {
    if (!this.ready) return;

    if (this.track) {
      // A fresh world is far more reliable than unpicking colliders one at a
      // time, and cheap: no bodies are ever simulated in it. The old one has
      // to be freed explicitly -- it lives in WASM memory that the JS garbage
      // collector cannot see, so dropping the reference alone leaks a
      // heightfield and a road trimesh on every single edit.
      this.world.free();
      this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
      disposeScene(this.scene);
    }

    const built = createScene(def);
    this.scene = built.scene;
    this.track = new Track(this.world, RAPIER, this.scene, def);

    this.marker = buildStartMarker();
    const spawn = this.track.spawnAt(0.985);
    this.marker.position.set(spawn.position.x, spawn.position.y + 0.4, spawn.position.z);
    this.scene.add(this.marker);

    built.sun.target.position.set(0, 0, 0);
    this.scene.add(built.sun.target);

    if (!this._framed) { this.frame(); this._framed = true; }
    this.resize();
  }

  /** Point the camera at the whole circuit. */
  frame() {
    if (!this.track) return;
    const pts = this.track.points;
    const box = new THREE.Box3();
    for (const p of pts) box.expandByPoint(p);
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const reach = Math.max(size.x, size.z) * 0.95;
    this.controls.target.copy(centre);
    this.camera.position.set(centre.x + reach * 0.6, centre.y + reach * 0.75, centre.z + reach * 0.9);
    this.controls.update();
  }

  /** Drop the camera onto the road at a lap progress, roughly at driver height. */
  lookAt(progress) {
    if (!this.track) return;
    const n = this.track.points.length;
    const i = Math.round(progress * n) % n;
    const p = this.track.points[i];
    const t = this.track.tangents[i];
    this.controls.target.copy(p);
    this.camera.position.set(p.x - t.x * 34 + 6, p.y + 14, p.z - t.z * 34 + 6);
    this.controls.update();
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      this.controls.update();
      if (this.scene) this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop() { this.running = false; }
}

function buildStartMarker() {
  const group = new THREE.Group();
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.18, 5, 8),
    new THREE.MeshBasicMaterial({ color: 0xffd23f }),
  );
  post.position.y = 2.5;
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffd23f }),
  );
  ball.position.y = 5.6;
  group.add(post, ball);
  return group;
}

/**
 * Release GPU memory for a scene being thrown away.
 *
 * Rebuilding on every edit without this leaks a heightfield, a swept road and
 * a few hundred tree meshes each time, and the tab is out of VRAM after a few
 * dozen edits -- which in an editor is a couple of minutes' work.
 */
function disposeScene(scene) {
  if (!scene) return;
  scene.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m) continue;
      for (const key of Object.keys(m)) {
        const v = m[key];
        if (v && v.isTexture) v.dispose();
      }
      m.dispose();
    }
  });
}
