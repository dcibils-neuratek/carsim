// Renderer, lighting, sky, horizon, and the car mesh.
//
// Everything here is flat-shaded, untextured primitives -- the low-poly look
// comes from hard facets and a small, deliberate palette, not from assets.

import * as THREE from 'three';

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

  scene.add(createSky(pal));
  scene.add(createHorizonRange(def));

  const hemi = new THREE.HemisphereLight(pal.sky, pal.groundDark, 1.15);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(def.sun.color, def.sun.intensity);
  sun.position.set(...def.sun.position);
  // Remembered so updateSunTarget can keep the same light direction as the
  // camera follows the car -- each track has its own sun angle.
  sun.userData.offset = def.sun.position.slice();
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 420;
  // Tight ortho box that we slide along with the car -- a box big enough to
  // cover the whole circuit would make the shadows uselessly blocky.
  const s = 55;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);

  return { scene, sun };
}

// Keep the shadow frustum centred on the car.
export function updateSunTarget(sun, focus) {
  const o = sun.userData.offset || [70, 110, 45];
  sun.target.position.copy(focus);
  sun.position.set(focus.x + o[0], focus.y + o[1], focus.z + o[2]);
  sun.target.updateMatrixWorld();
}

function createSky(pal) {
  const geo = new THREE.SphereGeometry(1600, 24, 14);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(pal.skyHigh) },
      mid: { value: new THREE.Color(pal.sky) },
      bot: { value: new THREE.Color(pal.horizon) },
    },
    vertexShader: `
      varying float vH;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vH = normalize(world.xyz).y;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `
      uniform vec3 top, mid, bot;
      varying float vH;
      void main() {
        float h = clamp(vH, -1.0, 1.0);
        vec3 c = h < 0.08
          ? mix(bot, mid, smoothstep(-0.15, 0.08, h))
          : mix(mid, top, smoothstep(0.08, 0.65, h));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

// A ring of jagged peaks so the horizon isn't a flat line. Purely decorative,
// no collision -- it sits well beyond anywhere the car can reach.
function createHorizonRange(def) {
  const positions = [];
  const radius = def.scenery.ridgeRadius;
  const count = def.scenery.ridgeCount;
  const [hMin, hMax] = def.scenery.ridgeHeight;
  const jitter = def.scenery.ridgeJitter;
  // Deterministic pseudo-random so the skyline is the same every run.
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  for (let i = 0; i < count; i++) {
    const a0 = (i / count) * Math.PI * 2;
    const a1 = ((i + 1) / count) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const h = hMin + rand() * (hMax - hMin);
    const r = radius + (rand() - 0.5) * jitter;
    positions.push(
      Math.cos(a0) * radius, -20, Math.sin(a0) * radius,
      Math.cos(a1) * radius, -20, Math.sin(a1) * radius,
      Math.cos(am) * r, h, Math.sin(am) * r,
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
  car.add(body);

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
  car.add(cabin);

  // Windscreen and rear glass, inset a hair so they don't z-fight the cabin.
  const glassMat = flatMat(PALETTE.carGlass, {
    roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.55,
  });
  const windscreen = new THREE.Mesh(new THREE.PlaneGeometry(1.16, 0.66), glassMat);
  windscreen.position.set(0, 0.36, 0.47);
  windscreen.rotation.x = -0.80;
  car.add(windscreen);

  const rearGlass = new THREE.Mesh(new THREE.PlaneGeometry(1.18, 0.78), glassMat);
  rearGlass.position.set(0, 0.35, -1.16);
  rearGlass.rotation.x = Math.PI + 0.86;
  car.add(rearGlass);

  // Modest ducktail rather than a big wing -- the A110 doesn't wear one.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.50, 0.05, 0.26), flatMat(PALETTE.carBody));
  wing.position.set(0, 0.20, -1.94);
  wing.castShadow = true;
  car.add(wing);

  // Lights. Taillights get swapped to a hot emissive when braking.
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff6d8, emissive: 0xfff0c4, emissiveIntensity: 0.85, flatShading: true,
  });
  for (const sx of [-1, 1]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.10, 0.06), headMat);
    head.position.set(sx * 0.40, -0.06, 2.09);
    car.add(head);
  }

  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x8c1a1a, emissive: 0xff2222, emissiveIntensity: 0.35, flatShading: true,
  });
  for (const sx of [-1, 1]) {
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.11, 0.06), tailMat);
    tail.position.set(sx * 0.40, -0.04, -2.10);
    car.add(tail);
  }

  // Wheels, built separately so the physics can place each one every frame.
  const wheelMeshes = [];
  for (let i = 0; i < 4; i++) {
    wheelMeshes.push(createWheelMesh(tuning.wheels.radius, tuning.wheels.width));
  }

  // Same hook the GLB path exposes, so the frame loop drives brake lights
  // through one call whichever car it is looking at.
  const setBrakeLights = (on) => { tailMat.emissiveIntensity = on ? 1.7 : 0.35; };

  return { group: car, wheelMeshes, tailMat, setBrakeLights };
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
