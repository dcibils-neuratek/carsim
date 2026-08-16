// Loading a real car model and wiring it to the physics.
//
// The physics drives five transforms: a chassis and four wheels that steer and
// spin independently. A downloaded model almost never comes that way -- this
// one has all four tyres merged into a single mesh -- so the job here is to
// take whatever arrives, orient and scale it to the tuned dimensions, split the
// wheels back out, and hand main.js the same {group, wheelMeshes} contract the
// procedural car provides.
//
// Model: "free low poly car" by Vladyslav Holhanov, CC-BY-4.0.
// https://sketchfab.com/3d-models/free-low-poly-car-38d83155e7724a14b300e156b134a1bb

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Node names whose geometry is wheels rather than bodywork.
const WHEEL_NAME = /tire|tyre|wheel|rim/i;

export async function loadCarModel(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  root.updateWorldMatrix(true, true);

  // Pull every mesh into a flat list, baked into world space, so we can stop
  // caring about the exporter's node hierarchy and unit conventions.
  const bodyGeoms = [];
  const wheelGeoms = [];
  let material = null;

  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    let isWheel = false;
    for (let n = o; n; n = n.parent) {
      if (n.name && WHEEL_NAME.test(n.name)) { isWheel = true; break; }
    }
    (isWheel ? wheelGeoms : bodyGeoms).push(geo);
    if (!material) material = o.material;
  });

  return { bodyGeoms, wheelGeoms, material, gltf };
}

/**
 * Build the render car from a loaded model, matched to the tuned dimensions.
 * Returns the same shape as scene.js createCarMesh().
 */
export function buildCarFromModel(loaded, tuning, palette) {
  const { bodyGeoms, wheelGeoms } = loaded;
  const all = bodyGeoms.concat(wheelGeoms);
  if (!all.length) throw new Error('model contained no meshes');

  // --- work out the model's own orientation and size ---
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  for (const g of all) {
    g.computeBoundingBox();
    tmp.copy(g.boundingBox);
    box.union(tmp);
  }
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // A car is longer than it is wide, and wider than it is tall. Whichever axis
  // is longest is the length; of the remaining two the shorter is height. That
  // identifies the model's axes without trusting any export convention.
  const axes = [
    { axis: 'x', len: size.x }, { axis: 'y', len: size.y }, { axis: 'z', len: size.z },
  ].sort((a, b) => b.len - a.len);
  const lengthAxis = axes[0].axis;
  const heightAxis = axes[2].axis;
  const widthAxis = axes[1].axis;

  const targetLength = tuning.chassis.halfLength * 2;
  const scale = targetLength / axes[0].len;

  // Rotate so length -> +Z and height -> +Y, then scale and centre.
  const orient = new THREE.Matrix4();
  const basis = new THREE.Matrix4();
  const ax = new THREE.Vector3(); const ay = new THREE.Vector3(); const az = new THREE.Vector3();
  unit(widthAxis, ax); unit(heightAxis, ay); unit(lengthAxis, az);
  basis.makeBasis(ax, ay, az);
  orient.copy(basis).invert();

  const transform = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(orient)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));

  const bake = (geoms) => geoms.map((g) => {
    const c = g.clone();
    c.applyMatrix4(transform);
    return c;
  });

  const body = bake(bodyGeoms);
  const wheels = bake(wheelGeoms);

  // --- split the merged wheel mesh into four ---
  const wheelParts = splitWheels(wheels, tuning);

  // --- assemble ---
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: palette.carBody, flatShading: true, roughness: 0.45, metalness: 0.25,
    vertexColors: false,
  });

  // Line the shell up with where the physics actually puts the wheels.
  //
  // Centring on the bounding box leaves the model's hubs wherever the artist
  // put them, while the simulation holds its wheels at (connectionY - sag)
  // below the body origin. Left alone the car looks jacked up or sunk into the
  // road. The static sag has a closed form: Rapier's suspension force is
  // stiffness * compression * mass, so at equilibrium 4kxm = mg gives
  // x = g / 4k, independent of mass.
  const sag = 9.81 / (4 * tuning.suspension.stiffness);
  const physicsHubY = tuning.wheels.connectionY - (tuning.suspension.restLength - sag);
  const modelHubY = wheelParts.reduce(
    (sum, g) => sum + (g.userData.hub ? g.userData.hub.y : 0), 0,
  ) / (wheelParts.length || 1);

  const bodyGeo = mergeGeometries(body);
  bodyGeo.translate(0, physicsHubY - modelHubY, 0);

  const bodyMesh = new THREE.Mesh(bodyGeo, mat);
  bodyMesh.castShadow = true;
  group.add(bodyMesh);

  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x1a1c20, flatShading: true, roughness: 0.9, metalness: 0.05,
  });
  const wheelMeshes = wheelParts.map((geo) => {
    const m = new THREE.Mesh(geo, wheelMat);
    m.castShadow = true;
    return m;
  });

  // Taillights: reuse the body material slot; the imported model has one
  // material, so brake lights are faked with a small emissive strip.
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x8c1a1a, emissive: 0xff2222, emissiveIntensity: 0.35, flatShading: true,
  });
  for (const sx of [-1, 1]) {
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.10, 0.06), tailMat);
    tail.position.set(sx * 0.42, -0.02, -tuning.chassis.halfLength + 0.02);
    group.add(tail);
  }

  return { group, wheelMeshes, tailMat, bodyMesh };
}

