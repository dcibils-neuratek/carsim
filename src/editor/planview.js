// The plan view: a top-down canvas where the layout is actually drawn by hand.
//
// This is the editor. Everything else is support. The whole point is that a
// corner you can see is too tight is one you can drag until it isn't, without
// leaving the page or running a lap to find out.
//
// Coordinates: world +X runs right across the screen and world +Z runs down it,
// which matches the game's minimap so a layout looks the same in both places.
// The car drives in +Z, so a lap runs down-screen from the start line.

const POINT_HIT_PX = 10;

const COLORS = {
  bg: '#0d1218',
  grid: '#18212c',
  gridMajor: '#22303e',
  axis: '#2c3d4e',
  asphalt: '#39414c',
  asphaltEdge: '#2a313a',
  centerline: '#7d8b9b',
  tight: '#ff4d4d',
  warn: '#e0b341',
  polygon: '#3d4c5e',
  point: '#8fa3b8',
  pointRelaxed: '#e0b341',
  pointSelected: '#ffd23f',
  pointHover: '#e8eef5',
  start: '#57d97a',
  overlap: '#ff4d4d',
  label: '#5f7386',
};

export class PlanView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { cx: 0, cz: 0, scale: 1.4 };   // world centre, pixels per metre

    this.geo = null;
    this.check = null;
    this.controlPoints = [];
    this.selected = -1;
    this.hover = -1;
    this.showGrid = true;
    this.showPolygon = true;

    // Set by the owner; the view reports intent and does not mutate the doc.
    this.onPointDragStart = null;   // (index)
    this.onPointDrag = null;        // (index, worldX, worldZ)
    this.onPointDragEnd = null;     // (index)
    this.onSelect = null;           // (index | -1)
    this.onInsert = null;           // (afterIndex, [x, y, z])

    this._drag = null;
    this._pan = null;
    this._bindEvents();
    this.resize();
  }

  // --- transforms ----------------------------------------------------------

  toScreen(x, z) {
    const { cx, cz, scale } = this.view;
    return [
      (x - cx) * scale + this.canvas.clientWidth / 2,
      (z - cz) * scale + this.canvas.clientHeight / 2,
    ];
  }

  toWorld(sx, sy) {
    const { cx, cz, scale } = this.view;
    return [
      (sx - this.canvas.clientWidth / 2) / scale + cx,
      (sy - this.canvas.clientHeight / 2) / scale + cz,
    ];
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  /** Frame the whole circuit with a margin. */
  fit(margin = 60) {
    const pts = this.geo ? this.geo.points : null;
    if (!pts || !pts.length) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const w = this.canvas.clientWidth - margin * 2;
    const h = this.canvas.clientHeight - margin * 2;
    // Refuse rather than compute nonsense: called before layout, both of these
    // are negative and the scale comes out useless in a way that looks like a
    // broken circuit rather than a broken call.
    if (w <= 0 || h <= 0) return;
    this.view.scale = Math.min(w / (maxX - minX || 1), h / (maxZ - minZ || 1));
    this.view.cx = (minX + maxX) / 2;
    this.view.cz = (minZ + maxZ) / 2;
    this.draw();
  }

  setData(geo, check, controlPoints) {
    this.geo = geo;
    this.check = check;
    this.controlPoints = controlPoints;
    this.draw();
  }

  // --- events --------------------------------------------------------------

  _bindEvents() {
    const c = this.canvas;

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const [sx, sy] = this._local(e);
      const hit = this._pointAt(sx, sy);
      if (hit >= 0) {
        this.selected = hit;
        this._drag = { index: hit };
        this.onSelect?.(hit);
        this.onPointDragStart?.(hit);
      } else {
        // Clicking bare canvas pans. Deselecting on the same gesture would
        // make it impossible to pan while keeping a point in the inspector,
        // which is exactly what you want when nudging a value and watching
        // the road move.
        this._pan = { sx, sy, cx: this.view.cx, cz: this.view.cz };
      }
      this.draw();
    });

    c.addEventListener('pointermove', (e) => {
      const [sx, sy] = this._local(e);
      if (this._drag) {
        const [wx, wz] = this.toWorld(sx, sy);
        this.onPointDrag?.(this._drag.index, wx, wz);
        return;
      }
      if (this._pan) {
        this.view.cx = this._pan.cx - (sx - this._pan.sx) / this.view.scale;
        this.view.cz = this._pan.cz - (sy - this._pan.sy) / this.view.scale;
        this.draw();
        return;
      }
      const hit = this._pointAt(sx, sy);
      if (hit !== this.hover) {
        this.hover = hit;
        c.style.cursor = hit >= 0 ? 'grab' : 'default';
        this.draw();
      }
    });

    const end = (e) => {
      if (this._drag) { this.onPointDragEnd?.(this._drag.index); this._drag = null; }
      this._pan = null;
      try { c.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('dblclick', (e) => {
      const [sx, sy] = this._local(e);
      if (this._pointAt(sx, sy) >= 0) return;    // double-click ON a point is not an insert
      const [wx, wz] = this.toWorld(sx, sy);
      const seg = this._nearestSegment(wx, wz);
      if (seg) this.onInsert?.(seg.index, [wx, seg.y, wz]);
    });

    // Zoom about the cursor, so the thing under the pointer stays under it.
    // Zooming to the centre instead means every zoom needs a pan to correct,
    // which is the difference between an editor that is pleasant to use and
    // one that fights you.
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = this._local(e);
      const [wx, wz] = this.toWorld(sx, sy);
      const factor = Math.exp(-e.deltaY * 0.0016);
      this.view.scale = Math.max(0.12, Math.min(24, this.view.scale * factor));
      const [nx, nz] = this.toWorld(sx, sy);
      this.view.cx += wx - nx;
      this.view.cz += wz - nz;
      this.draw();
    }, { passive: false });
  }

  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _pointAt(sx, sy) {
    for (let i = 0; i < this.controlPoints.length; i++) {
      const [px, py] = this.toScreen(this.controlPoints[i][0], this.controlPoints[i][2]);
      if (Math.hypot(px - sx, py - sy) <= POINT_HIT_PX) return i;
    }
    return -1;
  }

  /** Which leg of the control polygon a world point is closest to. */
  _nearestSegment(wx, wz) {
    const pts = this.controlPoints;
    const n = pts.length;
    if (n < 2) return null;
    let best = null;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const dx = b[0] - a[0];
      const dz = b[2] - a[2];
      const len2 = dx * dx + dz * dz;
      const t = len2 > 0
        ? Math.max(0, Math.min(1, ((wx - a[0]) * dx + (wz - a[2]) * dz) / len2))
        : 0;
      const px = a[0] + dx * t;
      const pz = a[2] + dz * t;
      const d = Math.hypot(wx - px, wz - pz);
      if (!best || d < best.d) best = { d, index: i, y: a[1] + (b[1] - a[1]) * t };
    }
    return best;
  }

  // --- drawing -------------------------------------------------------------

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    if (this.showGrid) this._drawGrid(W, H);
    if (this.geo) {
      this._drawRibbon();
      this._drawTightSections();
      this._drawCenterline();
      this._drawStart();
      this._drawIssueMarkers();
    }
    if (this.showPolygon) this._drawPolygon();
    this._drawPoints();
    this._drawScaleBar(W, H);
  }

  _drawGrid(W, H) {
    const ctx = this.ctx;
    // Grid spacing in metres, chosen so lines never crowd closer than ~40 px.
    const targets = [5, 10, 25, 50, 100, 250, 500, 1000];
    const step = targets.find((s) => s * this.view.scale >= 40) ?? 1000;

    const [x0, z0] = this.toWorld(0, 0);
    const [x1, z1] = this.toWorld(W, H);

    ctx.lineWidth = 1;
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
      const [sx] = this.toScreen(x, 0);
      ctx.strokeStyle = x === 0 ? COLORS.axis : (x % (step * 5) === 0 ? COLORS.gridMajor : COLORS.grid);
      ctx.beginPath();
      ctx.moveTo(Math.round(sx) + 0.5, 0);
      ctx.lineTo(Math.round(sx) + 0.5, H);
      ctx.stroke();
    }
    for (let z = Math.floor(z0 / step) * step; z <= z1; z += step) {
      const [, sy] = this.toScreen(0, z);
      ctx.strokeStyle = z === 0 ? COLORS.axis : (z % (step * 5) === 0 ? COLORS.gridMajor : COLORS.grid);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(sy) + 0.5);
      ctx.lineTo(W, Math.round(sy) + 0.5);
      ctx.stroke();
    }
  }

  _ribbonPath() {
    const ctx = this.ctx;
    const pts = this.geo.points;
    ctx.beginPath();
    for (let i = 0; i <= pts.length; i++) {
      const p = pts[i % pts.length];
      const [sx, sy] = this.toScreen(p.x, p.z);
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
  }

  /**
   * The road, stroked as one wide path.
   *
   * Stroking the centerline at the road's full width is exactly how the game
   * sweeps its ribbon, so this shows the real footprint -- including the way
   * the inner edge folds through itself at a corner that is too tight, which
   * is the single most useful thing this view can show you.
   */
  _drawRibbon() {
    const ctx = this.ctx;
    const full = (this.geo.halfWidth + this.geo.curbWidth) * 2 * this.view.scale;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.strokeStyle = COLORS.asphaltEdge;
    ctx.lineWidth = full;
    this._ribbonPath();
    ctx.stroke();

    ctx.strokeStyle = COLORS.asphalt;
    ctx.lineWidth = this.geo.halfWidth * 2 * this.view.scale;
    this._ribbonPath();
    ctx.stroke();

    this._drawSpeedProfile();
  }

  /**
   * Paint the road by the speed it demands.
   *
   * The rest of this view answers "is this circuit legal". This one answers
   * "is it any good", which is the question you are holding while dragging a
   * point and the one nothing here could show before. A lap of one colour is a
   * lap of one speed, and a lap of one speed is dull whatever that speed is --
   * what you are looking for is the mix, and where the slow parts fall.
   *
   * Drawn narrow and down the middle so the ribbon's own edges, the tight
   * sections overlay and the folding check are all still readable through it.
   */
  _drawSpeedProfile() {
    const speeds = this.check?.metrics?.cornerSpeeds;
    if (!speeds) return;
    const ctx = this.ctx;
    const pts = this.geo.points;
    const n = pts.length;

    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineWidth = Math.max(2, this.geo.halfWidth * 0.7 * this.view.scale);
    ctx.globalAlpha = 0.9;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      // Deep red at a crawl through to cyan flat out. Banded rather than a
      // smooth ramp, because the eye reads a change of band and does not read
      // a gradient.
      const v = speeds[i];
      ctx.strokeStyle = v < 70 ? '#c0392b'
        : v < 100 ? '#e07b39'
        : v < 140 ? '#e8c547'
        : v < 190 ? '#7fbf5f'
        : v < 250 ? '#3fa9c9'
        : '#5ce1e6';
      const [ax, ay] = this.toScreen(a.x, a.z);
      const [bx, by] = this.toScreen(b.x, b.z);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Overlay the stretches where the corner radius is at or past the limit. */
  _drawTightSections() {
    if (!this.check) return;
    const ctx = this.ctx;
    const geo = this.geo;
    const n = geo.samples;
    const minRadius = this.check.metrics.minRadius;
    const width = geo.halfWidth * 2 * this.view.scale;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = width;

    let run = null;
    const flush = () => {
      if (!run || run.length < 2) { run = null; return; }
      ctx.globalAlpha = run.severity >= 1 ? 0.85 : 0.45;
      ctx.strokeStyle = run.severity >= 1 ? COLORS.tight : COLORS.warn;
      ctx.beginPath();
      run.forEach(([sx, sy], k) => (k === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy)));
      ctx.stroke();
      run = null;
    };

    for (let i = 0; i < n; i++) {
      const radius = geo.curvature[i] > 1e-6 ? 1 / geo.curvature[i] : Infinity;
      // Warn from 1.35x the limit so a corner shows amber before it fails --
      // the useful signal while dragging is "getting close", not "already broken".
      const ratio = minRadius / radius;
      if (ratio > 0.74) {
        const p = geo.points[i];
        if (!run) { run = []; run.severity = 0; }
        run.push(this.toScreen(p.x, p.z));
        run.severity = Math.max(run.severity, ratio);
      } else {
        flush();
      }
    }
    flush();
    ctx.globalAlpha = 1;
  }

  _drawCenterline() {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = COLORS.centerline;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 8]);
    ctx.globalAlpha = 0.7;
    this._ribbonPath();
    ctx.stroke();
    ctx.restore();
  }

  _drawStart() {
    const ctx = this.ctx;
    const geo = this.geo;
    const p = geo.points[0];
    const t = geo.tangents[0];
    const [sx, sy] = this.toScreen(p.x, p.z);
    const hw = geo.halfWidth * this.view.scale;

    // Start line, drawn across the road.
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(Math.atan2(t.x, -t.z));
    ctx.strokeStyle = COLORS.start;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-hw, 0);
    ctx.lineTo(hw, 0);
    ctx.stroke();
    // Direction of travel.
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(-5, 4);
    ctx.lineTo(5, 4);
    ctx.closePath();
    ctx.fillStyle = COLORS.start;
    ctx.fill();
    ctx.restore();
  }

  /** Ring the tightest corner and draw the bar between overlapping sections. */
  _drawIssueMarkers() {
    if (!this.check) return;
    const ctx = this.ctx;
    const geo = this.geo;
    const n = geo.samples;

    for (const iss of this.check.issues) {
      if (iss.severity === 'info') continue;
      const color = iss.severity === 'error' ? COLORS.overlap : COLORS.warn;

      if (iss.span) {
        const a = geo.points[Math.round(iss.span[0] * n) % n];
        const b = geo.points[Math.round(iss.span[1] * n) % n];
        const [ax, ay] = this.toScreen(a.x, a.z);
        const [bx, by] = this.toScreen(b.x, b.z);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.restore();
      } else if (iss.at !== null && iss.at !== undefined) {
        const p = geo.points[Math.round(iss.at * n) % n];
        const [px, py] = this.toScreen(p.x, p.z);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 14, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  _drawPolygon() {
    const pts = this.controlPoints;
    if (pts.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = COLORS.polygon;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    for (let i = 0; i <= pts.length; i++) {
      const [sx, sy] = this.toScreen(pts[i % pts.length][0], pts[i % pts.length][2]);
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawPoints() {
    const ctx = this.ctx;
    const relaxed = new Set(
      this.check?.issues.find((i) => i.id === 'control-relaxed')?.points ?? [],
    );
    const flagged = new Set(
      this.check?.issues.flatMap((i) => (i.severity !== 'info' && i.points) || []) ?? [],
    );

    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';

    for (let i = 0; i < this.controlPoints.length; i++) {
      const p = this.controlPoints[i];
      const [sx, sy] = this.toScreen(p[0], p[2]);
      const isSel = i === this.selected;
      const r = isSel ? 7 : 5;

      let fill = COLORS.point;
      if (relaxed.has(i)) fill = COLORS.pointRelaxed;
      if (flagged.has(i)) fill = COLORS.tight;
      if (i === this.hover) fill = COLORS.pointHover;
      if (isSel) fill = COLORS.pointSelected;

      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = COLORS.bg;
      ctx.stroke();

      if (isSel || this.view.scale > 1.1) {
        ctx.fillStyle = isSel ? COLORS.pointSelected : COLORS.label;
        ctx.fillText(String(i), sx, sy - r - 4);
      }
    }
  }

  _drawScaleBar(W, H) {
    const ctx = this.ctx;
    const targets = [10, 25, 50, 100, 250, 500];
    const metres = targets.find((s) => s * this.view.scale >= 70) ?? 500;
    const px = metres * this.view.scale;
    // Bottom right: the hint line owns the bottom left of the canvas.
    const x = W - px - 16;
    const y = H - 26;

    ctx.strokeStyle = COLORS.label;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.fillStyle = COLORS.label;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${metres} m`, x + 4, y - 7);
  }
}
