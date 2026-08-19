// Lap and sector timing driven by centerline progress rather than trigger
// volumes. Sectors must be collected in order before a line crossing counts,
// so cutting across the infield can't manufacture a lap.
//
// Best laps survive the session. The whole stated point of the game is the gap
// between your best lap and the one you are on, and a best that dies on reload
// makes that gap meaningless after four minutes -- there is nothing to come
// back to. They are kept per circuit AND per car, because a time set in the
// SC18 tells you nothing about how well you are driving the Alpine.

export const SECTORS = [0.33, 0.66];
const WRAP_HIGH = 0.85;   // progress above this counts as "approaching the line"
const WRAP_LOW = 0.15;

const STORAGE_KEY = 'vroom.bestlaps.v1';

/** Every stored best, as { "circuit:car": seconds }. Empty if unreadable. */
function loadBests() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};   // private browsing, or someone else's JSON in our key
  }
}

export class LapTimer {
  /**
   * @param {string|null} key  circuit + car this session's times belong to,
   *   or null for a session whose times are not worth keeping.
   */
  constructor(key = null) {
    // An unsaved editor layout changes shape every time it is stashed, so a
    // time set on one is not a time on anything -- it would just overwrite
    // itself with times from a different circuit under the same name.
    this.key = key && !key.startsWith('__') ? key : null;
    this.reset();
    if (this.key) {
      const stored = loadBests()[this.key];
      if (typeof stored === 'number' && stored > 0) this.best = stored;
    }
  }

  reset() {
    this.running = false;
    this.current = 0;
    this.last = null;
    this.best = null;
    // Cleared while the computer is driving. Its laps are still timed and
    // shown -- watching what it does is the point of the autopilot -- but they
    // are not yours, so they never take the record.
    this.counting = true;
    this.lapCount = 0;
    this.sectorsHit = new Set();
    this._prevProgress = null;
    this.justCompleted = false;
    // A lap crossing the line both ends one lap and starts the next, and the
    // recorder needs the start edge as much as the finish one.
    this.justStarted = false;
    this.isBest = false;
  }

  /** Call once per frame with the car's progress around the lap (0..1). */
  update(dt, progress, onTrack) {
    this.justCompleted = false;
    this.justStarted = false;
    if (this.running) this.current += dt;

    const prev = this._prevProgress;
    this._prevProgress = progress;
    if (prev === null) return;

    for (let i = 0; i < SECTORS.length; i++) {
      const s = SECTORS[i];
      // Ordinary forward crossing of a sector marker.
      if (prev < s && progress >= s && progress - prev < 0.4) {
        if (i === 0 || this.sectorsHit.has(i - 1)) this.sectorsHit.add(i);
      }
    }

    const crossedLine = prev > WRAP_HIGH && progress < WRAP_LOW;
    if (!crossedLine) return;

    if (this.running && this.sectorsHit.size === SECTORS.length) {
      this.last = this.current;
      this.isBest = this.counting && (this.best === null || this.last < this.best);
      if (this.isBest) {
        this.best = this.last;
        this._persist();
      }
      this.lapCount++;
      this.justCompleted = true;
    }

    // Any line crossing starts (or restarts) a lap, valid or not.
    this.running = true;
    this.current = 0;
    this.justStarted = true;
    this.sectorsHit.clear();
  }

  /**
   * Write the new best out.
   *
   * Read-modify-write rather than keeping the whole table in memory: the game
   * only ever holds one circuit and one car, so anything else in there belongs
   * to a session that is not this one and must survive untouched.
   */
  _persist() {
    if (!this.key) return;
    try {
      const all = loadBests();
      all[this.key] = this.best;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch { /* full, or private browsing -- the lap still stands this session */ }
  }

  /** Invalidate the lap in progress -- used when the car is respawned. */
  invalidate() {
    this.running = false;
    this.current = 0;
    this.sectorsHit.clear();
    this._prevProgress = null;
  }
}

export function formatTime(seconds) {
  if (seconds === null || seconds === undefined) return '--:--.---';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
