// The elevation strip: height against distance around the lap.
//
// The plan view can only edit two of a control point's three coordinates. This
// is where the third one lives, and it needs its own view rather than a number
// field because elevation is a *profile* -- what matters is the shape of the
// climb and how abruptly it changes, neither of which you can see one number
// at a time.
//
// It also draws the gradient-change trace underneath, because that is the
// measurement behind "the road has a hard break and change of angle which
// makes it undrivable" and it is invisible in the height profile itself: a
// crest can look gentle and still be a step change in slope.

const PAD = { left: 44, right: 12, top: 12, bottom: 20 };

const COLORS = {
  bg: '#0d1218',
  grid: '#1b242f',
  profile: '#6fa8dc',
  fill: 'rgba(111,168,220,0.12)',
  point: '#8fa3b8',
  pointSelected: '#ffd23f',
  kink: '#e0b341',
  kinkBad: '#ff4d4d',
  label: '#5f7386',
  axis: '#2c3d4e',
};

export class ElevationView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = null;
    this.check = null;
    this.controlPoints = [];
    this.selected = -1;
    this.anchors = [];        // control point index -> distance along the lap

    this.onPointDragStart = null;
    this.onPointDrag = null;  // (index, worldY)
    this.onPointDragEnd = null;
    this.onSelect = null;

    this._drag = null;
    this._bindEvents();
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  setData(geo, check, controlPoints) {
    this.geo = geo;
    this.check = check;
    this.controlPoints = controlPoints;
    this._computeAnchors();
    this.draw();
  }

  /**
   * Where each control point sits along the lap.
   *
   * The spline is approximating and the corner cutter inserts points, so a
   * control point does not correspond to any particular sample. Matching by
   * nearest position in plan is an approximation, but it is the one that
   * matches intuition: the marker lands where that point pulls the road.
   */
  _computeAnchors() {
    if (!this.geo) { this.anchors = []; return; }
    const { points, distances, samples: n } = this.geo;
    this.anchors = this.controlPoints.map((cp) => {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = (points[i].x - cp[0]) ** 2 + (points[i].z - cp[2]) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      return distances[best];
    });
  }

  // --- scales --------------------------------------------------------------

  _bounds() {
    const ys = this.geo.points.map((p) => p.y);
    const cpYs = this.controlPoints.map((p) => p[1]);
    let lo = Math.min(...ys, ...cpYs);
    let hi = Math.max(...ys, ...cpYs);
    // Never let a flat track collapse to a zero-height band; keep at least 4 m
    // of range so there is somewhere to drag a point to.
    const span = Math.max(hi - lo, 4);
    const mid = (lo + hi) / 2;
    return { lo: mid - span * 0.7, hi: mid + span * 0.7 };
  }

  _plot() {
    return {
      x: PAD.left,
      y: PAD.top,
      w: this.canvas.clientWidth - PAD.left - PAD.right,
      h: this.canvas.clientHeight - PAD.top - PAD.bottom,
    };
  }

  _toScreen(dist, y) {
    const p = this._plot();
    const b = this._bounds();
    return [
      p.x + (dist / this.geo.length) * p.w,
      p.y + p.h - ((y - b.lo) / (b.hi - b.lo)) * p.h,
    ];
  }

  _toWorldY(sy) {
    const p = this._plot();
    const b = this._bounds();
    return b.lo + ((p.y + p.h - sy) / p.h) * (b.hi - b.lo);
  }

  // --- events --------------------------------------------------------------

  _bindEvents() {
    const c = this.canvas;

    c.addEventListener('pointerdown', (e) => {
      if (!this.geo) return;
      c.setPointerCapture(e.pointerId);
      const [sx, sy] = this._local(e);
      const hit = this._pointAt(sx, sy);
      if (hit >= 0) {
        this.selected = hit;
        this._drag = { index: hit };
        this.onSelect?.(hit);
        this.onPointDragStart?.(hit);
        this.draw();
      }
    });

    c.addEventListener('pointermove', (e) => {
      const [sx, sy] = this._local(e);
      if (this._drag) {
        this.onPointDrag?.(this._drag.index, this._toWorldY(sy));
        return;
      }
      c.style.cursor = this._pointAt(sx, sy) >= 0 ? 'ns-resize' : 'default';
    });

    const end = (e) => {
      if (this._drag) { this.onPointDragEnd?.(this._drag.index); this._drag = null; }
      try { c.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _pointAt(sx, sy) {
    if (!this.geo) return -1;
    for (let i = 0; i < this.controlPoints.length; i++) {
      const [px, py] = this._toScreen(this.anchors[i], this.controlPoints[i][1]);
      if (Math.hypot(px - sx, py - sy) <= 8) return i;
    }
    return -1;
  }

  // --- drawing -------------------------------------------------------------

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    if (!this.geo) return;

    const p = this._plot();
    const b = this._bounds();

    // Height grid, at a spacing that keeps the labels readable.
    const targets = [1, 2, 5, 10, 20, 50];
    const step = targets.find((s) => (s / (b.hi - b.lo)) * p.h >= 26) ?? 50;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    for (let y = Math.ceil(b.lo / step) * step; y <= b.hi; y += step) {
      const [, sy] = this._toScreen(0, y);
      ctx.strokeStyle = Math.abs(y) < 1e-9 ? COLORS.axis : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(p.x, Math.round(sy) + 0.5);
      ctx.lineTo(p.x + p.w, Math.round(sy) + 0.5);
      ctx.stroke();
      ctx.fillStyle = COLORS.label;
      ctx.fillText(`${y}m`, p.x - 6, sy + 3);
    }

    // Distance ticks every 200 m.
    ctx.textAlign = 'center';
    for (let d = 0; d <= this.geo.length; d += 200) {
      const [sx] = this._toScreen(d, 0);
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(Math.round(sx) + 0.5, p.y);
      ctx.lineTo(Math.round(sx) + 0.5, p.y + p.h);
      ctx.stroke();
      ctx.fillStyle = COLORS.label;
      ctx.fillText(`${d}`, sx, p.y + p.h + 13);
    }

    // The profile itself, filled to the bottom so the shape reads at a glance.
    ctx.beginPath();
    for (let i = 0; i < this.geo.samples; i++) {
      const [sx, sy] = this._toScreen(this.geo.distances[i], this.geo.points[i].y);
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    const tail = this._toScreen(this.geo.length, this.geo.points[0].y);
    ctx.lineTo(tail[0], tail[1]);
    ctx.strokeStyle = COLORS.profile;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo(p.x + p.w, p.y + p.h);
    ctx.lineTo(p.x, p.y + p.h);
    ctx.closePath();
    ctx.fillStyle = COLORS.fill;
    ctx.fill();

    this._drawGradientChange(p);
    this._drawAnchors();
  }

  /**
   * Gradient change along the bottom of the strip, scaled against the limit.
   *
   * A bar that reaches the marked line is a road that breaks rather than
   * curves. This is the trace that turns "somewhere it feels wrong" into a
   * distance you can point at.
   */
  _drawGradientChange(p) {
    const ctx = this.ctx;
    const limit = 0.006;               // LIMITS.gradientChangeError
    const warn = 0.002;                // LIMITS.gradientChangeWarn
    const band = 22;
    const base = p.y + p.h;

    for (let i = 0; i < this.geo.samples; i++) {
      const v = this.geo.gradientChange[i];
      if (v < warn * 0.35) continue;
      const [sx] = this._toScreen(this.geo.distances[i], 0);
      const h = Math.min(1, v / limit) * band;
      ctx.fillStyle = v >= limit ? COLORS.kinkBad : COLORS.kink;
      ctx.globalAlpha = 0.65;
      ctx.fillRect(sx, base - h, 2, h);
    }
    ctx.globalAlpha = 1;

    ctx.strokeStyle = COLORS.kinkBad;
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(p.x, base - band + 0.5);
    ctx.lineTo(p.x + p.w, base - band + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  _drawAnchors() {
    const ctx = this.ctx;
    for (let i = 0; i < this.controlPoints.length; i++) {
      const [sx, sy] = this._toScreen(this.anchors[i], this.controlPoints[i][1]);
      const sel = i === this.selected;
      ctx.beginPath();
      ctx.arc(sx, sy, sel ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = sel ? COLORS.pointSelected : COLORS.point;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = COLORS.bg;
      ctx.stroke();
    }
  }
}
