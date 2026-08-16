// Gamepad (primary) and keyboard (fallback) input.
//
// Chrome does not expose a connected pad until the user presses a button on it,
// which is why the boot screen waits for one. Mappings vary between pads, so
// the raw axis/button state is surfaced in the debug panel for diagnosis.

import { TUNING } from './tuning.js';

// Standard mapping. Anything reporting mapping !== 'standard' falls back to
// scanning for analog triggers among the axes.
const BTN = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9,
};

const KEY_STEER_RATE = 3.2;   // how fast a key ramps the virtual stick
const KEY_RETURN_RATE = 5.0;
const KEY_PEDAL_RATE = 4.5;

export class Input {
  constructor() {
    this.state = {
      steer: 0, steerRaw: 0, throttle: 0, brake: 0, handbrake: 0,
      shiftUp: false, shiftDown: false,
      reset: false, camera: false, toggleGearbox: false,
      source: 'none',
    };

    this.keys = new Set();
    this.gamepadIndex = null;
    this.gamepadId = '';
    this.raw = { axes: [], buttons: [] };

    // Virtual analog values driven by the keyboard.
    this.kSteer = 0;
    this.kThrottle = 0;
    this.kBrake = 0;

    this._prevButtons = [];
    this._prevKeys = new Set();
    this._anyInputSeen = false;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this._anyInputSeen = true;
      // Don't let the browser scroll the page out from under the canvas.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
      this.gamepadId = e.gamepad.id;
      this._anyInputSeen = true;
      console.log(`gamepad connected: ${e.gamepad.id} (mapping: ${e.gamepad.mapping || 'non-standard'})`);
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.gamepadIndex === e.gamepad.index) {
        this.gamepadIndex = null;
        this.gamepadId = '';
      }
    });
  }

  /** True once the player has pressed anything -- used to dismiss the boot screen. */
  get ready() {
    return this._anyInputSeen || this._findGamepad() !== null;
  }

  _findGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (this.gamepadIndex !== null && pads[this.gamepadIndex]) return pads[this.gamepadIndex];
    for (const pad of pads) {
      if (pad && pad.connected) {
        this.gamepadIndex = pad.index;
        this.gamepadId = pad.id;
        return pad;
      }
    }
    return null;
  }

  update(dt) {
    const s = this.state;
    s.shiftUp = s.shiftDown = s.reset = s.camera = s.toggleGearbox = false;

    const pad = this._findGamepad();
    if (pad) {
      this._readGamepad(pad, s);
      s.source = 'gamepad';
    } else if (s.source !== 'keyboard') {
      s.source = 'keyboard';
      s.steer = 0; s.steerRaw = 0; s.throttle = 0; s.brake = 0; s.handbrake = 0;
    }

    // The keyboard stays live even with a pad attached, so you can nudge the
    // car from the desk without unplugging anything.
    this._readKeyboard(dt, s, !!pad);

    this._prevKeys = new Set(this.keys);
    return s;
  }

  _readGamepad(pad, s) {
    this.raw.axes = Array.from(pad.axes);
    this.raw.buttons = pad.buttons.map((b) => (typeof b === 'object' ? b.value : b));

    const btn = (i) => {
      const b = pad.buttons[i];
      if (!b) return 0;
      return typeof b === 'object' ? b.value : b;
    };
    const pressed = (i) => btn(i) > 0.5;
    const edge = (i) => pressed(i) && !((this._prevButtons[i] || 0) > 0.5);

    // Keep the pre-curve value too: seeing raw against curved is how you
    // tell a deadzone problem from a response-curve problem.
    s.steerRaw = pad.axes[0] || 0;
    s.steer = applySteerCurve(s.steerRaw);

    let throttle = btn(BTN.RT);
    let brake = btn(BTN.LT);

    // Some pads (and some browsers) report triggers as axes in -1..1 rather
    // than as analog buttons. If the trigger buttons look dead but a plausible
    // trigger axis is live, use that instead.
    if (pad.mapping !== 'standard' && throttle === 0 && brake === 0) {
      const axisTrigger = (i) => (pad.axes[i] === undefined ? 0 : (pad.axes[i] + 1) / 2);
      throttle = axisTrigger(5);
      brake = axisTrigger(4);
    }

    s.throttle = clamp01(throttle);
    s.brake = clamp01(brake);
    s.handbrake = clamp01(btn(BTN.A));

    s.shiftUp = edge(BTN.RB);
    s.shiftDown = edge(BTN.LB);
    s.reset = edge(BTN.START);
    s.camera = edge(BTN.Y);
    s.toggleGearbox = edge(BTN.BACK);

    this._prevButtons = this.raw.buttons.slice();

    if (s.throttle > 0.05 || s.brake > 0.05 || Math.abs(pad.axes[0] || 0) > 0.2) {
      this._anyInputSeen = true;
    }
    for (let i = 0; i < pad.buttons.length; i++) {
      if (pressed(i)) this._anyInputSeen = true;
    }
  }

  _readKeyboard(dt, s, hasGamepad) {
    const held = (code) => this.keys.has(code);
    const tapped = (code) => this.keys.has(code) && !this._prevKeys.has(code);

    const left = held('KeyA') || held('ArrowLeft');
    const right = held('KeyD') || held('ArrowRight');
    const gas = held('KeyW') || held('ArrowUp');
    const stop = held('KeyS') || held('ArrowDown');

    // Ramp toward the target instead of snapping, so keyboard driving keeps at
    // least some of the proportional feel the stick gives you.
    const target = (right ? 1 : 0) - (left ? 1 : 0);
    const rate = target === 0 ? KEY_RETURN_RATE : KEY_STEER_RATE;
    this.kSteer = approach(this.kSteer, target, rate * dt);
    this.kThrottle = approach(this.kThrottle, gas ? 1 : 0, KEY_PEDAL_RATE * dt);
    this.kBrake = approach(this.kBrake, stop ? 1 : 0, KEY_PEDAL_RATE * dt);

    if (!hasGamepad) {
      s.steerRaw = this.kSteer;
      s.steer = applySteerCurve(this.kSteer);
      s.throttle = this.kThrottle;
      s.brake = this.kBrake;
      s.handbrake = held('Space') ? 1 : 0;
    } else {
      // With a pad attached the keyboard can only add, never cancel.
      if (Math.abs(this.kSteer) > 0.01) {
        s.steerRaw = this.kSteer;
        s.steer = applySteerCurve(this.kSteer);
      }
      s.throttle = Math.max(s.throttle, this.kThrottle);
      s.brake = Math.max(s.brake, this.kBrake);
      s.handbrake = Math.max(s.handbrake, held('Space') ? 1 : 0);
    }

    if (tapped('ShiftLeft') || tapped('ShiftRight')) s.shiftUp = true;
    if (tapped('ControlLeft') || tapped('ControlRight')) s.shiftDown = true;
    if (tapped('KeyR')) s.reset = true;
    if (tapped('KeyC')) s.camera = true;
    if (tapped('KeyM')) s.toggleGearbox = true;
  }

  describe() {
    if (this.gamepadId) return this.gamepadId.slice(0, 40);
    return this.state.source === 'keyboard' ? 'keyboard' : 'none';
  }
}

// Deadzone, then x*|x|^e. The exponent gives fine control near center without
// costing any lock at full deflection -- the thing that makes a 24 mm stick
// usable for steering at all.
function applySteerCurve(rawValue) {
  const { deadzone, inputExponent } = TUNING.steering;
  const sign = Math.sign(rawValue);
  const mag = Math.abs(rawValue);
  if (mag < deadzone) return 0;
  const scaled = (mag - deadzone) / (1 - deadzone);
  return sign * Math.pow(scaled, 1 + inputExponent);
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function approach(current, target, maxDelta) {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}
