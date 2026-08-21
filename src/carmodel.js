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
// Rear lights, by mesh or material name.
//
// Two traps here, both found on a Lancia whose entire back end lit up under
// braking. The word boundary is load-bearing: without it `tail` matches inside
// `deTAIL`, and this model has a `detail_1` mesh and four `Chrome_Detail`
// meshes -- the mud flaps, the aerial, the rear window trim and the wiper.
// They all glowed and the actual lights did not.
//
// And the lights did not because the name was the other way round. Matching
// only `rear.?light` misses `Light_Rear` and `LightBump_rear`, which is how
// this model spells it, so both orders are matched now.
const TAIL_NAME = /\btail|rear.?light|light.{0,6}rear|brake.?light|stop.?light/i;
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
    const geo = deNormalize(o.geometry.clone());
    geo.applyMatrix4(o.matrixWorld);
    let named = false;
    for (let n = o; n; n = n.parent) {
      if (n.name && WHEEL_NAME.test(n.name)) { named = true; break; }
    }
    // Materials count as names too, and on some exports they are the ONLY
    // names. A model can arrive with every node called Object_7 while its
    // materials are called tire, tire_side, brakedisk and rimlogo -- which
    // happens whenever the exporter groups geometry by material rather than by
    // part. Reading only the node names threw that away and left the wheels
    // welded into the bodywork, where they neither steer nor turn.
    if (!named) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      named = mats.some((m) => m && m.name && WHEEL_NAME.test(m.name));
    }
    all.push({ geo, material: o.material, name: o.name || '', named });
  });

  discardScenery(all);

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

  absorbWheelParts(wheelGeoms, bodyParts);

  return { bodyParts, wheelGeoms, gltf };
}

/**
 * Move rims, discs and anything else built around the hub out of the bodywork
 * and into the wheels, in place.
 *
 * Naming finds the tyre and stops. On a model grouped by material the rim is
 * whatever the paint material happened to be called -- on the F1 it is
 * "McLaren_F1_1993_By_Alex_Ka", twelve thousand triangles of it -- and the
 * brake disc is a separate mesh again. Left in the body they stand still while
 * the tyre turns inside them, and since a tyre is a plain black ring the car
 * reads as having wheels that do not rotate at all. That is what it looked
 * like: static wheels, when in fact the only part that was spinning was the
 * one part with nothing on it to show the spin.
 *
 * Two tests, both against the wheels already found, and a part must pass in at
 * least two corners to move -- a mesh holding all four rims passes in four,
 * while something that merely happens to be round in one corner does not.
 *
 * ROUND about the axle, seen from the side. A rim and a disc are; a suspension
 * arm crossing the same space is not, and on this model neither is the
 * underbody or the wheel-arch liner.
 *
 * CENTRED on the hub. This is the one that keeps the front repeater lamp out:
 * it is small and round and sits inside the wheel's box, and only its distance
 * from the axle gives it away.
 */
