// Editor bootstrap and wiring.
//
// The loop is: the document changes -> re-derive the runtime definition ->
// re-sample the centerline -> re-check it -> redraw. That whole chain runs on
// every mouse move during a drag, which is only viable because none of it
// builds meshes or colliders: sampling 720 points and checking them is about a
// millisecond. The 3D preview is the one expensive step, so it sits behind a
// debounce.

import { loadTracks, getTrack, TRACK_IDS, getDefaultsFile } from '../tracks.js';
import { trackGeometry, validateTrack } from '../trackcheck.js';
import { EditorDoc, EDITOR_TRACK_ID } from './state.js';
import { PlanView } from './planview.js';
import { ElevationView } from './elevation.js';
import { Inspector, PointInspector } from './inspector.js';
import { Preview3D } from './preview3d.js';

const PREVIEW_DEBOUNCE = 450;   // ms of quiet before the 3D view is rebuilt

const $ = (sel) => document.querySelector(sel);

class Editor {
  constructor(doc) {
    this.doc = doc;
    this.geo = null;
    this.check = null;
    this.previewTimer = null;
    this.previewStale = true;

    this.plan = new PlanView($('#planCanvas'));
    this.elevation = new ElevationView($('#elevCanvas'));
    this.inspector = new Inspector($('#inspector'), doc);
    this.pointInspector = new PointInspector($('#pointPanel'), doc);
    this.preview = new Preview3D($('#previewCanvas'));

    this._wireViews();
    this._wireToolbar();
    this._wireKeyboard();

    doc.onChange(() => this.recompute());
    this.recompute();
    this.plan.fit();

    this.preview.init().then(() => {
      this.preview.start();
      this.schedulePreview(0);
    });

    window.addEventListener('resize', () => {
      this.plan.resize();
      this.elevation.resize();
      this.preview.resize();
    });

    window.addEventListener('beforeunload', (e) => {
      if (!this.doc.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  // --- the derive/check/draw chain -----------------------------------------

  recompute() {
    const { def, error } = this.doc.runtime();
    const banner = $('#errorBanner');
    if (error) {
      // Keep the last good drawing on screen. Blanking the canvas because a
      // field is momentarily half-typed would be worse than useless.
      banner.textContent = error;
      banner.hidden = false;
      return;
    }
    banner.hidden = true;

    this.def = def;
    this.geo = trackGeometry(def);
    this.check = validateTrack(def, this.geo);

    const cps = this.doc.controlPoints;
    this.plan.setData(this.geo, this.check, cps);
    this.elevation.setData(this.geo, this.check, cps);
    this.pointInspector.refresh();
    this.inspector.refresh();
    this.renderIssues();
    this.renderMetrics();
    this.updateHistoryButtons();

    this.previewStale = true;
    this.schedulePreview();
  }

  schedulePreview(delay = PREVIEW_DEBOUNCE) {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      if (!this.preview.ready || !this.def) return;
      $('#previewStatus').textContent = 'building…';
      // Yield so the status text paints before the build blocks the thread.
      requestAnimationFrame(() => {
        const t0 = performance.now();
        try {
          this.preview.rebuild(this.def);
          $('#previewStatus').textContent = `${Math.round(performance.now() - t0)} ms`;
          this.previewStale = false;
        } catch (err) {
          $('#previewStatus').textContent = 'build failed';
          console.error(err);
        }
      });
    }, delay);
  }

  renderMetrics() {
    const m = this.check.metrics;
    $('#metrics').innerHTML = [
      ['length', `${(m.length / 1000).toFixed(2)} km`],
      ['points', m.controlPoints],
      ['tightest', `${m.tightestRadius.toFixed(1)} m`, m.tightestRadius < m.minRadius],
      ['min gap', `${m.minSeparation.toFixed(0)} m`, m.minSeparation < m.neededSeparation],
      ['climb', `${m.elevationRange.span.toFixed(1)} m`],
      ['max slope', `${(m.steepestGradient * 100).toFixed(1)}%`],
    ].map(([k, v, bad]) =>
      `<span class="metric${bad ? ' bad' : ''}"><b>${v}</b>${k}</span>`).join('');
  }

  renderIssues() {
    const list = $('#issues');
    const issues = this.check.issues;
    $('#issueCount').textContent = issues.length
      ? `${this.check.errors.length} error${this.check.errors.length === 1 ? '' : 's'}, ` +
        `${this.check.warnings.length} warning${this.check.warnings.length === 1 ? '' : 's'}`
      : 'no problems';
    $('#issueCount').className = this.check.errors.length ? 'bad'
      : (this.check.warnings.length ? 'warn' : 'good');

    list.innerHTML = '';
    if (!issues.length) {
      const ok = document.createElement('div');
      ok.className = 'issue good';
      ok.innerHTML = '<b>Circuit checks out</b><span>Nothing is folded, overlapping or too steep.</span>';
      list.appendChild(ok);
      return;
    }

    for (const iss of issues) {
      const node = document.createElement('div');
      node.className = `issue ${iss.severity}`;
      node.innerHTML = `<b>${iss.title}</b><span>${iss.detail}</span>`;
      // Clicking an issue takes you to it -- in the plan view, in the 3D
      // preview, and by selecting the control point responsible where there
      // is one. Reading "at progress 0.961" and hunting for it by hand is the
      // difference between a report and a tool.
      node.addEventListener('click', () => {
        if (iss.points?.length) this.select(iss.points[0]);
        const at = iss.at ?? iss.span?.[0];
        if (at !== null && at !== undefined && this.geo) {
          const p = this.geo.points[Math.round(at * this.geo.samples) % this.geo.samples];
          this.plan.view.cx = p.x;
          this.plan.view.cz = p.z;
          this.plan.view.scale = Math.max(this.plan.view.scale, 2.6);
          this.plan.draw();
          if (!this.previewStale) this.preview.lookAt(at);
        }
      });
      list.appendChild(node);
    }
  }

  updateHistoryButtons() {
    $('#undoBtn').disabled = !this.doc.canUndo;
    $('#redoBtn').disabled = !this.doc.canRedo;
    $('#trackName').textContent = this.doc.raw.name + (this.doc.dirty ? ' •' : '');
  }

  // --- selection -----------------------------------------------------------

  select(index) {
    this.plan.selected = index;
    this.elevation.selected = index;
    this.pointInspector.set(index);
    this.plan.draw();
    this.elevation.draw();
  }

  _wireViews() {
    const p = this.plan;
    p.onSelect = (i) => this.select(i);
    p.onPointDragStart = () => this.doc.begin();
    p.onPointDrag = (i, x, z) => {
      this.doc.touch(() => this.doc.movePoint(i, x, undefined, z));
    };
    p.onPointDragEnd = () => this.doc.commit('move point');
    p.onInsert = (after, point) => this.select(this.doc.insertPoint(after, point));

    const e = this.elevation;
    e.onSelect = (i) => this.select(i);
    e.onPointDragStart = () => this.doc.begin();
    e.onPointDrag = (i, y) => {
      this.doc.touch(() => this.doc.movePoint(i, undefined, y, undefined));
    };
    e.onPointDragEnd = () => this.doc.commit('move elevation');

    this.pointInspector.onSelect = (i) => this.select(i);
  }

  // --- toolbar -------------------------------------------------------------

  _wireToolbar() {
    $('#trackSelect').addEventListener('change', (ev) => {
      if (this.doc.dirty &&
          !confirm('Discard unsaved changes to this circuit?')) {
        ev.target.value = this.doc.raw.id;
        return;
      }
      location.search = `?track=${ev.target.value}`;
    });

    $('#fitBtn').addEventListener('click', () => this.plan.fit());
    $('#undoBtn').addEventListener('click', () => this.doc.undo());
    $('#redoBtn').addEventListener('click', () => this.doc.redo());

    $('#gridBtn').addEventListener('click', (ev) => {
      this.plan.showGrid = !this.plan.showGrid;
      ev.target.classList.toggle('off', !this.plan.showGrid);
      this.plan.draw();
    });

    $('#polyBtn').addEventListener('click', (ev) => {
      this.plan.showPolygon = !this.plan.showPolygon;
      ev.target.classList.toggle('off', !this.plan.showPolygon);
      this.plan.draw();
    });

    $('#frameBtn').addEventListener('click', () => this.preview.frame());

    // Drive what you are looking at, in the real physics. This is the loop
    // that actually makes a track fun: shape it, drive it, come back.
    $('#driveBtn').addEventListener('click', () => {
      this.doc.stashForDriving();
      window.open(`./index.html?track=${EDITOR_TRACK_ID}`, '_blank');
    });

    $('#exportBtn').addEventListener('click', () => this.showExport());
    $('#importBtn').addEventListener('click', () => $('#importFile').click());

    $('#importFile').addEventListener('change', async (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      try {
        if (this.doc.dirty && !confirm('Discard unsaved changes to this circuit?')) return;
        const raw = JSON.parse(await file.text());
        this.doc.replace(mergeDeep(getDefaultsFile(), raw));
        // The palette and every slider belong to the old track's values.
        this.inspector.build();
        this.select(-1);
        this.plan.fit();
      } catch (err) {
        alert(`Could not read that file:\n${err.message}`);
      } finally {
        // Clear it, or picking the same file twice fires no change event.
        ev.target.value = '';
      }
    });

    $('#exportClose').addEventListener('click', () => { $('#exportModal').hidden = true; });
    $('#exportCopy').addEventListener('click', async () => {
      await navigator.clipboard.writeText($('#exportText').value);
      $('#exportCopy').textContent = 'copied';
      setTimeout(() => { $('#exportCopy').textContent = 'copy'; }, 1200);
    });
    $('#exportDownload').addEventListener('click', () => {
      const blob = new Blob([$('#exportText').value], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${this.doc.raw.id}.track.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      this.doc.dirty = false;
      this.updateHistoryButtons();
    });
  }

  showExport() {
    $('#exportText').value = this.doc.exportJson();
    $('#exportPath').textContent = `assets/tracks/${this.doc.raw.id}.track.json`;
    $('#exportModal').hidden = false;
    $('#exportText').select();
  }

  _wireKeyboard() {
    window.addEventListener('keydown', (e) => {
      // Never steal keys from a field the user is typing in.
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }

      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.doc.redo(); else this.doc.undo();
        return;
      }
      if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); this.showExport(); return; }

      if (e.key === 'Escape') { $('#exportModal').hidden = true; this.select(-1); return; }
      if (e.key === 'f') { this.plan.fit(); return; }

      const sel = this.plan.selected;
      if (sel < 0) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (this.doc.deletePoint(sel)) this.select(-1);
        return;
      }

      // Arrow keys nudge: 1 m, or 10 m with shift. Fine positioning by hand is
      // the whole job, and a mouse cannot reliably hit a single metre.
      const step = e.shiftKey ? 10 : 1;
      const nudges = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0],
        ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      const n = nudges[e.key];
      if (n) {
        e.preventDefault();
        const p = this.doc.controlPoints[sel];
        this.doc.change((raw) => {
          raw.road.controlPoints[sel][0] = round1(p[0] + n[0]);
          raw.road.controlPoints[sel][2] = round1(p[2] + n[1]);
        }, 'nudge point');
        return;
      }

