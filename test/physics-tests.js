// Headless physics tests.
//
// No renderer, no canvas, no camera -- just the Rapier world, the real Track
// and the real Vehicle, stepped in simulated time. That makes results
// independent of frame rate and machine speed, and fast enough to drive a
// whole lap in a few seconds.
//
// Open /test.html, or read window.__testResults after window.__testsDone.
//
// The lap test is the important one: an autopilot drives the full circuit and
// fails if the car ever stalls at full throttle. Every "invisible wall" bug
// this project has had would have been caught by it automatically.

import * as THREE from 'three';

import { TUNING, resetTuning } from '../src/tuning.js';
import { initPhysics, RAPIER } from '../src/physics.js';
import { Track } from '../src/track.js';
import { Vehicle } from '../src/vehicle.js';
import { loadTracks, getTrack, TRACK_IDS, DEFAULT_TRACK } from '../src/tracks.js';
import {
  validateTrackFile, normaliseTrack, mergeDefaults, parseColor, formatColor,
  TrackFormatError,
} from '../src/trackfile.js';
import { validateTrack, LIMITS } from '../src/trackcheck.js';
import { tyreMix } from '../src/tyreaudio.js';
import { AT_LIMIT } from '../src/telemetry.js';

const DT = TUNING.world.fixedStep;
const CHUNK = 400;              // steps between yields, keeps the page alive

const NEUTRAL = {
  steer: 0, throttle: 0, brake: 0, handbrake: 0,
  shiftUp: false, shiftDown: false, reset: false, camera: false, toggleGearbox: false,
};

function input(over = {}) { return { ...NEUTRAL, ...over }; }

// --- tiny assertion harness ------------------------------------------------

class Report {
  constructor(el) { this.el = el; this.lines = []; this.pass = 0; this.fail = 0; this.results = {}; }

  log(text, cls = 'info') {
    this.lines.push(`<span class="${cls}">${text}</span>`);
    this.flush();
  }

  section(name) { this.log(`\n── ${name} ${'─'.repeat(Math.max(0, 52 - name.length))}`); }

  check(label, ok, detail) {
    if (ok) { this.pass++; this.log(`  PASS  ${label}${detail ? `   ${detail}` : ''}`, 'pass'); }
    else { this.fail++; this.log(`  FAIL  ${label}${detail ? `   ${detail}` : ''}`, 'fail'); }
    return ok;
  }

  flush() { if (this.el) this.el.innerHTML = this.lines.join('\n'); }
}

// --- world helpers ---------------------------------------------------------

async function buildWorld(trackId = 'forest') {
  const world = await initPhysics();
  const scene = new THREE.Scene();       // geometry only, never rendered
  const track = new Track(world, RAPIER, scene, getTrack(trackId));
  const vehicle = new Vehicle(world, RAPIER, track.spawnAt(0.985));
  const grip = (p) => track.gripAt(p, TUNING.surfaces);
  return { world, track, vehicle, grip };
}

/**
 * Yield to the event loop without setTimeout's background-tab clamping.
 *
 * Chrome throttles setTimeout in a hidden or unfocused window to about once a
 * second, and to once a minute after five minutes. A lap yields ~40 times, so
 * clicking away from the tab turned a one-minute suite into one that would
 * never finish. MessageChannel is not throttled, so the tests now run at full
 * speed whether or not anyone is watching them.
 */
const yieldChannel = new MessageChannel();
function yieldToLoop() {
  return new Promise((resolve) => {
    yieldChannel.port1.onmessage = resolve;
    yieldChannel.port2.postMessage(0);
  });
}

/** Step the sim, yielding periodically so the browser stays responsive. */
async function run(ctx, steps, controller, onStep) {
  const { world, vehicle, grip } = ctx;
  for (let i = 0; i < steps; i++) {
    const cmd = controller ? controller(vehicle, i) : NEUTRAL;
    vehicle.update(DT, cmd, grip);
    world.step();
    if (onStep) onStep(vehicle, i);
    if (i % CHUNK === CHUNK - 1) await yieldToLoop();
  }
}

/**
 * A large flat pad well away from the circuit, at y = 0. Used for the tests
 * that need clean, unambiguous conditions: braking distance and top speed.
 */
const PAD = { x: 6000, z: 6000, halfWidth: 600, halfLength: 9000 };

function makePad(world) {
  const collider = world.createCollider(
    RAPIER.ColliderDesc
      .cuboid(PAD.halfWidth, 5, PAD.halfLength)
      .setTranslation(PAD.x, -5, PAD.z)
      .setFriction(1.0),
  );
  return {
    collider,
    spawn(backFromCentre = 8000) {
      return {
        position: { x: PAD.x, y: 0.9, z: PAD.z - backFromCentre },
        rotation: { x: 0, y: 0, z: 0, w: 1 },   // facing +Z
      };
    },
    remove() { world.removeCollider(collider, false); },
  };
}

function rideHeight(ctx) {
  const p = ctx.vehicle.body.translation();
  return p.y - ctx.track.project({ x: p.x, y: p.y, z: p.z }).height;
}

function chassisTouching(ctx) {
  // Broad-phase pairs always exist near the ground; only count real penetration.
  const p = ctx.vehicle.body.translation();
  const road = ctx.track.project({ x: p.x, y: p.y, z: p.z }).height;
  const bottom = p.y - TUNING.chassis.halfHeight + TUNING.chassis.colliderOffsetY;
  return bottom <= road + 0.005;
}

// --- the autopilot ---------------------------------------------------------
//
// Pure pursuit: aim at a point on the centerline about a second ahead, and cap
// speed by the tightest curvature coming up. Not fast, just competent enough
// that any place it gets stuck is the track's fault, not the driver's.

// The autopilot exists to prove the circuit is driveable, not to set a lap
// record, so it is deliberately slow and conservative. If it can complete a lap
// without ever stalling, there is no invisible wall anywhere on the track.
const LATERAL_BUDGET = 6.0;   // m/s^2 it is willing to ask of the tyres
const SPEED_CAP = 30;         // m/s (~108 km/h)

const _pos = new THREE.Vector3();
const _toTarget = new THREE.Vector3();