function absorbWheelParts(wheelGeoms, bodyParts) {
  if (!wheelGeoms.length || !bodyParts.length) return;

  const union = new THREE.Box3();
  for (const g of wheelGeoms) { g.computeBoundingBox(); union.union(g.boundingBox); }
  const mid = union.getCenter(new THREE.Vector3());
  const span = union.getSize(new THREE.Vector3());
  // The car has not been oriented yet at this point -- that happens later, in
  // buildCarFromModel -- so the length axis has to be found rather than
  // assumed. Written assuming +Z, this silently did nothing at all on a model
  // authored along X, which is a whole class of car it would have refused.
  const LEN = span.x >= span.z ? 'x' : 'z';
  const WID = LEN === 'x' ? 'z' : 'x';
  // Four wheels across one wheel's height, so the height is a diameter.
  const radius = span.y / 2;
  if (!(radius > 0)) return;

  const CORNERS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ROUND = 0.75;       // side-on aspect ratio a wheel part must reach
  const OFF_AXLE = 0.35;    // how far off the hub its centre may sit, in radii

  // Reduce one mesh to its extents inside one corner of the car.
  const inCorner = (geo, sl, sw) => {
    const pos = geo.attributes.position;
    let ylo = Infinity; let yhi = -Infinity; let llo = Infinity; let lhi = -Infinity;
    let n = 0;
    for (let i = 0; i < pos.count; i++) {
      const l = LEN === 'x' ? pos.getX(i) : pos.getZ(i);
      const wdt = WID === 'x' ? pos.getX(i) : pos.getZ(i);
      if ((l - mid[LEN]) * sl < 0 || (wdt - mid[WID]) * sw < 0) continue;
      const y = pos.getY(i);
      n++;
      if (y < ylo) ylo = y; if (y > yhi) yhi = y;
      if (l < llo) llo = l; if (l > lhi) lhi = l;
    }
    return { n, y: (ylo + yhi) / 2, l: (llo + lhi) / 2, sy: yhi - ylo, sl: lhi - llo };
  };

  const hubs = CORNERS.map(([sl, sw]) => {
    let best = null;
    for (const g of wheelGeoms) {
      const c = inCorner(g, sl, sw);
      if (c.n && (!best || c.n > best.n)) best = c;
    }
    return best && best.n ? best : null;
  });

  // A hair of tolerance on the containment test, and it is not cosmetic. A
  // model whose wheels arrive as one mesh per AXLE gives a union exactly as
  // wide as the track, and the rim inside it is exactly as wide again -- so an
  // exact containsBox() rejected the rims of this car by a rounding error.
  // Nothing that is not a wheel gains entry from 24 mm, and everything still
  // has to pass the roundness and off-axle tests below.
  const room = union.clone().expandByScalar(radius * 0.08);

  for (let i = bodyParts.length - 1; i >= 0; i--) {
    const geo = bodyParts[i].geo;
    geo.computeBoundingBox();
    if (!room.containsBox(geo.boundingBox)) continue;

    let corners = 0;
    for (let k = 0; k < CORNERS.length; k++) {
      const hub = hubs[k];
      if (!hub) continue;
      const c = inCorner(geo, CORNERS[k][0], CORNERS[k][1]);
      if (c.n < 24) continue;
      if (Math.min(c.sy, c.sl) / Math.max(c.sy, c.sl, 1e-6) < ROUND) continue;
      if (Math.hypot(c.y - hub.y, c.l - hub.l) > radius * OFF_AXLE) continue;
      corners++;
    }
    if (corners >= 2) {
      wheelGeoms.push(geo);
      bodyParts.splice(i, 1);
    }
  }
}

/**
 * Turn quantized integer attributes back into plain floats, in place.
 *
 * `gltf-transform optimize` -- the command this project's own docs tell you to
 * run -- writes KHR_mesh_quantization: positions become normalized integers and
 * the scale that turns them back into metres is left in the node matrix. Three
 * renders that correctly, and every node carries its own scale, so a file can
 * hold factors of 7.1 and 0.04 side by side.
 *
 * Baking the node matrix into the geometry is how this loader stops caring
 * about the exporter's hierarchy, and on a quantized mesh it quietly destroys
 * the model: applyMatrix4 writes the transformed values straight back into the
 * Int16 array, so the normalization is lost and every mesh collapses to the
 * ±1 cube the integers describe. It does not throw. The car simply arrives as
 * a 2 x 2 x 2 block, and since scale and orientation are both read off the
 * bounding box, everything after it is wrong too.
 *
 * getX/getY/getZ apply the normalization, which is what makes this a copy
 * rather than a calculation.
 */
function deNormalize(geo) {
  for (const [name, attr] of Object.entries(geo.attributes)) {
    if (!attr.normalized) continue;
    const out = new Float32Array(attr.count * attr.itemSize);
    for (let i = 0; i < attr.count; i++) {
      const at = i * attr.itemSize;
      if (attr.itemSize > 0) out[at] = attr.getX(i);
      if (attr.itemSize > 1) out[at + 1] = attr.getY(i);
      if (attr.itemSize > 2) out[at + 2] = attr.getZ(i);
      if (attr.itemSize > 3) out[at + 3] = attr.getW(i);
    }
    geo.setAttribute(name, new THREE.BufferAttribute(out, attr.itemSize));
  }
  return geo;
}

/**
 * Throw away everything in the file that is not the car, in place.
 *
 * Downloaded models are often a little SCENE rather than a car: a ground disc
 * to stand on, a backdrop dome, a soft shadow blob under the sills. They cost
 * nothing to render and they wreck everything downstream, because scale and
 * orientation are both read off the bounding box -- one 15.6 m ground plane
 * around a 5.2 m car and the car is scaled to a third of its size and laid on
 * an axis it does not lie on.
 *
 * Two tests, because the props fail in two different ways:
 *
 * FLAT. A mesh with no thickness at all is a decal, a shadow catcher or a
 * backdrop card. Bodywork always encloses some volume, so nothing real is
 * lost, and a zero-thickness surface sitting on the paint would z-fight anyway.
 *
 * OUTSIDE. Anything reaching well beyond the car is scenery. "The car" is
 * taken from the meshes with real tessellation in them -- a ground plane is two
 * triangles and a dome is thirty, while any panel large enough to matter runs
 * to thousands -- so the reference box is built from substantial meshes only
 * and cannot itself be dragged out by the props it is meant to find.
 */
