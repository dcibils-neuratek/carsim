// A race: a fixed number of laps, and a total time at the end of them.
//
// Until now every circuit ran forever. That is the right shape for practice --
// the whole game is the gap between your best lap and the one you are on --
// but it is not a shape you can WIN, and without a finish there is nothing to
// put on a leaderboard and nothing to add up into a championship. Three laps
// and a total gives you all three.
//
// This owns none of the timing. LapTimer already knows what a valid lap is,
// including that you cannot manufacture one by cutting the infield, so a race
// is a small state machine reading its edges: justStarted opens the race,
// justCompleted banks a lap, and the lap after the last one closes it.

export const RACE_LAPS = 3;

export class Race {
  constructor(totalLaps = RACE_LAPS) {
    this.totalLaps = totalLaps;
    this.reset();
  }

  reset() {
    /** 'waiting' before the first line crossing, then 'running', then 'finished'. */
    this.state = 'waiting';
    /** Completed lap times, in order. */
    this.laps = [];
    this.total = 0;
    /** True for the single frame the race ends on, the way LapTimer does it. */
    this.justFinished = false;
    /** Whether the total was set with the player driving, not the autopilot. */
    this.counted = true;
  }

  /** 1-based lap in progress, clamped so a finished race reads N of N. */
  get lapNumber() {
    if (this.state === 'waiting') return 0;
    return Math.min(this.laps.length + 1, this.totalLaps);
  }

  get finished() { return this.state === 'finished'; }

  /** Index of the quickest lap, or -1 if none are banked yet. */
  get bestLapIndex() {
    let best = -1;
    for (let i = 0; i < this.laps.length; i++) {
      if (best === -1 || this.laps[i] < this.laps[best]) best = i;
    }
    return best;
  }

  /**
   * Call once per frame, AFTER lapTimer.update().
   *
   * Reading the timer's edge flags rather than progress directly means a race
   * inherits every rule about what counts as a lap for free -- sectors in
   * order, no wrap-around shortcuts -- and cannot drift out of agreement with
   * the lap counter sitting next to it on the HUD.
   */
  update(lapTimer) {
    this.justFinished = false;
    if (this.state === 'finished') return;

    if (this.state === 'waiting') {
      if (!lapTimer.justStarted) return;
      this.state = 'running';
      // Latched at the start, not read at the end: switching to the autopilot
      // mid-race must not hand the player a time the computer drove, and
      // switching away from it must not launder one either.
      this.counted = lapTimer.counting;
      return;
    }

    if (!lapTimer.justCompleted) return;
    this.laps.push(lapTimer.last);
    this.total += lapTimer.last;
    this.counted = this.counted && lapTimer.counting;
    if (this.laps.length >= this.totalLaps) {
      this.state = 'finished';
      this.justFinished = true;
    }
  }
}