/** Pure-pursuit steering toward a point on the centerline about a second ahead. */
function pursuit(track, vehicle) {
  vehicle.position(_pos);
  const proj = track.project(_pos);
  const n = track.points.length;
  const speed = Math.abs(vehicle.speed);

  const lookahead = Math.max(5, Math.round(speed * 0.62));
  _toTarget.subVectors(track.points[(proj.index + lookahead) % n], _pos);

  const fwd = vehicle.forward();
  const right = vehicle.right();          // true right-hand side (-X in car space)
  // How far to the car's right the target sits, and how far ahead.
  const lateral = _toTarget.x * right.x + _toTarget.z * right.z;
  const ahead = Math.max(_toTarget.x * fwd.x + _toTarget.z * fwd.z, 1);

  // input.steer is +1 for right, matching the sign of the lateral error.
  let steer = THREE.MathUtils.clamp((lateral / ahead) * 1.8, -1, 1);
  // proj.lateral is positive when we're right of the centerline, so steer left.
  steer += THREE.MathUtils.clamp(-proj.lateral * 0.045, -0.35, 0.35);

  let curv = 0;
  for (let k = 2; k < lookahead + 14; k++) {
    curv = Math.max(curv, track.curvature[(proj.index + k) % n]);
  }

  // Ask less of the tyres on a low-grip surface, or the autopilot simply
  // drives off the outside of every corner on snow.
  const budget = LATERAL_BUDGET * track.def.surface.roadGrip;
  return {
    steer: THREE.MathUtils.clamp(steer, -1, 1),
    proj,
    cornerSpeed: Math.min(curv > 1e-5 ? Math.sqrt(budget / curv) : SPEED_CAP, SPEED_CAP),
  };
}

function makeAutopilot(track) {
  return (vehicle) => {
    const { steer, cornerSpeed } = pursuit(track, vehicle);
    const speed = Math.abs(vehicle.speed);
    return input({
      steer,
      throttle: speed < cornerSpeed ? 1 : 0,
      brake: speed > cornerSpeed * 1.08 ? 0.75 : 0,
    });
  };
}

// --- tests -----------------------------------------------------------------

/**
 * The track file format itself: that the shipped circuits load and land on
 * sane values, and that the validator actually rejects the mistakes it claims
 * to. A validator nobody has watched reject anything is decoration -- and this
 * one is meant to be the thing a future track editor leans on, so it gets to
 * prove it catches a missing field, a bad colour and a folded control point
 * list before anyone trusts it with a layout.
 */
async function testTrackFiles(r) {
  r.section('track files');

  r.check('catalogue loaded', TRACK_IDS.length === 4, TRACK_IDS.join(', '));
  r.check('default circuit resolves', Boolean(getTrack(DEFAULT_TRACK)), DEFAULT_TRACK);
  r.check('unknown id falls back to default',
    getTrack('nope-not-a-track').id === DEFAULT_TRACK);

  // Every circuit must arrive with the fields Track and Scene read directly.
  // Missing any of these used to be a TypeError deep inside a mesh builder.
  for (const id of TRACK_IDS) {
    const d = getTrack(id);
    const ok =
      typeof d.name === 'string' && d.name.length > 0 &&
      d.halfWidth > 0 && d.curbWidth >= 0 &&
      Array.isArray(d.controlPoints) && d.controlPoints.length >= 4 &&
      Number.isFinite(d.envSlope) && Number.isFinite(d.roadClearance) &&
      Number.isFinite(d.surface.roadGrip) && Number.isFinite(d.surface.grassGrip) &&
      Number.isFinite(d.banking.gain) && Number.isFinite(d.hills.amplitude) &&
      Number.isFinite(d.fog.near) && Number.isFinite(d.fog.far) &&
      typeof d.sun.color === 'number' && d.sun.position.length === 3 &&
      Number.isFinite(d.scenery.treeCount) && d.scenery.treeHeight.length === 2 &&
      Number.isFinite(d.scenery.postSpacing);
    r.check(`complete runtime shape — ${id}`, ok,
      `${d.controlPoints.length} pts, ${(d.halfWidth * 2).toFixed(1)} m wide, grip ${d.surface.roadGrip}`);
  }

  // Palette colours must be numbers by the time they reach three.js: a
  // "#rrggbb" string that slipped through renders as black, silently.
  for (const id of TRACK_IDS) {
    const p = getTrack(id).palette;
    const bad = Object.entries(p).filter(([, v]) => typeof v !== 'number');
    r.check(`palette parsed to numbers — ${id}`, bad.length === 0,
      bad.length ? bad.map(([k]) => k).join(', ') : `${Object.keys(p).length} colours`);
  }

  // Defaults must actually reach a file that doesn't restate them: forest
  // declares nothing but control points, so every other value it has is
  // inherited. If merging broke, this is where it shows.
  const forest = getTrack('forest');
  r.check('defaults merge into a sparse file',
    forest.halfWidth === 6.0 && forest.scenery.treeCount === 620 &&
    forest.surface.grassGrip === 0.45 && forest.palette.skidmark === 0x101216,
    'forest inherits width, scenery, grip and skidmark colour');

  // ...and a track that overrides one key of a nested group must keep its
  // siblings. Mountains sets terrain.envelope only; hills comes from defaults.
  const mountains = getTrack('mountains');
  r.check('nested override keeps siblings',
    mountains.envSlope === 0.20 && mountains.roadClearance === 0.30 &&
    mountains.hills.scale === 1.2,
    'envelope overridden, hills its own, neither clobbered');

  r.check('colour round trip', formatColor(parseColor('#74b6e8', 'x')) === '#74b6e8');

  // Rejections. Each starts from a known-good file and breaks exactly one
  // thing, so a pass means the validator caught that specific mistake.
  const good = JSON.parse(JSON.stringify(forest.source));
  const rejects = (label, mutate) => {
    const bad = JSON.parse(JSON.stringify(good));
    mutate(bad);
    let caught = null;
    try { validateTrackFile(bad, 'test'); } catch (err) { caught = err; }
    r.check(`rejects ${label}`, caught instanceof TrackFormatError,
      caught ? caught.message.slice(0, 64) : 'NOT REJECTED');
  };

  rejects('a wrong format tag', (b) => { b.format = 'something.else'; });
  rejects('a future version', (b) => { b.version = 99; });
  rejects('a missing road width', (b) => { delete b.road.halfWidth; });
  rejects('a negative road width', (b) => { b.road.halfWidth = -1; });
  rejects('too few control points', (b) => { b.road.controlPoints = [[0, 0, 0], [1, 0, 1]]; });
  rejects('a 2D control point', (b) => { b.road.controlPoints[3] = [10, 20]; });
  rejects('a NaN control point', (b) => { b.road.controlPoints[3] = [10, NaN, 20]; });
  rejects('a malformed colour', (b) => { b.environment.palette.asphalt = 'dark grey'; });
  rejects('fog far inside fog near', (b) => { b.environment.fog.far = 10; });
  rejects('an inverted tree height range', (b) => { b.scenery.trees.height = [9, 2]; });
  rejects('an impossible grip value', (b) => { b.road.surface.roadGrip = 0; });

  // The happy path has to still pass, or the checks above prove nothing.
  let ok = true;
  try { normaliseTrack(validateTrackFile(good, 'test')); } catch { ok = false; }
  r.check('accepts a valid file', ok);

  r.check('merge replaces arrays wholesale',
    mergeDefaults({ a: [1, 2, 3] }, { a: [9] }).a.length === 1,
    'a partially overridden point list is never what anyone means');
}

