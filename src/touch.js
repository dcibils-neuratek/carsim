// Touch controls.
//
// The game had two input sources, both of which need hardware a phone does not
// have. On a phone it loaded, let you pick a circuit, and then handed you a car
// you could not steer -- which reads as broken rather than as unsupported.
//
// Steering is a RELATIVE analog pad, not a fixed wheel or a pair of arrows.
// Put a thumb down anywhere in the left half and the point it lands becomes
// centre; sliding sideways from there steers in proportion. Anywhere is the
// important word: a fixed on-screen stick has to be found before it can be
// used, and finding it means looking down, and looking down at 200 km/h is
// what you were trying to avoid. A relative pad is wherever your thumb already
// is.
//
// Pedals are two buttons on the right, thumb-sized and far apart. They are
// digital -- held or not -- because an analog pedal needs a slider, a slider
// needs precision, and precision is what a thumb on glass does not have. The
// car's own throttle ramp does the smoothing that a real trigger would.

import { applySteerCurve } from './input.js';

/** How far the thumb travels for full lock, as a fraction of the short edge. */
const STEER_TRAVEL = 0.30;

/** Ramp rates, matching the keyboard's so a touch car drives like a key car. */
const PEDAL_RATE = 4.5;
const RETURN_RATE = 5.0;

/**
 * Is this worth showing at all?
 *
 * Touch points rather than screen size or user agent. A small window on a
 * desktop is still a keyboard, a large tablet is still a thumb, and the user
 * agent has been lying about both for twenty years. Laptops with touchscreens
 * report touch AND have a keyboard, which is why this only decides whether the
 * controls are AVAILABLE -- the keyboard stays live either way.
 */
export function touchLikely() {
  return (navigator.maxTouchPoints ?? 0) > 0
    && window.matchMedia('(pointer: coarse)').matches;
}

export class TouchControls {
  /**
   * @param {HTMLElement} root  a container inside #hud
   */
  constructor(root) {
    this.el = root;
    this.enabled = false;
    this.active = false;          // true once a finger has actually been used

    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = 0;

    // Held state per control, keyed by pointerId so two thumbs never fight.
    this._steerId = null;
    this._steerOrigin = 0;
    this._steerTarget = 0;
    this._held = { throttle: new Set(), brake: new Set(), handbrake: new Set() };

    this._build();
  }

