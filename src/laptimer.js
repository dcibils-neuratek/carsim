// Lap and sector timing driven by centerline progress rather than trigger
// volumes. Sectors must be collected in order before a line crossing counts,
// so cutting across the infield can't manufacture a lap.

const SECTORS = [0.33, 0.66];
const WRAP_HIGH = 0.85;   // progress above this counts as "approaching the line"
const WRAP_LOW = 0.15;

export class LapTimer {
  constructor() {
    this.reset();
  }

  reset() {
    this.running = false;
    this.current = 0;
    this.last = null;
    this.best = null;
    this.lapCount = 0;
    this.sectorsHit = new Set();
    this._prevProgress = null;
    this.justCompleted = false;
    this.isBest = false;
  }

  /** Call once per frame with the car's progress around the lap (0..1). */
  update(dt, progress, onTrack) {
    this.justCompleted = false;
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
      this.isBest = this.best === null || this.last < this.best;
      if (this.isBest) this.best = this.last;
      this.lapCount++;
      this.justCompleted = true;
    }

    // Any line crossing starts (or restarts) a lap, valid or not.
    this.running = true;
    this.current = 0;
    this.sectorsHit.clear();
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