export async function runAll(el) {
  const r = new Report(el);
  resetTuning();                       // always test the defaults, not a saved setup

  // Circuits are data files now, so they have to be fetched before anything
  // can be built from them.
  r.log('loading track files…');
  await loadTracks();
  await testTrackFiles(r);

  r.log('building world (rapier + track)…');
  const t0 = performance.now();
  const ctx = await buildWorld();
  r.log(`world ready in ${Math.round(performance.now() - t0)} ms`);

  await testTerrainClearance(ctx, r);
  await testGeometry(getTrack('forest'), r, ' — forest');
  await testSettle(ctx, r);
  await testForcesDoNotAccumulate(ctx, r);
  await testSuspensionSettles(ctx, r);
  await testStraightLine(ctx, r);
  await testBraking(ctx, r);
  await testTopSpeed(ctx, r);
  await testUtilisationSignal(ctx, r);
  await testTyreAudioWarning(ctx, r);
  await testTyreAudioLevels(r);
  await testBrakingSquealsToo(ctx, r);
  await testTyresAreQuietNormally(ctx, r);
  await testHandbrake(ctx, r);
  await testLap(ctx, r, ' — forest');

  // Every other circuit gets its own world, and the two checks that catch a
  // bad layout: terrain punching through the road, and anywhere undriveable.
  for (const id of TRACK_IDS.filter((t) => t !== 'forest')) {
    const other = await buildWorld(id);
    await testTerrainClearance(other, r, ` — ${id}`);
    await testGeometry(getTrack(id), r, ` — ${id}`);
    await testLap(other, r, ` — ${id}`);
  }

  r.log(`\n${'═'.repeat(56)}`);
  r.log(`${r.fail === 0 ? 'ALL TESTS PASSED' : `${r.fail} FAILURE(S)`}  —  ${r.pass} passed, ${r.fail} failed`,
    r.fail === 0 ? 'pass' : 'fail');

  window.__testResults = r.results;
  window.__testsFailed = r.fail;
  window.__testsDone = true;
  return r;
}

async function testTerrainClearance(ctx, r, label = '') {
  r.section(`terrain vs road${label}`);
  const c = ctx.track.terrainClearance;
  r.results.terrainClearance = c;
  // Only needs to be BELOW: the terrain is deliberately near-flush at the road
  // edge so you can drive back on after running wide. A big clearance here
  // would mean a step at the edge, which is the bug, not the goal.
  r.check('terrain stays below the asphalt everywhere', c > 0.008,
    `min clearance ${c.toFixed(3)} m`);
}

/**
 * Circuit geometry, via the shared checker in src/trackcheck.js.
 *
 * The same function the editor calls on every drag of a control point, so a
 * layout that passes here is one the editor showed as clean -- and a layout
 * the editor flagged fails here. One definition of "driveable", not two that
 * can drift apart.
 */
async function testGeometry(def, r, label = '') {
  r.section(`circuit geometry${label}`);
  const result = validateTrack(def);
  const m = result.metrics;
  r.results[`geometry${label}`] = m;

  r.log(`  ${(m.length / 1000).toFixed(2)} km, ${m.controlPoints} control points, ` +
        `${m.elevationRange.span.toFixed(1)} m of elevation`);

  r.check('no corner tighter than the road can be swept around',
    m.tightestRadius >= m.minRadius,
    `tightest ${m.tightestRadius.toFixed(1)} m (needs ${m.minRadius.toFixed(1)} m) ` +
    `at progress ${m.tightestAt.toFixed(3)}`);

  r.check('no two parts of the lap are closer than the road is wide',
    m.minSeparation >= m.neededSeparation,
    `closest ${m.minSeparation.toFixed(1)} m (needs ${m.neededSeparation.toFixed(1)} m) ` +
    `at progress ${m.separationSpan[0].toFixed(3)} vs ${m.separationSpan[1].toFixed(3)}`);

  r.check('no slope too steep to climb cleanly',
    m.steepestGradient <= LIMITS.gradientError,
    `steepest ${(m.steepestGradient * 100).toFixed(1)}% at progress ${m.steepestAt.toFixed(3)}`);

  r.check('no abrupt change of slope',
    m.worstGradientChange <= LIMITS.gradientChangeError,
    `worst ${(m.worstGradientChange * 1000).toFixed(2)}% per 10 m ` +
    `at progress ${m.worstGradientChangeAt.toFixed(3)}`);

  // Warnings are reported but do not fail: they mean the circuit will drive
  // oddly, not that it is broken. Printing them keeps them visible rather than
  // letting them accumulate unseen.
  for (const w of result.warnings) {
    r.log(`  WARN  ${w.title} — ${w.detail}`, 'warn');
  }
}