/**
 * Partition merged wheel geometry into four, by which quadrant each triangle
 * sits in. Wheels are the only things at the car's corners, so a sign test on
 * the triangle centroid separates them cleanly. Each part is then recentred on
 * its own hub so the physics can rotate it about its axle.
 */
function splitWheels(geoms, tuning) {
  const buckets = [[], [], [], []];   // FL, FR, RL, RR -- matches WHEEL enum
  const centres = [
    new THREE.Vector3(tuning.wheels.trackHalf, 0, tuning.wheels.frontZ),
    new THREE.Vector3(-tuning.wheels.trackHalf, 0, tuning.wheels.frontZ),
    new THREE.Vector3(tuning.wheels.trackHalf, 0, -tuning.wheels.rearZ),
    new THREE.Vector3(-tuning.wheels.trackHalf, 0, -tuning.wheels.rearZ),
  ];

  for (const geo of geoms) {
    const src = geo.index ? geo.toNonIndexed() : geo;
    const pos = src.getAttribute('position');
    for (let i = 0; i < pos.count; i += 3) {
      const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
      const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      // +x is the model's left (car forward is +Z), matching the WHEEL order.
      const idx = (cz >= 0 ? 0 : 2) + (cx >= 0 ? 0 : 1);
      const b = buckets[idx];
      for (let k = 0; k < 3; k++) {
        b.push(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k));
      }
    }
  }

  return buckets.map((verts, i) => {
    const g = new THREE.BufferGeometry();
    if (!verts.length) {
      // No geometry landed in this quadrant (a model with fewer than four
      // separable wheels). A plain cylinder keeps the car on four wheels.
      const fallback = new THREE.CylinderGeometry(
        tuning.wheels.radius, tuning.wheels.radius, tuning.wheels.width, 14,
      );
      fallback.rotateZ(Math.PI / 2);
      return fallback;
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    // Recentre on the hub so rotation happens about the axle, not the origin.
    g.computeBoundingBox();
    const c = g.boundingBox.getCenter(new THREE.Vector3());
    g.translate(-c.x, -c.y, -c.z);

    // Match the simulated wheel radius. The artist's wheels are whatever size
    // they are; the physics raycasts against tuning.wheels.radius, so a
    // mismatch shows up as wheels hovering above the road or sunk into it.
    g.computeBoundingBox();
    const s = g.boundingBox.getSize(new THREE.Vector3());
    const modelRadius = Math.max(s.y, s.z) / 2;      // spin axis is x
    if (modelRadius > 1e-4) {
      const k = tuning.wheels.radius / modelRadius;
      g.scale(1, k, k);
    }

    g.computeVertexNormals();
    g.userData.hub = c;
    return g;
  });
}

function mergeGeometries(geoms) {
  if (geoms.length === 1) return geoms[0].index ? geoms[0].toNonIndexed() : geoms[0];
  const verts = [];
  for (const geo of geoms) {
    const src = geo.index ? geo.toNonIndexed() : geo;
    const pos = src.getAttribute('position');
    for (let i = 0; i < pos.count; i++) verts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.computeVertexNormals();
  return g;
}

function unit(axis, out) {
  out.set(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  return out;
}
