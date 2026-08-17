// Bootstrap and the main loop.
//
// Frame shape: read input once, run N fixed physics steps, then render one
// interpolated frame. Input edges (shifts, respawn) are consumed on the first
// sub-step only, so a slow frame that runs four physics steps can't fire four
// upshifts off one button press.

import * as THREE from 'three';

import { TUNING, loadTuning } from './tuning.js';
import { createRenderer, createScene, createCarMesh, updateSunTarget } from './scene.js';
import { initPhysics, RAPIER, FixedStepper, PhysicsDebug } from './physics.js';
import { Track, sampleCircuit } from './track.js';
import { Vehicle } from './vehicle.js';
import { Input } from './input.js';
import { CarCamera } from './camera.js';
import { Hud } from './hud.js';
import { LapTimer, formatTime } from './laptimer.js';
import { createGui } from './gui.js';
import { loadCarModel, buildCarFromModel } from './carmodel.js';
import { PALETTE } from './scene.js';
import { Skidmarks } from './skidmarks.js';
import { TyreSmoke } from './smoke.js';
import { loadTracks, TRACK_IDS, getTrack, hasTrack, registerTrack } from './tracks.js';
import { loadStashedTrack, EDITOR_TRACK_ID } from './editor/state.js';
import { EngineAudio } from './audio.js';
import { TyreAudio } from './tyreaudio.js';
import { PadPanel } from './padui.js';
import { Music } from './music.js';
import { SpeedBlur } from './postfx.js';
import { CARS, getCar, applyCarTuning, carStats } from './cars.js';

const SPAWN_PROGRESS = 0.985;   // just before the start line
const STUCK_SECONDS = 2.5;

/**
 * Ask which circuit to drive, before anything is built.
 *
 * Choosing up front is deliberate: switching tracks later would mean tearing
 * down Rapier colliders and the whole scene graph mid-frame, which is a rich
 * source of bugs for no benefit. Picking first means the world is constructed
 * exactly once. Changing track is a reload, which costs under a second.
 */
function chooseTrack(input) {
  const requested = new URLSearchParams(location.search).get('track');

  // The editor's "drive it" button hands a track over through localStorage
  // rather than a file, so a layout can be driven before it is saved anywhere.
  if (requested === EDITOR_TRACK_ID) {
    const stashed = loadStashedTrack();
    if (stashed) return Promise.resolve(registerTrack(stashed));
    console.warn('no track stashed by the editor; falling back to the menu');
  }

  if (requested && hasTrack(requested)) return Promise.resolve(requested);

  const prompt = document.getElementById('bootPrompt');
  const menu = document.getElementById('trackMenu');
  prompt.textContent = 'CHOOSE YOUR CIRCUIT';
  prompt.classList.remove('blink');
  menu.classList.add('on');

  return new Promise((resolve) => {
    const cards = [];
    let selected = 0;

    const highlight = () => {
      cards.forEach((c, i) => c.classList.toggle('sel', i === selected));
      cards[selected]?.focus({ preventScroll: true });
    };

    for (const id of TRACK_IDS) {
      const def = getTrack(id);
      const card = document.createElement('div');
      card.className = 'trackCard';
      card.tabIndex = 0;
      card.innerHTML =
        trackPreview(def) +
        `<div class="nm">${def.name.toUpperCase()}</div>` +
        `<div class="tag">${def.tagline}</div>` +
        `<div class="diff">${def.difficulty.toUpperCase()}</div>`;

      const index = cards.length;
      const pick = () => {
        menu.classList.remove('on');
        menu.innerHTML = '';
        cancelAnimationFrame(raf);
        resolve(id);
      };
      card.addEventListener('click', pick);
      card.addEventListener('mouseenter', () => { selected = index; highlight(); });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
      card.__pick = pick;
      cards.push(card);
      menu.appendChild(card);
    }

    // Gamepad navigation. Chrome hides a pad until a button is pressed, so
    // this polls rather than waiting on an event -- press anything and the
    // menu starts responding.
    //
    // The cards are a two-column grid, so up/down move by a row and
    // left/right by one. Hardcoding 2 would break if the layout changed, so
    // the column count is read back from where the cards actually landed.
    let raf = 0;
    const columns = () => {
      if (cards.length < 2) return 1;
      const top = cards[0].offsetTop;
      let n = 0;
      while (n < cards.length && cards[n].offsetTop === top) n++;
      return Math.max(1, n);
    };

    const poll = () => {
      raf = requestAnimationFrame(poll);
      const m = input.readMenu();
      if (!m.pad) return;
      const cols = columns();
      const before = selected;
      if (m.left) selected--;
      if (m.right) selected++;
      if (m.up) selected -= cols;
      if (m.down) selected += cols;
      selected = Math.max(0, Math.min(cards.length - 1, selected));
      if (selected !== before) highlight();
      if (m.confirm) cards[selected].__pick();
    };

    highlight();
    poll();
  });
}