async function testSettle(ctx, r) {
  r.section('settling at rest');
  ctx.vehicle.reset(ctx.track.spawnAt(0.985));
  await run(ctx, 360);

  const ride = rideHeight(ctx);
  const susp = [0, 1, 2, 3].map((i) => ctx.vehicle.controller.wheelSuspensionLength(i));
  const contacts = [0, 1, 2, 3].filter((i) => ctx.vehicle.controller.wheelIsInContact(i)).length;
  const minSusp = TUNING.suspension.restLength - TUNING.suspension.maxTravel;

  r.results.settle = { ride, susp, contacts };
  r.check('rigid body is enabled', ctx.vehicle.body.isEnabled());
  r.check('all four wheels touch the ground', contacts === 4, `${contacts}/4`);
  r.check('springs carry the car (not on the bump stops)',
    susp.every((s) => s > minSusp + 0.02 && s < TUNING.suspension.restLength + 1e-6),
    `susp ${susp.map((s) => s.toFixed(3)).join(' / ')}`);
  r.check('chassis is not grounded', !chassisTouching(ctx), `ride ${ride.toFixed(3)} m`);
}

// Regression test for the bug that made the car feel like it hit a wall:
// Rapier's addForce persists until reset, so aero was compounding every step.
async function testForcesDoNotAccumulate(ctx, r) {
  r.section('aero forces do not accumulate');
  ctx.vehicle.reset(ctx.track.spawnAt(0.985));
  ctx.vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  await run(ctx, 120, () => input({ throttle: 1 }));

  const sample = () => {
    const f = ctx.vehicle.body.userForce();
    return Math.hypot(f.x, f.y, f.z);
  };
  const early = sample();
  await run(ctx, 600, () => input({ throttle: 1 }));
  const late = sample();

  // Aero scales with v^2, so the force legitimately grows as the car speeds up.
  // What must never happen is unbounded growth: cap it well above any physical
  // value but far below the runaway the accumulation bug produced.
  const speed = Math.abs(ctx.vehicle.speed);
  const physicalMax = (TUNING.aero.downforce + TUNING.aero.dragCoeff) * speed * speed
    + TUNING.aero.rollingResistance + 50;

  r.results.userForce = { early, late, speed, physicalMax };
  r.check('per-step force stays within its physical bound',
    late <= physicalMax,
    `|F| ${late.toFixed(0)} N at ${(speed * 3.6).toFixed(0)} km/h, bound ${physicalMax.toFixed(0)} N`);
}

// Drop the car and watch it settle. A well damped sports car takes one small
// overshoot and stops; an under-damped one pogos for seconds, which is what
// "it drives like a buggy" feels like from the driver's seat.
async function testSuspensionSettles(ctx, r) {
  r.section('suspension settles (no pogo)');
  const pad = makePad(ctx.world);
  const car = new Vehicle(ctx.world, RAPIER, pad.spawn(0));
  const padCtx = { world: ctx.world, track: ctx.track, vehicle: car, grip: null };

  await run(padCtx, 300);                       // settle first
  const rest = car.body.translation().y;

  car.body.setTranslation({ ...car.body.translation(), y: rest + 0.25 }, true);
  car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);

  const heights = [];
  await run(padCtx, 480, null, (v) => heights.push(v.body.translation().y - rest));

  // Count direction reversals in the ride height: each one is an oscillation.
  let reversals = 0;
  let settleStep = -1;
  for (let i = 2; i < heights.length; i++) {
    const d0 = heights[i - 1] - heights[i - 2];
    const d1 = heights[i] - heights[i - 1];
    if (d0 * d1 < 0 && Math.abs(heights[i]) > 0.004) reversals++;
    if (settleStep < 0 && i > 30 && heights.slice(i - 30, i).every((h) => Math.abs(h) < 0.006)) {
      settleStep = i;
    }
  }
  const settleTime = settleStep < 0 ? Infinity : settleStep * DT;
  const sag = 9.81 / (4 * TUNING.suspension.stiffness);
  car.dispose();
  pad.remove();

  r.results.suspension = { reversals, settleTime, sag };
  r.check('static sag is sports-car firm (15-50 mm)',
    sag > 0.015 && sag < 0.05, `${(sag * 1000).toFixed(0)} mm`);
  r.check('settles quickly after a drop', settleTime < 1.2,
    Number.isFinite(settleTime) ? `${settleTime.toFixed(2)} s` : 'never settled');
  r.check('does not pogo (at most 3 oscillations)', reversals <= 3, `${reversals} reversals`);
}

async function testStraightLine(ctx, r) {
  r.section('straight-line acceleration');
  // Start of the main straight, steering with pure pursuit so the car actually
  // stays on the road instead of driving off into the scenery.
  ctx.vehicle.reset(ctx.track.spawnAt(0.985));
  await run(ctx, 240);

  const track = ctx.track;
  let t = 0, t100 = null, peak = 0, minRide = Infinity, grounded = 0, onTrackSteps = 0;

  await run(ctx, 3000,
    (v) => input({ steer: pursuit(track, v).steer, throttle: 1 }),
    (v) => {
      t += DT;
      if (t100 === null && v.speedKmh >= 100) t100 = t;
      peak = Math.max(peak, v.speedKmh);
      // Only judge ground clearance while we're actually on the circuit.
      if (Math.abs(pursuit(track, v).proj.lateral) < 8) {
        onTrackSteps++;
        minRide = Math.min(minRide, rideHeight(ctx));
        if (chassisTouching(ctx)) grounded++;
      }
    });

  r.results.acceleration = { t100, peak, minRide, grounded, onTrackSteps };
  r.check('reaches 100 km/h', t100 !== null, t100 ? `0-100 in ${t100.toFixed(2)} s` : 'never got there');
  r.check('0-100 is in a sane range for ~300 hp RWD',
    t100 !== null && t100 > 3 && t100 < 12, t100 ? `${t100.toFixed(2)} s` : '—');
  r.check('chassis never grounds while accelerating on track', grounded === 0,
    `min ride ${minRide.toFixed(3)} m over ${onTrackSteps} steps`);
  r.check('upshifts through the gearbox', ctx.vehicle.gear >= 3, `ended in gear ${ctx.vehicle.gearLabel}`);
}

