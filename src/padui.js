// The gamepad binding screen.
//
// Openable with a key AND navigable with the pad, because the player most
// likely to need it is one whose pad does not do what they expect -- telling
// them to use the keyboard to fix their gamepad is exactly the wrong answer.
//
// Rebinding is press-to-bind: pick an action, press a button, done. That works
// on pads Chrome does not report as "standard" too, since it captures whatever
// index the pad actually sends rather than assuming a layout.

import { ACTIONS, buttonName } from './bindings.js';

/**
 * Match a key by physical code, falling back to the character.
 *
 * `event.code` is the right thing to test -- it is layout-independent -- but
 * it is not always populated. Some remote-desktop and automation paths deliver
 * a keydown with `key` set and `code` empty, and a screen that exists to
 * rescue broken input should not itself be unreachable when that happens.
 */
function isKey(e, code, char) {
  if (e.code) return e.code === code;
  return typeof e.key === 'string' && e.key.toLowerCase() === char;
}

export class PadPanel {
  constructor(input) {
    this.input = input;
    this.el = document.getElementById('padPanel');
    this.rowsEl = document.getElementById('padRows');
    this.nameEl = document.getElementById('padName');
    this.selected = 0;
    this.listening = null;    // action id awaiting a button press
    this.rows = [];

    this._build();
    this.syncHelp();

    document.getElementById('padClose').addEventListener('click', () => this.close());
    document.getElementById('padReset').addEventListener('click', () => {
      this.input.bindings.reset();
      this.refresh();
    });

    // The panel owns its own key handling rather than borrowing the game's,
    // because it has to work on the menu screen too -- which exists before the
    // game's input handling is set up, and is exactly where someone with a
    // misbehaving pad will be stuck.
    window.addEventListener('keydown', (e) => {
      if (this.isOpen) { this.handleKey(e); e.preventDefault(); return; }
      if (isKey(e, 'KeyB', 'b')) { this.open(); e.preventDefault(); }
    });

    // Polled rather than event-driven: the panel has to respond to a pad that
    // Chrome only reveals once a button is pressed.
    const tick = () => {
      requestAnimationFrame(tick);
      if (this.isOpen) this._poll();
    };
    tick();
  }

  get isOpen() { return this.el.classList.contains('on'); }

  open() {
    this.el.classList.add('on');
    this.refresh();
  }

  close() {
    this.input.cancelCapture();
    this.listening = null;
    this.el.classList.remove('on');
  }

  toggle() { this.isOpen ? this.close() : this.open(); }

  _build() {
    this.rowsEl.innerHTML = '';
    this.rows = ACTIONS.map((action, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML =
        `<span class="lbl">${action.label}` +
        (action.hint ? `<span class="hint">${action.hint}</span>` : '') +
        `</span><span class="key"></span>`;
      row.addEventListener('click', () => { this.selected = i; this._listen(); });
      row.addEventListener('mouseenter', () => { this.selected = i; this.refresh(); });
      this.rowsEl.appendChild(row);
      return row;
    });
  }

  /**
   * Write the current bindings into the on-screen help.
   *
   * Called whenever they change, so the corner of the screen can never end up
   * telling you to press a button that does something else now.
   */
  syncHelp() {
    for (const el of document.querySelectorAll('#help [data-bind]')) {
      el.textContent = buttonName(this.input.bindings.get(el.dataset.bind));
    }
  }

  refresh() {
    this.syncHelp();
    const pad = this.input._findGamepad();
    this.nameEl.textContent = pad
      ? `${pad.id.slice(0, 52)}${pad.mapping === 'standard' ? '' : ' (non-standard mapping)'}`
      : 'no pad detected — press a button on it';

    ACTIONS.forEach((action, i) => {
      const row = this.rows[i];
      const button = this.input.bindings.get(action.id);
      const bound = button !== null && button !== undefined;
      row.classList.toggle('sel', i === this.selected && this.listening === null);
      row.classList.toggle('listening', this.listening === action.id);
      row.classList.toggle('unbound', !bound);
      row.querySelector('.key').textContent =
        this.listening === action.id ? 'press…' : (bound ? buttonName(button) : 'unbound');
    });
  }

  /** Arm capture for the highlighted action. */
  _listen() {
    const action = ACTIONS[this.selected];
    this.listening = action.id;
    this.refresh();
    this.input.beginCapture((button) => {
      this.input.bindings.set(action.id, button);
      this.listening = null;
      this.refresh();
    });
  }

  _poll() {
    // While waiting for a button, menu navigation has to stay out of the way
    // or the same press that binds an action also moves the cursor.
    if (this.listening !== null) { this.refresh(); return; }

    const m = this.input.readMenu();
    if (m.pad) {
      const before = this.selected;
      if (m.up) this.selected--;
      if (m.down) this.selected++;
      this.selected = Math.max(0, Math.min(ACTIONS.length - 1, this.selected));
      if (m.confirm) { this._listen(); return; }
      if (m.back) { this.close(); return; }
      if (before !== this.selected) this.refresh();
    }
    this.refresh();
  }

  /** Keyboard driving of the same panel, for when no pad is attached. */
  handleKey(e) {
    if (!this.isOpen) return false;
    if (isKey(e, 'Escape', 'escape') || isKey(e, 'KeyB', 'b')) { this.close(); return true; }
    if (isKey(e, 'ArrowUp', 'arrowup')) {
      this.selected = Math.max(0, this.selected - 1);
      this.refresh();
      return true;
    }
    if (isKey(e, 'ArrowDown', 'arrowdown')) {
      this.selected = Math.min(ACTIONS.length - 1, this.selected + 1);
      this.refresh();
      return true;
    }
    if (isKey(e, 'Enter', 'enter') || isKey(e, 'Space', ' ')) { this._listen(); return true; }
    return true;   // swallow everything else so the car cannot be driven blind
  }
}
