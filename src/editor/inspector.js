// The property panel: everything about a track that isn't a control point.
//
// Driven by a field table rather than hand-written markup, so adding a field
// to the track format means adding one row here. Every field carries its own
// range and step, which is the difference between a panel you can drag values
// on and one where you have to already know what a sensible number looks like.

import { formatColor, parseColor } from '../trackfile.js';

/**
 * `hint` is the reasoning behind a value, shown on hover. Most of these are
 * lessons this project paid for once already, and they are far more useful
 * next to the slider than buried in a comment.
 */
const SECTIONS = [
  {
    title: 'Identity',
    fields: [
      { path: 'name', label: 'Name', type: 'text' },
      { path: 'tagline', label: 'Tagline', type: 'text' },
      { path: 'difficulty', label: 'Difficulty', type: 'text' },
    ],
  },
  {
    title: 'Road',
    fields: [
      { path: 'road.halfWidth', label: 'Half width', unit: 'm', min: 2, max: 12, step: 0.1,
        hint: 'The road is twice this wide. Corner radius has to stay above 1.5x (halfWidth + curbWidth) or the inner edge folds through itself.' },
      { path: 'road.curbWidth', label: 'Curb width', unit: 'm', min: 0, max: 4, step: 0.1,
        hint: 'Curb strip outside the asphalt, flush with it so you can drive back on after running wide.' },
      { path: 'road.surface.roadGrip', label: 'Road grip', min: 0.3, max: 1.3, step: 0.01,
        hint: '1.0 is dry tarmac. Snow runs 0.55, which is what makes stopping the hard part there.' },
      { path: 'road.surface.grassGrip', label: 'Grass grip', min: 0.1, max: 1, step: 0.01,
        hint: 'Off-track grip. Low values make running wide expensive but should stay recoverable.' },
      { path: 'road.banking.gain', label: 'Banking gain', min: 0, max: 400, step: 5,
        hint: 'Converts corner curvature into cross-slope. Higher means corners tip in harder.' },
      { path: 'road.banking.maxDegrees', label: 'Banking max', unit: '°', min: 0, max: 12, step: 0.1,
        hint: 'Ceiling on the above. Beyond ~5.5° the wheel height difference across the road approaches the suspension travel and the car stops settling evenly.' },
    ],
  },
  {
    title: 'Terrain',
    fields: [
      { path: 'terrain.hills.amplitude', label: 'Hill height', min: 0, max: 8, step: 0.1,
        hint: 'Background undulation away from the road. Does not affect the racing surface.' },
      { path: 'terrain.hills.scale', label: 'Hill scale', min: 0.2, max: 4, step: 0.1,
        hint: 'Horizontal wavelength of the undulation. Higher is broader, smoother country.' },
      { path: 'terrain.envelope.slope', label: 'Verge slope', min: 0.02, max: 0.5, step: 0.01,
        hint: 'How fast terrain climbs away from the road. On a circuit that doubles back over itself, too shallow digs a trench beside the road; too steep chords the heightfield above the asphalt over a crest. Mountains needs 0.20.' },
      { path: 'terrain.envelope.roadClearance', label: 'Road clearance', unit: 'm', min: 0.05, max: 0.8, step: 0.01,
        hint: 'How far terrain sits below the road. Raise it on circuits with abrupt gradient changes.' },
    ],
  },
  {
    title: 'Environment',
    fields: [
      { path: 'environment.fog.near', label: 'Fog near', unit: 'm', min: 20, max: 800, step: 10 },
      { path: 'environment.fog.far', label: 'Fog far', unit: 'm', min: 100, max: 2500, step: 25 },
      { path: 'environment.sun.intensity', label: 'Sun', min: 0.2, max: 5, step: 0.1 },
      { path: 'environment.sun.color', label: 'Sun colour', type: 'color' },
    ],
  },
  {
    title: 'Scenery',
    fields: [
      { path: 'scenery.trees.count', label: 'Trees', min: 0, max: 3000, step: 20 },
      { path: 'scenery.trees.clearance', label: 'Tree clearance', unit: 'm', min: 4, max: 40, step: 1,
        hint: 'How far trees stay off the road. Low values crowd the verges and shorten sightlines.' },
      { path: 'scenery.ridges.count', label: 'Ridges', min: 0, max: 160, step: 2 },
      { path: 'scenery.ridges.radius', label: 'Ridge distance', unit: 'm', min: 300, max: 2000, step: 50 },
      { path: 'scenery.posts.spacing', label: 'Post spacing', unit: 'm', min: 4, max: 40, step: 1 },
    ],
  },
];

const PALETTE_KEYS = [
  'sky', 'skyHigh', 'horizon', 'ground', 'groundDark', 'asphalt', 'asphaltEdge',
  'curbA', 'curbB', 'ridge', 'trunk', 'leaf', 'post', 'postStripe', 'skidmark',
];

export class Inspector {
  constructor(root, doc) {
    this.root = root;
    this.doc = doc;
    this.build();
  }

  build() {
    this.root.innerHTML = '';
    this.inputs = [];

    for (const section of SECTIONS) {
      this.root.appendChild(this._section(section.title, (body) => {
        for (const field of section.fields) this._field(body, field);
      }));
    }

    this.root.appendChild(this._section('Palette', (body) => {
      const grid = el('div', 'paletteGrid');
      for (const key of PALETTE_KEYS) {
        const path = `environment.palette.${key}`;
        const wrap = el('label', 'swatchWrap');
        wrap.title = key;
        const input = el('input');
        input.type = 'color';
        input.addEventListener('input', () => {
          this.doc.setField(path, input.value, `palette ${key}`);
        });
        const name = el('span', 'swatchName');
        name.textContent = key;
        wrap.append(input, name);
        grid.appendChild(wrap);
        this.inputs.push({ path, apply: (v) => { input.value = formatColor(v ?? 0); } });
      }
      body.appendChild(grid);
    }, true));

    this.refresh();
  }

