// Bootstrap and the main loop.
//
// Frame shape: read input once, run N fixed physics steps, then render one
// interpolated frame. Input edges (shifts, respawn) are consumed on the first
// sub-step only, so a slow frame that runs four physics steps can't fire four
// upshifts off one button press.

import * as THREE from 'three';

import { TUNING, loadTuning } from './tuning.js';
import { createRenderer, createScene, createCarMesh, updateSunTarget, keepSkyWithCamera } from './scene.js';
import { setMaxAnisotropy } from './roadtexture.js';
import { initPhysics, RAPIER, FixedStepper, PhysicsDebug } from './physics.js';
import { Track, sampleCircuit } from './track.js';
import { Vehicle } from './vehicle.js';
import { Input } from './input.js';
import { CarCamera, applyHandheldFraming } from './camera.js';
import { Hud } from './hud.js';
import { LapTimer, SECTORS, formatTime } from './laptimer.js';
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
import { CARS, getCar, applyCarTuning, carStats } from './cars.js';
import { Autopilot } from './autopilot.js';
import { GhostLap } from './ghost.js';
import { Race } from './race.js';
import { Headlights } from './headlights.js';
import { TouchControls, touchLikely } from './touch.js';
import { HandlingAssist, assistPreference, setAssistPreference } from './assist.js';
import { FinishScreen } from './finish.js';
import { listEffects, toggleEffect, loadEffects, renderFrame, resetPostHistory } from './post/post.js';

/**
 * `?touch=1`, `?assist=0` and so on: force either one, on either device.
 *
 * Auto-detection is right for players and useless for testing. The touch
 * controls could not be tried on a desktop at all, and the assist could only
 * be reached through a menu that only exists once the controls are up -- so
 * the two things most in need of a side-by-side comparison were the two that
 * could not be compared. A query parameter survives a reload and travels in a
 * link, which a key press does not.
 *
 * @returns {boolean|null} null when the parameter is absent, meaning "decide".
 */
function forced(name) {
  const v = new URLSearchParams(location.search).get(name);
  if (v === null) return null;
  return v !== '0' && v !== 'false' && v !== 'off';
}

/**
 * What the assist will do on this load, before the car exists to be told.
 *
 * Order matters and it runs most-explicit first: a toggle made this session, a
 * parameter in the link, the choice the player last made and had remembered,
 * and only then a guess from the input device.
 */
function assistDefault() {
  return forced('assist') ?? assistPreference() ?? touchLikely();
}

/**
 * The assist switch on the title card.
 *
 * Wired here rather than with the rest of the game because it has to work
 * before there is a car: the menu is the natural place to decide how the car
 * should drive, and on a phone it is the only place, since Y is not a key
 * anybody has. It writes the stored preference and nothing else -- the car
 * reads that when it is built.
 */
