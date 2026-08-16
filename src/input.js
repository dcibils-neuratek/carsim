// Gamepad (primary) and keyboard (fallback) input.
//
// Chrome does not expose a connected pad until the user presses a button on it,
// which is why the boot screen waits for one. Mappings vary between pads, so
// the raw axis/button state is surfaced in the debug panel for diagnosis.

import { TUNING } from './tuning.js';
import { Bindings, MENU } from './bindings.js';

const KEY_STEER_RATE = 3.2;   // how fast a key ramps the virtual stick
const KEY_RETURN_RATE = 5.0;
const KEY_PEDAL_RATE = 4.5;

export class Input {
  constructor() {
    this.state = {
      steer: 0, steerRaw: 0, throttle: 0, brake: 0, handbrake: 0,
      lookX: 0, lookY: 0,
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

    // Which pad button does what. Data rather than constants, so the handbrake
    // can live somewhere the player can actually reach.
    this.bindings = new Bindings();
    // When set, the next button press is captured for rebinding instead of
    // being treated as a control. See beginCapture().
    this._capture = null;

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
      s.lookX = 0; s.lookY = 0;
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
      if (i === null || i === undefined) return 0;
      const b = pad.buttons[i];
      if (!b) return 0;
      return typeof b === 'object' ? b.value : b;
    };
    const pressed = (i) => btn(i) > 0.5;
    const edge = (i) => pressed(i) && !((this._prevButtons[i] || 0) > 0.5);
    const bound = (action) => this.bindings.get(action);

    // Rebinding: swallow the press so the car does not lurch while the player
    // is assigning a button.
    if (this._capture) {
      for (let i = 0; i < pad.buttons.length; i++) {
        if (edge(i)) {
          const done = this._capture;
          this._capture = null;
          this._prevButtons = this.raw.buttons.slice();
          done(i);
          break;
        }
      }
      this._prevButtons = this.raw.buttons.slice();
      s.throttle = 0; s.brake = 0; s.handbrake = 0; s.steer = 0; s.steerRaw = 0;
      return;
    }

    // Keep the pre-curve value too: seeing raw against curved is how you
    // tell a deadzone problem from a response-curve problem.
    s.steerRaw = pad.axes[0] || 0;
    s.steer = applySteerCurve(s.steerRaw);

    let throttle = btn(bound('throttle'));
    let brake = btn(bound('brake'));

    // Some pads (and some browsers) report triggers as axes in -1..1 rather
    // than as analog buttons. If the trigger buttons look dead but a plausible
    // trigger axis is live, use that instead.
    if (pad.mapping !== 'standard' && throttle === 0 && brake === 0) {
      const axisTrigger = (i) => (pad.axes[i] === undefined ? 0 : (pad.axes[i] + 1) / 2);
      throttle = axisTrigger(5);
      brake = axisTrigger(4);
    }

    // Right stick, for looking around the car. Axes 2/3 on a standard pad.
    s.lookX = pad.axes[2] || 0;
    s.lookY = pad.axes[3] || 0;

    s.throttle = clamp01(throttle);
    s.brake = clamp01(brake);
    s.handbrake = clamp01(btn(bound('handbrake')));

    s.shiftUp = edge(bound('shiftUp'));
    s.shiftDown = edge(bound('shiftDown'));
    s.reset = edge(bound('reset'));
    s.camera = edge(bound('camera'));
    s.toggleGearbox = edge(bound('toggleGearbox'));

    this._prevButtons = this.raw.buttons.slice();

    if (s.throttle > 0.05 || s.brake > 0.05 || Math.abs(pad.axes[0] || 0) > 0.2) {
      this._anyInputSeen = true;
    }
    for (let i = 0; i < pad.buttons.length; i++) {
      if (pressed(i)) this._anyInputSeen = true;
    }
  }

  /**
   * Capture the next pad button press and hand it to `callback`.
   *
   * Used by the rebinding screen. While a capture is pending every control is
   * held at zero, because otherwise assigning the throttle means flooring it.
   */
  beginCapture(callback) { this._capture = callback; }
  cancelCapture() { this._capture = null; }
  get capturing() { return this._capture !== null; }

  /**
   * One-shot menu directions and confirm/back, for driving the UI with a pad.
   *
   * Separate from the driving controls and deliberately not rebindable: these
   * have to work before the player can reach the screen that would rebind
   * them. Returns nulls when no pad is attached.
   */
  readMenu() {
    const pad = this._findGamepad();
    const out = { up: false, down: false, left: false, right: false, confirm: false, back: false, pad: !!pad };
    if (!pad || this._capture) return out;

    const value = (i) => {
      const b = pad.buttons[i];
      if (!b) return 0;
      return typeof b === 'object' ? b.value : b;
    };
    const edge = (list) => list.some(
      (i) => value(i) > 0.5 && !((this._menuPrev?.[i] || 0) > 0.5),
    );

    // The left stick nudges the selection too, treated as a d-pad with a big
    // deadzone so a resting thumb cannot walk the menu on its own.
    const ax = pad.axes[0] || 0;
    const ay = pad.axes[1] || 0;
    const stick = { up: ay < -0.6, down: ay > 0.6, left: ax < -0.6, right: ax > 0.6 };
    const stickEdge = (dir) => stick[dir] && !this._menuStick?.[dir];

    out.up = edge(MENU.up) || stickEdge('up');
    out.down = edge(MENU.down) || stickEdge('down');
    out.left = edge(MENU.left) || stickEdge('left');
    out.right = edge(MENU.right) || stickEdge('right');
    out.confirm = edge(MENU.confirm);
    out.back = edge(MENU.back);

    this._menuPrev = pad.buttons.map((b) => (typeof b === 'object' ? b.value : b));
    this._menuStick = stick;
    if (out.up || out.down || out.left || out.right || out.confirm) this._anyInputSeen = true;
    return out;
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