async function testBraking(ctx, r) {
  r.section('braking');
  // On a private flat pad, not the circuit: the main straight is short enough
  // that the car is turning into corner one before it has stopped, and braking
  // half on the grass measures cornering, not stopping distance.
  const pad = makePad(ctx.world);
  const car = new Vehicle(ctx.world, RAPIER, pad.spawn(0));
  const padCtx = { world: ctx.world, track: ctx.track, vehicle: car, grip: null };

  await run(padCtx, 120);
  await run(padCtx, 2400, (v) => (v.speedKmh < 100 ? input({ throttle: 1 }) : NEUTRAL));

  const from = car.speedKmh;
  // Measure ground distance actually covered, not integrated forward speed:
  // if the car yaws under braking the forward component under-reads badly.
  const start = car.body.translation();
  const startXZ = { x: start.x, z: start.z };
  let t = 0;
  let groundedWhileBraking = false;
  await run(padCtx, 2400,
    (v) => (v.speedKmh > 3 ? input({ brake: 1 }) : NEUTRAL),
    (v) => {
      if (v.speedKmh > 3) t += DT;
      const p = v.body.translation();
      if (p.y - TUNING.chassis.halfHeight + TUNING.chassis.colliderOffsetY <= 0.005) {
        groundedWhileBraking = true;
      }
    });
  const end = car.body.translation();
  const dist = Math.hypot(end.x - startXZ.x, end.z - startXZ.z);
  const stoppedAt = car.speedKmh;
  car.dispose();
  pad.remove();
  ctx.vehicle.reset(ctx.track.spawnAt(0.985));

  // Average deceleration over the stop, from the time taken.
  const gFromTime = t > 0 ? (from / 3.6) / t / 9.81 : 0;
  // Independent estimate from distance: v^2 = 2 a s.
  const gFromDist = dist > 0 ? ((from / 3.6) ** 2) / (2 * dist) / 9.81 : 0;

  r.results.braking = { from, t, dist, gFromTime, gFromDist, groundedWhileBraking };
  r.check('nose does not dig in under braking', !groundedWhileBraking);
  r.check('reached test speed', from > 60, `${from.toFixed(0)} km/h`);
  r.check('comes to a stop', stoppedAt < 5, `${stoppedAt.toFixed(1)} km/h`);
  r.check('deceleration is plausible for a road car (0.6–1.5 g)',
    gFromTime > 0.6 && gFromTime < 1.5,
    `${gFromTime.toFixed(2)} g over ${t.toFixed(2)} s, ${dist.toFixed(0)} m from ${from.toFixed(0)} km/h`);
  // The two only diverge a lot if the car yawed instead of stopping straight.
  // Some gap is normal: the bite is strongest at the start, so deceleration
  // isn't constant and the distance estimate reads a little high.
  r.check('time and distance agree (car brakes straight, no spin)',
    Math.abs(gFromTime - gFromDist) < 1.0,
    `${gFromTime.toFixed(2)} g by time vs ${gFromDist.toFixed(2)} g by distance`);
}

// The circuit has no straight long enough to reach terminal velocity, so this
// runs on a private flat pad well away from the track.
async function testTopSpeed(ctx, r) {
  r.section('top speed');
  const { world } = ctx;
  const pad = makePad(world);
  const car = new Vehicle(world, RAPIER, pad.spawn(8000));
  // grip: null means "no surface lookup", i.e. full grip everywhere.
  const padCtx = { world, track: ctx.track, vehicle: car, grip: null };

  // Launch already rolling, just under terminal. Terminal velocity is
  // approached asymptotically -- net force shrinks to nothing as you close on
  // it -- so starting well below would need minutes of simulated time and would
  // report a number that is still climbing rather than the real top speed.
  await run(padCtx, 60);
  car.body.setLinvel({ x: 0, y: 0, z: 68 }, true);   // ~245 km/h

  let peak = 0;
  const p = new THREE.Vector3();
  await run(padCtx, 10800, (v) => {
    // Just enough correction to keep it on the pad. Any more and the steering
    // scrubs off the very speed we're trying to measure.
    v.position(p);
    return input({ throttle: 1, steer: THREE.MathUtils.clamp((p.x - PAD.x) * 0.008, -0.04, 0.04) });
  }, (v) => {
    peak = Math.max(peak, v.speedKmh);
  });
  const topGear = car.gearLabel;
  car.dispose();
  pad.remove();

  r.results.topSpeed = { peak, topGear };
  r.check('tops out near the A110\'s 250 km/h',
    peak > 230 && peak < 275, `${peak.toFixed(0)} km/h in gear ${topGear}`);
}

/**
 * Gate 0 of the fun plan: is friction utilisation a usable warning channel?
 *
 * This is the measurement the whole "give the car a voice" phase rests on.
 * Rapier's raycast vehicle has no tyre slip curve -- it solves a lateral
 * impulse clamped at mu * load, so a tyre has full grip until saturation and
 * is saturated after. The worry that follows is that SLIP ANGLE, which is what
 * a driving game would normally drive tyre audio from, stays near zero until
 * the car has already let go, and so cannot warn anybody about anything.
 *
 * A skidpad ramp settles it. Hold a constant steering angle, let the speed
 * climb, and watch two numbers: utilisation, and rear slip angle. If
 * utilisation climbs smoothly from zero while slip angle is still flat, then
 * utilisation is the warning channel and slip angle is a lagging indicator of
 * a crash that already happened.
 */
