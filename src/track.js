// Procedural circuit.
//
// A closed Catmull-Rom centerline drives everything: the road ribbon and its
// collider, the curbs, the surrounding terrain, surface grip, and lap timing.
// Position on track is found by projecting onto the centerline rather than by
// trigger volumes, which makes "am I on the grass" and "have I cut the course"
// the same cheap query.

import * as THREE from 'three';
import { flatMat } from './scene.js';
import { TUNING } from './tuning.js';
import { applyRoadTexture, hasRoadTexture, tileMetres } from './roadtexture.js';

// Centreline samples, as a DENSITY rather than a count.
//
// 720 was a count, and it was a fine one for a 1.3 km lap: a road
// cross-section every 1.8 m, comfortably finer than the terrain's 5.6 m grid.
// Scaled to 5 km the same 720 gives a section every 6.9 m -- coarser than the
// terrain that has to stay underneath it. The heightfield then rises above the
// road's own chord between two sections and pokes through the asphalt, which
// is a wedge you hit at speed and get launched off. Measured at -29 mm of
// clearance where the rule is that terrain must never reach the surface.
//
// So: metres per sample, and the count follows the circuit. Bounded because
// the road mesh, its collider and the terrain envelope all scale with it.
const SAMPLE_SPACING = 1.8;   // metres between centreline samples
const MIN_SAMPLES = 720;
const MAX_SAMPLES = 3600;
// Elevation smoothing, as a FRACTION of the lap rather than a distance.
//
// It was 55 metres, which was right for the 1.3 km circuits it was tuned on
// and quietly wrong the moment they were scaled to 5 km: the same window then
// covers a quarter as much of the layout, so every crest comes out four times
// sharper. Measured after the scale-up and before this change, the autopilot
// grounded the chassis on 1837 steps of a clean lap -- the car was bottoming
// out on crests that used to be smoothed away.
//
// 1/24 of the lap is what 55 m was of 1.3 km, so every circuit now gets the
// profile the originals were tuned to have, whatever length it is.
const ELEVATION_SMOOTH_FRACTION = 1 / 24;
const ROUNDING_PASSES = 70;   // curvature-diffusion passes; rounds tight corners
const CURB_HEIGHT = 0.035;    // a rumble strip, not a step you can trip over
const CURB_CURVATURE = 0.010; // rad/m of centerline turn before curbs appear
// Kerb stripe, in METRES.
//
// It was 5 samples, and that was the same trap the dashes fell into: anything
// counted in samples silently changes size whenever the sampling does. With
// the circuits scaled to 5 km on a fixed 720 samples, one sample went from
// 1.8 m to 6.9 m and every kerb stripe, every post gap and every centre-line
// dash grew with it -- which cost exactly the sense of speed all of this was
// for. Sampling is a density again now, but expressing these in metres means
// it cannot happen a fourth time.
const CURB_STRIPE_METRES = 9;

// --- road surface detail ---------------------------------------------------
//
// The asphalt used to be one quad across, carrying six shades that differ by
// 0.02 in lightness. Measured, those six sit between 0.037 and 0.058 in linear
// light: indistinguishable. So the road showed nothing at all, and a surface
// that shows nothing cannot show that it is moving -- which is most of why
// 150 km/h did not feel like 150 km/h. Optical flow measured across the frame
// found the outer third of the screen completely featureless.
//
// What replaces it is what a real road has and what every arcade rally game
// leans on: two darker lines where the tyres run, and patches that come and go
// along its length. The ruts matter most, because they run ALONG the direction
// of travel -- a longitudinal feature sweeps toward you and past the camera,
// which is the strongest self-motion cue there is.
const ROAD_LANES = 10;        // lateral strips of the asphalt; colours are per
                              // vertex, so these read as gradients, not stripes
const RUT_POSITION = 0.42;    // where the tyre lines sit, as a fraction of half width
const RUT_WIDTH = 0.20;
const RUT_DEPTH = 0.075;      // how much darker the lines are, in HSL lightness
const PATCH_DEPTH = 0.055;    // and how much the surface wanders along its length
const EDGE_LINE = 0.85;       // fraction of half width where the edge line starts
const EDGE_LINE_LIGHT = 0.30; // how much lighter that strip is
// With a photograph on top, the vertex colours stop being a colour and become
// a multiplier around 1. This turns the figures above into that multiplier.
const TEXTURE_GAIN = 2.0;

// Verge hoardings. Height and offset matter more than they look: a board at
// the road edge is the fastest-moving thing in the periphery, and the eye
// reads peripheral motion as speed.
//
// 1.15 m was the first guess and it drove badly. Measured against the car it
// was actually LOWER -- 0.85 of the Alpine's 1.36 m -- but height next to the
// car is the wrong comparison: these are a continuous wall seen from an eye at
// 1.95 m, so they read as taller than anything they are next to and they hide
// the corner behind the corner. Half the car is enough to sweep past and low
// enough to see over.
const BOARD_LENGTH = 3.6;
const BOARD_HEIGHT = 0.7;
const BOARD_OFFSET = 0.7;     // metres beyond the curb
// Bright, and deliberately independent of the ground: their whole job is to
// be seen going past. Overridable per circuit via palette.boardA / boardB.
const BOARD_A = 0xd94141;
const BOARD_B = 0xf2f2f2;

// The ground the circuits sit on.
//
// Both grew a long way when the six layouts were scaled to real circuit
// lengths. At 5 km a lap the widest of them reaches 1005 m from its own
// centre; the original 900 m square covered 450 m, so the road would have run
// off the edge of the world several times over.
//
// The CELL SIZE is deliberately unchanged at about 5.6 m, which is why the
// count went up with the span rather than staying put. The heightfield has to
// stay below the asphalt everywhere, and it does that by a measured 24 mm; a
// coarser grid chords further between samples and would eat that margin, and
// terrain poking through the road is invisible from every angle except the
// one where you hit it.
const TERRAIN_CELLS = 429;
const TERRAIN_SIZE = 2400;
const TERRAIN_MARGIN = 26;    // metres of flat verge before the hills start
const TERRAIN_BLEND = 45;

// Lower-envelope parameters. The terrain height at a point is the minimum over
// every nearby road surface of (road height + a gentle upward slope with
// distance). Taking the minimum rather than the nearest road's height is what
// keeps a high stretch of track from throwing a shelf across a low one that
// passes close by -- see _envelope().
const ENV_RADIUS = 70;        // how far to look for competing road surfaces
const ENV_FLAT = 11;          // flat verge either side of the centerline
const ENV_SLOPE = 0.06;       // default rise per metre once past the verge
const ENV_CAP = 35;           // stop rising after this far, let the hills take over
const ROAD_CLEARANCE = 0.15;  // depth of terrain below the middle of the road
// Depth at the road edge. Small enough to drive over when rejoining, big
// enough that the heightfield still can't poke through the asphalt.
// Effectively flush. Real roads don't have a lip where the shoulder meets the
// asphalt, and anything you can catch a wheel on stops you rejoining the track.
// This is only non-zero so the coarse heightfield can never chord above the road.
const EDGE_CLEARANCE = 0.012;

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Sample a closed circuit from its control points.
 *
 * This is a uniform cubic B-spline, NOT Catmull-Rom. The difference matters:
 * Catmull-Rom *interpolates* -- it passes exactly through every control point,
 * so any imprecision in a hand-placed point becomes a real kink in the road,
 * and unevenly spaced points make it overshoot into tight loops. A B-spline
 * *approximates*: the curve is pulled toward the control polygon but never
 * forced through it, and it is C2 continuous, meaning curvature itself is
 * continuous rather than just direction. A road built on it cannot have a
 * corner sharper than its control spacing allows, and cannot cusp.
 *
 * The result is resampled at uniform arc length so downstream code can treat
 * sample index as distance along the lap.
 */