      // Page up/down raise and lower it, same idea in the third axis.
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        const dy = (e.key === 'PageUp' ? 1 : -1) * (e.shiftKey ? 5 : 0.5);
        const p = this.doc.controlPoints[sel];
        this.doc.change((raw) => {
          raw.road.controlPoints[sel][1] = round2(p[1] + dy);
        }, 'raise point');
      }
    });
  }
}

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

function mergeDeep(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = (isPlain(v) && isPlain(out[k])) ? mergeDeep(out[k], v) : v;
  }
  return out;
}
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

let editor = null;

function startEditor(raw, defaults) {
  const doc = new EditorDoc(raw, defaults);
  editor = new Editor(doc);
  window.__editor = editor;      // for poking at from the console
}

export async function boot() {
  await loadTracks();

  const select = $('#trackSelect');
  for (const id of TRACK_IDS) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = getTrack(id).name;
    select.appendChild(opt);
  }

  const requested = new URLSearchParams(location.search).get('track');
  const id = TRACK_IDS.includes(requested) ? requested : TRACK_IDS[0];
  select.value = id;

  // `source` is the merged file the loader kept, which is exactly what the
  // editor wants: authored form, defaults already applied.
  startEditor(getTrack(id).source, getDefaultsFile());
  $('#boot').hidden = true;
}