async function testUtilisationSignal(ctx, r) {
  r.section('friction utilisation (fun plan, gate 0)');
  const { world } = ctx;
  const pad = makePad(world);
  const car = new Vehicle(world, RAPIER, pad.spawn(8000));
  const padCtx = { world, track: ctx.track, vehicle: car, grip: null };

  await run(padCtx, 90);

  // A GENTLE constant lock, and let speed do the work.
  //
  // Lateral demand is m*v^2/R, so on a wide circle it climbs slowly with speed
  // and the tyre walks up its capacity over several seconds. The first version
  // of this test used near-full lock, which saturates the tyres before the car
  // has finished its first car-length -- and then reported that utilisation
  // was a step function, when all it had actually measured was the part of the
  // ramp above the limit.
  const trace = [];
  await run(padCtx, 4200, () => input({ throttle: 0.5, steer: 0.09 }), (v) => {
    const t = v.telemetry;
    trace.push({
      speed: v.speedKmh,
      util: t.peakUtil,
      rearUtil: t.rearUtil,
      slip: Math.abs(v.slipRear) * 180 / Math.PI,
      gLat: Math.abs(v.gLat),
    });
  });
  car.dispose();
  pad.remove();

  const moving = trace.filter((s) => s.speed > 12);
  if (moving.length < 100) {
    r.check('skidpad produced a usable trace', false, `${moving.length} samples`);
    return;
  }

  const maxUtil = Math.max(...moving.map((s) => s.util));
  const maxSlip = Math.max(...moving.map((s) => s.slip));

  // The signal has to be READABLE BEFORE THE LIMIT, which means it must spend
  // real time in the middle of its range rather than snapping 0 -> 1.
  const inBand = moving.filter((s) => s.util > 0.25 && s.util < 0.9).length;
  const bandFraction = inBand / moving.length;

  // The load-up: where does slip angle sit when utilisation first crosses the
  // 60% mark the plan wants the warning to start at?
  const firstWarn = moving.find((s) => s.util >= 0.6);
  const slipAtWarn = firstWarn ? firstWarn.slip : NaN;

  r.results.utilisation = { maxUtil, maxSlip, bandFraction, slipAtWarn };

  r.check('utilisation reaches the limit under load',
    maxUtil > 0.9, `peak ${maxUtil.toFixed(2)}`);

  r.check('utilisation is continuous, not a step',
    bandFraction > 0.1,
    `${(bandFraction * 100).toFixed(0)}% of the ramp sits between 25% and 90%`);

  // The point of the whole exercise. A warning channel is only a warning if it
  // fires while the tyre is still gripping.
  r.check('utilisation warns before slip angle does',
    Number.isFinite(slipAtWarn) && slipAtWarn < 2.0,
    `rear slip is ${slipAtWarn.toFixed(2)} deg when utilisation first hits 60%`);

  r.log(`  peak utilisation ${maxUtil.toFixed(2)}, peak rear slip ${maxSlip.toFixed(1)} deg`);
}

/**
 * Phase 2.1: does the tyre audio warn before the limit, or only report it?
 *
 * The whole reason tyre sound exists in this project is to replace the force
 * feedback a wheel would give -- so the question that matters is not "does it
 * make a noise when sliding" (easy, and useless) but "how much notice does it
 * give". That is measurable: run the same skidpad ramp Gate 0 used, and find
 * the gap between the tyre first becoming audible and the tyre saturating.
 *
 * The plan's design target is ~400 ms of warning. At 120 Hz that is 48 steps.
 */
async function testTyreAudioWarning(ctx, r) {
  r.section('tyre audio warning window (phase 2.1)');
  const { world } = ctx;
  const pad = makePad(world);
  const car = new Vehicle(world, RAPIER, pad.spawn(8000));
  const padCtx = { world, track: ctx.track, vehicle: car, grip: null };

  await run(padCtx, 90);

  let firstAudible = -1;
  let firstAtLimit = -1;
  let step = 0;
  const mixes = [];

  // A touch more lock than the Gate 0 ramp uses. That one is deliberately so
  // gentle the tyre never quite saturates, which is right for measuring the
  // shape of the signal but useless here: with no saturation there is no limit
  // to measure the warning against.
  await run(padCtx, 4200, () => input({ throttle: 0.5, steer: 0.16 }), (v) => {
    const mix = tyreMix(v);
    mixes.push({ step, mix, util: v.telemetry.frontUtil });
    if (firstAudible < 0 && mix.front.gain > 0.01) firstAudible = step;
    if (firstAtLimit < 0 && v.telemetry.frontUtil >= AT_LIMIT) firstAtLimit = step;
    step++;
  });
  car.dispose();
  pad.remove();

  const dt = TUNING.world.fixedStep;
  const warningMs = (firstAudible >= 0 && firstAtLimit > firstAudible)
    ? (firstAtLimit - firstAudible) * dt * 1000
    : 0;

  r.results.tyreAudio = { firstAudible, firstAtLimit, warningMs };

  r.check('tyres become audible before they saturate',
    firstAudible >= 0 && firstAtLimit > firstAudible,
    `audible at step ${firstAudible}, limit at ${firstAtLimit}`);

  r.check('the warning window is usable (>250 ms)',
    warningMs > 250, `${warningMs.toFixed(0)} ms of notice`);

  // Silence while the car is comfortably within grip. A tyre that sings all
  // the time carries no information -- the signal has to have an off state.
  // The bar that matters for "is it annoying". Squealing through ordinary
  // cornering is the failure this threshold exists to catch: it was reported
  // from the driver's seat once already, when the warning was keyed on
  // combined rather than lateral utilisation.
  const quietBelow = 0.7;
  const quiet = mixes.filter((m) => m.util < quietBelow).every((m) => m.mix.front.gain < 0.001);
  r.check('silent through ordinary cornering', quiet,
    `no squeal below ${(quietBelow * 100).toFixed(0)}% lateral utilisation`);

  // Front and rear have to be tellable apart, or "which end let go" is not
  // information the player can act on.
  const sep = Math.abs(TUNING.audio.tyre.freqFront - TUNING.audio.tyre.freqRear);
  const ratioFR = TUNING.audio.tyre.freqFront / TUNING.audio.tyre.freqRear;
  r.check('front and rear are distinguishable by pitch',
    ratioFR > 1.25, `${sep.toFixed(0)} Hz apart, a ratio of ${ratioFR.toFixed(2)}`);

  // Past the limit the character must change, not just the volume: that is
  // what separates "loaded" from "gone" by ear.
  // Loaded enough to be audible, but not sliding -- the comparison is only
  // meaningful if both states are actually making a sound.
  const gripping = tyreMix(fakeVehicle({ frontUtil: 0.95, rearUtil: 0.95, slipSpeed: 0 }));
  const sliding = tyreMix(fakeVehicle({ frontUtil: 1.0, rearUtil: 1.0, slipSpeed: 5 }));
  r.check('timbre opens up once sliding',
    sliding.front.q < gripping.front.q * 0.5 && sliding.front.freq < gripping.front.freq,
    `Q ${gripping.front.q.toFixed(1)} -> ${sliding.front.q.toFixed(1)}, ` +
    `${gripping.front.freq.toFixed(0)} -> ${sliding.front.freq.toFixed(0)} Hz`);

  r.log(`  warning window ${warningMs.toFixed(0)} ms before saturation`);
}