/**
 * Cut corners that are too sharp to sweep a road around.
 *
 * A B-spline's corner radius is governed by the turn angle at each control
 * point: measured across these circuits, ~110 deg gives a 20 m radius and
 * ~148 deg collapses to 9 m, which is narrower than the road is wide. Rather
 * than hand-placing points to avoid it, any vertex that turns more than
 * `maxTurnDeg` is replaced by two points set back along its own legs -- the
 * Chaikin corner-cutting step. One pass halves the angle, so a few passes turn
 * any hairpin into an arc the road can actually follow.
 *
 * Self-limiting: it stops as soon as nothing is too sharp, so gentle layouts
 * pass through untouched.
 */
function relaxSharpCorners(controlPoints, maxTurnDeg = 55, passes = 6) {
  let pts = controlPoints.map((p) => [p[0], p[1], p[2]]);

  for (let pass = 0; pass < passes; pass++) {
    const n = pts.length;
    const out = [];
    let cut = false;

    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n];
      const cur = pts[i];
      const next = pts[(i + 1) % n];
      const inV = [cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]];
      const outV = [next[0] - cur[0], next[1] - cur[1], next[2] - cur[2]];
      const li = Math.hypot(inV[0], inV[2]);
      const lo = Math.hypot(outV[0], outV[2]);
      if (li < 1 || lo < 1) { out.push(cur); continue; }

      const dot = (inV[0] * outV[0] + inV[2] * outV[2]) / (li * lo);
      const turn = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;

      if (turn > maxTurnDeg) {
        // 0.25 is the classic Chaikin ratio. Cutting deeper leaves the two
        // new points close together, and short legs make tight corners -- the
        // very thing being fixed.
        const t = 0.25;
        out.push([cur[0] - inV[0] * t, cur[1] - inV[1] * t, cur[2] - inV[2] * t]);
        out.push([cur[0] + outV[0] * t, cur[1] + outV[1] * t, cur[2] + outV[2] * t]);
        cut = true;
      } else {
        out.push(cur);
      }
    }

    pts = out;
    if (!cut) break;
  }
  return pts;
}

export function sampleCircuit(controlPoints, count, elevationSmoothMetres = 0, roundingPasses = 0) {
  const P = relaxSharpCorners(controlPoints).map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const n = P.length;
  const STEPS = 32;
  const dense = [];

  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n];
    const p1 = P[i];
    const p2 = P[(i + 1) % n];
    const p3 = P[(i + 2) % n];
    for (let s = 0; s < STEPS; s++) {
      const u = s / STEPS;
      const u2 = u * u;
      const u3 = u2 * u;
      // Uniform cubic B-spline basis.
      const b0 = (1 - 3 * u + 3 * u2 - u3) / 6;
      const b1 = (4 - 6 * u2 + 3 * u3) / 6;
      const b2 = (1 + 3 * u + 3 * u2 - 3 * u3) / 6;
      const b3 = u3 / 6;
      dense.push(new THREE.Vector3(
        p0.x * b0 + p1.x * b1 + p2.x * b2 + p3.x * b3,
        p0.y * b0 + p1.y * b1 + p2.y * b2 + p3.y * b3,
        p0.z * b0 + p1.z * b1 + p2.z * b2 + p3.z * b3,
      ));
    }
  }

  let out = resampleUniform(dense, count);

  // Curvature diffusion.
  //
  // The B-spline is already C2, but its corner radius is bounded by how far
  // apart the control points are, so a short leg meeting a long one still
  // makes a tight corner. Averaging each sample with its neighbours diffuses
  // curvature, and because the effect scales with how sharp a corner is, it
  // rounds the tightest ones hardest and leaves gentle sweepers alone.
  // Re-resampled after, since smoothing bunches the spacing.
  for (let pass = 0; pass < roundingPasses; pass++) {
    const src = out;
    const n2 = src.length;
    const next = new Array(n2);
    for (let i = 0; i < n2; i++) {
      const a = src[(i - 2 + n2) % n2], b = src[(i - 1 + n2) % n2];
      const c = src[i];
      const d = src[(i + 1) % n2], e = src[(i + 2) % n2];
      next[i] = new THREE.Vector3(
        (a.x + 2 * b.x + 4 * c.x + 2 * d.x + e.x) / 10,
        (a.y + 2 * b.y + 4 * c.y + 2 * d.y + e.y) / 10,
        (a.z + 2 * b.z + 4 * c.z + 2 * d.z + e.z) / 10,
      );
    }
    out = next;
  }
  if (roundingPasses > 0) out = resampleUniform(out, count);

  const total = pathLength(out);

  // Elevation is smoothed separately, and much harder than the plan view.
  //
  // What makes a crest or dip undriveable is not the slope itself but how fast
  // the slope CHANGES -- the vertical curvature. A single moving average
  // flattens height while leaving that second derivative rough, so the road can
  // still break sharply from climb to descent. Iterated diffusion attacks the
  // curvature directly: each pass is a heat-equation step on the height
  // profile, and repeated passes drive the gradient continuous.
  if (elevationSmoothMetres > 0 && total > 0) {
    const spacing = total / count;
    // Diffusion spreads roughly sqrt(passes) samples per pass, so the number of
    // passes needed grows with the square of the distance to smooth over.
    const reach = Math.max(1, elevationSmoothMetres / spacing);
    const passes = Math.max(1, Math.round(reach * reach));
    let y = new Float64Array(count);
    for (let i = 0; i < count; i++) y[i] = out[i].y;
    let next = new Float64Array(count);
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < count; i++) {
        const a = y[(i - 1 + count) % count];
        const b = y[i];
        const c = y[(i + 1) % count];
        next[i] = b + 0.25 * (a - 2 * b + c);   // discrete Laplacian
      }
      const tmp = y; y = next; next = tmp;
    }
    for (let i = 0; i < count; i++) out[i].y = y[i];
  }

  return out;
}

function pathLength(pts) {
  let total = 0;
  for (let i = 0; i < pts.length; i++) total += pts[i].distanceTo(pts[(i + 1) % pts.length]);
  return total;
}

/** Resample a closed polyline so its points are evenly spaced by arc length. */
function resampleUniform(pts, count) {
  const m = pts.length;
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) cum[i + 1] = cum[i] + pts[i].distanceTo(pts[(i + 1) % m]);
  const total = cum[m];
  const out = new Array(count);
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / count) * total;
    while (seg < m - 1 && cum[seg + 1] < target) seg++;
    const span = cum[seg + 1] - cum[seg] || 1;
    const t = (target - cum[seg]) / span;
    out[i] = pts[seg].clone().lerp(pts[(seg + 1) % m], t);
  }
  return out;
}

