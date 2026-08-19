// Your best lap, kept so you can drive against it.
//
// One recording answers all three of the things a driver wants to know:
//
//   the delta bar   how much you are up or down, right now
//   sector splits   where that gap was won or lost
//   the ghost car   what the fast lap actually did, in front of you
//
// They come from the same array because they are the same question asked three
// ways: "at this point on the road, what was the clock?" Storing time against
// PROGRESS rather than against time is what makes that work -- a lap sampled
// on the clock cannot be compared to a lap driven at different speeds, but a
// lap sampled on the road can be compared to any lap around the same road.
//
// Only two numbers per checkpoint are kept: the clock, and how far from the
// centreline the car was. Everything else the ghost needs to be drawn -- where
// that is in the world, which way it points, how high the ground is -- the
// circuit already knows. A recording is therefore about 8 KB, small enough to
// sit in localStorage next to the lap time it belongs to, and it survives a
// reload for the same reason the time does: a best you cannot drive against
// tomorrow is not much of a best.

const STORAGE_KEY = 'vroom.ghost.v1';

// Checkpoints per lap. At 5 km that is a reading every 10 m, which is finer
// than the delta bar can show and finer than the eye can catch the ghost
// jumping between them.
const SAMPLES = 512;

// A progress jump larger than this is the start/finish line going past, not
// driving. Used to throw away the frame that wraps rather than recording a lap
// that appears to run backwards through every checkpoint at once.
const WRAP_JUMP = 0.5;

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** A stored lap: time and lateral offset at each of SAMPLES checkpoints. */
function decode(entry) {
  if (!entry || !Array.isArray(entry.t) || !Array.isArray(entry.lat)) return null;
  if (entry.t.length !== SAMPLES || entry.lat.length !== SAMPLES) return null;
  // A recording whose clock runs backwards is corrupt, and would send the
  // ghost sliding around the circuit the wrong way rather than simply failing.
  for (let i = 1; i < SAMPLES; i++) if (entry.t[i] < entry.t[i - 1]) return null;
  return { t: Float32Array.from(entry.t), lat: Float32Array.from(entry.lat) };
}

export class GhostLap {
  /**
   * @param {string|null} key  the same "circuit:car" the lap times use, so a
   *   ghost can never be replayed onto a circuit it was not driven on.
   */
  constructor(key = null) {
    this.key = key && !key.startsWith('__') ? key : null;
    this.reference = this.key ? decode(readAll()[this.key]) : null;
    this._reset();
  }

  _reset() {
    this._t = new Float32Array(SAMPLES);
    this._lat = new Float32Array(SAMPLES);
    this._filled = 0;          // checkpoints written so far, in order
    this._prev = null;         // { progress, elapsed, lateral } of last frame
    this._recording = false;
  }

  /** True once there is a lap to be measured against. */
  get hasReference() { return this.reference !== null; }

  /** Start recording. Anything half-recorded is thrown away. */
  begin() {
    this._reset();
    this._recording = true;
  }

  /** Stop recording and drop whatever was captured. */
  abandon() {
    this._recording = false;
    this._prev = null;
  }

  /**
   * One frame of the lap in progress.
   *
   * Checkpoints are written by interpolating between this frame and the last,
   * not by taking whichever frame happened to land nearest. At 200 km/h a frame
   * covers 0.9 m, so which side of a checkpoint it falls on is luck -- and luck
   * that lands in the recording comes back as a delta bar that flickers.
   */
  sample(progress, elapsed, lateral) {
    if (!this._recording) return;
    const prev = this._prev;
    this._prev = { progress, elapsed, lateral };
    if (prev === null) return;

    const step = progress - prev.progress;
    if (step <= 0 || step > WRAP_JUMP) return;   // stopped, reversing, or wrapped

    while (this._filled < SAMPLES) {
      const at = this._filled / SAMPLES;
      if (at > progress) break;
      if (at < prev.progress) { this._filled++; continue; }
      const f = (at - prev.progress) / step;
      this._t[this._filled] = prev.elapsed + (elapsed - prev.elapsed) * f;
      this._lat[this._filled] = prev.lateral + (lateral - prev.lateral) * f;
      this._filled++;
    }
  }

  /**
   * Keep the lap just recorded as the one to beat.
   *
   * Refuses a partial recording. A lap can complete having missed checkpoints
   * -- the car was respawned, or the frame rate dropped through a corner -- and
   * a reference with holes in it produces a delta against times that were never
   * driven.
   */
  commit() {
    this._recording = false;
    if (this._filled < SAMPLES) return false;
    this.reference = { t: Float32Array.from(this._t), lat: Float32Array.from(this._lat) };
    if (!this.key) return true;
    try {
      const all = readAll();
      all[this.key] = {
        t: Array.from(this._t, (v) => Math.round(v * 1000) / 1000),
        lat: Array.from(this._lat, (v) => Math.round(v * 100) / 100),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch { /* full, or private browsing -- it still stands this session */ }
    return true;
  }

  /** The reference lap's clock at a point on the road, or null. */
  timeAt(progress) {
    const ref = this.reference;
    if (!ref) return null;
    const x = Math.min(Math.max(progress, 0), 0.999999) * SAMPLES;
    const i = Math.floor(x);
    const j = Math.min(i + 1, SAMPLES - 1);
    return ref.t[i] + (ref.t[j] - ref.t[i]) * (x - i);
  }

  /** How far ahead (+) or behind (-) the reference you are, in seconds. */
  delta(progress, elapsed) {
    const was = this.timeAt(progress);
    return was === null ? null : elapsed - was;
  }

  /** The reference lap's own time, or null. */
  get referenceTime() {
    return this.reference ? this.reference.t[SAMPLES - 1] : null;
  }

  /**
   * Where the ghost is after `elapsed` seconds of its lap.
   *
   * The inverse of timeAt(): the clock is monotonic along the road, so this is
   * a binary search rather than a scan. Returns null once the ghost has
   * finished -- it has gone, and drawing it parked on the line would read as a
   * car stopped in the middle of the circuit.
   */
  poseAt(elapsed) {
    const ref = this.reference;
    if (!ref || elapsed < 0 || elapsed > ref.t[SAMPLES - 1]) return null;
    let lo = 0;
    let hi = SAMPLES - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ref.t[mid] <= elapsed) lo = mid; else hi = mid;
    }
    const span = ref.t[hi] - ref.t[lo];
    const f = span > 1e-6 ? (elapsed - ref.t[lo]) / span : 0;
    return {
      progress: (lo + f) / SAMPLES,
      lateral: ref.lat[lo] + (ref.lat[hi] - ref.lat[lo]) * f,
    };
  }
}

export { SAMPLES as GHOST_SAMPLES };