/**
 * Pick a car, on the same cards and the same navigation as the circuits.
 *
 * Deliberately the same screen furniture rather than a new kind of menu: two
 * choices in a row should feel like one flow, and anything a player learned
 * about moving around the first should still be true on the second.
 */
function chooseCar(input, trackDef) {
  const requested = new URLSearchParams(location.search).get('car');
  if (requested && CARS.some((c) => c.id === requested)) {
    return Promise.resolve(getCar(requested));
  }

  const prompt = document.getElementById('bootPrompt');
  const menu = document.getElementById('trackMenu');
  prompt.textContent = `${trackDef.name.toUpperCase()} — PICK YOUR CAR`;
  prompt.classList.remove('blink');
  menu.innerHTML = '';
  menu.classList.add('on');

  return new Promise((resolve) => {
    const cards = [];
    let selected = 0;

    const highlight = () => {
      cards.forEach((c, i) => c.classList.toggle('sel', i === selected));
      cards[selected]?.focus({ preventScroll: true });
    };

    for (const car of CARS) {
      const card = document.createElement('div');
      card.className = 'trackCard carCard';
      card.tabIndex = 0;
      card.innerHTML =
        `<div class="swatch carSwatch">${carSilhouette(car)}</div>` +
        `<div class="nm">${car.name}</div>` +
        `<div class="tag">${car.tagline}</div>` +
        `<div class="spec">` +
        // Read out of the car's own tuning, so the card cannot claim a figure
        // the simulation will not deliver.
        Object.values(carStats(TUNING, car)).map((v) => `<span>${v}</span>`).join('') +
        `</div>` +
        `<div class="diff">${car.badge}</div>`;

      const index = cards.length;
      const pick = () => {
        menu.classList.remove('on');
        menu.innerHTML = '';
        cancelAnimationFrame(raf);
        resolve(car);
      };
      card.addEventListener('click', pick);
      card.addEventListener('mouseenter', () => { selected = index; highlight(); });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
      card.__pick = pick;
      cards.push(card);
      menu.appendChild(card);
    }

    let raf = 0;
    const columns = () => {
      if (cards.length < 2) return 1;
      const top = cards[0].offsetTop;
      let n = 0;
      while (n < cards.length && cards[n].offsetTop === top) n++;
      return Math.max(1, n);
    };

    const poll = () => {
      raf = requestAnimationFrame(poll);
      const m = input.readMenu();
      if (!m.pad) return;
      const cols = columns();
      const before = selected;
      if (m.left) selected--;
      if (m.right) selected++;
      if (m.up) selected -= cols;
      if (m.down) selected += cols;
      selected = Math.max(0, Math.min(cards.length - 1, selected));
      if (selected !== before) highlight();
      if (m.confirm) cards[selected].__pick();
    };

    highlight();
    poll();
  });
}

/**
 * The card's picture: the car's own photo, with the drawn silhouette as a
 * fallback.
 *
 * A photo says which car this is instantly, in a way four coloured wedges
 * never did. The fallback stays because it costs nothing and a missing image
 * should leave a car pickable rather than blank.
 */
function carSilhouette(car) {
  if (car.image) {
    // decoding=async so a slow image cannot hold up the menu drawing, and the
    // alt text is the name because that is exactly what the picture conveys.
    return `<img class="carPic" src="${car.image}" alt="${car.name}" decoding="async">`;
  }

  const BODY = {
    // Mid-engined wedge: low nose, cabin forward, long flat deck behind.
    alpine:  'M18,74 L34,52 L62,40 L108,36 L152,44 L186,58 L206,74 Z',
    gt3rs:   'M14,74 L26,56 L52,46 L86,34 L122,34 L148,46 L166,44 L166,30 L200,30 L200,36 L172,36 L172,50 L202,58 L212,74 Z',
    sc18:    'M10,74 L18,60 L48,52 L78,38 L120,36 L150,48 L168,50 L168,28 L206,28 L206,34 L176,34 L176,54 L206,60 L214,74 Z',
  };
  const TINT = { alpine: '#9fb6c9', gt3rs: '#c8a02c', sc18: '#2e2f33' };
  const body = BODY[car.id] || BODY.alpine;
  const tint = TINT[car.id] || '#9fb6c9';
  return `<svg viewBox="0 0 224 96" preserveAspectRatio="xMidYMid meet">
    <rect width="224" height="96" fill="#11161d"/>
    <path d="${body}" fill="${tint}"/>
    <circle cx="62" cy="74" r="15" fill="#15181c"/>
    <circle cx="166" cy="74" r="15" fill="#15181c"/>
    <rect x="0" y="86" width="224" height="10" fill="#0b0e12"/>
  </svg>`;
}

