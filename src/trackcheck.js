// Geometry validation for a track definition.
//
// This is the half of validation that `src/trackfile.js` cannot do. That module
// answers "is this a well-formed file?"; this one answers "is this a circuit
// anyone can drive?" -- which needs the sampled centerline, not just the
// fields.
//
// It runs on a plain track definition and builds nothing: no Rapier world, no
// meshes, no colliders. That is what lets the editor re-run the whole thing on
// every drag of a control point, and the headless tests run it without a
// renderer.
//
// The checks themselves are not new. Every one of them is a mistake this
// project actually shipped and then had to debug from the driver's seat: a
// hairpin whose inner edge folded through itself, two parts of a lap
// overlapping into a roof over the road, a slope change abrupt enough to
// launch the car. Having them as a function means an editor can say "this
// corner is 5.6 m, it needs 13.4" while you are still dragging the point,
// instead of you discovering it at 200 km/h.

import * as THREE from 'three';
import { sampleCircuit } from './track.js';

const UP = new THREE.Vector3(0, 1, 0);

// Sampling has to match src/track.js or the numbers here describe a different
// circuit from the one that gets built.
export const SAMPLES = 720;
export const ELEVATION_SMOOTH = 55;
export const ROUNDING_PASSES = 70;

// --- thresholds ------------------------------------------------------------
//
// Calibrated against the four shipped circuits rather than picked from the
// air: each limit sits where a layout known to feel bad crosses it, and clears
// the layouts known to be fine.

export const LIMITS = {
  // The ribbon folds through itself below `width`. 1.5x leaves margin without
  // banning legitimately tight hairpins -- Forest drove fine at ~11 m for a
  // long time, so a stricter bar would fail corners that are genuinely OK.
  radiusFactor: 1.5,

  // Two ribbons edge to edge. Closer than this and one becomes a roof over the
  // other: spawn under it and the car is ejected sideways.
  separationFactor: 2.0,

  // Gradient, as a fraction. 12% is an alpine pass; 20% is a hill climb and
  // about where an A110 stops pulling cleanly uphill in a mid gear.
  // The shipped circuits run 1.1% to 5.9% (Mountains is the steep one), so
  // there is deliberate headroom here: these are real-world limits, not a bar
  // fitted to what already exists.
  gradientWarn: 0.12,
  gradientError: 0.20,

  // Rate of change of gradient, per metre -- vertical curvature. This is the
  // one that produced the "the road has a hard break and change of angle which
  // makes it undrivable" report: it launches the car rather than merely
  // tilting it.
  //
  // Measured across the four circuits after smoothing: 0.17% to 0.48% per 10 m.
  // Warn at 2% per 10 m, roughly 4x the current worst, so drift gets caught
  // while a hillier layout still has room. Error at 6%: a proper mountain crest
  // swinging +8% to -8% over 40 m works out at 4% per 10 m, so it warns rather
  // than failing -- that is a hard compression, not a broken road.
  gradientChangeWarn: 0.002,
  gradientChangeError: 0.006,

  // Control points turning more than this are relaxed automatically by the
  // corner cutter, so the point is not used where it was placed. Not a defect
  // -- worth surfacing so an author knows why a point appears to be ignored.
  controlTurnDeg: 55,

  // Banking tilts the road across its width, so the wheels on one side sit
  // halfTrack * tan(angle) higher than the other. Once that approaches the
  // suspension travel the car can no longer settle evenly on the surface.
  // Values from tuning.js: trackHalf 0.78 m, maxTravel 0.13 m.
  halfTrackWidth: 0.78,
  suspensionTravel: 0.13,
};

// --- geometry --------------------------------------------------------------

/**
 * Sample a definition's centerline and derive everything the checks need.
 *
 * Deliberately mirrors `Track._sampleCenterline()`. The editor needs these
 * numbers before a Track exists (and without paying for terrain and colliders
 * on every mouse move), so they are computed here from the same
 * `sampleCircuit()` the real track is built from -- same smoothing, same
 * corner relaxation, same elevation filter, so the shape measured is the shape
 * that gets built.
 */
