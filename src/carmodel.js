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
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Node names whose geometry is wheels rather than bodywork.

// Named light clusters, if a model happens to have them.
const TAIL_NAME = /tail|rear.?light|brake.?light|stop.?light/i;
const WHEEL_NAME = /tire|tyre|wheel|rim/i;

export async function loadCarModel(url) {
  const loader = new GLTFLoader();

  // Draco, because an optimised export very likely is. Without a decoder
  // GLTFLoader throws "No DRACOLoader instance provided", the car falls back
  // to the procedural shell, and it reads as the model being broken rather
  // than the loader being unable to read it.
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/draco/');
  loader.setDRACOLoader(draco);

  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;
  root.updateWorldMatrix(true, true);

  // Pull every mesh into a flat list, baked into world space, so we can stop
  // caring about the exporter's node hierarchy and unit conventions.
  // Each part keeps its OWN material. The model is painted by whoever made it
  // -- body colour, glass, lights, trim -- and merging everything under one
  // material threw all of that away and repainted the car a flat red.
  const bodyParts = [];
  const wheelGeoms = [];
  const all = [];

  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    let named = false;
    for (let n = o; n; n = n.parent) {
      if (n.name && WHEEL_NAME.test(n.name)) { named = true; break; }
    }
    all.push({ geo, material: o.material, name: o.name || '', named });
  });

  // Names first, geometry second.
  //
  // Name matching works beautifully on a model whose author named things, and
  // not at all on one exported as Object_7, Object_9, Object_10 -- which two
  // of the four cars here are. Falling back to WHERE a mesh sits rather than
  // what it is called makes the loader work on any model: the wheels are the
  // meshes clustered at the four corners of the footprint, low down. That is
  // true of every car ever made, and it needs no cooperation from the
  // exporter.
  const anyNamed = all.some((p) => p.named);
  const isWheel = anyNamed ? (p) => p.named : geometricWheelTest(all);

  for (const part of all) {
    if (isWheel(part)) wheelGeoms.push(part.geo);
    else bodyParts.push({ geo: part.geo, material: part.material, name: part.name });
  }

  return { bodyParts, wheelGeoms, gltf };
}

/**
 * A wheel test built from the model's own proportions, for models whose meshes
 * have no useful names.
 *
 * A wheel sits in the lower part of the car, out toward a corner, and is small
 * relative to the whole. Anything failing one of those is bodywork. The
 * thresholds are fractions of the model's bounding box rather than metres, so
 * this works whatever units the exporter used -- and the cars here arrive in
 * both metres and some private unit a hundred times smaller.
 */
function geometricWheelTest(parts) {
  const bounds = new THREE.Box3();
  const box = new THREE.Box3();
  for (const p of parts) {
    p.geo.computeBoundingBox();
    bounds.union(p.geo.boundingBox);
  }
  const size = bounds.getSize(new THREE.Vector3());
  const min = bounds.min;
  // Longest horizontal axis is the car's length whichever way it was authored.
  const lengthAxis = size.z >= size.x ? 'z' : 'x';
  const widthAxis = lengthAxis === 'z' ? 'x' : 'z';
  const length = size[lengthAxis];
  const width = size[widthAxis];

  return (p) => {
    box.copy(p.geo.boundingBox);
    const s = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    // Low: the whole mesh sits under half the car's height.
    if ((c.y - min.y) > size.y * 0.5) return false;
    // Small: a wheel is a fraction of the car, a floorpan is not.
    if (s[lengthAxis] > length * 0.30 || s[widthAxis] > width * 0.42) return false;
    // Outboard, both along and across: a wheel is at a corner, an exhaust is
    // low and central and a sill is long and lateral.
    const along = Math.abs((c[lengthAxis] - min[lengthAxis]) / length - 0.5);
    const across = Math.abs((c[widthAxis] - min[widthAxis]) / width - 0.5);
    return along > 0.16 && across > 0.22;
  };
}

/**
 * Build the render car from a loaded model, matched to the tuned dimensions.
 * Returns the same shape as scene.js createCarMesh().
 */