function wireBootOptions() {
  const btn = document.getElementById('assistOpt');
  if (!btn) return;
  const value = btn.querySelector('.v');
  let on = assistDefault();
  const paint = () => {
    btn.setAttribute('aria-pressed', String(on));
    value.textContent = on ? 'ON' : 'OFF';
  };
  btn.addEventListener('click', () => {
    on = !on;
    setAssistPreference(on);
    paint();
  });
  paint();
}

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
    // Long low nose, a small canopy set well forward, and a tail that runs
    // flat to the tip. No wing: that is most of what an F1 looks like.
    mclarenf1: 'M12,74 L24,60 L58,50 L96,38 L124,37 L152,45 L184,55 L212,74 Z',
  };
  const TINT = {
    alpine: '#9fb6c9', gt3rs: '#c8a02c', sc18: '#2e2f33', mclarenf1: '#b9bfc6',
  };
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
  wireBootOptions();
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

  // How the car is FRAMED follows the screen, not the controls.
  //
  // Deliberately not `touchLikely() && !hasGamepad`, which is the rule for the
  // on-screen buttons: pairing a Bluetooth pad to a phone puts the controls
  // away, and does nothing at all about the phone still being a phone-sized
  // screen held at arm's length. The buttons are about how you drive; this is
  // about how far away everything looks.
  //
  // After applyCarTuning, so a car's overrides cannot land on top of it. None
  // of them touch the camera today, and this should not quietly depend on that
  // staying true.
  const framing = new URLSearchParams(location.search).get('framing');
  const handheld = framing ? framing === 'handheld' : touchLikely();
  if (handheld) applyHandheldFraming(TUNING);

  await stage(prompt, 'STARTING PHYSICS');

  const renderer = createRenderer();
  // The one line that stops a tiled road turning into crawling noise at
  // distance. Told once; the track asks for its surface long after this.
  setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());
  const { scene, sun, sky } = createScene(trackDef);
  const camera = new THREE.PerspectiveCamera(
    TUNING.camera.fovBase, window.innerWidth / window.innerHeight, 0.2, 3000,
  );

  const world = await initPhysics();
  await stage(prompt, 'BUILDING TRACK');

  const track = new Track(world, RAPIER, scene, trackDef);
  const debug = new PhysicsDebug(scene);
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
  await stage(prompt, `LOADING ${carDef.name.toUpperCase()}`);
  let carModel = null;
  try {
    carModel = await loadCarModel(carDef.file);
  } catch (err) {
    console.warn(`no car model at ${carDef.file}, using the procedural car:`, err);
  }

  // Touch controls, and the compact HUD that makes room for them.
  //
  // Enabled on a coarse pointer with NO gamepad attached: phones and tablets
  // pair Bluetooth pads happily, and when one is connected the on-screen
  // controls are just something covering the road. The keyboard stays live
  // throughout either way.
  const touch = new TouchControls(document.getElementById('touch'));
  const assist = new HandlingAssist(TUNING);

  const forceTouch = forced('touch');
  const forceAssist = forced('assist');
  // Read once, not per frame: syncTouch runs every frame and localStorage is
  // synchronous. Nothing can change it while the game is up anyway -- the
  // switch that writes it lives on the title card, which is gone by now.
  const storedAssist = assistPreference();

  /**
   * Set once the player toggles the assist by hand, and never cleared.
   *
   * Without it, auto-detection would quietly undo the choice the moment
   * anything re-evaluated -- turning the assist back on for someone who had
   * just decided they wanted it off.
   */
  let assistChosen = null;

  const syncTouch = () => {
    const wantTouch = forceTouch ?? (touchLikely() && !input.hasGamepad);
    if (wantTouch !== touch.enabled) {
      touch.setEnabled(wantTouch);
      // Same call swaps the dials for the digital cluster: both changes have
      // the same cause, which is that the screen is small and being held.
      hud.setCompact(wantTouch);
    }
    // Independent of the controls, so a phone can be driven raw and a desktop
    // can be driven assisted -- which is the only way to tell what the assist
    // is actually doing. It follows the controls only until somebody says
    // otherwise.
    const wantAssist = assistChosen ?? forceAssist ?? storedAssist ?? wantTouch;
    if (wantAssist !== assist.on) assist.setOn(wantAssist);
  };

  const toggleAssist = () => {
    assistChosen = !assist.on;
    assist.setOn(assistChosen);
    // Remembered, so the switch on the title card agrees with the car you just
    // got out of -- and so going back to the circuits does not undo it.
    setAssistPreference(assistChosen);
    hud.toast(assistChosen
      ? 'assist ON — more lock, more grip, counter-steer help'
      : 'assist OFF — the raw car');
    return assistChosen;
  };

  const hud = new Hud();
  hud.setTrackName(trackDef.name);
  hud.buildMinimap(track.points);
  const lapTimer = new LapTimer(`${trackDef.id}:${carDef.id}`);
  const ghost = new GhostLap(`${trackDef.id}:${carDef.id}`);
  const race = new Race();
  let sectorsShown = 0;
  const stepper = new FixedStepper();

  let vehicle = new Vehicle(world, RAPIER, track.spawnAt(SPAWN_PROGRESS));
  /** @type {Headlights|null} — created by mountCar, rebuilt with the mesh. */
  let headlights = null;
  let car = mountCar(scene, null);

  /**
   * The car your best lap was driven in, to drive against.
   *
   * The same mesh as your own, made translucent rather than a simplified
   * stand-in: the whole value of a ghost is reading its line and its braking
   * point off it, and you read those off a shape you recognise. It carries no
   * physics and no collider -- it is a picture of a lap, and driving through it
   * has to be free or it stops being a reference and becomes an obstacle.
   */
  function buildGhostCar() {
    const built = mountCar(scene, null);   // adds its own wheels and scene entry
    built.group.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      o.material = mats.map((m) => {
        const ghosted = m.clone();
        ghosted.transparent = true;
        ghosted.opacity = GHOST_OPACITY;
        // Both of these are here because the obvious settings look wrong.
        //
        // depthWrite off is the usual advice for transparency, and on a car it
        // is exactly backwards: nothing occludes anything, so you see the seats
        // and the far side of the shell THROUGH the near side and the car reads
        // as an interior with no outside. Writing depth lets the nearest
        // surface hide what is behind it, which is what makes it read as a car
        // at all.
        ghosted.depthWrite = true;
        // And the far side of the bodywork is still drawn without this, since a
        // model authored for an opaque car has no reason to cull anything.
        ghosted.side = THREE.FrontSide;
        return ghosted;
      });
      if (o.material.length === 1) [o.material] = o.material;
      o.castShadow = false;
      o.receiveShadow = false;
    });
    built.group.visible = false;
    return built;
  }

  // Built on demand rather than at boot: the lap that first sets a reference is
  // driven in a session that started without one, and waiting for a reload to
  // show the ghost means never seeing it on the run that earned it.
  let ghostCar = null;
  const GHOST_OPACITY = 0.45;
  const _ghostPos = new THREE.Vector3();

  // How far the car's origin sits above the road surface. A recording holds a
  // point ON the road, but a car's group is anchored at the chassis, so placing
  // the ghost at the recorded point buries it to the windows -- 0.71 m of a
  // car about 1.2 m tall.
  //
  // Taken from the circuit's own spawn height rather than reassembled from the
  // suspension figures here, so it cannot drift away from where the game
  // actually puts a car. The sag is the one part spawn does not include: it
  // drops the car at its RESTING height and lets it settle, and a ghost that
  // never settles has to be lowered by hand. Closed form from carmodel.js.
  const GHOST_LIFT = track.spawnAt(0).position.y - track.points[0].y
    - 9.81 / (4 * TUNING.suspension.stiffness);

  /**
   * Put the ghost where its lap says it was at this point on the clock.
   *
   * A recording holds only progress and how far off the centreline it ran; the
   * rest is looked up in the circuit, which is why it costs 8 KB instead of a
   * megabyte. The heading comes from the road's own tangent rather than from
   * the recording, so the ghost never points somewhere the road does not go --
   * it loses the drift angle, and that is a fair trade for never looking
   * broken.
   */
  function placeGhost(elapsed) {
    if (!ghost.hasReference) return;
    if (!ghostCar) ghostCar = buildGhostCar();
    const pose = ghost.poseAt(elapsed);
    if (!pose) { ghostCar.group.visible = false; return; }

    const pts = track.points;
    const n = pts.length;
    const x = pose.progress * n;
    const i = Math.floor(x) % n;
    const j = (i + 1) % n;
    const f = x - Math.floor(x);
    const a = pts[i];
    const b = pts[j];
    const r = track.rights[i];
    _ghostPos.set(
      a.x + (b.x - a.x) * f + r.x * pose.lateral,
      a.y + (b.y - a.y) * f + GHOST_LIFT,
      a.z + (b.z - a.z) * f + r.z * pose.lateral,
    );
    ghostCar.group.position.copy(_ghostPos);
    const t = track.tangents[i];
    ghostCar.group.rotation.set(0, Math.atan2(t.x, t.z), 0);
    ghostCar.group.visible = true;
  }

  const carCamera = new CarCamera(camera, renderer.domElement, (x, z) => track.terrainHeight(x, z));

  // A computer driver you can sit and watch. Not the timid one in the test
  // harness -- this one is trying, and that makes it the fastest way to see
  // what a layout does. See autopilot.js.
  const autopilot = new Autopilot(track);

  loadEffects();

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
        built = buildCarFromModel(carModel, TUNING, PALETTE, carDef.modelYaw ?? 0, carDef.paint);
      } catch (err) {
        console.warn('car model could not be built, using the procedural car:', err);
        built = createCarMesh(TUNING);
      }
    } else {
      built = createCarMesh(TUNING);
    }
    for (const wheel of built.wheelMeshes) built.group.add(wheel);
    targetScene.add(built.group);
    // Bolted to the car's own group, so they follow it without any per-frame
    // work. Rebuilt with the mesh because the old ones went with the old group.
    const wasOn = headlights?.on ?? (trackDef.headlights ?? false);
    headlights?.dispose();
    headlights = new Headlights(built.group, TUNING, built.frontLampMats ?? [], { scene, camera });
    headlights.setOn(wasOn);
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
    // The camera just teleported. Motion blur reprojects from where it was
    // last frame, so without this the first frame back smears the whole
    // screen across the distance the car was moved.
    resetPostHistory();
  }

  // One definition, shared by the key and the button, so they cannot drift.
  const toMenu = () => { location.search = ''; };

  /**
   * Start the race over without rebuilding the world.
   *
   * A reload would be simpler and is what T does, but it costs a second of
   * black screen and re-parses the circuit -- fine as a way out to the menu,
   * far too slow for the button you press the instant you cross the line and
   * want another go. Everything that carries state across a race is reset here
   * by hand, and the list is short enough to keep honest.
   */
  function restartRace() {
    race.reset();
    lapTimer.reset();
    ghost.abandon();
    sectorsShown = 0;
    respawn(SPAWN_PROGRESS);
    skidmarks.clear();
    smoke.clear();
    hud.toast(`${race.totalLaps} laps — go`, 1800);
  }

  // The keyboard-only toggles, as things you can tap. Labels are read at the
  // moment the menu opens rather than baked in, so a toggle shows its CURRENT
  // state instead of the state it had when the game booted.
  touch.setActions([
    { label: () => `Assist: ${assist.on ? 'on' : 'off'}`, run: () => toggleAssist() },
    { label: 'FPS counter', run: () => hud.toggleFps() },
    { label: 'Headlights', run: () => hud.toast(headlights?.toggle() ? 'headlights on' : 'headlights off') },
    { label: 'Camera', run: () => hud.toast(`camera: ${carCamera.cycle()}`) },
    { label: 'Sound', run: () => { audio.setMuted(!audio.muted); hud.toast(audio.muted ? 'sound off' : 'sound on'); } },
    { label: 'Back on track', run: () => { respawn(); ghost.abandon(); hud.toast('respawned'); } },
    { label: 'Restart race', run: () => restartRace() },
    { label: 'Circuits', run: () => toMenu() },
  ]);

  const finishScreen = new FinishScreen(
    document.getElementById('finish'),
    (action) => { if (action === 'again') restartRace(); else toMenu(); },
  );
  document.getElementById('menuBtn')?.addEventListener('click', toMenu);

  /**
   * How big the window actually is, which on a phone is not innerWidth.
   *
   * iOS reports innerHeight including the strip the URL bar sits in, and
   * Safari slides that bar away on its own schedule. Between the two the canvas
   * ends up shorter than the page and the difference shows as a black band
   * across the top -- the HUD is fixed to the viewport so it keeps drawing over
   * the band, which makes it look like a rendering fault rather than a sizing
   * one. visualViewport is the one that reports what you can actually see.
   */
  const viewportSize = () => {
    const vv = window.visualViewport;
    return {
      w: Math.round(vv?.width ?? window.innerWidth),
      h: Math.round(vv?.height ?? window.innerHeight),
    };
  };

  let lastSize = { w: 0, h: 0 };
  const applySize = () => {
    const { w, h } = viewportSize();
    if (!w || !h || (w === lastSize.w && h === lastSize.h)) return;
    lastSize = { w, h };
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    // No style resize call: a style that keeps its own render targets notices
    // the new size on the next frame and rebuilds itself once, rather than
    // once per resize event while the window edge is being dragged.
    // Point size is in pixels, so smoke has to be told or it changes size
    // with the window.
    smoke.setViewportHeight(h);
  };

  /**
   * Re-measure repeatedly for a moment after a rotation.
   *
   * iOS fires orientationchange BEFORE the viewport has finished changing, and
   * a measurement taken then is the old one -- so a single resize on that event
   * locks in exactly the wrong size and the black band stays until something
   * else happens to trigger another. Sampling for two thirds of a second costs
   * nothing (applySize returns immediately when the size has not moved) and
   * covers the animation however long the device takes over it.
   */
  let settleTimer = null;
  const settleSize = () => {
    applySize();
    clearInterval(settleTimer);
    const until = performance.now() + 650;
    settleTimer = setInterval(() => {
      applySize();
      if (performance.now() > until) clearInterval(settleTimer);
    }, 60);
  };

  window.addEventListener('resize', applySize);
  window.addEventListener('orientationchange', settleSize);
  // Fires when the URL bar slides away, which `resize` on iOS does not always
  // do -- and that bar appearing or leaving is most of what changes here.
  window.visualViewport?.addEventListener('resize', applySize);
  window.visualViewport?.addEventListener('scroll', applySize);
  applySize();

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    // The binding screen owns its own keys; the game just stays out of the
    // way so the car cannot be driven blind behind it.
    if (padPanel.isOpen) return;
    // The controls list, which used to be permanently in the corner. Toggling
    // it here rather than in the Hud because every other overlay key lives on
    // this switch and splitting them makes the set impossible to read.
    if (e.code === 'KeyH') {
      const panel = document.getElementById('help');
      const hint = document.getElementById('helpHint');
      const on = panel?.classList.toggle('on');
      if (hint) hint.style.opacity = on ? '0.25' : '';
    }
    if (e.code === 'KeyF') hud.toggleFps();
    if (e.code === 'Backquote') hud.toast(hud.toggleDebug() ? 'debug on' : 'debug off');
    if (e.code === 'KeyG') gui._hidden ? gui.show() : gui.hide();
    if (e.code === 'KeyP') hud.toast(debug.toggle() ? 'colliders on' : 'colliders off');
    if (e.code === 'KeyO') hud.toast(toggleWireframe());
    // Watch the computer drive it. Puts the car back on the line first, so it
    // always starts from somewhere it can actually get going from.
    if (e.code === 'KeyJ') {
      autopilot.enabled = !autopilot.enabled;
      // Its laps are timed and shown, but they are not yours and never take
      // the record.
      lapTimer.counting = !autopilot.enabled;
      if (autopilot.enabled) { respawn(); lapTimer.invalidate(); ghost.abandon(); }
      hud.toast(autopilot.enabled ? 'autopilot — watch it drive' : 'autopilot off', 2200);
    }
    // 1-7 switch post effects on and off while driving, whatever style is on.
    //
    // Judging a look is not something you can do from a settings screen: what
    // matters is whether the bloom helps at 200 km/h into a corner, and the
    // only way to know is to take it away without stopping. The digits are
    // positional and match the pipeline order, and the toast names what moved.
    if (/^Digit[1-9]$/.test(e.code)) {
      const changed = toggleEffect(Number(e.code.slice(5)) - 1);
      if (changed) hud.toast(`${changed.label} ${changed.on ? 'on' : 'off'}`);
    }
    if (e.code === 'KeyY') toggleAssist();
    if (e.code === 'KeyL') hud.toast(headlights?.toggle() ? 'headlights on' : 'headlights off');
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
      lapTimer, race, finishScreen, restartRace, touch, assist,
      get headlights() { return headlights; },
    },
  });

  // Compile every shader before saying GO.
  //
  // three builds a material's GPU program the first time it is DRAWN, and this
  // scene has a lot of materials -- so without this the first seconds of play
  // are spent compiling, one stall per material, while the car sits there
  // apparently frozen. It is the same total work either way; the difference is
  // whether it happens behind a screen that says it is loading or after one
  // that says GO.
  //
  // compileAsync yields between programs so the page stays alive; compile()
  // is the synchronous fallback for anything that lacks it.
  await stage(prompt, 'PREPARING GRAPHICS');
  try {
    if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
    else renderer.compile(scene, camera);
  } catch (err) {
    // Never fatal: a shader that will not precompile still compiles on first
    // draw, which is exactly where it was before.
    console.warn('shader precompile skipped:', err);
  }

  prompt.classList.remove('working');
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
    // After the keyboard and pad, so a finger wins over a stick that is not
    // being held -- and before anything reads the state.
    syncTouch();
    touch.update(dt);
    touch.apply(state);

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

    if (state.reset) { respawn(); ghost.abandon(); hud.toast('respawned'); }
    if (state.camera) hud.toast(`camera: ${carCamera.cycle()}`);

    // Hands off once the race is over.
    //
    // The world keeps stepping -- the car rolls to a stop, the suspension
    // settles, the engine idles down, and it all stays on screen behind the
    // results. What it must not do is respond: a pad still resting on the
    // trigger would otherwise drive off into the scenery under the leaderboard,
    // and the keys the results screen wants (R, T, Enter, the arrows) are the
    // same keys that drive.
    if (race.finished) {
      state.throttle = 0;
      state.brake = 0;
      state.steer = 0;
      state.handbrake = 0;
      state.shiftUp = false;
      state.shiftDown = false;
      state.reset = false;
      state.camera = false;
      state.toggleGearbox = false;
    }

    // --- physics ---
    // The autopilot substitutes for the pad at the input layer and nowhere
    // else: same car, same physics, same limits. If it cannot make a corner,
    // neither can you.
    if (autopilot.enabled && !race.finished) Object.assign(state, autopilot.update(vehicle));

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
    car.setBrakeLights?.(vehicle.braking, headlights?.on ?? false);
    skidmarks.update(vehicle);
    smoke.update(dt, vehicle);
    audio.update(vehicle, dt);
    if (tyreAudio && !audio.muted) tyreAudio.update(vehicle);

    carPos.copy(car.group.position);
    const projection = track.project(carPos);
    const onTrack = Math.abs(projection.lateral) < 8;
    lapTimer.update(dt, projection.progress, onTrack);
    hud.setProgress(projection.progress, carPos, lapTimer.running, race);

    // --- driving against your own best lap ---------------------------------
    //
    // Order matters here and it is not obvious. Crossing the line ENDS one lap
    // and STARTS the next in the same frame, so a recording kept for the lap
    // that just finished has to be taken before the next one wipes it. Written
    // the other way round -- and it was -- every best lap commits a recording
    // that is one frame old and empty.
    race.update(lapTimer);
    if (race.justFinished) {
      finishScreen.show({
        race, track: trackDef, car: carDef,
        counted: race.counted, at: Date.now(),
      });
    }
    if (lapTimer.justCompleted && lapTimer.isBest) ghost.commit();
    if (lapTimer.justStarted) { ghost.begin(); sectorsShown = 0; }
    if (lapTimer.running) ghost.sample(projection.progress, lapTimer.current, projection.lateral);

    // Sectors say WHERE the delta bar's number came from. The bar tells you
    // that you are down four tenths; the split tells you it all went in the
    // first third, which is the half of it you can act on.
    if (lapTimer.sectorsHit.size > sectorsShown) {
      const s = SECTORS[sectorsShown];
      const was = ghost.timeAt(s);
      sectorsShown = lapTimer.sectorsHit.size;
      if (was !== null && lapTimer.running) {
        const d = lapTimer.current - was;
        hud.toast(`S${sectorsShown}   ${d > 0 ? '+' : '-'}${Math.abs(d).toFixed(2)}`, 1600);
      }
    }

    hud.setDelta(
      lapTimer.running && ghost.hasReference
        ? ghost.delta(projection.progress, lapTimer.current)
        : null,
    );
    placeGhost(lapTimer.running ? lapTimer.current : -1);

    if (lapTimer.justCompleted) {
      hud.toast(
        `LAP ${Math.min(race.laps.length, race.totalLaps)}/${race.totalLaps}  ` +
        `${formatTime(lapTimer.last)}${lapTimer.isBest ? '   ★ BEST' : ''}`,
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
    keepSkyWithCamera(sky, camera);
    debug.update(world);

    hud.update(dt, vehicle, lapTimer);
    hud.updateDebug({
      vehicle, stepper, input, projection, camera: carCamera, lapTimer, tyreAudio,
      fx: listEffects().filter((e) => e.on).map((e) => e.id).join('+') || 'none',
      autopilot: autopilot.enabled,
    });

    // One exit point. With no effects switched on this is renderer.render()
    // straight to the canvas -- see post/post.js.
    renderFrame(dt, { renderer, scene, camera }, { vehicle });
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
    skidmarks, smoke, lapTimer, ghost, race, assist, touch,
    get ghostCar() { return ghostCar; },
    get tyreAudio() { return tyreAudio; },
  };

  requestAnimationFrame(frame);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/**
 * Announce a loading stage and let it paint.
 *
 * Setting textContent and then immediately doing several hundred milliseconds
 * of synchronous work means the text never appears: the browser needs a frame
 * to draw it and the main thread is busy. Every stage was written that way, so
 * the screen simply sat there -- the messages existed and nobody ever saw
 * them, which reads as a hang rather than as loading.
 *
 * Bundling the yield into the announcement makes that impossible to forget.
 */
async function stage(prompt, text) {
  prompt.textContent = text;
  prompt.classList.add('working');
  await nextFrame();
}