export function trackGeometry(def, samples = SAMPLES) {
  const n = samples;
  const points = sampleCircuit(def.controlPoints, n, ELEVATION_SMOOTH, ROUNDING_PASSES);

  const tangents = new Array(n);
  for (let i = 0; i < n; i++) {
    tangents[i] = new THREE.Vector3()
      .subVectors(points[(i + 1) % n], points[(i - 1 + n) % n])
      .normalize();
  }

  const distances = new Float32Array(n + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    distances[i] = acc;
    acc += points[i].distanceTo(points[(i + 1) % n]);
  }
  distances[n] = acc;

  // Turn rate per metre. 1/curvature is the radius of the circle the road is
  // following at that point.
  const curvature = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = tangents[(i - 1 + n) % n];
    const b = tangents[(i + 1) % n];
    const seg = points[(i - 1 + n) % n].distanceTo(points[(i + 1) % n]);
    curvature[i] = seg > 0
      ? Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)) / seg
      : 0;
  }

  // Gradient is rise over horizontal run, not over 3D arc length: a 10% slope
  // should read 0.10 regardless of how the sampler spaced the points.
  const gradient = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[(i - 1 + n) % n];
    const b = points[(i + 1) % n];
    const run = Math.hypot(b.x - a.x, b.z - a.z);
    gradient[i] = run > 1e-6 ? (b.y - a.y) / run : 0;
  }

  // How fast the gradient itself is changing -- vertical curvature. Measured
  // over a window rather than between neighbours, because at ~1.8 m sample
  // spacing the point-to-point difference is mostly sampling noise.
  const WINDOW = 8;
  const gradientChange = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - WINDOW + n) % n;
    const b = (i + WINDOW) % n;
    let run = 0;
    for (let k = 0; k < WINDOW * 2; k++) {
      const p = points[(a + k) % n];
      const q = points[(a + k + 1) % n];
      run += Math.hypot(q.x - p.x, q.z - p.z);
    }
    gradientChange[i] = run > 1e-6 ? Math.abs(gradient[b] - gradient[a]) / run : 0;
  }

  const halfWidth = def.halfWidth;
  const curbWidth = def.curbWidth ?? 0;

  return {
    points, tangents, curvature, gradient, gradientChange, distances,
    length: acc,
    samples: n,
    halfWidth,
    curbWidth,
    ribbonWidth: halfWidth + curbWidth,
    up: UP,
  };
}

// --- issues ----------------------------------------------------------------

function issue(id, severity, title, detail, extra = {}) {
  return { id, severity, title, detail, at: null, span: null, ...extra };
}

/**
 * The closest approach between two parts of the lap that are not neighbours
 * along it. Returns the worst pair and its separation.
 *
 * O(n^2) over 720 samples is ~260k distance checks -- around a millisecond,
 * which is cheap enough to run on every drag in the editor and not worth the
 * complexity of a spatial index.
 */
function closestApproach(geo) {
  const { points, length, samples: n, ribbonWidth } = geo;
  const needed = ribbonWidth * LIMITS.separationFactor;
  // Ignore neighbours along the lap; only compare genuinely distant sections.
  const skip = Math.ceil((needed * 3) / (length / n));

  let worst = Infinity;
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    for (let j = i + skip; j < n - (i < skip ? skip : 0); j++) {
      const q = points[j];
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d < worst) { worst = d; a = i; b = j; }
    }
  }
  return { worst, a, b, needed, dy: points[b].y - points[a].y };
}

/** Turn angle in degrees at each control point of the raw polygon. */
export function controlTurnAngles(controlPoints) {
  const n = controlPoints.length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const prev = controlPoints[(i - 1 + n) % n];
    const cur = controlPoints[i];
    const next = controlPoints[(i + 1) % n];
    const ix = cur[0] - prev[0], iz = cur[2] - prev[2];
    const ox = next[0] - cur[0], oz = next[2] - cur[2];
    const li = Math.hypot(ix, iz);
    const lo = Math.hypot(ox, oz);
    if (li < 1e-6 || lo < 1e-6) continue;
    const dot = (ix * ox + iz * oz) / (li * lo);
    out[i] = Math.acos(THREE.MathUtils.clamp(dot, -1, 1)) * 180 / Math.PI;
  }
  return out;
}