  _section(title, fill, collapsed = false) {
    const sec = el('section', 'insSection');
    const head = el('button', 'insHead');
    head.type = 'button';
    head.innerHTML = `<span class="chev">▾</span>${title}`;
    const body = el('div', 'insBody');
    if (collapsed) { sec.classList.add('collapsed'); }
    head.addEventListener('click', () => sec.classList.toggle('collapsed'));
    fill(body);
    sec.append(head, body);
    return sec;
  }

  _field(body, field) {
    const row = el('div', 'insRow');
    const label = el('label', 'insLabel');
    label.textContent = field.label + (field.unit ? ` (${field.unit})` : '');
    if (field.hint) { label.title = field.hint; label.classList.add('hasHint'); }

    if (field.type === 'text') {
      const input = el('input', 'insText');
      input.type = 'text';
      input.addEventListener('change', () => this.doc.setField(field.path, input.value, field.label));
      row.append(label, input);
      this.inputs.push({ path: field.path, apply: (v) => { input.value = v ?? ''; } });
    } else if (field.type === 'color') {
      const input = el('input');
      input.type = 'color';
      input.addEventListener('input', () => this.doc.setField(field.path, input.value, field.label));
      row.append(label, input);
      this.inputs.push({ path: field.path, apply: (v) => { input.value = formatColor(v ?? 0); } });
    } else {
      // Slider plus a number box: the slider is for finding a value by feel,
      // the box for typing one you already know. Both write the same field.
      const slider = el('input', 'insSlider');
      slider.type = 'range';
      slider.min = field.min; slider.max = field.max; slider.step = field.step ?? 0.01;
      const num = el('input', 'insNum');
      num.type = 'number';
      num.min = field.min; num.max = field.max; num.step = field.step ?? 0.01;

      let dragging = false;
      slider.addEventListener('pointerdown', () => { dragging = true; this.doc.begin(); });
      slider.addEventListener('input', () => {
        num.value = slider.value;
        // Live during the drag, one history entry at the end.
        this.doc.touch((raw) => setPath(raw, field.path, Number(slider.value)));
      });
      const finish = () => {
        if (!dragging) return;
        dragging = false;
        this.doc.commit(field.label);
      };
      slider.addEventListener('pointerup', finish);
      slider.addEventListener('change', finish);

      num.addEventListener('change', () => {
        const v = Number(num.value);
        if (Number.isFinite(v)) this.doc.setField(field.path, v, field.label);
      });

      row.append(label, slider, num);
      this.inputs.push({
        path: field.path,
        apply: (v) => { slider.value = v; num.value = v; },
      });
    }
    body.appendChild(row);
  }

  /** Push current document values into every control. */
  refresh() {
    for (const { path, apply } of this.inputs) {
      const v = this.doc.getField(path);
      if (v !== undefined) apply(v);
    }
  }
}

// --- point inspector -------------------------------------------------------

/** The three coordinates of the selected control point, editable directly. */
export class PointInspector {
  constructor(root, doc) {
    this.root = root;
    this.doc = doc;
    this.index = -1;
    this.onSelect = null;

    this.root.innerHTML = `
      <div class="ptHead">
        <span class="ptTitle">No point selected</span>
        <span class="ptNav">
          <button type="button" data-nav="-1" title="Previous point">‹</button>
          <button type="button" data-nav="1" title="Next point">›</button>
        </span>
      </div>
      <div class="ptRows">
        <label>X<input type="number" step="1" data-axis="0"></label>
        <label>Y<input type="number" step="0.1" data-axis="1"></label>
        <label>Z<input type="number" step="1" data-axis="2"></label>
      </div>
      <div class="ptActions">
        <button type="button" data-act="delete">Delete point</button>
      </div>`;

    this.title = this.root.querySelector('.ptTitle');
    this.fields = [...this.root.querySelectorAll('[data-axis]')];

    for (const f of this.fields) {
      f.addEventListener('change', () => {
        if (this.index < 0) return;
        const v = Number(f.value);
        if (!Number.isFinite(v)) return;
        const axis = Number(f.dataset.axis);
        this.doc.change((raw) => {
          raw.road.controlPoints[this.index][axis] = v;
        }, `point ${this.index}`);
      });
    }

    this.root.querySelector('[data-act="delete"]').addEventListener('click', () => {
      if (this.index < 0) return;
      if (this.doc.deletePoint(this.index)) this.onSelect?.(-1);
    });

    for (const b of this.root.querySelectorAll('[data-nav]')) {
      b.addEventListener('click', () => {
        const n = this.doc.controlPoints.length;
        if (!n) return;
        const next = this.index < 0
          ? 0
          : (this.index + Number(b.dataset.nav) + n) % n;
        this.onSelect?.(next);
      });
    }
  }

  set(index) {
    this.index = index;
    const p = index >= 0 ? this.doc.controlPoints[index] : null;
    this.title.textContent = p ? `Point ${index}` : 'No point selected';
    this.root.classList.toggle('empty', !p);
    if (p) this.fields.forEach((f, i) => { f.value = p[i]; });
  }

  refresh() { this.set(this.index); }
}

// --- helpers ---------------------------------------------------------------

function el(tag, className) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  return n;
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  cur[parts[parts.length - 1]] = value;
}

export { parseColor };