export class Track {
  constructor(world, RAPIER, scene, def) {
    this.world = world;
    this.RAPIER = RAPIER;
    this.def = def;
    this.palette = def.palette;
    this.scenery = def.scenery;
    this.halfWidth = def.halfWidth;
    this.curbWidth = def.curbWidth;
    // How fast terrain climbs away from the road. On a circuit that switchbacks
    // over itself, a shallow slope lets a lower section's envelope win next to a
    // much higher one, digging a trench at the road edge that the car falls
    // into. Climbing steeply keeps each road's own height dominant.
    this.envSlope = def.envSlope ?? ENV_SLOPE;
    // Terrain is interpolated across 5.6 m heightfield cells while the road is
    // a smooth curve, so over a sharp crest the flat cell chords above the
    // asphalt. Circuits with abrupt gradient changes need deeper clearance.
    this.roadClearance = def.roadClearance ?? ROAD_CLEARANCE;

    this._sampleCenterline();
    this._buildSpatialIndex();

    this.group = new THREE.Group();
    scene.add(this.group);

    // Terrain first, deliberately: it lets _verifyTerrainClearsRoad() probe the
    // heightfield with plain unfiltered raycasts, because at that moment it is
    // the only collider in the world. See the note in that method.
    this._buildTerrain();
    this._buildRoad();
    if (this.def.centerLine !== false) this._buildCenterLine();
    this._buildStartLine();
    this._buildMarkers();

    this._nearestCache = 0;
  }

  // --- centerline ----------------------------------------------------------

