// Renderer, lighting, sky, horizon, and the car mesh.
//
// Everything here is flat-shaded, untextured primitives -- the low-poly look
// comes from hard facets and a small, deliberate palette, not from assets.

import * as THREE from 'three';
import { OUTPUT_GLSL, withOutputUniform } from './post/colorspace.js';

export const PALETTE = {
  sky: 0x74b6e8,
  skyHigh: 0x2f6ea8,
  horizon: 0xcfe6f5,
  grass: 0x5f9e4a,
  grassDark: 0x4a7f3a,
  asphalt: 0x3a3f47,
  asphaltEdge: 0x2b2f35,
  curbA: 0xd94141,
  curbB: 0xf2f2f2,
  mountain: 0x6b7f96,
  carBody: 0xd8433a,
  carCabin: 0x1b2028,
  carGlass: 0x8fc4dd,
  tire: 0x16181c,
  rim: 0xb9c2cc,
};

export function createRenderer() {
  // preserveDrawingBuffer is what makes screenshots and canvas readback work,
  // but it forces an extra copy every frame. Off by default; add ?capture=1 to
  // the URL when you want to grab an image.
  const capture = new URLSearchParams(location.search).has('capture');
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: capture,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;
  document.body.appendChild(renderer.domElement);
  return renderer;
}

export function createScene(def) {
  const pal = def.palette;
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(pal.horizon, def.fog.near, def.fog.far);

  const sky = createSky(pal);
  scene.add(sky);
  scene.add(createHorizonRange(def));
  scene.environment = createEnvironment(pal);

  // Fill light, per circuit.
  //
  // This was pinned at 1.15, which is a fine midday number and the reason a
  // circuit could never be anything but midday: the sun can be dropped to
  // nothing and the world stays evenly lit from the sky, so dusk came out as
  // "noon with an orange lamp" and night was not expressible at all. Shadow
  // DEPTH is the difference between the sun and this, so it is the control
  // that decides what time it is, more than the sun's own intensity.
  const hemi = new THREE.HemisphereLight(
    def.ambient?.sky ?? pal.sky,
    def.ambient?.ground ?? pal.groundDark,
    def.ambient?.intensity ?? 1.15,
  );
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(def.sun.color, def.sun.intensity);
  sun.position.set(...def.sun.position);
  // Remembered so updateSunTarget can keep the same light direction as the
  // camera follows the car -- each track has its own sun angle.
  sun.userData.offset = def.sun.position.slice();
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // Tight ortho box that we slide along with the car -- a box big enough to
  // cover the whole circuit would make the shadows uselessly blocky.
  const s = 55;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;

  // Near and far wrapped tightly around the light, and it is worth explaining
  // why they are not just "1 and far enough".
  //
  // shadow.bias is in the shadow camera's DEPTH units, so what it costs in
  // metres is bias * (far - near). At near 1 and far 420 that made a bias of
  // -0.0008 worth 34 cm of displacement along the light ray -- and a shadow
  // pushed a third of a metre away from its caster detaches at the contact
  // patch. The car reads as hovering above the road, which is exactly what it
  // looked like.
  //
  // The light sits a fixed distance from the focus (updateSunTarget keeps the
  // offset constant), so the depth range only has to cover the ortho box and
  // whatever terrain rises inside it. Half that box's diagonal is about 78 m;
  // 100 m of margin either side is generous and still halves the range.
  const dist = Math.hypot(...def.sun.position);
  const span = 100;
  sun.shadow.camera.near = Math.max(1, dist - span);
  sun.shadow.camera.far = dist + span;

  // Now that a unit of bias is worth a fifth of what it was, it can be small
  // enough to stop peter-panning while still keeping acne off the road. Most
  // of the work is done by normalBias, which offsets along the surface normal
  // rather than along the light, so it does not slide the shadow sideways.
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.05;
  scene.add(sun);
  scene.add(sun.target);

  return { scene, sun, sky };
}

/**
 * Keep the sky centred on the camera.
 *
 * A sky is at infinity. Anchoring one to the world origin works only while the
 * world is smaller than the sphere, which stopped being true the moment a
 * circuit grew past a kilometre from the origin.
 */
export function keepSkyWithCamera(sky, camera) {
  if (sky) sky.position.copy(camera.position);
}

// Keep the shadow frustum centred on the car.
export function updateSunTarget(sun, focus) {
  const o = sun.userData.offset || [70, 110, 45];
  sun.target.position.copy(focus);
  sun.position.set(focus.x + o[0], focus.y + o[1], focus.z + o[2]);
  sun.target.updateMatrixWorld();
}