  _build() {
    this.el.innerHTML = `
      <div class="tPad" data-t="steer"><span class="tHint">STEER</span><i class="tKnob"></i></div>
      <div class="tCol">
        <button class="tBtn tBrake" data-t="brake" type="button">BRAKE</button>
        <button class="tBtn tGas" data-t="throttle" type="button">GO</button>
      </div>
      <button class="tBtn tHand" data-t="handbrake" type="button">HAND</button>
      <button class="tMenuBtn" type="button" aria-label="options">&#8942;</button>
      <div class="tMenu"></div>`;

    this.knob = this.el.querySelector('.tKnob');
    this.menu = this.el.querySelector('.tMenu');
    this.menuBtn = this.el.querySelector('.tMenuBtn');
    this.menuBtn.addEventListener('click', () => this._toggleMenu());
    const pad = this.el.querySelector('.tPad');

    // Pointer events rather than touch events: one code path covers finger,
    // stylus and a mouse on a touchscreen laptop, and it gives pointerId for
    // free, which is what keeps two thumbs from overwriting each other.
    pad.addEventListener('pointerdown', (e) => {
      if (this._steerId !== null) return;
      this._steerId = e.pointerId;
      this._steerOrigin = e.clientX;
      this._steerTarget = 0;
      this.active = true;
      pad.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    pad.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._steerId) return;
      const travel = Math.min(window.innerWidth, window.innerHeight) * STEER_TRAVEL;
      this._steerTarget = clamp((e.clientX - this._steerOrigin) / travel, -1, 1);
      e.preventDefault();
    });
    const release = (e) => {
      if (e.pointerId !== this._steerId) return;
      this._steerId = null;
      this._steerTarget = 0;
    };
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);

    for (const btn of this.el.querySelectorAll('.tBtn')) {
      const key = btn.dataset.t;
      btn.addEventListener('pointerdown', (e) => {
        this._held[key].add(e.pointerId);
        this.active = true;
        btn.classList.add('on');
        btn.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      const off = (e) => {
        this._held[key].delete(e.pointerId);
        if (!this._held[key].size) btn.classList.remove('on');
      };
      btn.addEventListener('pointerup', off);
      btn.addEventListener('pointercancel', off);
      // A thumb that slides off a button must release it, or the throttle
      // sticks on and the car drives itself into the scenery.
      btn.addEventListener('pointerleave', off);
    }
  }

  /**
   * Everything that was only reachable by pressing a key.
   *
   * Every toggle in this game -- the frame counter, the headlights, the
   * camera, a respawn -- is bound to a letter, which on a phone means it does
   * not exist. Handed in as a map rather than imported, because touch.js has
   * no business knowing what a headlight is; it knows how to put a label under
   * a thumb.
   *
   * @param {{label: string, run: () => void}[]} actions
   */
  setActions(actions) {
    this._actions = actions;
    this.menu.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      b.addEventListener('click', () => {
        a.run();
        // Anything that toggles wants its label refreshed; anything that acts
        // wants the menu out of the way. Closing covers both.
        this._toggleMenu(false);
      });
      this.menu.append(b);
    }
  }

  _toggleMenu(force) {
    const open = force ?? !this.menu.classList.contains('on');
    this.menu.classList.toggle('on', open);
    this.menuBtn.classList.toggle('on', open);
    // Hands off the wheel while the menu is up, or the car keeps whatever
    // input was held when it opened.
    if (open) this.reset();
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.el.classList.toggle('on', this.enabled);
    if (!this.enabled) this.reset();
  }

  reset() {
    this.steer = this.throttle = this.brake = this.handbrake = 0;
    this._steerId = null;
    this._steerTarget = 0;
    for (const k of Object.keys(this._held)) this._held[k].clear();
    for (const b of this.el.querySelectorAll('.tBtn')) b.classList.remove('on');
  }

  /**
   * Advance the analog values. Call once a frame before reading them.
   *
   * Steering follows the thumb directly rather than ramping: the thumb IS the
   * analog axis, and putting a filter between them makes the car feel like it
   * is arguing with you. The pedals ramp, because they are buttons pretending
   * to be pedals and a step from nothing to full throttle is a wheelspin.
   */
  update(dt) {
    if (!this.enabled) return;

    this.steer = this._steerTarget;
    if (this.knob) {
      this.knob.style.transform = `translate(-50%, -50%) translateX(${(this.steer * 42).toFixed(1)}px)`;
      this.knob.classList.toggle('on', this._steerId !== null);
    }

    const ramp = (value, wanted) => {
      const rate = wanted > value ? PEDAL_RATE : RETURN_RATE;
      const step = rate * dt;
      return wanted > value ? Math.min(wanted, value + step) : Math.max(wanted, value - step);
    };
    this.throttle = ramp(this.throttle, this._held.throttle.size ? 1 : 0);
    this.brake = ramp(this.brake, this._held.brake.size ? 1 : 0);
    this.handbrake = this._held.handbrake.size ? 1 : 0;
  }

  /** Fold into the shared input state, taking over only where a finger is down. */
  apply(state) {
    if (!this.enabled || !this.active) return false;
    const touching = this._steerId !== null
      || this._held.throttle.size || this._held.brake.size || this._held.handbrake.size;

    state.steerRaw = this.steer;
    state.steer = applySteerCurve(this.steer);
    state.throttle = Math.max(state.throttle, this.throttle);
    state.brake = Math.max(state.brake, this.brake);
    state.handbrake = Math.max(state.handbrake, this.handbrake);
    if (touching) state.source = 'touch';
    return true;
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
