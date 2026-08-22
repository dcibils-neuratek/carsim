// Handling assist, for when the input device is a thumb.
//
// This is not the simulation being made dishonest. The physics stays exactly as
// it is; what changes is how much the car asks of the CONTROL, and a thumb on
// glass is a far worse control than a stick. It has no spring returning it to
// centre, no detent telling it where centre is, no force telling you the front
// has gone light, and it is sitting on top of the thing it is trying to look
// at. A car tuned for a control that reports all of that will feel broken on
// one that reports none of it.
//
// So the assist widens the margin the driver has to work in: more lock, held to
// higher speeds, arriving faster, with more grip under it and a hand on the
// slide. The car still understeers when overloaded and still steps out on the
// throttle; it just does those things somewhere a thumb can catch them.
//
// Every value here is a MULTIPLIER, never an absolute, because grip and lock
// are per-car -- the Mini and the SC18 must stay different cars with the assist
// on, and an absolute would flatten them into the same one.

/**
 * What the assist changes, and by how much.
 *
 * `maxAngleHigh` is the one that matters most. At 0.16 rad the car has about
 * nine degrees of lock at speed, which is plenty when you can feel the front
 * loading up and can hold a stick a third of the way over. On a phone it reads
 * as a car that will not turn.
 */
const ASSIST = {
  steering: {
    maxAngleLow: 1.10,        // a bit more lock parking-speed
    maxAngleHigh: 1.65,       // and much more of it at speed -- the big one
    falloffSpeed: 1.30,       // lock bleeds away later
    rateLimit: 1.45,          // a thumb flick actually arrives
    returnRate: 1.20,
    counterSteerAssist: null, // set outright below, not scaled: it starts at 0
  },
  wheels: {
    frictionFront: 1.12,
    frictionRear: 1.12,
  },
};

/** Absolute, because scaling zero gives zero. */
const COUNTER_STEER = 0.35;

export class HandlingAssist {
  constructor(tuning) {
    this.tuning = tuning;
    this.on = false;
    this._saved = null;
  }

  /**
   * Snapshot exactly the keys about to change, and nothing else.
   *
   * TUNING is a live object that the vehicle re-reads every step and the panel
   * mutates as you drag, so a wholesale copy taken here and restored later
   * would also silently undo anything the player changed in between.
   */
  _snapshot() {
    const saved = {};
    for (const [group, keys] of Object.entries(ASSIST)) {
      saved[group] = {};
      for (const key of Object.keys(keys)) saved[group][key] = this.tuning[group][key];
    }
    return saved;
  }

  setOn(want) {
    const next = !!want;
    if (next === this.on) return this.on;

    if (next) {
      this._saved = this._snapshot();
      for (const [group, keys] of Object.entries(ASSIST)) {
        for (const [key, mult] of Object.entries(keys)) {
          if (mult === null) continue;
          this.tuning[group][key] *= mult;
        }
      }
      this.tuning.steering.counterSteerAssist = COUNTER_STEER;
    } else if (this._saved) {
      for (const [group, keys] of Object.entries(this._saved)) {
        for (const [key, value] of Object.entries(keys)) this.tuning[group][key] = value;
      }
      this._saved = null;
    }

    this.on = next;
    return this.on;
  }

  toggle() { return this.setOn(!this.on); }
}