  _sampleCenterline() {
    // The control polygon's perimeter is a good enough stand-in for the lap
    // length, and it is available before the circuit has been sampled.
    let perimeter = 0;
    {
      const cps = this.def.controlPoints;
      for (let i = 0; i < cps.length; i++) {
        const a = cps[i], b = cps[(i + 1) % cps.length];
        perimeter += Math.hypot(b[0] - a[0], b[2] - a[2]);
      }
    }
    const n = Math.max(MIN_SAMPLES,
      Math.min(MAX_SAMPLES, Math.round(perimeter / SAMPLE_SPACING)));
    this.points = sampleCircuit(
      this.def.controlPoints, n, perimeter * ELEVATION_SMOOTH_FRACTION, ROUNDING_PASSES);
    this.tangents = new Array(n);
    this.rights = new Array(n);
    this.distances = new Float32Array(n + 1);

    for (let i = 0; i < n; i++) {
      // Central difference: with uniform arc-length spacing this is a good
      // tangent and, unlike an analytic derivative, it reflects the smoothed
      // elevation too.
      const tan = new THREE.Vector3()
        .subVectors(this.points[(i + 1) % n], this.points[(i - 1 + n) % n])
        .normalize();
      this.tangents[i] = tan;
      // up x tangent, which is +X for a tangent pointing along +Z. Note that
      // with forward = +Z, +X is a car's LEFT, so this array is the leftward
      // side axis despite the name. It is only ever used for symmetric offsets
      // (rails, curbs, markers), where the sign cancels -- except in project(),
      // which negates it so `lateral` is positive to the driver's right.
      this.rights[i] = new THREE.Vector3().crossVectors(UP, tan).normalize();
    }

    let acc = 0;
    for (let i = 0; i < n; i++) {
      this.distances[i] = acc;
      acc += this.points[i].distanceTo(this.points[(i + 1) % n]);
    }
    this.distances[n] = acc;
    this.length = acc;

    // Turn rate per metre, used to decide where curbs belong. The signed
    // version also records which way the corner goes, which is what banking
    // needs: cross(prev, next).y is negative for a right-hand turn.
    this.curvature = new Float32Array(n);
    const signed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = this.tangents[(i - 1 + n) % n];
      const b = this.tangents[(i + 1) % n];
      const seg = this.points[(i - 1 + n) % n].distanceTo(this.points[(i + 1) % n]);
      const k = seg > 0 ? Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)) / seg : 0;
      this.curvature[i] = k;
      signed[i] = k * Math.sign(a.z * b.x - a.x * b.z);
    }

    // Curbs are raised at corners, so the OUTER edge of the road there is a
    // step above the asphalt. The terrain has to meet that, not the road
    // surface, or the grass sits a curb-height below the edge and you cannot
    // drive back on after running wide.
    this.curbLift = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.curbLift[i] = this.curvature[i] > CURB_CURVATURE ? CURB_HEIGHT : 0;
    }

    this._buildBanking(signed);
  }

  /**
   * Superelevation: tilt the road into its corners.
   *
   * Banking is proportional to how hard the corner is, capped at the track's
   * maximum. The curvature is smoothed over ~30 m first so the camber eases in
   * and out across the entry and exit instead of snapping on at the apex --
   * an abrupt change in camber is a jolt through the suspension, and reads as
   * a crease in the road.
   *
   * `bank` is a slope: rail height = centerline height + lateralOffset * bank.
   * Offsets are measured along `rights`, which points LEFT, so a positive bank
   * raises the left-hand side -- correct for a right-hand turn.
   */
  _buildBanking(signed) {
    const n = signed.length;
    const cfg = this.def.banking;
    this.bank = new Float32Array(n);
    this.bankDrop = new Float32Array(n);
    if (!cfg || cfg.maxDegrees <= 0) return;

    // Wide smoothing window. Camber that changes quickly twists the road
    // surface, and a car crossing a twisting surface is pitched and rolled by
    // it -- the road itself becomes a disturbance. Easing it in over ~90 m
    // keeps the transition below what the suspension notices.
    const span = Math.max(1, Math.round(45 / (this.length / n)));
    const maxSlope = Math.tan((cfg.maxDegrees * Math.PI) / 180);
    const edge = this.halfWidth + this.curbWidth;

    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -span; k <= span; k++) sum += signed[(i + k + n) % n];
      const smooth = sum / (span * 2 + 1);
      this.bank[i] = THREE.MathUtils.clamp(-smooth * cfg.gain, -maxSlope, maxSlope);
      // How far the low edge of the banked cross-section falls below the
      // centerline. The terrain has to stay under that, not under the middle.
      this.bankDrop[i] = Math.abs(this.bank[i]) * edge;
    }
  }

  // Uniform grid over the centerline so terrain generation can ask "how far is
  // the nearest road point" 26k times without going quadratic.
  _buildSpatialIndex() {
    this.cell = 40;
    this.grid = new Map();
    const key = (cx, cz) => `${cx},${cz}`;
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      const cx = Math.floor(p.x / this.cell);
      const cz = Math.floor(p.z / this.cell);
      const k = key(cx, cz);
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(i);
    }
    this._gridKey = key;
  }

  _nearestByGrid(x, z) {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    let best = -1, bestDist = Infinity;
    // Widen the ring until something is found -- far out in the terrain the
    // nearest occupied cell can be several rings away.
    for (let ring = 1; ring <= 12 && best < 0; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (ring > 1 && Math.abs(dx) < ring && Math.abs(dz) < ring) continue;
          const bucket = this.grid.get(this._gridKey(cx + dx, cz + dz));
          if (!bucket) continue;
          for (const i of bucket) {
            const p = this.points[i];
            const d = (p.x - x) ** 2 + (p.z - z) ** 2;
            if (d < bestDist) { bestDist = d; best = i; }
          }
        }
      }
    }
    return { index: best < 0 ? 0 : best, distance: Math.sqrt(bestDist) };
  }

  /**
   * Project a world point onto the centerline.
   * Uses a window around the last result, since the car moves continuously.
   */
  project(point) {
    const n = this.points.length;
    let best = this._nearestCache;
    let bestDist = Infinity;
    const window = 48;

    for (let k = -window; k <= window; k++) {
      const i = (this._nearestCache + k + n * 2) % n;
      const p = this.points[i];
      const d = (p.x - point.x) ** 2 + (p.z - point.z) ** 2;
      if (d < bestDist) { bestDist = d; best = i; }
    }

    // The window lost track (respawn, big jump): fall back to the grid.
    if (Math.sqrt(bestDist) > window * 1.2) {
      const g = this._nearestByGrid(point.x, point.z);
      best = g.index;
      bestDist = g.distance ** 2;
    }
    this._nearestCache = best;

    const p = this.points[best];
    const side = this.rights[best];
    // Negated so `lateral` is positive when the car is to the driver's right.
    const lateral = -((point.x - p.x) * side.x + (point.z - p.z) * side.z);

    return {
      index: best,
      lateral,
      progress: this.distances[best] / this.length,
      point: p,
      tangent: this.tangents[best],
      height: p.y,
    };
  }

  /**
   * Grip multiplier at a world point. Both the on-road and off-road figures
   * come from the track, so snow can be slippery everywhere while forest
   * tarmac is not.
   */
  gripAt(point, tuningSurfaces) {
    const proj = this.project(point);
    const off = Math.abs(proj.lateral);
    const edge = this.halfWidth + this.curbWidth;
    const onRoad = this.def.surface.roadGrip;
    if (off <= edge) return onRoad;
    // The track's own off-road figure wins; the tuning value is the fallback.
    const offRoad = this.def.surface.grassGrip ?? tuningSurfaces.grassGripMult;
    const blend = Math.max(tuningSurfaces.edgeBlend, 0.01);
    const t = THREE.MathUtils.clamp((off - edge) / blend, 0, 1);
    return THREE.MathUtils.lerp(onRoad, offRoad, t);
  }

  /** A spawn transform on the racing line at the given progress (0..1). */
  spawnAt(progress = 0.985) {
    const n = this.points.length;
    const i = Math.floor(THREE.MathUtils.euclideanModulo(progress, 1) * n) % n;
    const p = this.points[i];
    const tan = this.tangents[i];
    // The car's local forward is +Z, so build the yaw that maps +Z onto the tangent.
    // Yaw down the road, then roll to match the camber. Without the roll the
    // car is dropped flat onto a banked surface and lands balanced on one
    // wheel, with no grip and nowhere to go.
    const yaw = Math.atan2(tan.x, tan.z);
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    const bank = this.bank ? this.bank[i] : 0;
    if (bank !== 0) {
      // Offsets run along `rights`, which points left, so a positive bank
      // raises the car's left (+X) side -- a positive rotation about forward.
      q.multiply(new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1), Math.atan(bank),
      ));
    }
    // Spawn at the car's natural ride height. Dropping it in from above makes
    // the suspension bottom out on landing, which can ground the chassis and
    // leave it stuck before you've touched the throttle.
    const ride = -TUNING.wheels.connectionY
      + TUNING.suspension.restLength
      + TUNING.wheels.radius;
    return {
      position: { x: p.x, y: p.y + ride - 0.02, z: p.z },
      rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
    };
  }

  // --- geometry ------------------------------------------------------------

  // Four longitudinal rails: outer-left curb, road edge, road edge, outer-right
  // curb. Curbs rise only where the centerline actually turns, so they sit
  // flush on the straights and there are never gaps to fall into.
  _rails() {
    const n = this.points.length;
    const rails = [[], [], [], []];
    for (let i = 0; i <= n; i++) {
      const idx = i % n;
      const p = this.points[idx];
      const r = this.rights[idx];
      const raised = this.curvature[idx] > CURB_CURVATURE ? CURB_HEIGHT : 0;
      const off = [-(this.halfWidth + this.curbWidth), -this.halfWidth, this.halfWidth, this.halfWidth + this.curbWidth];
      const lift = [raised, 0, 0, raised];
      const bank = this.bank[idx];
      for (let k = 0; k < 4; k++) {
        rails[k].push(new THREE.Vector3(
          p.x + r.x * off[k],
          p.y + lift[k] + off[k] * bank,   // superelevation
          p.z + r.z * off[k],
        ));
      }
    }
    return rails;
  }

  _buildRoad() {
    const rails = this._rails();
    const n = this.points.length;

    const pos = [];
    const col = [];
    const nrm = [];

    // Surface normal per sample: perpendicular to both the direction of travel
    // and the banked cross-section. Assigning these per vertex lets the shader
    // interpolate across each quad, so a change of gradient reads as gradual
    // shading instead of a hard crease between two flat facets.
    const normals = [];
    for (let i = 0; i <= n; i++) {
      const idx = i % n;
      const tan = this.tangents[idx];
      const r = this.rights[idx];
      const side = new THREE.Vector3(r.x, this.bank[idx], r.z).normalize();
      const nv = new THREE.Vector3().crossVectors(side, tan).normalize();
      if (nv.y < 0) nv.negate();
      normals.push(nv);
    }
    const edge = new THREE.Color(this.palette.asphaltEdge);
    const curbA = new THREE.Color(this.palette.curbA);
    const curbB = new THREE.Color(this.palette.curbB);

    // Colours go per VERTEX, not per quad. A colour per quad would draw the
    // ruts as ten hard stripes; per vertex, the smooth-shaded road interpolates
    // them into the soft gradients a worn surface actually has.
    const pushTri = (a, b, c, ca, cb, cc, na, nb, nc) => {
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      col.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b);
      nrm.push(na.x, na.y, na.z, nb.x, nb.y, nb.z, nc.x, nc.y, nc.z);
    };

    // --- the asphalt, subdivided across its width ---------------------------
    //
    // Its own set of rails at ROAD_LANES + 1 lateral offsets, carrying the
    // same superelevation as the curbs so the two still meet exactly.
    const laneRails = [];
    for (let j = 0; j <= ROAD_LANES; j++) {
      const s = (j / ROAD_LANES) * 2 - 1;            // -1..1 across the road
      const off = s * this.halfWidth;
      const rail = [];
      for (let i = 0; i <= n; i++) {
        const idx = i % n;
        const p = this.points[idx];
        const r = this.rights[idx];
        rail.push(new THREE.Vector3(
          p.x + r.x * off, p.y + off * this.bank[idx], p.z + r.z * off,
        ));
      }
      laneRails.push(rail);
    }

    // Whether a photograph of tarmac is going on top of all this.
    //
    // It changes what the vertex colours have to MEAN, which is the trap. With
    // a map in place three multiplies map x vertexColor x material.color, so
    // vertex colours carrying the palette's dark asphalt against a photograph
    // of dark asphalt would land the road at about a thousandth of the light
    // it should have -- black. Textured, the photograph is the colour and the
    // vertex colours become a multiplier around white carrying nothing but the
    // ruts, the patches and the edge line. Untextured, they carry the colour
    // as they always did.
    const textured = hasRoadTexture(this.def.surface?.texture);

    const surface = [];
    for (let j = 0; j <= ROAD_LANES; j++) {
      const s = (j / ROAD_LANES) * 2 - 1;
      const a = Math.abs(s);
      // Two wheel tracks, as a smooth well rather than a painted line.
      const rut = Math.exp(-((a - RUT_POSITION) ** 2) / (2 * RUT_WIDTH ** 2));
      // A lighter strip where the asphalt meets the curb, which is both what a
      // road has and a second longitudinal line for the eye to run along.
      const line = a > EDGE_LINE ? (a - EDGE_LINE) / (1 - EDGE_LINE) : 0;
      const lateral = -rut * RUT_DEPTH + line * EDGE_LINE_LIGHT;
      const row = [];
      for (let i = 0; i <= n; i++) {
        // Three periods that share no common multiple, so the surface never
        // settles into a repeat you can see coming. This also breaks up the
        // texture's own two-metre tile, which is the other thing that would
        // otherwise read as a pattern down a long straight.
        const along = Math.sin(i * 0.037) * 0.55
                    + Math.sin(i * 0.113 + 1.7) * 0.30
                    + Math.sin(i * 0.283 + 0.4) * 0.15;
        const v = lateral + along * PATCH_DEPTH;
        row.push(textured
          ? new THREE.Color().setScalar(Math.min(1.9, Math.max(0.45, 1 + v * TEXTURE_GAIN)))
          : new THREE.Color(this.palette.asphalt).offsetHSL(0, 0, v));
      }
      surface.push(row);
    }

    // UVs, in metres. u runs across the road and v along it, both divided by
    // the tile size, so the grain is the size the photograph says it is and
    // does not stretch through a corner.
    const spacing = this.length / n;
    const roadWidth = this.halfWidth * 2;
    // Metres of ground per repeat, as published by whoever scanned the
    // surface. Asked per circuit, because gravel and tarmac were not shot at
    // the same scale and a shared constant would make one of them wrong.
    const tile = tileMetres(this.def.surface?.texture);
    const uvs = [];
    const pushUV = (...vs) => { for (const v of vs) uvs.push(v[0], v[1]); };

    for (let i = 0; i < n; i++) {
      const n0 = normals[i], n1 = normals[i + 1];
      const v0 = (i * spacing) / tile;
      const v1 = ((i + 1) * spacing) / tile;
      for (let j = 0; j < ROAD_LANES; j++) {
        const a = laneRails[j][i], b = laneRails[j][i + 1];
        const c = laneRails[j + 1][i + 1], d = laneRails[j + 1][i];
        const ca = surface[j][i], cb = surface[j][i + 1];
        const cc = surface[j + 1][i + 1], cd = surface[j + 1][i];
        const u0 = ((j / ROAD_LANES) * roadWidth) / tile;
        const u1 = (((j + 1) / ROAD_LANES) * roadWidth) / tile;
        pushTri(a, b, c, ca, cb, cc, n0, n1, n1);
        pushUV([u0, v0], [u0, v1], [u1, v1]);
        pushTri(a, c, d, ca, cc, cd, n0, n1, n0);
        pushUV([u0, v0], [u1, v1], [u1, v0]);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

    // Smooth shading, unlike the rest of the world. Faceting is the look
    // everywhere else, but on the road it turns every gradient change into a
    // visible crease and makes a smooth surface look broken.
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: false, roughness: 0.92, metalness: 0.0,
    }));
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.roadMesh = mesh;
    // Fire and forget: the road is already on screen and correct without it.
    applyRoadTexture(mesh.material, this.def.surface?.texture, this.palette.asphalt);

    // --- curbs, as their own mesh -------------------------------------------
    //
    // Separate because they need a material WITHOUT the road's map. Sharing one
    // would multiply a red-and-white kerb by a photograph of dark tarmac and
    // leave it muddy. One extra draw call, and the kerbs keep their colour.
    const cpos = [], ccol = [], cnrm = [];
    const pushCurb = (a, b, c, color, na, nb, nc) => {
      cpos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      for (let k = 0; k < 3; k++) ccol.push(color.r, color.g, color.b);
      cnrm.push(na.x, na.y, na.z, nb.x, nb.y, nb.z, nc.x, nc.y, nc.z);
    };
    for (let i = 0; i < n; i++) {
      const raised = this.curvature[i % n] > CURB_CURVATURE;
      const stripe = Math.floor(this.distances[i] / CURB_STRIPE_METRES) % 2 === 0 ? curbA : curbB;
      const curbColor = raised ? stripe : edge;
      const n0 = normals[i], n1 = normals[i + 1];
      for (const k of [0, 2]) {
        const a = rails[k][i], b = rails[k][i + 1];
        const c = rails[k + 1][i + 1], d = rails[k + 1][i];
        pushCurb(a, b, c, curbColor, n0, n1, n1);
        pushCurb(a, c, d, curbColor, n0, n1, n0);
      }
    }
    const curbGeo = new THREE.BufferGeometry();
    curbGeo.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3));
    curbGeo.setAttribute('color', new THREE.Float32BufferAttribute(ccol, 3));
    curbGeo.setAttribute('normal', new THREE.Float32BufferAttribute(cnrm, 3));
    const curbMesh = new THREE.Mesh(curbGeo, new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: false, roughness: 0.95, metalness: 0.0,
    }));
    curbMesh.receiveShadow = true;
    this.group.add(curbMesh);

    // Indexed twin of the same surface for the collider: 4 verts per section.
    const verts = new Float32Array((n + 1) * 4 * 3);
    for (let i = 0; i <= n; i++) {
      for (let k = 0; k < 4; k++) {
        const v = rails[k][i];
        const o = (i * 4 + k) * 3;
        verts[o] = v.x; verts[o + 1] = v.y; verts[o + 2] = v.z;
      }
    }
    const indices = new Uint32Array(n * 3 * 6);
    let w = 0;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const a = i * 4 + k, b = (i + 1) * 4 + k;
        const c = (i + 1) * 4 + k + 1, d = i * 4 + k + 1;
        indices[w++] = a; indices[w++] = b; indices[w++] = c;
        indices[w++] = a; indices[w++] = c; indices[w++] = d;
      }
    }

    this.roadCollider = this.world.createCollider(
      this.RAPIER.ColliderDesc.trimesh(verts, indices).setFriction(1.0),
    );
  }

  /**
   * Lower envelope of every road surface within ENV_RADIUS: the minimum of
   * (sample height + slope * distance beyond the verge).
   *
   * Using the nearest sample's height instead makes terrain a Voronoi step
   * function. Wherever two stretches of track at different elevations pass
   * within a couple of grid cells of each other, the higher one wins some of
   * the vertices beside the lower one, and bilinear interpolation then smears
   * that cliff straight across the lower road -- an invisible wall the car
   * slams into. The minimum can never exceed any nearby road, so that whole
   * failure mode is gone by construction.
   */
  /**
   * Nearest road sample to a point far from the road, from a precomputed field.
   *
   * Multi-source breadth-first over the same 40 m grid the road is bucketed
   * into: every occupied bucket starts knowing its own nearest sample, and the
   * answer spreads outward one ring at a time. That is a few thousand steps
   * ONCE, against a few hundred lookups per terrain cell for a hundred and
   * fifty thousand cells.
   *
   * The distance it returns is measured to the real sample, not to the bucket,
   * so it is exact. Only which sample is nearest can be off, and only by one
   * bucket -- which matters not at all out here, where the slope term has long
   * since saturated and every nearby sample contributes the same constant.
   */
  _coarseNearest(x, z) {
    if (!this._coarse) this._buildCoarseField();
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const index = this._coarse.get(this._gridKey(cx, cz));
    if (index === undefined) return this._nearestByGrid(x, z);
    const p = this.points[index];
    return { index, distance: Math.hypot(p.x - x, p.z - z) };
  }

  _buildCoarseField() {
    const field = new Map();
    let frontier = [];
    // Seed: every bucket that holds road, pointing at its own first sample.
    for (const [key, bucket] of this.grid) {
      field.set(key, bucket[0]);
      frontier.push(key);
    }
    // Spread outward. Bounded by the terrain, which is why this terminates
    // quickly even on a circuit that only occupies part of the square.
    const span = Math.ceil(TERRAIN_SIZE / this.cell) + 4;
    const limit = span * span * 4;
    let guard = 0;
    while (frontier.length && guard++ < limit) {
      const next = [];
      for (const key of frontier) {
        const [kx, kz] = key.split(',').map(Number);
        const from = field.get(key);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (!dx && !dz) continue;
            const nx = kx + dx, nz = kz + dz;
            if (Math.abs(nx) > span || Math.abs(nz) > span) continue;
            const nkey = this._gridKey(nx, nz);
            if (field.has(nkey)) continue;
            field.set(nkey, from);
            next.push(nkey);
          }
        }
      }
      frontier = next;
    }
    this._coarse = field;
  }

  _envelope(x, z) {
    const reach = Math.ceil(ENV_RADIUS / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    let roadY = Infinity;
    let nearest = Infinity;

    for (let dx = -reach; dx <= reach; dx++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const bucket = this.grid.get(this._gridKey(cx + dx, cz + dz));
        if (!bucket) continue;
        for (const i of bucket) {
          const p = this.points[i];
          const d = Math.hypot(p.x - x, p.z - z);
          if (d < nearest) nearest = d;
          const h = (p.y + this.curbLift[i] - this.bankDrop[i])
            + this.envSlope * THREE.MathUtils.clamp(d - ENV_FLAT, 0, ENV_CAP);
          if (h < roadY) roadY = h;
        }
      }
    }

    if (roadY === Infinity) {
      // Beyond every bucket we looked at, so more than about 60 m from any
      // asphalt. Answered from a field computed once rather than by expanding
      // rings from here.
      //
      // This is where the terrain build was spending its life. _nearestByGrid
      // widens a ring until it finds road, and from the far corner of a 2400 m
      // square that is eight rings, a couple of hundred bucket lookups -- per
      // terrain cell, and five sixths of the 184,000 cells are out here. It did
      // not show while the world was 900 m across and the far field was small.
      const g = this._coarseNearest(x, z);
      nearest = g.distance;
      roadY = this.points[g.index].y + this.curbLift[g.index] - this.bankDrop[g.index]
        + this.envSlope * THREE.MathUtils.clamp(g.distance - ENV_FLAT, 0, ENV_CAP);
    }
    return { roadY, nearest };
  }

  /** Terrain height, in metres, that meets the road exactly at its edge. */
  terrainHeight(x, z) {
    const { roadY, nearest: distance } = this._envelope(x, z);
    const t = THREE.MathUtils.smoothstep(distance, TERRAIN_MARGIN, TERRAIN_MARGIN + TERRAIN_BLEND);
    // Rolling terrain away from the track. Amplitude and feature size come from
    // the track, so mountains get big landforms and woods gets fine ripples.
    const a = this.def.hills.amplitude;
    const f = this.def.hills.scale;
    const hills = a * (
      3.6 * Math.sin(x * 0.0128 * f) * Math.cos(z * 0.0109 * f) +
      2.1 * Math.sin(x * 0.0307 * f + 1.7) * Math.sin(z * 0.0271 * f) +
      1.2 * Math.cos(x * 0.0061 * f - 0.4) * Math.sin(z * 0.0083 * f + 2.2)
    );
    // Clearance is tapered, not constant.
    //
    // It exists so the coarse heightfield can never chord ABOVE the asphalt,
    // but it is only needed under the road, where the terrain is hidden. Held
    // constant it also makes the road EDGE a step of the same size -- and a
    // step deeper than the suspension can absorb is a wall you can't drive
    // back over after running wide. So: full depth under the middle of the
    // road, tapering to nearly flush by the time it reaches the edge.
    const edge = this.halfWidth + this.curbWidth;

    const under = THREE.MathUtils.clamp((edge - distance) / 4, 0, 1);
    const clearance = THREE.MathUtils.lerp(EDGE_CLEARANCE, this.roadClearance, under);
    return roadY - clearance + hills * t;
  }

  _buildTerrain() {
    const cells = TERRAIN_CELLS;
    const size = TERRAIN_SIZE;
    const step = size / cells;

    // Centre the terrain on the circuit's bounding box.
    const box = new THREE.Box3().setFromPoints(this.points);
    const center = box.getCenter(new THREE.Vector3());
    center.y = 0;
    this.terrainCenter = center;

    // Rapier heightfield indexing, established by probing the actual build
    // (see README): heights[zIndex + xIndex*(cells+1)]. The FIRST index runs
    // along +Z and the second along +X -- the opposite of what the row/column
    // naming suggests. Getting this backwards transposes the terrain about its
    // diagonal, which leaves the visual mesh looking perfect while the collider
    // throws invisible ridges across the track.
    const idx = (ix, jz) => jz + ix * (cells + 1);
    this._terrainIndex = idx;

    const heights = new Float32Array((cells + 1) * (cells + 1));
    for (let jz = 0; jz <= cells; jz++) {
      const z = center.z - size / 2 + jz * step;
      for (let ix = 0; ix <= cells; ix++) {
        const x = center.x - size / 2 + ix * step;
        heights[idx(ix, jz)] = this.terrainHeight(x, z);
      }
    }

    this.terrainCollider = this.world.createCollider(
      this.RAPIER.ColliderDesc
        .heightfield(cells, cells, heights, { x: size, y: 1, z: size })
        .setTranslation(center.x, 0, center.z)
        .setFriction(0.85),
    );

    this._verifyTerrainClearsRoad();

    // Visual mesh built from the identical height array, so what you see is
    // exactly what the wheels hit.
    const geo = new THREE.PlaneGeometry(size, size, cells, cells);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const grass = new THREE.Color(this.palette.ground);
    const grassDark = new THREE.Color(this.palette.groundDark);
    const tmp = new THREE.Color();

    for (let v = 0; v < pos.count; v++) {
      // Map each vertex back through the same index helper the collider used,
      // so what you see is exactly the surface the wheels hit.
      const x = pos.getX(v);
      const z = pos.getZ(v);
      const i = THREE.MathUtils.clamp(Math.round((x + size / 2) / step), 0, cells);
      const j = THREE.MathUtils.clamp(Math.round((z + size / 2) / step), 0, cells);
      pos.setY(v, heights[idx(i, j)]);

      const shade = 0.5 + 0.5 * Math.sin(i * 1.7 + j * 2.3);
      tmp.copy(grassDark).lerp(grass, shade);
      colors[v * 3] = tmp.r; colors[v * 3 + 1] = tmp.g; colors[v * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 1.0, metalness: 0,
    }));
    mesh.position.set(center.x, 0, center.z);
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.terrainMesh = mesh;
  }

  /**
   * Assert the terrain stays under the asphalt everywhere on the driveable
   * surface. Terrain poking through the road is invisible -- the road mesh
   * still renders on top -- but the wheels raycast onto it and the car slams
   * into a wall that isn't there. Cheap to check, so always check.
   *
   * This deliberately ray-casts the real collider rather than re-deriving the
   * surface from the heights array: reimplementing the heightfield indexing in
   * the checker is how you end up with a checker that agrees with a bug.
   *
   * Called from _buildTerrain() before the road collider exists, so an
   * unfiltered cast can only hit the terrain. Do NOT "improve" this by adding
   * a filter predicate to isolate the terrain later on -- passing a JS closure
   * to castRay leaves state in the WASM bridge that makes the next world.step()
   * deactivate the vehicle's rigid body, which presents as a car that ignores
   * gravity and the throttle.
   */
  _verifyTerrainClearsRoad() {
    // castRay reads the query pipeline, which is refreshed by step(). Nothing
    // dynamic exists yet, so this costs nothing.
    this.world.step();

    const surfaceAt = (x, z) => {
      const ray = new this.RAPIER.Ray({ x, y: 200, z }, { x: 0, y: -1, z: 0 });
      const hit = this.world.castRay(ray, 400, true);
      return hit ? 200 - hit.timeOfImpact : null;
    };

    let worst = Infinity;
    let worstAt = null;
    const offsets = [-1, -0.5, 0, 0.5, 1].map((f) => f * (this.halfWidth + this.curbWidth));

    for (let i = 0; i < this.points.length; i += 2) {
      const p = this.points[i];
      const r = this.rights[i];
      for (const off of offsets) {
        const x = p.x + r.x * off;
        const z = p.z + r.z * off;
        const terrainY = surfaceAt(x, z);
        if (terrainY === null) continue;
        // Compare against the banked road surface at this offset, which on the
        // low side of a corner sits below the centerline.
        // Outermost samples sit on the curb, which is raised.
        const onCurb = Math.abs(off) > this.halfWidth;
        const surface = p.y + off * this.bank[i] + (onCurb ? this.curbLift[i] : 0);
        const clearance = surface - terrainY;
        if (clearance < worst) {
          worst = clearance;
          worstAt = { x: +x.toFixed(1), z: +z.toFixed(1), progress: +(i / this.points.length).toFixed(3) };
        }
      }
    }

    this.terrainClearance = worst;
    if (worst < 0.01) {
      console.error(
        `track: terrain rises to within ${worst.toFixed(3)} m of the road surface ` +
        `(worst at progress ${worstAt.progress}, x=${worstAt.x} z=${worstAt.z}). ` +
        'The car will hit an invisible wall there.',
      );
    } else {
      console.log(`track: terrain clears the road by at least ${worst.toFixed(3)} m`);
    }
    return worst;
  }

  /**
   * Dashed centre line.
   *
   * Mostly a speed cue: at a fixed 8 m pitch the dashes stream past at a rate
   * proportional to speed, which the eye reads far better than a uniform grey
   * ribbon. Placed by distance along the lap rather than by sample index, so
   * the pitch stays constant regardless of how the centerline was sampled.
   */
  _buildCenterLine() {
    const n = this.points.length;
    const DASH = 3.0;          // metres of paint
    const GAP = 5.0;           // metres of nothing
    const HALF_W = 0.11;       // a 22 cm line
    // 9 mm of lift lost the z-buffer fight at distance and the line vanished.
    // 4 cm is still visually flush but survives depth precision down the road.
    const LIFT = 0.04;
    const period = DASH + GAP;

    const pos = [];
    const nrm = [];
    const up = new THREE.Vector3(0, 1, 0);

    const corner = (idx, off) => {
      const p = this.points[idx];
      const r = this.rights[idx];
      return new THREE.Vector3(
        p.x + r.x * off,
        p.y + off * this.bank[idx] + LIFT,
        p.z + r.z * off,
      );
    };

    for (let i = 0; i < n; i++) {
      // Skip the stretch that falls in a gap.
      if (this.distances[i] % period > DASH) continue;
      const j = (i + 1) % n;
      const a = corner(i, -HALF_W), b = corner(i, HALF_W);
      const c = corner(j, HALF_W), d = corner(j, -HALF_W);
      for (const tri of [[a, b, c], [a, c, d]]) {
        for (const v of tri) {
          pos.push(v.x, v.y, v.z);
          nrm.push(up.x, up.y, up.z);
        }
      }
    }

    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));

    // Unlit on purpose. A lit white surface takes on the colour of the light,
    // and this scene's sun is a warm cream (0xfff3dd), which turned the
    // markings visibly yellow. Paint should read as white whatever the sun is
    // doing, so the line is drawn at its own colour and only fog affects it.
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: this.palette.centerLine ?? 0xf7f8fa,
      fog: true,
      // The quad winding here puts the geometric normal downwards, so with
      // default FrontSide the whole line is back-face culled and simply never
      // appears. Setting the normal attribute doesn't help -- culling is
      // decided by winding, not by the normals you supply.
      side: THREE.DoubleSide,
      // Nudged toward the camera so it can't z-fight the asphalt beneath it.
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }));
    mesh.renderOrder = 1;
    this.group.add(mesh);
  }

  _buildStartLine() {
    const i = 0;
    const p = this.points[i];
    const r = this.rights[i];
    const t = this.tangents[i];
    const squares = 12;
    const pos = [];
    const col = [];
    const black = new THREE.Color(0x111318);
    const white = new THREE.Color(0xf2f2f2);
    const w = (this.halfWidth * 2) / squares;
    const depth = 1.6;

    for (let s = 0; s < squares; s++) {
      for (let row = 0; row < 2; row++) {
        const o0 = -this.halfWidth + s * w;
        const o1 = o0 + w;
        const d0 = (row - 1) * depth;
        const d1 = d0 + depth;
        const v = (off, dep) => new THREE.Vector3(
          p.x + r.x * off + t.x * dep,
          p.y + 0.012,
          p.z + r.z * off + t.z * dep,
        );
        const a = v(o0, d0), b = v(o1, d0), c = v(o1, d1), d = v(o0, d1);
        const color = (s + row) % 2 === 0 ? black : white;
        for (const tri of [[a, b, c], [a, c, d]]) {
          for (const vert of tri) {
            pos.push(vert.x, vert.y, vert.z);
            col.push(color.r, color.g, color.b);
          }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    this.group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.9,
    })));
  }

  // Trackside furniture: gives the eye something to judge speed and distance
  // against, which flat colour alone does not.
  //
  // All of it is instanced. A mesh per tree costs ~1400 geometries and 600+
  // draw calls, which drags the frame rate low enough that the fixed-step
  // accumulator starts dropping physics steps -- the car then genuinely
  // accelerates in slow motion. Scenery is not allowed to cost handling.
  _buildMarkers() {
    const dummy = new THREE.Object3D();
    const n = this.points.length;

    // --- marker posts along both verges ---
    const postSpots = [];
    // Posts every so many METRES, not every so many samples.
    const postStep = Math.max(1, Math.round(
      (this.scenery.postSpacing * 1.8) / (this.length / n)));
    for (let i = 0; i < n; i += postStep) {
      const p = this.points[i];
      const r = this.rights[i];
      for (const side of [-1, 1]) {
        const off = side * (this.halfWidth + this.curbWidth + 1.6);
        postSpots.push({ x: p.x + r.x * off, y: p.y, z: p.z + r.z * off });
      }
    }

    const posts = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.14, 1.0, 0.14), flatMat(this.palette.post), postSpots.length,
    );
    const stripes = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.16, 0.22, 0.16), flatMat(this.palette.postStripe), postSpots.length,
    );
    postSpots.forEach((s, i) => {
      dummy.position.set(s.x, s.y + 0.5, s.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      posts.setMatrixAt(i, dummy.matrix);
      dummy.position.y = s.y + 0.86;
      dummy.updateMatrix();
      stripes.setMatrixAt(i, dummy.matrix);
    });
    posts.castShadow = true;
    this.group.add(posts, stripes);

    // --- hoardings along the verge ------------------------------------------
    //
    // The single biggest thing missing from the sense of speed, and the reason
    // is geometric rather than aesthetic. Optical flow measured across the
    // frame on Forest: the outer third of the screen carried a sixth of the
    // flow of the middle, and held no detail at all -- flat sky above, flat
    // grass beside, untextured road below. Widening the field of view made it
    // WORSE (0.33 down to 0.27 from 62 to 95 degrees), because all it does is
    // put more empty grass on screen. There was nothing at the edges to see.
    //
    // A continuous run of boards at the road edge is what every arcade rally
    // game puts there, and it is not decoration: a vertical surface a metre
    // from the tarmac sweeps through the periphery faster than anything else
    // in the scene, which is exactly the signal the eye reads as self-motion.
    //
    // In runs with gaps rather than an unbroken wall -- partly so it reads as a
    // circuit rather than a corridor, and partly so you can still see the
    // corner behind the corner.
    const boardSpots = [];
    const spacing = this.length / n;   // metres between centreline samples
    const perBoard = Math.max(1, Math.round(BOARD_LENGTH / spacing));
    for (let i = 0; i < n; i += perBoard) {
      // Runs of about twelve, then a gap of about five.
      if (Math.floor(i / (perBoard * 12)) % 3 === 2) continue;
      const p = this.points[i];
      const r = this.rights[i];
      const t = this.tangents[i];
      const yaw = Math.atan2(t.x, t.z);
      for (const side of [-1, 1]) {
        const off = side * (this.halfWidth + this.curbWidth + BOARD_OFFSET);
        boardSpots.push({
          x: p.x + r.x * off, y: p.y, z: p.z + r.z * off, yaw,
          alt: Math.floor(i / perBoard) % 2 === 0,
        });
      }
    }

    const boardGeo = new THREE.BoxGeometry(BOARD_LENGTH * 0.92, BOARD_HEIGHT, 0.12);
    for (const alt of [false, true]) {
      const spots = boardSpots.filter((s) => s.alt === alt);
      if (!spots.length) continue;
      // Their own colours, NOT the curbs'.
      //
      // Falling back to the curbs was the first idea and it was wrong on the
      // one circuit it mattered: Dirt's curbs are earth tones by design --
      // there are no red-and-white kerbs on a gravel stage -- so the hoardings
      // came out sand-coloured and vanished into the verge they were put there
      // to stand against. A sponsor board is a manufactured object and looks
      // the same on gravel as on tarmac.
      const colour = alt
        ? (this.palette.boardB ?? BOARD_B)
        : (this.palette.boardA ?? BOARD_A);
      const mesh = new THREE.InstancedMesh(boardGeo, flatMat(colour), spots.length);
      spots.forEach((s, i) => {
        dummy.position.set(s.x, s.y + BOARD_HEIGHT / 2, s.z);
        dummy.rotation.set(0, s.yaw, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.castShadow = true;
      this.group.add(mesh);
    }

    // --- deterministic tree scatter, kept clear of the track and its verges ---
    let seed = 9091;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    const trees = [];
    // Scattered over the terrain, and counted by AREA rather than by a fixed
    // number. The span was hardcoded at 780 m, so growing the ground to 1500
    // would have left the same 620 trees spread over nearly three times the
    // land -- a forest that thinned out the moment the circuits got bigger.
    const scatterSpan = TERRAIN_SIZE - 120;
    const wanted = Math.round(this.scenery.treeCount * (scatterSpan / 780) ** 2);
    for (let attempt = 0; attempt < wanted * 2.2 && trees.length < wanted; attempt++) {
      const x = this.terrainCenter.x + (rand() - 0.5) * scatterSpan;
      const z = this.terrainCenter.z + (rand() - 0.5) * scatterSpan;
      const spread = rand();
      const height = rand();
      if (this._nearestByGrid(x, z).distance < this.halfWidth + this.scenery.treeClearance) continue;
      const [hMin, hMax] = this.scenery.treeHeight;
      trees.push({ x, z, y: this.terrainHeight(x, z), h: hMin + height * (hMax - hMin), spread });
    }

    // Unit-sized source geometry; each instance is scaled into place.
    const trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.22, 0.3, 1, 5), flatMat(this.palette.trunk), trees.length,
    );
    const crowns = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, this.scenery.treeSegments), flatMat(this.palette.leaf), trees.length,
    );

    trees.forEach((t, i) => {
      const trunkH = t.h * 0.42;
      dummy.position.set(t.x, t.y + trunkH / 2, t.z);
      dummy.rotation.set(0, t.spread * Math.PI, 0);
      dummy.scale.set(1, trunkH, 1);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);

      const crownH = t.h * 0.85;
      const [rMin, rMax] = this.scenery.treeRadius;
      const crownR = rMin + t.spread * (rMax - rMin);
      dummy.position.set(t.x, t.y + trunkH + crownH / 2, t.z);
      dummy.scale.set(crownR, crownH, crownR);
      dummy.updateMatrix();
      crowns.setMatrixAt(i, dummy.matrix);
    });
    crowns.castShadow = true;
    this.group.add(trunks, crowns);
  }
}