/**
 * A preview drawn from the track's own data, so a card can never misrepresent
 * the circuit behind it: real palette, a horizon built from the same ridge
 * settings, tree density from its scenery, and the actual centerline plotted
 * from its control points.
 */
function trackPreview(def) {
  const W = 352, H = 168, SKY = 76;
  const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
  const p = def.palette;

  // Same deterministic generator idea as the world itself, so a track's
  // skyline preview matches its mood (jagged and tall, or low and soft).
  let seed = 2024;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  // Horizon ridge: peak height scaled from the track's own ridgeHeight range.
  const [rMin, rMax] = def.scenery.ridgeHeight;
  const peakScale = Math.min(rMax / 520, 1);
  const teeth = 15;
  let ridge = `M 0 ${SKY}`;
  for (let i = 0; i < teeth; i++) {
    const x0 = (i / teeth) * W;
    const x1 = ((i + 0.5) / teeth) * W;
    const h = (13 + rand() * 34) * (0.35 + peakScale);
    ridge += ` L ${x0.toFixed(1)} ${SKY} L ${x1.toFixed(1)} ${(SKY - h).toFixed(1)}`;
  }
  ridge += ` L ${W} ${SKY} Z`;

  // Conifers along the horizon, as many as the track actually scatters.
  const treeCount = Math.round(7 + (def.scenery.treeCount / 1400) * 20);
  let trees = '';
  for (let i = 0; i < treeCount; i++) {
    const x = rand() * W;
    const h = 11 + rand() * 15;
    trees += `<path d="M ${x.toFixed(1)} ${SKY + 7} l ${(-h / 3).toFixed(1)} 0 ` +
             `l ${(h / 3).toFixed(1)} ${(-h).toFixed(1)} l ${(h / 3).toFixed(1)} ` +
             `${h.toFixed(1)} Z" fill="${hex(p.leaf)}"/>`;
  }

  // The circuit itself, plan view. Sampled from the same Catmull-Rom curve the
  // track is actually built from, not the raw control points, so the preview
  // shows the real shape rather than an angular approximation of it.
  const pts = sampleCircuit(def.controlPoints, 140).map((v) => [v.x, v.y, v.z]);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, , z] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const boxW = 250, boxH = 74;
  const scale = Math.min(boxW / (maxX - minX || 1), boxH / (maxZ - minZ || 1));
  const ox = W / 2 - ((maxX + minX) / 2) * scale;
  const oy = SKY + (H - SKY) / 2 - ((maxZ + minZ) / 2) * scale;
  const xy = ([x, , z]) => `${(ox + x * scale).toFixed(1)},${(oy + z * scale).toFixed(1)}`;
  const outline = pts.map(xy).join(' ');

  return `<span class="swatch"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="sky-${def.id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${hex(p.skyHigh)}"/>
        <stop offset="1" stop-color="${hex(p.horizon)}"/>
      </linearGradient>
      <linearGradient id="gnd-${def.id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${hex(p.ground)}"/>
        <stop offset="1" stop-color="${hex(p.groundDark)}"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${SKY}" fill="url(#sky-${def.id})"/>
    <path d="${ridge}" fill="${hex(p.ridge)}"/>
    <rect y="${SKY}" width="${W}" height="${H - SKY}" fill="url(#gnd-${def.id})"/>
    ${trees}
    <polygon points="${outline}" fill="none"
             stroke="${hex(p.curbA)}" stroke-width="13"
             stroke-linejoin="round" stroke-linecap="round" opacity="0.5"/>
    <polygon points="${outline}" fill="none"
             stroke="${hex(p.asphalt)}" stroke-width="8" stroke-linejoin="round"/>
  </svg></span>`;
}

