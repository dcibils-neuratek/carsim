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
import { getTrack, TRACK_IDS } from '../src/tracks.js';

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

/** Step the sim, yielding periodically so the browser stays responsive. */
async function run(ctx, steps, controller, onStep) {
  const { world, vehicle, grip } = ctx;
  for (let i = 0; i < steps; i++) {
    const cmd = controller ? controller(vehicle, i) : NEUTRAL;
    vehicle.update(DT, cmd, grip);
    world.step();
    if (onStep) onStep(vehicle, i);
    if (i % CHUNK === CHUNK - 1) await new Promise((r) => setTimeout(r, 0));
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

export async function runAll(el) {
  const r = new Report(el);
  resetTuning();                       // always test the defaults, not a saved setup

  r.log('building world (rapier + track)…');
  const t0 = performance.now();
  const ctx = await buildWorld();
  r.log(`world ready in ${Math.round(performance.now() - t0)} ms`);

  await testTerrainClearance(ctx, r);
  await testNoSelfOverlap(ctx, r, ' — forest');
  await testSettle(ctx, r);
  await testForcesDoNotAccumulate(ctx, r);
  await testSuspensionSettles(ctx, r);
  await testStraightLine(ctx, r);
  await testBraking(ctx, r);
  await testTopSpeed(ctx, r);
  await testHandbrake(ctx, r);
  await testLap(ctx, r, ' — forest');

  // Every other circuit gets its own world, and the two checks that catch a
  // bad layout: terrain punching through the road, and anywhere undriveable.
  for (const id of TRACK_IDS.filter((t) => t !== 'forest')) {
    const other = await buildWorld(id);
    await testTerrainClearance(other, r, ` — ${id}`);
    await testNoSelfOverlap(other, r, ` — ${id}`);
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
 * The circuit must not run over itself.
 *
 * The road is swept as a ribbon of a fixed width. Where two parts of the lap
 * pass closer than that width, the ribbons overlap -- and if they sit at
 * different heights, one becomes a ceiling over the other. Spawn under it and
 * the car is ejected sideways; drive under it and you hit a roof.
 */
async function testNoSelfOverlap(ctx, r, label = '') {
  r.section(`circuit does not overlap itself${label}`);
  const { track } = ctx;
  const n = track.points.length;
  const width = track.halfWidth + track.curbWidth;
  const needed = width * 2;                  // both ribbons, edge to edge
  // Ignore neighbours along the lap; only compare genuinely distant sections.
  const skip = Math.ceil((needed * 3) / (track.length / n));

  let worst = Infinity;
  let worstAt = null;
  for (let i = 0; i < n; i++) {
    const a = track.points[i];
    for (let j = i + skip; j < n - (i < skip ? skip : 0); j++) {
      const b = track.points[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < worst) {
        worst = d;
        worstAt = { at: +(i / n).toFixed(3), and: +(j / n).toFixed(3), dy: +(b.y - a.y).toFixed(2) };
      }
    }
  }

  r.results[`overlap${label}`] = { worst, needed, worstAt };
  r.check('no two parts of the lap are closer than the road is wide',
    worst >= needed,
    `closest ${worst.toFixed(1)} m (needs ${needed.toFixed(1)} m) at progress ` +
    `${worstAt.at} vs ${worstAt.and}, ${worstAt.dy} m apart vertically`);

  // Corner radius. Below the road's own half-width the inner edge of the
  // ribbon folds through itself; anywhere near that reads as a kink rather
  // than a curve, which is how a badly shaped corner gets noticed by eye.
  let tightest = Infinity;
  let tightestAt = 0;
  for (let i = 0; i < n; i++) {
    if (track.curvature[i] > 1e-6) {
      const radius = 1 / track.curvature[i];
      if (radius < tightest) { tightest = radius; tightestAt = i / n; }
    }
  }
  // The ribbon folds through itself below `width`; 1.5x leaves margin without
  // banning legitimately tight hairpins. Forest drove fine for a long time at
  // ~11 m, so a stricter bar would fail corners that are genuinely OK.
  const minRadius = width * 1.5;
  r.results[`radius${label}`] = { tightest, minRadius, tightestAt };
  r.check('no corner tighter than the road can be swept around',
    tightest >= minRadius,
    `tightest ${tightest.toFixed(1)} m (needs ${minRadius.toFixed(1)} m) ` +
    `at progress ${tightestAt.toFixed(3)}`);
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