/**
 * How much of a normal lap is spent squealing?
 *
 * The check that would have caught the worst tyre-audio regression this
 * project has had. Every other audio test asks "does it make a noise when it
 * should"; none of them asked "is it quiet when it should be", and the answer
 * turned out to be no -- the car sang almost continuously, which makes the
 * warning worthless because it never stops.
 *
 * The autopilot is a moderate driver: it holds about 6 m/s^2 of lateral
 * acceleration, well inside the tyres. A lap of that should be nearly silent.
 */
async function testTyresAreQuietNormally(ctx, r) {
  r.section('tyres are quiet in normal driving');
  const { vehicle, track } = ctx;
  vehicle.reset(track.spawnAt(0.985));

  const drive = makeAutopilot(track);
  let audible = 0;
  let samples = 0;
  let peak = 0;

  await run(ctx, 5200, drive, (v) => {
    if (Math.abs(v.speed) < 4) return;
    const mix = tyreMix(v);
    // Measured on `load`, the 0..1 loudness driver, NOT on `gain`. Gain
    // carries the filter makeup (~5.7x), so a gain of 0.02 is about 0.001 RMS
    // against an engine at 0.10 -- silence, counted as noise. Judging the
    // metric on the wrong quantity is how this looked worse than it was.
    const loud = Math.max(mix.front.load, mix.rear.load);
    peak = Math.max(peak, loud);
    if (loud > 0.1) audible++;
    samples++;
  });

  const fraction = samples > 0 ? audible / samples : 0;
  r.results.tyreQuiet = { fraction, peak, samples };

  // 15%, against a measured 13%. Set just above where the car actually sits
  // rather than where it would be nice for it to sit: the job of this check is
  // to catch a regression back toward continuous squealing, and a bar the code
  // already fails is a bar nobody can act on.
  //
  // Whether 13% is the RIGHT number is not something a test can decide -- the
  // autopilot corners to a fixed lateral budget and takes full throttle out of
  // every corner, so it spends more of a lap near the limit than a person
  // would. Judge it by ear and move squealStart.
  r.check('a moderate lap is mostly silent',
    fraction < 0.15,
    `audible for ${(fraction * 100).toFixed(0)}% of the lap`);

  r.log(`  ${(fraction * 100).toFixed(0)}% audible over ${samples} samples, peak loudness ${peak.toFixed(2)}`);
}

/**
 * Braking in a straight line has to squeal too.
 *
 * The first version drove the squeal from LATERAL utilisation alone, so a
 * threshold stop laid rubber the whole way down in complete silence. That is
 * both wrong physically -- a locked tyre scrubs just as hard as a sliding one
 * -- and wrong for the player, who sees a skidmark and hears nothing.
 *
 * The fix was to drive it from contact patch slip speed, which does not care
 * which direction the sliding is in. This checks the case that was broken.
 */
async function testBrakingSquealsToo(ctx, r) {
  r.section('braking squeals (not just cornering)');
  const { world } = ctx;
  const pad = makePad(world);
  const car = new Vehicle(world, RAPIER, pad.spawn(8000));
  const padCtx = { world, track: ctx.track, vehicle: car, grip: null };

  await run(padCtx, 60);
  car.body.setLinvel({ x: 0, y: 0, z: 30 }, true);   // ~108 km/h
  await run(padCtx, 30);

  let peakGain = 0;
  let peakSlipLong = 0;
  let peakLatUtil = 0;
  // Dead straight, full brakes. No steering at all, so nothing lateral.
  await run(padCtx, 400, () => input({ brake: 1 }), (v) => {
    if (Math.abs(v.speed) < 3) return;
    const mix = tyreMix(v);
    peakGain = Math.max(peakGain, mix.front.gain);
    peakLatUtil = Math.max(peakLatUtil, v.telemetry.frontUtil);
    for (const wheel of v.telemetry.wheels) {
      peakSlipLong = Math.max(peakSlipLong, wheel.longUtil);
    }
  });
  car.dispose();
  pad.remove();

  r.results.brakingSqueal = { peakGain, peakSlipLong };

  r.check('braking saturates the tyres longitudinally', peakSlipLong > 0.9,
    `${(peakSlipLong * 100).toFixed(0)}% of longitudinal capacity under full brakes`);

  r.check('a straight-line stop is audible', peakGain > 0.05,
    `peak squeal gain ${peakGain.toFixed(3)} with no steering input`);

  r.log(`  ${(peakSlipLong * 100).toFixed(0)}% longitudinal use -> gain ${peakGain.toFixed(3)}`);
}

/**
 * Is the tyre audio actually AUDIBLE?
 *
 * This exists because the first version was not, and nothing caught it. Every
 * signal was correct -- utilisation right, gain curve right, timbre right --
 * and the tyres could not be heard, because a resonant bandpass discards most
 * of the noise energy you feed it. Measured: -20.4 dB at Q=9, putting a full
 * squeal at 0.030 RMS against engine samples at roughly 0.10.
 *
 * Worse, the loss varies with Q, and Q is what we modulate for timbre: sliding
 * came out 3x louder than gripping as a pure side effect of the filter, not
 * because anything asked for it.
 *
 * So this renders the real filter graph in an OfflineAudioContext and measures
 * what comes out. No AudioContext gesture needed, and it is deterministic.
 */
async function testTyreAudioLevels(r) {
  r.section('tyre audio levels');

  const sr = 48000;
  const render = async (type, q, freq, gain) => {
    const ctx = new OfflineAudioContext(1, sr * 0.4, sr);
    const len = sr * 2;
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start();
    const out = await ctx.startRendering();
    const c = out.getChannelData(0);
    let s = 0;
    for (let i = 0; i < c.length; i++) s += c[i] * c[i];
    return Math.sqrt(s / c.length);
  };

  const gripping = tyreMix(fakeVehicle({ frontUtil: 1.0, rearUtil: 1.0, slipSpeed: 0 }));
  const sliding = tyreMix(fakeVehicle({ frontUtil: 1.0, rearUtil: 1.0, slipSpeed: 6 }));

  const gripRms = await render('bandpass', gripping.front.q, gripping.front.freq, gripping.front.gain);
  const slideRms = await render('bandpass', sliding.front.q, sliding.front.freq, sliding.front.gain);

  r.results.tyreLevels = { gripRms, slideRms };

  // Engine samples land around 0.10 RMS. A squeal below about half that is
  // masked by the engine and might as well not exist.
  r.check('a full squeal is loud enough to hear over the engine',
    gripRms > 0.06, `${gripRms.toFixed(3)} RMS at the limit`);

  // The makeup gain has to hold level flat as Q changes, so that a slide is
  // louder because slideVolume says so, not because the filter opened up.
  const expected = TUNING.audio.tyre.slideVolume;
  const actual = slideRms / gripRms;
  r.check('a slide is louder by design, not by filter accident',
    Math.abs(actual - expected) / expected < 0.2,
    `${actual.toFixed(2)}x measured against slideVolume ${expected}`);

  r.log(`  gripping ${gripRms.toFixed(3)} RMS, sliding ${slideRms.toFixed(3)} RMS`);
}

