// Gamepad button bindings.
//
// The mapping used to be constants in input.js, which meant that a pad laying
// its buttons out differently -- or a player who simply wanted the handbrake
// somewhere reachable -- had no recourse. Bindings now live here as data,
// persist to localStorage, and can be rebound at runtime.
//
// Button numbers follow the W3C "standard" gamepad mapping, which is what
// Chrome reports for an Xbox or DualShock pad. Pads that report a different
// mapping still work: the numbers are just indices into pad.buttons, and the
// rebinding screen captures whatever the pad actually sends.

const STORAGE_KEY = 'carsim.bindings.v1';

/** Standard-mapping button indices, for readable defaults. */
export const BTN = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9,
  L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

export const BUTTON_NAMES = {
  0: 'A', 1: 'B', 2: 'X', 3: 'Y',
  4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
  8: 'Back', 9: 'Start', 10: 'L3', 11: 'R3',
  12: 'D-Up', 13: 'D-Down', 14: 'D-Left', 15: 'D-Right',
  16: 'Guide',
};

export function buttonName(index) {
  if (index === null || index === undefined) return '—';
  return BUTTON_NAMES[index] ?? `Btn ${index}`;
}

/**
 * The bindable actions, in the order the rebinding screen shows them.
 *
 * `analog` actions read the button's pressure (triggers give 0..1); everything
 * else is an edge-triggered press. Steering is deliberately absent -- it comes
 * from the left stick, and putting an axis into a button-rebinding flow is a
 * different and much fiddlier problem than this screen is for.
 */
export const ACTIONS = [
  { id: 'throttle', label: 'Throttle', analog: true, hint: 'Best on an analog trigger' },
  { id: 'brake', label: 'Brake / reverse', analog: true, hint: 'Best on an analog trigger' },
  { id: 'handbrake', label: 'Handbrake', analog: true, hint: 'Rear brake — your main drift tool' },
  { id: 'shiftUp', label: 'Shift up' },
  { id: 'shiftDown', label: 'Shift down' },
  { id: 'reset', label: 'Respawn on track' },
  { id: 'camera', label: 'Cycle camera' },
  { id: 'toggleGearbox', label: 'Auto / manual gearbox' },
];

/**
 * Defaults.
 *
 * Gear shifts sit on A and B rather than the shoulder buttons: they are the
 * two most reachable buttons on the pad, and shifting is the thing you do most
 * often after steering and throttle. That frees the shoulders, and the
 * handbrake moves to X where it can actually be reached mid-corner -- on the
 * old layout it shared A with nothing else to press, and was easy to miss.
 */
export const DEFAULT_BINDINGS = {
  throttle: BTN.RT,
  brake: BTN.LT,
  handbrake: BTN.X,
  shiftUp: BTN.A,
  shiftDown: BTN.B,
  reset: BTN.START,
  camera: BTN.Y,
  toggleGearbox: BTN.BACK,
};

/**
 * Menu navigation, deliberately NOT rebindable.
 *
 * These have to work before the player has reached anything that could rebind
 * them, so they stay on the conventional buttons. A pad that cannot drive the
 * menu cannot get to the screen that would fix it.
 */
export const MENU = {
  up: [BTN.UP], down: [BTN.DOWN], left: [BTN.LEFT], right: [BTN.RIGHT],
  confirm: [BTN.A, BTN.START],
  back: [BTN.B],
};

export class Bindings {
  constructor() {
    this.map = { ...DEFAULT_BINDINGS };
    this.load();
  }

  get(action) { return this.map[action]; }

  /**
   * Bind an action to a button, clearing anything else that held it.
   *
   * Two actions on one button is nearly always a mistake and is miserable to
   * diagnose from the driver's seat, so the previous owner is unbound and the
   * screen shows it as unset rather than silently double-firing.
   */
  set(action, button) {
    for (const [key, value] of Object.entries(this.map)) {
      if (key !== action && value === button) this.map[key] = null;
    }
    this.map[action] = button;
    this.save();
  }

  clear(action) {
    this.map[action] = null;
    this.save();
  }

  reset() {
    this.map = { ...DEFAULT_BINDINGS };
    this.save();
    return this.map;
  }

  /** Which actions currently have no button. */
  unbound() {
    return ACTIONS.filter((a) => this.map[a.id] === null || this.map[a.id] === undefined);
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      // Only accept keys that still exist, so a saved layout survives the
      // action list gaining or losing an entry.
      for (const action of ACTIONS) {
        if (action.id in saved) {
          const v = saved[action.id];
          this.map[action.id] = (v === null || Number.isInteger(v)) ? v : this.map[action.id];
        }
      }
    } catch (err) {
      console.warn('could not restore gamepad bindings:', err);
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.map));
    } catch { /* private browsing */ }
  }
}