function discardScenery(parts) {
  const SUBSTANTIAL = 256;    // triangles: below this a big mesh is a prop
  const MARGIN = 1.2;         // how far past the car a real part may reach

  const core = new THREE.Box3();
  for (const p of parts) {
    p.geo.computeBoundingBox();
    const idx = p.geo.index;
    const tris = (idx ? idx.count : p.geo.attributes.position.count) / 3;
    if (tris >= SUBSTANTIAL) core.union(p.geo.boundingBox);
  }
  if (core.isEmpty()) return;

  const centre = core.getCenter(new THREE.Vector3());
  const half = core.getSize(new THREE.Vector3()).multiplyScalar(MARGIN / 2);
  const size = new THREE.Vector3();
  const c = new THREE.Vector3();

  for (let i = parts.length - 1; i >= 0; i--) {
    const box = parts[i].geo.boundingBox;
    box.getSize(size);
    box.getCenter(c);
    const flat = Math.min(size.x, size.y, size.z) <= Math.max(size.x, size.y, size.z) * 1e-3;
    const outside = Math.abs(c.x - centre.x) > half.x
      || Math.abs(c.y - centre.y) > half.y
      || Math.abs(c.z - centre.z) > half.z
      || size.x > half.x * 2 || size.y > half.y * 2 || size.z > half.z * 2;
    if (flat || outside) parts.splice(i, 1);
  }
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

    // ROUND, seen from the side. This is the test that actually separates a
    // wheel from the bodywork around it, and without it the 930's wide rear
    // arches and low tail came out as part of the rear wheels -- which then
    // spun with them. Measured: rear "wheels" 0.93 m across against 0.74 at
    // the front, on a car whose wheels are all the same size. A tyre is as
    // tall as it is long; an arch, a sill or a bumper is much longer than tall.
    const round = Math.min(s[lengthAxis], s.y) / Math.max(s[lengthAxis], s.y, 1e-6);
    if (round < 0.62) return false;
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
export function buildCarFromModel(loaded, tuning, palette, yaw = 0, paint = null) {
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

  // A car is longer than it is wide, so the longest axis is the length. That
  // much is safe.
  const axes = [
    { axis: 'x', len: size.x }, { axis: 'y', len: size.y }, { axis: 'z', len: size.z },
  ].sort((a, b) => b.len - a.len);
  const lengthAxis = axes[0].axis;

  // Telling WIDTH from HEIGHT by size is not safe, and this is where a Lancia
  // Delta ended up lying on its side.
  //
  // "A car is wider than it is tall" is true of the car and not reliably true
  // of the model. This one measured 1.71 m across and 1.72 m tall -- one
  // centimetre over, once a roof aerial and the wheels dropping below the
  // sills were both in the box -- so the shorter-is-height rule picked the
  // wrong one and rolled the car ninety degrees. A centimetre either way on a
  // four-metre car is not a margin, it is a coin toss.
  //
  // The wheels settle it. Along the real up axis they sit at ONE END, under
  // everything; along the width axis they are symmetric about the centre,
  // because there are two on each side. So the up axis is whichever of the two
  // candidates the wheels are furthest off-centre along -- a large signal
  // where the size test had one centimetre, and it needs nothing stated per
  // car.
  //
  // It answers which way is UP as well, which the old rule could not: wheels
  // below the centre means +up, above it means the model is inverted.
  let heightAxis = axes[2].axis;
  let widthAxis = axes[1].axis;
  let flip = false;
  if (wheelGeoms.length) {
    const wb = new THREE.Box3();
    for (const g of wheelGeoms) { g.computeBoundingBox(); wb.union(g.boundingBox); }
    const wc = wb.getCenter(new THREE.Vector3());
    const off = (a) => (wc[a] - center[a]) / Math.max(size[a], 1e-6);
    const [a, b] = [axes[1].axis, axes[2].axis];
    if (Math.abs(off(a)) > Math.abs(off(b))) { heightAxis = a; widthAxis = b; }
    else { heightAxis = b; widthAxis = a; }
    flip = off(heightAxis) > 0;
  }

  const targetLength = tuning.chassis.halfLength * 2;
  const scale = targetLength / axes[0].len;

  // Rotate so length -> +Z and height -> +Y, then scale and centre.
  const orient = new THREE.Matrix4();
  const basis = new THREE.Matrix4();
  const ax = new THREE.Vector3(); const ay = new THREE.Vector3(); const az = new THREE.Vector3();
  unit(widthAxis, ax); unit(heightAxis, ay); unit(lengthAxis, az);
  // Upside down: roll 180 degrees about the length axis rather than negating
  // up on its own, which would mirror the car instead of turning it over.
  if (flip) { ax.negate(); ay.negate(); }
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
  // Repaint, for a car whose model came in a colour it should not be in.
  //
  // Everything else here works hard to keep the colour the model's author
  // chose, and this is the deliberate exception rather than a loosening of it:
  // a car states `paint` only when its own asset is wrong for it, and it has
  // to name the material it means. Matching "body" or "base" by guesswork
  // would repaint the wheels on this very car, whose rim material is called
  // Koleso_mat_Base.
  const repaint = paint && paint.match
    ? { re: new RegExp(paint.match, 'i'), color: new THREE.Color(paint.color) }
    : null;
  const flatten = (material) => {
    if (!material) return material;
    if (!flattened.has(material.uuid)) {
      const m = material.clone();
      m.flatShading = true;
      if (repaint && m.name && repaint.re.test(m.name)) {
        m.color = repaint.color.clone();
        // A texture would tint rather than replace, and the point is to
        // replace: a baked-in body colour has to go for the new one to show.
        if (m.map) m.map = null;
      }

      // Give reflective paint something to work with.
      //
      // A metal has no diffuse term -- it is entirely reflection -- so with a
      // dim environment it reads as a silhouette however bright its colour is.
      // The Ferrari's paint is #00bca0, a metallic teal, and it rendered as a
      // pure black car. Lifting the environment response is what puts the
      // colour back WITHOUT repainting anything: the model keeps the colour its
      // author chose, which is the whole reason it is drawn as authored.
      if (m.envMapIntensity !== undefined) m.envMapIntensity = 1.9;

      // Bring the model's materials into the same language as the world.
      //
      // Everything else here is flat-shaded MeshStandardMaterial at roughness
      // ~0.45 and metalness ~0.25 -- matte, readable, lit by its own colour.
      // Downloaded car models are authored for a photographic renderer and
      // arrive at metalness 1 across the board: the 930 has its CHROME, its
      // PLASTICS, its GLASS and its PAINT all fully metallic. A full metal has
      // no diffuse term at all, so its colour never appears -- it can only
      // reflect, and against this game's small bright sky that renders as a
      // dark grey car whatever colour the author actually chose.
      //
      // Capping metalness is what puts the colour back. It is not physically
      // faithful to the source material, and it is not meant to be: the car
      // has to sit in the same world as flat green hills and cone trees, and
      // a photoreal paint shader in that world reads as a bug rather than as
      // realism. The COLOUR is still entirely the model's own.
      if (m.metalness !== undefined && m.metalness > 0.45) m.metalness = 0.45;
      if (m.roughness !== undefined) {
        m.roughness = Math.min(Math.max(m.roughness, 0.35), 0.85);
      }

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
        // 0.34 was tuned on the Alpine, whose interior is dark. On a car with
        // a WHITE interior the same glass let the cabin outshine the bodywork,
        // so the car read as being see-through -- you saw the inside of it
        // instead of the outside. Glass you can see a hint through, rather
        // than glass you can see the whole cabin through.
        m.opacity = 0.55;
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

    // Find the axle from the TYRE, not from the bounding box.
    //
    // The box centre is the axle centre only when the group is a clean disc.
    // Real wheel groups carry a brake caliper on one side, and a caliper sits
    // off-centre and at small radius -- so it drags the box centre away from
    // the axle. Spinning about that point makes the wheel ORBIT rather than
    // turn, which reads as a wheel that is slightly tilted or wobbling. The
    // same box also made the radius too large, which is why the wheels came
    // out oversized.
    //
    // The fix is to look only at the outer ring. Everything at large radius
    // in the Y-Z plane is tyre, and a tyre is a circle centred on the axle, so
    // its extremes give the centre exactly however much clutter sits inboard.
    const { hub, radius } = fitWheel(verts);
    g.translate(-hub.x, -hub.y, -hub.z);

    // Take the camber out of the GEOMETRY.
    //
    // Models are authored with the suspension's camber baked in -- the GT3 RS
    // carries 0.82 deg at the front and 1.53 at the rear, mirrored left to
    // right, which is how the real car is set up. The wheel is then a disc
    // whose plane is NOT square to the axle we spin it about, and spinning a
    // tilted disc about a straight axis makes it wobble like a dropped coin.
    // That is the tilt you see, and it survives perfect centring: the hub was
    // already dead on the axis at 0.0 mm when the wobble was still there.
    //
    // Removing about a degree of static lean costs nothing anyone can see.
    // The wobble it causes is obvious at every wheel revolution.
    // Iterated, because one pass does not fully converge: the fit selects the
    // rim by radius from the CURRENT orientation, so straightening the wheel
    // slightly changes which vertices count as rim. Three passes took the GT3
    // RS from 0.82/1.53 deg to under 0.02, where one pass left 0.12/0.33.
    for (let pass = 0; pass < 3; pass++) {
      const camber = wheelCamber(g, radius);
      if (Math.abs(camber.z) < 2e-4 && Math.abs(camber.y) < 2e-4) break;
      g.rotateZ(camber.z);
      g.rotateY(camber.y);
    }

    // Match the simulated wheel radius. The artist's wheels are whatever size
    // they are; the physics raycasts against tuning.wheels.radius, so a
    // mismatch shows up as wheels hovering above the road or sunk into it.
    if (radius > 1e-4) {
      const k = tuning.wheels.radius / radius;
      g.scale(1, k, k);
    }
    const c = hub;

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

/**
 * The axle centre and tyre radius of one wheel, from its vertices.
 *
 * Two passes. The first uses the crude Y-Z box centre only as a seed, good
 * enough to tell the outer ring from the hub clutter. The second takes the
 * points in that ring -- the tyre -- and centres on THEIR extremes, which is
 * the axle, because a tyre is a circle about it. Anything asymmetric and
 * inboard (a caliper, a disc, a brake duct) sits at small radius and is
 * excluded, so it can no longer pull the centre off the axle.
 *
 * The spin axis is x, so x is left where it is: it decides how far the wheel
 * sits inboard, not whether it runs true.
 */
function fitWheel(verts) {
  let minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  let cy = (minY + maxY) / 2;
  let cz = (minZ + maxZ) / 2;
  const seedR = Math.max(maxY - minY, maxZ - minZ) / 2;

  // Second pass over the outer ring only.
  const RING = 0.82;                       // fraction of the seed radius
  const cut = (seedR * RING) ** 2;
  let rMinY = Infinity, rMaxY = -Infinity, rMinZ = Infinity, rMaxZ = -Infinity;
  let found = 0;
  for (let i = 0; i < verts.length; i += 3) {
    const dy = verts[i + 1] - cy, dz = verts[i + 2] - cz;
    if (dy * dy + dz * dz < cut) continue;
    found++;
    if (verts[i + 1] < rMinY) rMinY = verts[i + 1];
    if (verts[i + 1] > rMaxY) rMaxY = verts[i + 1];
    if (verts[i + 2] < rMinZ) rMinZ = verts[i + 2];
    if (verts[i + 2] > rMaxZ) rMaxZ = verts[i + 2];
  }
  // A group with no clear ring is not a tyre shape; keep the seed rather than
  // inventing a centre from a handful of stray points.
  if (found >= 12) {
    cy = (rMinY + rMaxY) / 2;
    cz = (rMinZ + rMaxZ) / 2;
  }

  // Radius from the refined centre, as the true half-extent of the ring.
  const radius = found >= 12
    ? Math.max(rMaxY - rMinY, rMaxZ - rMinZ) / 2
    : seedR;

  return { hub: new THREE.Vector3((minX + maxX) / 2, cy, cz), radius };
}

/**
 * How far a wheel's own plane leans away from the axle it will spin about.
 *
 * A disc centred on the origin and square to x has all its rim at x = 0. Tilt
 * it, and the rim's x traces a sine wave once around: x ~= a*cos(t) + b*sin(t),
 * where t is the angle about the axle. Fitting that wave gives both lean angles
 * directly, and it is robust to spokes, calipers and facet count because it
 * uses only the rim and only its average.
 *
 * Measured this way the GT3 RS reads -0.82 deg front left, +0.82 front right,
 * -1.53 rear left, +1.53 rear right -- mirror-symmetric and front-to-rear
 * different, which is what makes it recognisable as authored camber rather
 * than a broken export.
 */
function wheelCamber(geo, radius) {
  const p = geo.getAttribute('position');
  const inner = (0.85 * radius) ** 2;
  let sa = 0, sb = 0, n = 0;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), z = p.getZ(i);
    if (y * y + z * z < inner) continue;      // rim only
    const t = Math.atan2(z, y);
    sa += p.getX(i) * Math.cos(t);
    sb += p.getX(i) * Math.sin(t);
    n++;
  }
  if (n < 12 || radius < 1e-4) return { y: 0, z: 0 };
  // The 2/n is the standard Fourier coefficient for a sampled sine.
  return {
    z: Math.atan2(2 * sa / n, radius),
    y: -Math.atan2(2 * sb / n, radius),
  };
}