/** A stand-in vehicle, for exercising the mix at states a skidpad won't reach. */
function fakeVehicle({ frontUtil, rearUtil, slipSpeed, frontSlip, rearSlip, longUtil }) {
  return {
    speed: 30,
    airborne: false,
    gripMult: [1, 1, 1, 1],
    telemetry: {
      frontUtil,
      rearUtil,
      slipSpeed,
      // Slip is per axle now, so both ends can be in different states.
      frontSlip: frontSlip ?? slipSpeed ?? 0,
      rearSlip: rearSlip ?? slipSpeed ?? 0,
      // Longitudinal saturation stands in for locking and wheelspin.
      wheels: [0, 1, 2, 3].map(() => ({ longUtil: longUtil ?? 0 })),
    },
  };
}

// The handbrake has to be a steering tool, not just a brake: pulling it should
// break the rears loose and rotate the car noticeably more than the same
// steering input alone.
async function testHandbrake(ctx, r) {
  r.section('handbrake rotates the car');
  const { world } = ctx;
  const pad = makePad(world);

  const measureYaw = async (useHandbrake) => {
    const car = new Vehicle(world, RAPIER, pad.spawn(4000));
    const padCtx = { world, track: ctx.track, vehicle: car, grip: null };
    await run(padCtx, 60);
    car.body.setLinvel({ x: 0, y: 0, z: 25 }, true);   // ~90 km/h
    // A moderate, comfortably-gripping steering input: if the baseline is
    // already sliding at the limit there's no headroom left for the handbrake
    // to show up in. Same input in both runs; only the handbrake differs.
    let peakYaw = 0;
    let peakSlip = 0;
    await run(padCtx, 200,
      () => input({ steer: 0.28, throttle: 0.1, handbrake: useHandbrake ? 1 : 0 }),
      (v) => {
        peakYaw = Math.max(peakYaw, Math.abs(v.body.angvel().y));
        peakSlip = Math.max(peakSlip, Math.abs(v.slipRear));
      });
    car.dispose();
    return { yawRate: peakYaw, slip: peakSlip };
  };

  const plain = await measureYaw(false);
  const pulled = await measureYaw(true);
  pad.remove();

  r.results.handbrake = { plain, pulled };
  r.check('handbrake increases yaw rate',
    pulled.yawRate > plain.yawRate * 1.15,
    `${plain.yawRate.toFixed(2)} -> ${pulled.yawRate.toFixed(2)} rad/s`);
  r.check('handbrake breaks the rear axle loose',
    pulled.slip > plain.slip * 1.2,
    `rear slip ${(plain.slip * 180 / Math.PI).toFixed(1)} -> ${(pulled.slip * 180 / Math.PI).toFixed(1)} deg`);
}

async function testLap(ctx, r, label = '') {
  r.section(`autopilot lap${label}`);
  const { track, vehicle } = ctx;
  vehicle.reset(track.spawnAt(0.0));
  await run(ctx, 240);

  const drive = makeAutopilot(track);
  const n = track.points.length;

  let stalledFor = 0;
  let stuckAt = null;
  let groundedSteps = 0;
  let offTrackSteps = 0;
  let maxSpeed = 0;
  let lastIndex = track.project(vehicle.position()).index;
  let wrapped = 0;
  let steps = 0;
  const pos = new THREE.Vector3();

  const MAX_STEPS = 17000;      // 140 s; the longer, low-grip circuits need it
  await run(ctx, MAX_STEPS, drive, (v) => {
    steps++;
    if (stuckAt) return;
    maxSpeed = Math.max(maxSpeed, v.speedKmh);

    v.position(pos);
    const proj = track.project(pos);
    const onTrack = Math.abs(proj.lateral) < 9;
    if (!onTrack) offTrackSteps++;
    // Only judge the car while it's actually on the circuit -- out in the
    // scenery it is allowed to bottom out on a hillside.
    if (onTrack && chassisTouching(ctx)) groundedSteps++;

    // Full-throttle but going nowhere = something is holding the car.
    if (v.speedKmh < 5) {
      stalledFor += DT;
      if (stalledFor > 2.5) {
        stuckAt = {
          progress: +(proj.index / n).toFixed(3),
          x: +pos.x.toFixed(1), z: +pos.z.toFixed(1),
          ride: +rideHeight(ctx).toFixed(3),
          lateral: +proj.lateral.toFixed(2),
        };
      }
    } else {
      stalledFor = 0;
    }

    if (onTrack && lastIndex > n * 0.85 && proj.index < n * 0.15) wrapped++;
    if (onTrack) lastIndex = proj.index;
  });

  r.results.lap = { stuckAt, wrapped, maxSpeed, groundedSteps, offTrackSteps, steps };
  r.check('never stalls at full throttle', stuckAt === null,
    stuckAt ? `stuck at progress ${stuckAt.progress} (x=${stuckAt.x} z=${stuckAt.z}, ride ${stuckAt.ride} m)`
            : `top speed ${maxSpeed.toFixed(0)} km/h`);
  r.check('chassis never grounds on the racing line', groundedSteps === 0,
    `${groundedSteps} steps grounded`);
  r.check('completes a full lap', wrapped >= 1, `${wrapped} lap(s)`);
  r.check('autopilot keeps the car on the circuit',
    offTrackSteps < steps * 0.15,
    `${offTrackSteps}/${steps} steps off track (${((offTrackSteps / steps) * 100).toFixed(0)}%)`);
}