/**
 * Check a track definition's geometry.
 *
 * Returns `{ ok, errors, warnings, issues, metrics, geometry }`. Errors mean
 * the circuit will be broken to drive; warnings mean it will drive but feel
 * wrong. Every issue carries `at` (a lap progress in 0..1) or `span` where it
 * has a location, so a caller can point at it rather than just describe it.
 *
 * Pass an existing `geometry` to reuse it -- the editor samples once per edit
 * and uses the same result for drawing and for checking.
 */
export function validateTrack(def, geometry = null) {
  const geo = geometry || trackGeometry(def);
  const { samples: n, curvature, gradient, gradientChange, ribbonWidth } = geo;
  const issues = [];

  // --- corner radius -------------------------------------------------------
  let tightest = Infinity;
  let tightestAt = 0;
  for (let i = 0; i < n; i++) {
    if (curvature[i] > 1e-6) {
      const radius = 1 / curvature[i];
      if (radius < tightest) { tightest = radius; tightestAt = i; }
    }
  }
  const minRadius = ribbonWidth * LIMITS.radiusFactor;
  if (tightest < minRadius) {
    issues.push(issue(
      'corner-radius', 'error',
      'Corner tighter than the road can be swept around',
      `${tightest.toFixed(1)} m radius, needs ${minRadius.toFixed(1)} m. ` +
      'Below the road\'s own width the inner edge of the ribbon folds through itself.',
      { at: tightestAt / n, value: tightest, limit: minRadius },
    ));
  }

  // --- self-overlap --------------------------------------------------------
  const near = closestApproach(geo);
  if (near.worst < near.needed) {
    issues.push(issue(
      'self-overlap', 'error',
      'Two parts of the lap overlap',
      `${near.worst.toFixed(1)} m apart, needs ${near.needed.toFixed(1)} m ` +
      `(${near.dy.toFixed(1)} m of height between them). ` +
      'Overlapping ribbons put a roof over the road.',
      { span: [near.a / n, near.b / n], value: near.worst, limit: near.needed },
    ));
  }

  // --- gradient ------------------------------------------------------------
  let steepest = 0;
  let steepestAt = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(gradient[i]) > steepest) { steepest = Math.abs(gradient[i]); steepestAt = i; }
  }
  if (steepest > LIMITS.gradientError) {
    issues.push(issue(
      'gradient', 'error',
      'Slope too steep to climb cleanly',
      `${(steepest * 100).toFixed(0)}% gradient, over the ${(LIMITS.gradientError * 100).toFixed(0)}% limit.`,
      { at: steepestAt / n, value: steepest, limit: LIMITS.gradientError },
    ));
  } else if (steepest > LIMITS.gradientWarn) {
    issues.push(issue(
      'gradient', 'warning',
      'Steep slope',
      `${(steepest * 100).toFixed(0)}% gradient — alpine-pass territory. Driveable, but it will dominate the lap.`,
      { at: steepestAt / n, value: steepest, limit: LIMITS.gradientWarn },
    ));
  }

  // --- gradient change -----------------------------------------------------
  let kink = 0;
  let kinkAt = 0;
  for (let i = 0; i < n; i++) {
    if (gradientChange[i] > kink) { kink = gradientChange[i]; kinkAt = i; }
  }
  if (kink > LIMITS.gradientChangeError) {
    issues.push(issue(
      'gradient-change', 'error',
      'Abrupt change of slope',
      `Gradient swings ${(kink * 1000).toFixed(1)}% per 10 m. The road breaks rather than curves here, ` +
      'which launches the car instead of tilting it.',
      { at: kinkAt / n, value: kink, limit: LIMITS.gradientChangeError },
    ));
  } else if (kink > LIMITS.gradientChangeWarn) {
    issues.push(issue(
      'gradient-change', 'warning',
      'Sharp crest or compression',
      `Gradient swings ${(kink * 1000).toFixed(1)}% per 10 m. Noticeable through the suspension.`,
      { at: kinkAt / n, value: kink, limit: LIMITS.gradientChangeWarn },
    ));
  }

  // --- control points that get relaxed away --------------------------------
  const turns = controlTurnAngles(def.controlPoints);
  const sharp = turns
    .map((deg, i) => ({ deg, i }))
    .filter((t) => t.deg > LIMITS.controlTurnDeg);
  if (sharp.length > 0) {
    const worst = sharp.reduce((a, b) => (a.deg > b.deg ? a : b));
    issues.push(issue(
      'control-relaxed', 'info',
      `${sharp.length} control point${sharp.length > 1 ? 's are' : ' is'} being rounded off`,
      `Sharpest is point ${worst.i} at ${worst.deg.toFixed(0)}°, over the ${LIMITS.controlTurnDeg}° limit. ` +
      'Corner cutting replaces it with two points set back along its own legs, so the road will not ' +
      'pass exactly through where you put it.',
      { points: sharp.map((t) => t.i), value: worst.deg, limit: LIMITS.controlTurnDeg },
    ));
  }

  // --- the closing join ----------------------------------------------------
  //
  // The one corner every circuit in this project has failed on. A closed
  // spline's tangent at the start line is set by the LAST control point, so
  // putting it off the line of the start straight whips the road into a
  // tiny-radius loop right at the join. Worth its own check because the
  // symptom (a kink at 0% progress) is far from the cause (the last point).
  const cps = def.controlPoints;
  if (cps.length >= 3) {
    const last = cps[cps.length - 1];
    const first = cps[0];
    const second = cps[1];
    const inV = [first[0] - last[0], first[2] - last[2]];
    const outV = [second[0] - first[0], second[2] - first[2]];
    const li = Math.hypot(inV[0], inV[1]);
    const lo = Math.hypot(outV[0], outV[1]);
    if (li > 1e-6 && lo > 1e-6) {
      const dot = (inV[0] * outV[0] + inV[1] * outV[1]) / (li * lo);
      const deg = Math.acos(THREE.MathUtils.clamp(dot, -1, 1)) * 180 / Math.PI;
      if (deg > 40) {
        issues.push(issue(
          'closing-join', 'warning',
          'The road arrives at the start line off-line',
          `${deg.toFixed(0)}° between the last leg and the start straight. Move the last control point ` +
          'onto the line of the straight — it sets the tangent there, and off-line it whips the ' +
          'spline into a tight loop at the join.',
          { at: 0, points: [cps.length - 1], value: deg, limit: 40 },
        ));
      }
    }
  }

  // --- banking vs suspension travel ---------------------------------------
  const bankDeg = def.banking?.maxDegrees ?? 0;
  const lift = LIMITS.halfTrackWidth * Math.tan(bankDeg * Math.PI / 180);
  if (lift > LIMITS.suspensionTravel * 0.75) {
    issues.push(issue(
      'banking', 'warning',
      'Banking is steep for the suspension',
      `${bankDeg.toFixed(1)}° tilts one side ${(lift * 1000).toFixed(0)} mm above the other, against ` +
      `${(LIMITS.suspensionTravel * 1000).toFixed(0)} mm of travel. The car stops settling evenly on the surface.`,
      { value: lift, limit: LIMITS.suspensionTravel },
    ));
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  return {
    ok: errors.length === 0,
    issues,
    errors,
    warnings,
    geometry: geo,
    metrics: {
      length: geo.length,
      tightestRadius: tightest,
      minRadius,
      tightestAt: tightestAt / n,
      minSeparation: near.worst,
      neededSeparation: near.needed,
      separationSpan: [near.a / n, near.b / n],
      steepestGradient: steepest,
      steepestAt: steepestAt / n,
      worstGradientChange: kink,
      worstGradientChangeAt: kinkAt / n,
      elevationRange: elevationRange(geo.points),
      controlPoints: def.controlPoints.length,
    },
  };
}

function elevationRange(points) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) { if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; }
  return { min: lo, max: hi, span: hi - lo };
}

/**
 * Per-sample severity, for colouring a centerline by how close it is to
 * folding. 0 = comfortable, 1 = at the limit, >1 = past it. The editor draws
 * this straight onto the plan view, which is what turns "somewhere around 97%
 * of the lap" into a red patch you can see and drag.
 */
export function radiusSeverity(geo) {
  const minRadius = geo.ribbonWidth * LIMITS.radiusFactor;
  const out = new Float32Array(geo.samples);
  for (let i = 0; i < geo.samples; i++) {
    const radius = geo.curvature[i] > 1e-6 ? 1 / geo.curvature[i] : Infinity;
    out[i] = Math.min(2, minRadius / radius);
  }
  return out;
}