export function buildCarFromModel(loaded, tuning, palette, yaw = 0) {
  const { bodyParts, wheelGeoms } = loaded;
  const all = bodyParts.map((p) => p.geo).concat(wheelGeoms);
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

  // Which END is the front cannot be measured, only stated.
  //
  // The basis above finds the model's length axis and points it along +Z, but
  // "longest axis" is symmetric -- it identifies the LINE the car lies on, not
  // the direction it faces. A model authored nose-down-negative comes out
  // driving backwards, and no amount of looking at the bounding box can tell
  // you which it is: a car is not reliably taller, wider or blunter at either
  // end (a mid-engined Ferrari and a front-engined Charger disagree about all
  // three). So it is a per-car number in cars.js rather than a heuristic that
  // would be wrong half the time and inscrutable when it was.
  const yawFix = new THREE.Matrix4().makeRotationY(yaw);

  const transform = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(yawFix)
    .multiply(orient)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));

  const bake = (geoms) => geoms.map((g) => {
    const c = g.clone();
    c.applyMatrix4(transform);
    return c;
  });

  const wheels = bake(wheelGeoms);

  // --- split the merged wheel mesh into four ---
  const wheelParts = splitWheels(wheels, tuning);

  // --- assemble ---
  const group = new THREE.Group();

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

  // The model is drawn AS AUTHORED: its own materials, its own shading, its
  // own geometry.
  //
  // There was a pipeline here once -- merge by material, drop hidden parts,
  // bake atlas swatches into flat colours -- all of it built to make a 244k
  // triangle, 954 mesh model behave. None of that is this file's business once
  // the model arrives optimised, and every step was a chance to misrepresent
  // what the artist actually made. Optimise the asset, not the loader.
  // Flat shading is the one thing imposed on the model, and only that: its
  // colours, maps and material types are left exactly as authored. Smooth
  // normals on the car against a world of flat-shaded polygons read as a
  // photoreal object parked in a cartoon, and the car is the thing you look at
  // for the whole session.
  //
  // Materials are shared between parts in a glTF, so each is converted once
  // and reused -- flipping the flag per part would rebuild the same shader
  // program repeatedly for no reason.
  const flattened = new Map();
  const flatten = (material) => {
    if (!material) return material;
    if (!flattened.has(material.uuid)) {
      const m = material.clone();
      m.flatShading = true;

      // Trade refraction for plain transparency on the glass.
      //
      // A single material with transmission > 0 makes three render the WHOLE
      // SCENE a second time into a framebuffer so the glass can refract it.
      // Measured here: three such meshes cost 2.45 ms of a 4.50 ms frame --
      // 54% of the render, for physically-correct refraction through side
      // windows, on a car made of flat-shaded polygons, seen from behind at
      // 200 km/h. Nobody will ever see what it buys.
      if ((m.transmission ?? 0) > 0) {
        m.transmission = 0;
        m.transparent = true;
        m.opacity = 0.34;
        m.depthWrite = false;
      }

      m.needsUpdate = true;
      flattened.set(material.uuid, m);
    }
    return flattened.get(material.uuid);
  };

  // The shell hangs in its own group so it can be leant on its springs
  // independently of the wheels, which have to stay on the road. See
  // Vehicle._leanBody.
  const bodyGroup = new THREE.Group();
  group.add(bodyGroup);

  const lift = physicsHubY - modelHubY;
  const bodyMeshes = bodyParts.map(({ geo, material, name }) => {
    const g = geo.clone();
    g.applyMatrix4(transform);
    g.translate(0, lift, 0);
    const mesh = new THREE.Mesh(g, flatten(material));
    mesh.castShadow = true;
    mesh.name = material?.name || name || '';
    bodyGroup.add(mesh);
    return mesh;
  });

  const triangles = bodyMeshes.reduce((n, m) => n + (m.geometry.index
    ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
  console.info(
    `car model: ${bodyMeshes.length} meshes, ${Math.round(triangles / 1000)}k triangles`,
  );

  const bodyMesh = bodyMeshes[0] || null;

  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x1a1c20, flatShading: true, roughness: 0.9, metalness: 0.05,
  });
  const wheelMeshes = wheelParts.map((geo) => {
    const m = new THREE.Mesh(geo, wheelMat);
    m.castShadow = true;
    return m;
  });

  // Brake lights.
  //
  // The old approach bolted two emissive boxes onto the back of the model at
  // guessed coordinates. On a shell that already has its own light clusters
  // that read as exactly what it was -- two red bricks floating over the
  // bodywork -- so they are gone.
  //
  // The logic is kept, because the right version is close: now that parts
  // carry their own materials, a real brake light is a matter of finding the
  // cluster by name and driving ITS emissive. Nothing in this model is named
  // for its lights, so setBrakeLights is a no-op here and the hook stays for
  // when a model arrives that is.
  const tailMats = bodyMeshes
    .filter((m) => TAIL_NAME.test(m.name))
    .map((m) => m.material);

  const setBrakeLights = (on) => {
    for (const m of tailMats) {
      m.emissive?.setHex(0xff2222);
      m.emissiveIntensity = on ? 1.7 : 0.0;
    }
  };

  return { group, bodyGroup, wheelMeshes, bodyMesh, bodyMeshes, setBrakeLights, tailMats };
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

/**
 * Concatenate geometries into one.
 *
 * Carries UVs when every input has them, because the model's materials may be
 * textured and a merge that quietly dropped them would leave the car painted
 * in flat base colours with no obvious cause. Normals are recomputed rather
 * than carried: everything here renders flat-shaded, so the originals would be
 * thrown away anyway.
 */
function mergeGeometries(geoms) {
  if (geoms.length === 1) return geoms[0].index ? geoms[0].toNonIndexed() : geoms[0];

  const sources = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  const withUv = sources.every((g) => g.getAttribute('uv'));

  const verts = [];
  const uvs = [];
  for (const src of sources) {
    const pos = src.getAttribute('position');
    const uv = withUv ? src.getAttribute('uv') : null;
    for (let i = 0; i < pos.count; i++) {
      verts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (uv) uvs.push(uv.getX(i), uv.getY(i));
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  if (withUv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

function unit(axis, out) {
  out.set(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  return out;
}