export async function boot() {
  const prompt = document.getElementById('bootPrompt');

  loadTuning();

  // Circuits are data files, so the catalogue has to be fetched before the
  // menu can be drawn. Four small JSON files, fetched in parallel.
  prompt.textContent = 'LOADING CIRCUITS…';
  try {
    await loadTracks();
  } catch (err) {
    prompt.textContent = 'COULD NOT LOAD CIRCUITS';
    console.error(err);
    throw err;
  }

  // Input comes up before the menu, not with the car: the menu is the first
  // thing a player touches and it has to be reachable from the pad.
  const input = new Input();
  // Available from the menu onward: a player whose pad does not do what they
  // expect should not have to start a race to fix it.
  const padPanel = new PadPanel(input);

  // Pick the circuit before building anything, so the world is created once.
  const trackId = await chooseTrack(input);
  const trackDef = getTrack(trackId);

  // Car after circuit, because which car you want depends on where you are
  // going -- the Charger is a weapon on Dirt and a liability on Mediterranean.
  // Choosing the other way round would be picking blind.
  const carDef = await chooseCar(input, trackDef);
  applyCarTuning(TUNING, carDef);

  prompt.textContent = 'LOADING PHYSICS…';

  const renderer = createRenderer();
  const { scene, sun } = createScene(trackDef);
  const camera = new THREE.PerspectiveCamera(
    TUNING.camera.fovBase, window.innerWidth / window.innerHeight, 0.2, 3000,
  );

  const world = await initPhysics();
  prompt.textContent = 'BUILDING TRACK…';
  // Yield a frame so the loading text actually paints before the track build
  // blocks the thread for a few hundred milliseconds.
  await nextFrame();

  const track = new Track(world, RAPIER, scene, trackDef);
  const debug = new PhysicsDebug(scene);
  const blur = new SpeedBlur(renderer, scene, camera);
  const skidmarks = new Skidmarks(scene, 2400, trackDef);
  const smoke = new TyreSmoke(scene, 700, trackDef);
  smoke.setViewportHeight(window.innerHeight);
  const audio = new EngineAudio(carDef.sounds);
  // Built once the engine's AudioContext exists, so both share one context
  // and one master gain -- mute and volume stay in a single place.
  let tyreAudio = null;
  let music = null;

  // The car model is optional: if it's missing or malformed the game still runs
  // on the procedural car, so a bad asset can never stop you driving.
  prompt.textContent = `${carDef.name.toUpperCase()} — LOADING…`;
  let carModel = null;
  try {
    carModel = await loadCarModel(carDef.file);
  } catch (err) {
    console.warn(`no car model at ${carDef.file}, using the procedural car:`, err);
  }

  const hud = new Hud();
  hud.setTrackName(trackDef.name);
  hud.buildMinimap(track.points);
  const lapTimer = new LapTimer();
  const stepper = new FixedStepper();

  let vehicle = new Vehicle(world, RAPIER, track.spawnAt(SPAWN_PROGRESS));
  let car = mountCar(scene, null);

  const carCamera = new CarCamera(camera, renderer.domElement, (x, z) => track.terrainHeight(x, z));

  const gui = createGui({
    onRebuild: () => rebuildVehicle(),
    onToast: (msg) => hud.toast(msg),
    // Which car is being driven, so "reset to defaults" lands on THIS car's
    // defaults rather than on the shared baseline.
    car: carDef,
  });

  function mountCar(targetScene, previous) {
    if (previous) {
      targetScene.remove(previous.group);
      previous.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
    }
    // Use the imported model when it loaded; otherwise the procedural car.
    let built;
    if (carModel) {
      try {
        built = buildCarFromModel(carModel, TUNING, PALETTE, carDef.modelYaw ?? 0);
      } catch (err) {
        console.warn('car model could not be built, using the procedural car:', err);
        built = createCarMesh(TUNING);
      }
    } else {
      built = createCarMesh(TUNING);
    }
    for (const wheel of built.wheelMeshes) built.group.add(wheel);
    targetScene.add(built.group);
    return built;
  }

  // Rebuilding keeps the car where it is rather than teleporting it to the
  // start line, so you can tune mass or centre of mass mid-corner.
  function rebuildVehicle() {
    const p = vehicle.body.translation();
    const r = vehicle.body.rotation();
    const spawn = {
      position: { x: p.x, y: p.y + 0.15, z: p.z },
      rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
    };
    vehicle.dispose();
    vehicle = new Vehicle(world, RAPIER, spawn);
    car = mountCar(scene, car);
    carCamera.snap();
  }

  /**
   * Render wireframe: the triangles actually being drawn.
   *
   * Distinct from P, which shows Rapier's colliders -- what the physics sees.
   * This is what the GPU sees, and it is the view that makes a model's real
   * cost obvious: the car carried 954 meshes and a quarter of a million
   * triangles for a while without that being visible from any other angle.
   *
   * Reports the frame's draw calls and triangles with it, since those are the
   * numbers you actually act on and the renderer already counts them.
   */
  let wireframe = false;
  function toggleWireframe() {
    wireframe = !wireframe;
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        // Lines have no wireframe of their own, and forcing the flag onto the
        // collider debug view would silently do nothing.
        if (m && 'wireframe' in m) m.wireframe = wireframe;
      }
    });
    if (!wireframe) return 'wireframe off';
    // Counted from the geometry rather than read off renderer.info, which is
    // only populated after a render and so reports zero at the moment the key
    // is pressed.
    let meshes = 0;
    let tris = 0;
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.visible) return;
      const g = o.geometry;
      const count = g.index ? g.index.count : g.attributes.position?.count ?? 0;
      meshes++;
      tris += count / 3;
    });
    return `wireframe — ${meshes} meshes, ${(tris / 1000).toFixed(0)}k tris`;
  }

  function respawn(atProgress) {
    const progress = atProgress ?? track.project(vehicle.position()).progress;
    vehicle.reset(track.spawnAt(progress));
    lapTimer.invalidate();
    carCamera.snap();
  }

  // One definition, shared by the key and the button, so they cannot drift.
  const toMenu = () => { location.search = ''; };
  document.getElementById('menuBtn')?.addEventListener('click', toMenu);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Point size is in pixels, so smoke has to be told or it changes size
    // with the window.
    smoke.setViewportHeight(window.innerHeight);
    blur.setSize(window.innerWidth, window.innerHeight);
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    // The binding screen owns its own keys; the game just stays out of the
    // way so the car cannot be driven blind behind it.
    if (padPanel.isOpen) return;
    if (e.code === 'Backquote') hud.toast(hud.toggleDebug() ? 'debug on' : 'debug off');
    if (e.code === 'KeyG') gui._hidden ? gui.show() : gui.hide();
    if (e.code === 'KeyP') hud.toast(debug.toggle() ? 'colliders on' : 'colliders off');
    if (e.code === 'KeyO') hud.toast(toggleWireframe());
    if (e.code === 'KeyK') { skidmarks.clear(); smoke.clear(); hud.toast('skidmarks cleared'); }
    if (e.code === 'KeyV') { audio.setMuted(!audio.muted); hud.toast(audio.muted ? 'sound off' : 'sound on'); }
    if (e.code === 'KeyN') {
      if (music?.ready) hud.toast(music.toggle() ? 'music off' : 'music on');
      else hud.toast('no music loaded');
    }
    // Back to the circuit menu. A reload guarantees a clean world.
    // Back to the menu. Escape is what everyone reaches for, and T stays
    // because it always worked. location.search='' drops ?track= and ?car=,
    // so the deep link you arrived on cannot bounce you straight back in.
    if (e.code === 'KeyT' || e.code === 'Escape') toMenu();
  });

  // Expose for poking around from the console while tuning.
  Object.assign(window, {
    carsim: {
      get vehicle() { return vehicle; },
      get car() { return car; },
      track, trackDef, world, TUNING, hud, scene, camera, carCamera, renderer, skidmarks, smoke,
    },
  });

  prompt.textContent = `${trackDef.name.toUpperCase()} — GO`;
  prompt.classList.add('blink');

  const bootEl = document.getElementById('boot');
  // No second gate. Picking a circuit IS the button press, and making someone
  // press another one to confirm the thing they just chose is the opposite of
  // pick-up-and-play. It only ever existed to give the AudioContext a user
  // gesture to start from -- and a click or an Enter on a card is one, so the
  // common paths are already covered. The exception is choosing with a
  // gamepad, which browsers do not count as activation; that case is handled
  // below by asking for a key only when the audio really is still blocked.
  let started = false;
  let stuckTimer = 0;
  let last = performance.now();
  const carPos = new THREE.Vector3();
  const stepInput = {};

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;

    const state = input.update(dt);

    if (!started) {
      started = true;
      // Browsers only allow an AudioContext to start from a user gesture, and
      // this is the first one we get.
      audio.start().then(() => {
        if (audio.ready && !tyreAudio) {
          tyreAudio = new TyreAudio(
            audio.ctx, audio.buses,
            trackDef.surface.roadGrip, trackDef.surface.squeal ?? 1,
          );
          tyreAudio.load();   // the squeal sample, fetched without holding anything up
        }
        // Started separately and not awaited: the track is megabytes against
        // the engine's kilobytes, and the car should not be silent while it
        // downloads.
        if (audio.ready && !music) {
          music = new Music(audio.ctx, audio.buses.music);
          music.load().then(() => {
            if (music.ready && music.muted) hud.toast('music is muted — N to turn it on', 3500);
          });
        }
        // A gamepad button is not user activation as far as the browser is
        // concerned, so arriving here having only touched the pad leaves audio
        // blocked with nothing on screen to explain it. Say so -- any key or
        // click lifts it, and the handlers in audio.js are already waiting.
        if (audio.suspended) {
          hud.toast('press any key to enable sound', 5000);
        }
      });
      bootEl.classList.add('hidden');
      hud.toast(state.source === 'gamepad' ? `pad: ${input.describe()}` : 'keyboard — plug in a pad for analog control', 2600);
    }

    if (state.reset) { respawn(); hud.toast('respawned'); }
    if (state.camera) hud.toast(`camera: ${carCamera.cycle()}`);

    // --- physics ---
    let firstStep = true;
    stepper.advance(dt, (h) => {
      Object.assign(stepInput, state);
      if (!firstStep) {
        stepInput.shiftUp = false;
        stepInput.shiftDown = false;
        stepInput.toggleGearbox = false;
      }
      firstStep = false;

      vehicle.update(h, stepInput, gripAt);
      world.step();
    });

    if (state.toggleGearbox) {
      hud.toast(`gearbox: ${TUNING.transmission.automatic ? 'automatic' : 'manual'}`);
    }

    // --- render ---
    vehicle.syncMesh(car.group, car.wheelMeshes, stepper.alpha, car.bodyGroup);
    car.setBrakeLights?.(vehicle.braking);
    skidmarks.update(vehicle);
    smoke.update(dt, vehicle);
    audio.update(vehicle, dt);
    if (tyreAudio && !audio.muted) tyreAudio.update(vehicle);

    carPos.copy(car.group.position);
    const projection = track.project(carPos);
    const onTrack = Math.abs(projection.lateral) < 8;
    lapTimer.update(dt, projection.progress, onTrack);
    hud.setProgress(projection.progress, carPos, lapTimer.running);

    if (lapTimer.justCompleted) {
      hud.toast(
        `LAP ${lapTimer.lapCount}  ${formatTime(lapTimer.last)}${lapTimer.isBest ? '   ★ BEST' : ''}`,
        2800,
      );
    }

    // Rescue the car if it lands on its roof or drops out of the world.
    const upright = vehicle.up().y;
    if (upright < 0.2 && Math.abs(vehicle.speed) < 1.5) {
      stuckTimer += dt;
      if (stuckTimer > STUCK_SECONDS) {
        respawn(projection.progress);
        hud.toast('respawned');
        stuckTimer = 0;
      }
    } else {
      stuckTimer = 0;
    }
    if (carPos.y < -60) { respawn(projection.progress); hud.toast('respawned'); }

    carCamera.look(dt, state.lookX || 0, state.lookY || 0);
    carCamera.update(dt, car.group, vehicle);
    updateSunTarget(sun, carPos);
    debug.update(world);

    hud.update(dt, vehicle, lapTimer);
    hud.updateDebug({ vehicle, stepper, input, projection, camera: carCamera, lapTimer, tyreAudio });

    blur.render(scene, camera, vehicle.speedKmh);
  }

  const _grip = new THREE.Vector3();
  function gripAt(point) {
    _grip.copy(point);
    return track.gripAt(_grip, TUNING.surfaces);
  }

  // A handle on the running game, for poking at from the console. Audio in
  // particular is close to impossible to debug by ear alone -- being able to
  // hang an AnalyserNode off the master and measure what is actually coming
  // out is the difference between tuning it and guessing at it.
  window.__carsim = {
    vehicle, track, audio, hud, camera: carCamera, renderer, scene, cam: camera, car: () => car,
    skidmarks, smoke, blur,
    get tyreAudio() { return tyreAudio; },
  };

  requestAnimationFrame(frame);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}
