// Editor document state: the file being edited, undo history, and export.
//
// The editor works on the FILE-FORMAT object (the merged raw JSON), not on the
// flattened runtime definition. That is deliberate: exporting is then just
// "write out what you have been editing" rather than a reconstruction, and
// there is no chance of an edit surviving in the preview but not in the file.
// The runtime shape is derived from it on demand, which is the direction the
// loader already goes.

import { validateTrackFile, normaliseTrack, mergeDefaults } from '../trackfile.js';

const HISTORY_LIMIT = 120;
const HANDOFF_KEY = 'carsim.editor.track';

function clone(v) { return JSON.parse(JSON.stringify(v)); }

export class EditorDoc {
  /**
   * @param {object} raw       a complete (already merged) track file object
   * @param {object} defaults  the defaults file, used to keep exports sparse
   */
  constructor(raw, defaults) {
    this.raw = clone(raw);
    this.defaults = defaults ? clone(defaults) : null;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;      // snapshot taken at the start of a drag
    this.dirty = false;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) fn(this); }

  // --- history -------------------------------------------------------------
  //
  // Coalescing matters more here than it looks. Dragging a control point fires
  // a mousemove per frame; without begin/commit, one drag would leave sixty
  // undo entries and Ctrl+Z would be useless for the main thing the editor
  // does. `begin()` snapshots once at mousedown, `commit()` pushes that single
  // snapshot at mouseup.

  begin() {
    if (!this.pending) this.pending = clone(this.raw);
  }

  commit(label = 'edit') {
    if (!this.pending) this.pending = clone(this.raw);
    if (JSON.stringify(this.pending) === JSON.stringify(this.raw)) {
      this.pending = null;
      return;
    }
    this.undoStack.push({ raw: this.pending, label });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.pending = null;
    this.dirty = true;
    this._emit();
  }

  /** A single change with no drag around it: snapshot, mutate, push. */
  change(fn, label = 'edit') {
    this.begin();
    fn(this.raw);
    this.commit(label);
  }

  /** Mutate without touching history — for the live part of a drag. */
  touch(fn) {
    fn(this.raw);
    this._emit();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push({ raw: clone(this.raw), label: prev.label });
    this.raw = prev.raw;
    this.dirty = true;
    this._emit();
    return true;
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push({ raw: clone(this.raw), label: next.label });
    this.raw = next.raw;
    this.dirty = true;
    this._emit();
    return true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /**
   * Swap in a different track, keeping this document object identity.
   *
   * Opening an imported file by constructing a second Editor would leave the
   * first one's window listeners bound and its 3D preview still rendering, so
   * the document is replaced in place instead and every view keeps the
   * reference it already holds.
   */
  replace(raw) {
    this.raw = clone(raw);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.pending = null;
    this.dirty = false;
    this._emit();
  }

  // --- derived -------------------------------------------------------------

  /**
   * The runtime definition, or an error if the document is not currently a
   * valid file. Editing passes through invalid states -- a half-typed number,
   * a cleared field -- so this reports rather than throws, and the caller keeps
   * showing the last good state.
   */
  runtime() {
    try {
      return { def: normaliseTrack(validateTrackFile(clone(this.raw), 'editor')), error: null };
    } catch (err) {
      return { def: null, error: err.message };
    }
  }

  get controlPoints() { return this.raw.road.controlPoints; }

  // --- control point operations -------------------------------------------

  movePoint(i, x, y, z) {
    const p = this.raw.road.controlPoints[i];
    if (!p) return;
    if (x !== undefined) p[0] = round(x);
    if (y !== undefined) p[1] = round(y, 2);
    if (z !== undefined) p[2] = round(z);
  }

  /** Insert after index `i`, so a new point lands between i and i+1. */
  insertPoint(i, point) {
    this.change((raw) => {
      raw.road.controlPoints.splice(i + 1, 0,
        [round(point[0]), round(point[1], 2), round(point[2])]);
    }, 'insert point');
    return i + 1;
  }

  deletePoint(i) {
    // Four is the minimum a closed spline can be fitted through; the file
    // validator enforces it too, but failing here means the editor never
    // enters a state it cannot render.
    if (this.raw.road.controlPoints.length <= 4) return false;
    this.change((raw) => { raw.road.controlPoints.splice(i, 1); }, 'delete point');
    return true;
  }

  /** Set a nested field by dotted path, e.g. "road.banking.gain". */
  setField(path, value, label = path) {
    this.change((raw) => {
      const parts = path.split('.');
      let cur = raw;
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
      cur[parts[parts.length - 1]] = value;
    }, label);
  }

  getField(path) {
    let cur = this.raw;
    for (const p of path.split('.')) {
      if (cur === undefined || cur === null) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  // --- export --------------------------------------------------------------

  /**
   * The file to write out: everything that differs from the defaults, and
   * nothing that doesn't.
   *
   * Exporting the fully merged object would work, but it would also turn a
   * 21-line forest.track.json into a 90-line one where every value is restated
   * and a change to the defaults silently stops reaching it. Keeping exports
   * sparse is what keeps the defaults file meaningful.
   */
  exportFile() {
    const out = this.defaults ? sparse(this.raw, this.defaults) : clone(this.raw);
    // Identity always ships, even on the off-chance it matches a default.
    out.format = this.raw.format;
    out.version = this.raw.version;
    out.id = this.raw.id;
    out.name = this.raw.name;
    if (this.raw.tagline) out.tagline = this.raw.tagline;
    if (this.raw.difficulty) out.difficulty = this.raw.difficulty;
    if (this.raw.notes?.length) out.notes = this.raw.notes;
    return orderKeys(out);
  }

  exportJson() {
    return formatTrackJson(this.exportFile());
  }

  /**
   * Stash the current track where the game can pick it up, so "drive it" is a
   * real lap in the real physics rather than a preview. index.html reads this
   * for `?track=__editor`.
   */
  stashForDriving() {
    localStorage.setItem(HANDOFF_KEY, JSON.stringify(this.raw));
  }
}

export function loadStashedTrack() {
  const raw = localStorage.getItem(HANDOFF_KEY);
  if (!raw) return null;
  try {
    return normaliseTrack(validateTrackFile(JSON.parse(raw), 'editor handoff'));
  } catch (err) {
    console.error('stashed editor track could not be loaded:', err.message);
    return null;
  }
}

export const EDITOR_TRACK_ID = '__editor';
export { mergeDefaults };

// --- helpers ---------------------------------------------------------------

function round(v, digits = 1) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Recursively drop anything equal to the corresponding default. */
function sparse(value, defaults) {
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    const d = defaults ? defaults[key] : undefined;
    if (d === undefined) { out[key] = v; continue; }
    if (isPlain(v) && isPlain(d)) {
      const sub = sparse(v, d);
      if (Object.keys(sub).length) out[key] = sub;
    } else if (JSON.stringify(v) !== JSON.stringify(d)) {
      out[key] = v;
    }
  }
  return out;
}

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const KEY_ORDER = [
  'format', 'version', 'id', 'name', 'tagline', 'difficulty', 'notes',
  'road', 'terrain', 'environment', 'scenery',
];

function orderKeys(obj) {
  const out = {};
  for (const k of KEY_ORDER) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
  return out;
}

/**
 * JSON.stringify with the coordinate arrays kept on one line each.
 *
 * The default indenting explodes `[0, 0, -215]` into five lines, which turns a
 * 21-point layout into 105 lines of noise and makes a diff between two
 * versions of a circuit unreadable. Points are the thing you most want to read
 * in a track file, so they get to stay readable.
 */
export function formatTrackJson(obj) {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(
    /\[\s*\n\s*(-?[\d.]+),\s*\n\s*(-?[\d.]+)(?:,\s*\n\s*(-?[\d.]+))?\s*\n\s*\]/g,
    (_, a, b, c) => (c === undefined ? `[${a}, ${b}]` : `[${a}, ${b}, ${c}]`),
  );
}