/**
 * Something for the paint to reflect.
 *
 * A smooth or metallic material with no environment map has nothing to
 * reflect, so it renders as flat black -- and "black" here means the material
 * is working exactly as asked, which is why it looks like a bug rather than a
 * missing input. The Ferrari made this unmissable: its body paint is #111111
 * at roughness 0 and its wheels are metalness 1, so the whole car came out a
 * silhouette while its white interior showed through the glass. It read as
 * being able to see only the inside of the car.
 *
 * Built from the track's OWN sky colours rather than a stock studio HDR, so a
 * car reflects the circuit it is on: cold and blue on Snow, warm ochre on
 * Mediterranean. Three stops down a 2x64 gradient is plenty -- this is never
 * seen directly, only smeared across bodywork, and PMREM blurs it by roughness
 * anyway. Costs one small texture per session.
 */
function createEnvironment(pal) {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 64;
  const ctx = c.getContext('2d');
  const hex = (v) => `#${v.toString(16).padStart(6, '0')}`;
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  // Brighter than the sky actually is, on purpose. A full metal has no diffuse
  // term at all -- it is nothing but reflection -- so this texture is the only
  // light such a material ever receives, and a physically honest dome leaves
  // the paint reading much darker than the same car does under the same sky
  // in a photograph. The horizon band is kept bright because that is the part
  // that lands on a car's flanks, which is most of what you see from behind.
  g.addColorStop(0.00, hex(pal.skyHigh));
  g.addColorStop(0.42, hex(pal.sky));
  g.addColorStop(0.52, hex(pal.horizon));
  g.addColorStop(0.68, hex(pal.ground));
  g.addColorStop(1.00, hex(pal.groundDark));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 64);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createSky(pal) {
  // 2600, and it follows the camera -- see keepSkyWithCamera.
  //
  // It was 1600 and pinned to the world origin, which is a sky you can DRIVE
  // OUT OF. Mediterranean is 2085 m across with its centre well off the
  // origin, so a third of the lap sat outside the sphere, and from outside a
  // BackSide sphere there is nothing to see: the sky read as a hard black
  // wedge cut out of the horizon. Comfortably inside the camera's 3000 m far
  // plane, so widening it costs no depth precision -- and depth precision here
  // is not spare, the terrain clears the road by as little as 8 mm.
  const geo = new THREE.SphereGeometry(2600, 24, 14);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: withOutputUniform({
      top: { value: new THREE.Color(pal.skyHigh) },
      mid: { value: new THREE.Color(pal.sky) },
      bot: { value: new THREE.Color(pal.horizon) },
    }),
    vertexShader: `
      varying float vH;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vH = normalize(world.xyz).y;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `
      ${OUTPUT_GLSL}
      uniform vec3 top, mid, bot;
      varying float vH;
      void main() {
        float h = clamp(vH, -1.0, 1.0);
        vec3 c = h < 0.08
          ? mix(bot, mid, smoothstep(-0.15, 0.08, h))
          : mix(mid, top, smoothstep(0.08, 0.65, h));
        // Wrapped so the sky looks the same whether it is drawn to the canvas
        // or into a post chain's linear target. This shader writes its own
        // gl_FragColor, so it never received three's colour-space conversion
        // and has always been displayed darker than the palette says -- which
        // is the look, and which a composer would silently "fix". See
        // post/colorspace.js.
        gl_FragColor = vec4(vroomOutput(c), 1.0);
      }`,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

// A ring of jagged peaks so the horizon isn't a flat line. Purely decorative,
// no collision -- it sits well beyond anywhere the car can reach.
/** Clear air between the outermost part of the circuit and the skyline. */
const RIDGE_MARGIN = 250;

/**
 * How many slots wide each ridge triangle is drawn.
 *
 * One slot each made a COMB, not a mountain range: the base of a triangle was
 * the circumference divided by the count, and on Mountains that was 89 m
 * against peaks 980 m tall -- an 11:1 spike. Real mountains run nearer 0.3:1.
 *
 * Spanning several slots decouples the two: `count` still sets how many peaks
 * there are, while the width of each is this multiple of the spacing, so they
 * overlap into a massif the way a range actually does. Fixing it by dropping
 * the count instead would have bought width at the price of a skyline you
 * could see the polygons in.
 */
const RIDGE_SPAN = 5;

/**
 * Where the skyline ring actually sits, as { cx, cz, radius, inner }.
 *
 * Split out from the mesh so it can be checked without a renderer: `inner` is
 * the closest a peak can come to the ring's centre once jitter has pulled it
 * in, and that is the number a circuit has to stay clear of.
 */
export function ridgeRing(def) {
  const jitter = def.scenery.ridgeJitter;
  const pts = def.controlPoints ?? [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, , z] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const cx = pts.length ? (minX + maxX) / 2 : 0;
  const cz = pts.length ? (minZ + maxZ) / 2 : 0;
  let reach = 0;
  for (const [x, , z] of pts) reach = Math.max(reach, Math.hypot(x - cx, z - cz));

  const radius = Math.max(def.scenery.ridgeRadius, reach + RIDGE_MARGIN + jitter / 2);
  return { cx, cz, radius, inner: radius - jitter / 2, reach };
}

function createHorizonRange(def) {
  const positions = [];
  const count = def.scenery.ridgeCount;
  const [hMin, hMax] = def.scenery.ridgeHeight;
  const jitter = def.scenery.ridgeJitter;

  // Centred on the CIRCUIT, and never smaller than the circuit.
  //
  // This ring used to be centred on the world origin at a radius typed into
  // the track file, and both halves of that were wrong. No circuit here is
  // centred on the origin -- they sit up to 550 m off it -- and the authored
  // radii were smaller than the distance the layout actually reaches, so five
  // of the six had a mountain standing on the road. It is only a skyline mesh
  // with no collider, so the car drove through it, which is worse than hitting
  // it: you cannot see where you are going and nothing explains why.
  //
  // Control points bound the built centreline rather than tracking it, because
  // a uniform cubic B-spline passes INSIDE its controls -- so measuring the
  // footprint from them is conservative in the direction that matters.
  // Jitter pulls a peak INWARD by up to half its range, so the floor has to
  // clear the track by the margin plus that.
  const { cx, cz, radius } = ridgeRing(def);
  // Deterministic pseudo-random so the skyline is the same every run.
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const step = (Math.PI * 2) / count;
  for (let i = 0; i < count; i++) {
    // Centred on its slot and widened outward, so peaks stay evenly spaced
    // while their skirts overlap their neighbours'.
    const am = (i + 0.5) * step;
    const a0 = am - (step * RIDGE_SPAN) / 2;
    const a1 = am + (step * RIDGE_SPAN) / 2;
    const h = hMin + rand() * (hMax - hMin);
    const r = radius + (rand() - 0.5) * jitter;
    positions.push(
      cx + Math.cos(a0) * radius, -20, cz + Math.sin(a0) * radius,
      cx + Math.cos(a1) * radius, -20, cz + Math.sin(a1) * radius,
      cx + Math.cos(am) * r, h, cz + Math.sin(am) * r,
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color: def.palette.ridge, side: THREE.DoubleSide, fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 0;
  return mesh;
}

// ---------------------------------------------------------------------------
// Lofted geometry helper: builds a closed solid from rectangular cross-sections
// swept along Z. Non-indexed so every face gets its own hard normal.
// ---------------------------------------------------------------------------

function loft(sections) {
  const pos = [];
  const push = (v) => pos.push(v[0], v[1], v[2]);
  const quad = (a, b, c, d) => {
    push(a); push(b); push(c);
    push(a); push(c); push(d);
  };
  // Corner order per section, viewed from behind: bl, br, tr, tl
  const corners = (s) => [
    [-s.hw, s.yb, s.z], [s.hw, s.yb, s.z], [s.hw, s.yt, s.z], [-s.hw, s.yt, s.z],
  ];

  for (let i = 0; i < sections.length - 1; i++) {
    const a = corners(sections[i]);      // nearer the tail
    const b = corners(sections[i + 1]);  // nearer the nose
    quad(a[0], b[0], b[1], a[1]); // bottom
    quad(a[1], b[1], b[2], a[2]); // right
    quad(a[2], b[2], b[3], a[3]); // top
    quad(a[3], b[3], b[0], a[0]); // left
  }
  const tail = corners(sections[0]);
  const nose = corners(sections[sections.length - 1]);
  quad(tail[3], tail[2], tail[1], tail[0]);
  quad(nose[0], nose[1], nose[2], nose[3]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function flatMat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color, flatShading: true, roughness: 0.72, metalness: 0.06, ...opts,
  });
}

// ---------------------------------------------------------------------------
// Car
// ---------------------------------------------------------------------------

export function createCarMesh(tuning) {
  const car = new THREE.Group();
  // Everything except the wheels hangs here, so the shell can lean on its
  // springs while the wheels stay on the road. See Vehicle._leanBody.
  const bodyGroup = new THREE.Group();
  car.add(bodyGroup);

  // Body: a wedge that's widest at the doors and tapers to nose and tail.
  const body = new THREE.Mesh(loft([
    { z: -2.10, hw: 0.74, yb: -0.28, yt: -0.01 },
    { z: -1.70, hw: 0.86, yb: -0.34, yt:  0.08 },
    { z: -0.95, hw: 0.90, yb: -0.38, yt:  0.15 },
    { z:  0.10, hw: 0.90, yb: -0.38, yt:  0.18 },
    { z:  0.75, hw: 0.90, yb: -0.38, yt:  0.16 },
    { z:  1.55, hw: 0.86, yb: -0.36, yt:  0.09 },
    { z:  2.10, hw: 0.70, yb: -0.30, yt: -0.03 },
  ]), flatMat(PALETTE.carBody, { roughness: 0.45, metalness: 0.25 }));
  body.castShadow = true;
  bodyGroup.add(body);

  // Greenhouse: fastback, narrower than the body so the shoulders read.
  // The roof sits 0.47 above the body origin, which with the car's ride height
  // puts it at the A110's 1.25 m overall height.
  const cabin = new THREE.Mesh(loft([
    { z: -1.50, hw: 0.64, yb: 0.10, yt: 0.24 },
    { z: -0.85, hw: 0.77, yb: 0.14, yt: 0.45 },
    { z:  0.10, hw: 0.77, yb: 0.16, yt: 0.47 },
    { z:  0.72, hw: 0.63, yb: 0.16, yt: 0.26 },
  ]), flatMat(PALETTE.carCabin, { roughness: 0.35 }));
  cabin.castShadow = true;
  bodyGroup.add(cabin);

  // Windscreen and rear glass, inset a hair so they don't z-fight the cabin.
  const glassMat = flatMat(PALETTE.carGlass, {
    roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.55,
  });
  const windscreen = new THREE.Mesh(new THREE.PlaneGeometry(1.16, 0.66), glassMat);
  windscreen.position.set(0, 0.36, 0.47);
  windscreen.rotation.x = -0.80;
  bodyGroup.add(windscreen);

  const rearGlass = new THREE.Mesh(new THREE.PlaneGeometry(1.18, 0.78), glassMat);
  rearGlass.position.set(0, 0.35, -1.16);
  rearGlass.rotation.x = Math.PI + 0.86;
  bodyGroup.add(rearGlass);

  // Modest ducktail rather than a big wing -- the A110 doesn't wear one.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.50, 0.05, 0.26), flatMat(PALETTE.carBody));
  wing.position.set(0, 0.20, -1.94);
  wing.castShadow = true;
  bodyGroup.add(wing);

  // Lights. Taillights get swapped to a hot emissive when braking.
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff6d8, emissive: 0xfff0c4, emissiveIntensity: 0.85, flatShading: true,
  });
  for (const sx of [-1, 1]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.10, 0.06), headMat);
    head.position.set(sx * 0.40, -0.06, 2.09);
    bodyGroup.add(head);
  }

  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x8c1a1a, emissive: 0xff2222, emissiveIntensity: 0.35, flatShading: true,
  });
  for (const sx of [-1, 1]) {
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.11, 0.06), tailMat);
    tail.position.set(sx * 0.40, -0.04, -2.10);
    bodyGroup.add(tail);
  }

  // Wheels, built separately so the physics can place each one every frame.
  const wheelMeshes = [];
  for (let i = 0; i < 4; i++) {
    wheelMeshes.push(createWheelMesh(tuning.wheels.radius, tuning.wheels.width));
  }

  // Same hook the GLB path exposes, so the frame loop drives brake lights
  // through one call whichever car it is looking at.
  // Same three levels as the modelled cars: dim red with the headlights on,
  // bright red under braking, and a little glow otherwise so the shape reads.
  const setBrakeLights = (braking, running = false) => {
    tailMat.emissiveIntensity = braking ? 1.7 : (running ? 0.9 : 0.35);
  };

  return { group: car, bodyGroup, wheelMeshes, tailMat, setBrakeLights };
}

function createWheelMesh(radius, width) {
  const wheel = new THREE.Group();

  const tireGeo = new THREE.CylinderGeometry(radius, radius, width, 14, 1);
  tireGeo.rotateZ(Math.PI / 2); // cylinder axis Y -> X, the wheel's spin axis
  const tire = new THREE.Mesh(tireGeo, flatMat(PALETTE.tire, { roughness: 0.9, metalness: 0 }));
  tire.castShadow = true;
  wheel.add(tire);

  const rimGeo = new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, width * 1.04, 8, 1);
  rimGeo.rotateZ(Math.PI / 2);
  const rim = new THREE.Mesh(rimGeo, flatMat(PALETTE.rim, { roughness: 0.35, metalness: 0.55 }));
  wheel.add(rim);

  // A single spoke bar makes wheel rotation legible at speed.
  const spoke = new THREE.Mesh(
    new THREE.BoxGeometry(width * 1.08, radius * 1.05, radius * 0.16),
    flatMat(0x5c646e),
  );
  wheel.add(spoke);

  return wheel;
}

export { flatMat };
