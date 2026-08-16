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
import { loadTracks, TRACK_IDS, getTrack, hasTrack, registerTrack } from './tracks.js';
import { loadStashedTrack, EDITOR_TRACK_ID } from './editor/state.js';
import { EngineAudio } from './audio.js';
import { TyreAudio } from './tyreaudio.js';
import { PadPanel } from './padui.js';

const SPAWN_PROGRESS = 0.985;   // just before the start line
const STUCK_SECONDS = 2.5;
const CAR_MODEL_URL = './assets/car.glb';

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
  const skidmarks = new Skidmarks(scene, 2400, trackDef);
  const audio = new EngineAudio();
  // Built once the engine's AudioContext exists, so both share one context
  // and one master gain -- mute and volume stay in a single place.
  let tyreAudio = null;

  // The car model is optional: if it's missing or malformed the game still runs
  // on the procedural car, so a bad asset can never stop you driving.
  prompt.textContent = 'LOADING CAR…';
  let carModel = null;
  try {
    carModel = await loadCarModel(CAR_MODEL_URL);
  } catch (err) {
    console.warn(`no car model at ${CAR_MODEL_URL}, using the procedural car:`, err);
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
        built = buildCarFromModel(carModel, TUNING, PALETTE);
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

  function respawn(atProgress) {
    const progress = atProgress ?? track.project(vehicle.position()).progress;
    vehicle.reset(track.spawnAt(progress));
    lapTimer.invalidate();
    carCamera.snap();
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    // The binding screen owns its own keys; the game just stays out of the
    // way so the car cannot be driven blind behind it.
    if (padPanel.isOpen) return;
    if (e.code === 'Backquote') hud.toast(hud.toggleDebug() ? 'debug on' : 'debug off');
    if (e.code === 'KeyG') gui._hidden ? gui.show() : gui.hide();
    if (e.code === 'KeyP') hud.toast(debug.toggle() ? 'colliders on' : 'colliders off');
    if (e.code === 'KeyK') { skidmarks.clear(); hud.toast('skidmarks cleared'); }
    if (e.code === 'KeyV') { audio.setMuted(!audio.muted); hud.toast(audio.muted ? 'sound off' : 'sound on'); }
    // Back to the circuit menu. A reload guarantees a clean world.
    if (e.code === 'KeyT') { location.search = ''; }
  });

  // Expose for poking around from the console while tuning.
  Object.assign(window, {
    carsim: {
      get vehicle() { return vehicle; },
      get car() { return car; },
      track, trackDef, world, TUNING, hud, scene, camera, carCamera, renderer, skidmarks,
    },
  });

  prompt.textContent = `${trackDef.name.toUpperCase()} — PRESS ANY BUTTON OR KEY`;
  prompt.classList.add('blink');

  const bootEl = document.getElementById('boot');
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

    if (!started && input.ready) {
      started = true;
      // Browsers only allow an AudioContext to start from a user gesture, and
      // this is the first one we get.
      audio.start().then(() => {
        if (audio.ready && !tyreAudio) tyreAudio = new TyreAudio(audio.ctx, audio.buses);
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
    vehicle.syncMesh(car.group, car.wheelMeshes, stepper.alpha);
    car.tailMat.emissiveIntensity = vehicle.braking ? 1.7 : 0.35;
    skidmarks.update(vehicle);
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

    carCamera.update(dt, car.group, vehicle);
    updateSunTarget(sun, carPos);
    debug.update(world);

    hud.update(dt, vehicle, lapTimer);
    hud.updateDebug({ vehicle, stepper, input, projection, camera: carCamera, lapTimer, tyreAudio });

    renderer.render(scene, camera);
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
    vehicle, track, audio, hud, camera: carCamera,
    get tyreAudio() { return tyreAudio; },
  };

  requestAnimationFrame(frame);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}
