// DOM overlay: the twin-dial cluster, lap times, toast, and the debug readout.

import { TUNING, torqueAt, peakPowerHp } from './tuning.js';
import { formatTime } from './laptimer.js';

const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'];

const G_SCALE = 1.5;      // g at the outer ring of the g-meter

function THREE_clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Force in kN, signed, at a fixed width so the columns line up. */
function kN(newtons) {
  return (newtons / 1000).toFixed(2).padStart(6);
}

/**
 * A ten-cell bar for a 0..1 value.
 *
 * Numbers alone are close to useless for this: what you need to see at a
 * glance is which tyre is filling up first and how fast, and a row of digits
 * changing at 120 Hz does not show that. The bar does.
 */
function meter(v) {
  const cells = 10;
  const filled = THREE_clamp(Math.round(v * cells), 0, cells);
  // The last two cells are the warning zone, so the bar reads as "nearly out
  // of grip" before it reads as "out of grip".
  let out = '';
  for (let i = 0; i < cells; i++) {
    if (i >= filled) out += '·';
    else out += i >= cells - 2 ? '#' : '=';
  }
  return `[${out}]`;
}

// Both dials sweep 250 degrees, starting at the lower left and running
// clockwise -- the layout the real cluster uses, and the reason a needle at
// rest sits pointing down-left rather than straight down.
const DIAL_START = -125;
const DIAL_SWEEP = 250;

/** A point on a dial, angle measured from 12 o'clock, clockwise positive. */
function dialPoint(angleDeg, radius, cx = 100, cy = 100) {
  const a = (angleDeg * Math.PI) / 180;
  return [cx + Math.sin(a) * radius, cy - Math.cos(a) * radius];
}

/**
 * Build the ticks and numerals for a dial from its real range.
 *
 * Generated rather than authored so the face can never disagree with the car:
 * change the redline or the top speed in tuning and the dial redraws to match.
 */
/**
 * The car's terminal speed in km/h, where drive force meets drag.
 *
 * Solved rather than driven, because no circuit here has a straight long
 * enough to reach 350 km/h, and the dial has to be built before the car has
 * turned a wheel.
 */
function terminalSpeedKmh() {
  const t = TUNING;
  const top = t.transmission.gears[t.transmission.gears.length - 1];
  const eff = t.transmission.efficiency ?? 0.9;
  let best = 0;
  for (let rpm = 1500; rpm <= t.engine.maxRpm; rpm += 25) {
    const v = (rpm * 2 * Math.PI * t.wheels.radius) / (60 * top * t.transmission.final);
    const drive = torqueAt(rpm) * top * t.transmission.final * eff / t.wheels.radius;
    const resist = t.aero.dragCoeff * v * v + t.aero.rollingResistance;
    if (drive > resist && v > best) best = v;
  }
  return best * 3.6;
}

function buildDial(ticksEl, numsEl, { max, step, minorPer, labelEvery, small }) {
  const ticks = [];
  const nums = [];
  const steps = Math.round(max / step);

  for (let i = 0; i <= steps * minorPer; i++) {
    const frac = i / (steps * minorPer);
    const major = i % minorPer === 0;
    const a = DIAL_START + frac * DIAL_SWEEP;
    const [x1, y1] = dialPoint(a, major ? 74 : 79);
    const [x2, y2] = dialPoint(a, 87);
    ticks.push(`<line class="tick${major ? ' major' : ''}" x1="${x1.toFixed(1)}" ` +
               `y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" ` +
               `stroke-width="${major ? 2.6 : 1.2}"/>`);

    if (major) {
      const value = (i / minorPer) * step;
      if (value % labelEvery === 0) {
        const [nx, ny] = dialPoint(a, 60);
        nums.push(`<text class="num${small ? ' small' : ''}" x="${nx.toFixed(1)}" ` +
                  `y="${ny.toFixed(1)}">${value}</text>`);
      }
    }
  }
  ticksEl.innerHTML = ticks.join('');
  numsEl.innerHTML = nums.join('');
}

export class Hud {
  constructor() {
    this.el = {
      fps: document.getElementById('fps'),
      tach: document.getElementById('tach'),
      tachRed: document.getElementById('tachRed'),
      tachTicks: document.getElementById('tachTicks'),
      tachNeedle: document.getElementById('tachNeedle'),
      tachNums: document.getElementById('tachNums'),
      spdTicks: document.getElementById('spdTicks'),
      spdNums: document.getElementById('spdNums'),
      spdNeedle: document.getElementById('spdNeedle'),
      speedVal: document.getElementById('speedVal'),
      gearRow: document.getElementById('gearRow'),
      gearMode: document.getElementById('gearMode'),
      tachRpmVal: document.getElementById('tachRpmVal'),
      gDot: document.getElementById('gDot'),
      gTrail: document.getElementById('gTrail'),
      gLabel: document.getElementById('gLabel'),
      trackName: document.getElementById('trackName'),
      mmTrack: document.getElementById('mmTrack'),
      mmDone: document.getElementById('mmDone'),
      mmStart: document.getElementById('mmStart'),
      mmDot: document.getElementById('mmDot'),
      mmBarFill: document.getElementById('mmBarFill'),
      mmPct: document.getElementById('mmPct'),
      balanceFill: document.getElementById('balanceFill'),
      balanceText: document.getElementById('balanceText'),
      lapCur: document.getElementById('lapCur'),
      lapLast: document.getElementById('lapLast'),
      lapBest: document.getElementById('lapBest'),
      debug: document.getElementById('debug'),
      toast: document.getElementById('toast'),
    };
    this._toastTimer = null;
    this._fps = 60;
    this._fpsOn = false;
    this._displaySpeed = 0;
    this._gx = 0;
    this._gy = 0;
    this._peakG = 0;
    this._balance = 0;
    this._delta = 0;
    this._hp = 0;
    this._nm = 0;
    this._buildTach();
    this._buildDelta();
    this._buildPower();
  }

  /**
   * What the engine is making RIGHT NOW, in hp and Nm.
   *
   * The dials tell you how fast the car is going and how fast it is spinning.
   * Neither tells you how hard it is pulling, and that is the number the whole
   * gearbox exists to manage: the same 4000 rpm is 180 hp in third and 180 hp
   * in fifth, but the shove is completely different, and a driver watching
   * this can see a kickdown arrive as the torque bar jumping.
   *
   * Both bars are scaled to THIS car's own peak, so full bar means "all of it"
   * rather than a number that only means something if you remember what the
   * car makes. The peaks come from the same functions that fill the car cards,
   * so the bar and the card cannot disagree.
   *
   * Built here rather than written into the page, like the delta bar: the
   * whole feature stays in one file.
   */
  _buildPower() {
    const dash = document.getElementById('dash');
    if (!dash) return;

    this._peakHp = Math.max(1, peakPowerHp());
    this._peakNm = Math.max(1, TUNING.engine.peakTorque);

    // Width tracks the dials rather than being a fixed pixel figure, so the
    // block stays the width of the binnacle at every screen size -- --d is
    // clamped between 112 and 186 px and moves with the viewport.
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:var(--d);margin-top:8px;display:flex;'
      + 'flex-direction:column;gap:4px';

    const row = (label, colour) => {
      const line = document.createElement('div');
      line.style.cssText = 'display:flex;align-items:center;gap:6px';

      const key = document.createElement('span');
      key.textContent = label;
      key.style.cssText = 'font-size:10px;letter-spacing:1px;width:20px;'
        + 'color:rgba(232,238,245,.45)';

      const track = document.createElement('div');
      track.style.cssText = 'position:relative;flex:1;height:4px;border-radius:2px;'
        + 'background:rgba(255,255,255,.10);overflow:hidden';

      const fill = document.createElement('div');
      fill.style.cssText = `position:absolute;left:0;top:0;height:100%;width:0;background:${colour}`;
      track.append(fill);

      const val = document.createElement('span');
      val.style.cssText = 'font-size:11px;font-variant-numeric:tabular-nums;'
        + 'width:30px;text-align:right;color:rgba(232,238,245,.75)';
      val.textContent = '0';

      line.append(key, track, val);
      wrap.append(line);
      return { fill, val };
    };

    // Amber for power and steel for torque: the two are read together and at a
    // glance the colour is what tells you which is which, not the label.
    this.el.hpBar = row('HP', '#ffd23f');
    this.el.nmBar = row('NM', '#7fb2e5');
    dash.append(wrap);
  }

  /** @param {import('./vehicle.js').Vehicle} vehicle */
  setPower(vehicle) {
    if (!this.el.hpBar) return;

    // engineTorque carries engine braking, so it goes NEGATIVE off the
    // throttle. That is correct for the physics and meaningless on a bar, so
    // the display floors at zero -- an engine being driven by the car is not
    // making power, it is absorbing it.
    const nm = Math.max(0, vehicle.engineTorque || 0);
    const hp = (nm * vehicle.rpm) / 9549 / 0.7457;

    // Smoothed for the same reason the speedo needle is: a shift cuts torque
    // to zero for 140 ms and the raw number flickers through it.
    this._hp += (hp - this._hp) * 0.18;
    this._nm += (nm - this._nm) * 0.18;

    const set = (bar, value, peak) => {
      bar.fill.style.width = `${Math.min(100, (value / peak) * 100)}%`;
      bar.val.textContent = Math.round(value);
    };
    set(this.el.hpBar, this._hp, this._peakHp);
    set(this.el.nmBar, this._nm, this._peakNm);
  }

  /**
   * The delta bar: how far up or down you are on your own best lap, right now.
   *
   * Built here rather than written into the page, so the whole feature is one
   * file and the markup does not carry an element that means nothing until
   * there is a lap to compare against.
   *
   * It sits under the running clock because that is where the eye already is,
   * and it is a BAR rather than only a number: at speed there is no time to
   * read three digits and work out their sign, but a stripe growing to the
   * right of centre needs no reading at all.
   */
  _buildDelta() {
    const laps = document.getElementById('laps');
    if (!laps) return;

    const wrap = document.createElement('div');
    wrap.id = 'lapDelta';
    wrap.style.cssText = 'margin-top:6px;display:none';

    const track = document.createElement('div');
    track.style.cssText = 'position:relative;height:6px;border-radius:3px;'
      + 'background:rgba(255,255,255,.10);overflow:hidden';

    // The centre line is the reference lap. Everything is read against it, so
    // it stays visible under the fill rather than being covered by it.
    const zero = document.createElement('div');
    zero.style.cssText = 'position:absolute;left:50%;top:0;width:1px;height:100%;'
      + 'background:rgba(255,255,255,.45)';

    const fill = document.createElement('div');
    fill.style.cssText = 'position:absolute;top:0;height:100%;left:50%;width:0';

    const text = document.createElement('div');
    text.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums;'
      + 'font-size:13px;letter-spacing:1px;margin-top:2px';

    track.append(fill, zero);
    wrap.append(track, text);
    laps.append(wrap);
    this.el.deltaWrap = wrap;
    this.el.deltaFill = fill;
    this.el.deltaText = text;
  }

  /**
   * @param {number|null} seconds  + is down on the best lap, - is up on it.
   *   null hides the bar -- no reference lap, or not on a timed lap.
   */
  setDelta(seconds) {
    const wrap = this.el.deltaWrap;
    if (!wrap) return;
    if (seconds === null || seconds === undefined) {
      wrap.style.display = 'none';
      // Cleared while hidden, or the smoothing carries the last lap's gap into
      // the first second of the next one and reads as having lost time that
      // was never lost.
      this._delta = 0;
      return;
    }
    wrap.style.display = 'block';

    // Smoothed, because the raw figure is a difference between two
    // interpolated clocks and jitters by a few hundredths at the checkpoint
    // boundaries. The number is read, not integrated, so a little lag costs
    // nothing and a twitching readout costs legibility.
    this._delta += (seconds - this._delta) * 0.25;
    const d = this._delta;

    // Full scale at two seconds. Wider and a good lap shows no movement at
    // all; narrower and the bar is pinned for most of a bad one.
    const frac = Math.max(-1, Math.min(1, d / 2));
    const half = Math.abs(frac) * 50;
    const fill = this.el.deltaFill;
    fill.style.background = d > 0 ? '#e05252' : '#57d97a';
    fill.style.left = d > 0 ? '50%' : `${50 - half}%`;
    fill.style.width = `${half}%`;

    const text = this.el.deltaText;
    text.textContent = `${d > 0 ? '+' : '-'}${Math.abs(d).toFixed(2)}`;
    text.style.color = d > 0 ? '#e05252' : '#57d97a';
  }

  /**
   * Draw both dial faces once, from the tuning.
   *
   * The speedo's range is rounded up from the car's actual top speed, so a
   * faster car gets a longer scale instead of a needle pinned at the stop.
   */
  _buildTach() {
    const e = TUNING.engine;

    // Tacho in thousands, like the real one: 0-7 for a 7000 rpm engine.
    const maxK = Math.ceil(e.maxRpm / 1000);
    buildDial(this.el.tachTicks, this.el.tachNums, {
      max: maxK, step: 1, minorPer: 5, labelEvery: 1,
    });

    // Red segment over the last full division, 6 to 7 here -- which is what
    // the real cluster does (7 to 8 on its 8000 dial) rather than starting at
    // the exact rev limiter. A wedge that begins mid-division looks like a
    // mistake even when the number behind it is right.
    const t0 = (maxK - 1) / maxK;
    const a0 = DIAL_START + t0 * DIAL_SWEEP;
    const a1 = DIAL_START + DIAL_SWEEP;
    const [x0, y0] = dialPoint(a0, 81);
    const [x1, y1] = dialPoint(a1, 81);
    const large = (a1 - a0) > 180 ? 1 : 0;
    this.el.tachRed.setAttribute('d', `M ${x0.toFixed(1)} ${y0.toFixed(1)} A 81 81 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`);

    // Speedo scaled to what THIS car can actually do.
    //
    // It was pinned at 300 km/h, which suited the Alpine and left the SC18
    // pegged against the stop for the top 50 km/h of its range -- a dial that
    // stops before the car does is worse than no dial. The figure comes from
    // the same place the top speed does: solve drive force against drag across
    // the rev range in top gear. Rounded UP to a round 30 with a little room
    // over, so the needle never quite reaches the last numeral and the last
    // numeral is never orphaned.
    this._speedMax = Math.max(180, Math.ceil((terminalSpeedKmh() * 1.06) / 30) * 30);
    // Label only as many as fit.
    //
    // The dial sweeps 250 degrees whatever it reads to, so a fast car crowds
    // it: the SC18's 390 km/h meant fourteen numerals and they overlapped
    // outright at the top of the arc, where the sweep is tightest. Ten is
    // about the limit at this radius, so above that the labels go on every
    // OTHER major tick. The ticks themselves stay every 30 either way, so the
    // dial loses none of its resolution -- only the printing thins out, which
    // is what a real instrument does at the same problem.
    const labelEvery = this._speedMax / 30 > 10 ? 60 : 30;
    buildDial(this.el.spdTicks, this.el.spdNums, {
      max: this._speedMax, step: 30, minorPer: 3, labelEvery, small: true,
    });
    this._tachMax = maxK * 1000;
  }

  /** Point a needle at a 0..1 fraction of its dial. */
  _setNeedle(el, frac) {
    const a = DIAL_START + THREE_clamp(frac, 0, 1) * DIAL_SWEEP;
    const [x, y] = dialPoint(a, 72);
    el.setAttribute('x2', x.toFixed(2));
    el.setAttribute('y2', y.toFixed(2));
  }

  /**
   * The gear strip, standing in for the real car's P R N D.
   *
   * Rebuilt only when the label set changes, not every frame: it is a handful
   * of DOM nodes and rewriting them at 100 Hz would be the most expensive
   * thing on the overlay.
   */
  _updateGears(vehicle) {
    const labels = ['R', 'N', ...TUNING.transmission.gears.map((_, i) => String(i + 1))];
    const key = labels.join('');
    if (this._gearKey !== key) {
      this._gearKey = key;
      this.el.gearRow.innerHTML = labels.map((l) => `<span data-g="${l}">${l}</span>`).join('');
      this._gearSpans = [...this.el.gearRow.children];
    }
    const current = vehicle.gearLabel;
    for (const span of this._gearSpans) {
      span.classList.toggle('on', span.dataset.g === current);
    }
    this.el.gearMode.textContent = TUNING.transmission.automatic ? 'AUTO' : 'MANUAL';
  }

  setTrackName(name) { this.el.trackName.textContent = name.toUpperCase(); }

  /**
   * Draw the circuit once, from the same centerline the road is built from, so
   * the map can never disagree with the track. World x/z maps straight to the
   * SVG box; the transform is kept so the position dot uses the same one.
   */
  buildMinimap(points) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const pad = 9;
    const scale = Math.min((100 - pad * 2) / (maxX - minX || 1),
                           (100 - pad * 2) / (maxZ - minZ || 1));
    this._mm = {
      scale,
      ox: 50 - ((maxX + minX) / 2) * scale,
      oy: 50 - ((maxZ + minZ) / 2) * scale,
      count: points.length,
    };
    const at = (p) => `${(this._mm.ox + p.x * scale).toFixed(2)},${(this._mm.oy + p.z * scale).toFixed(2)}`;

    // Keep every point: the dash-based progress overlay needs the drawn path
    // and the sample indices to line up.
    const d = `M ${points.map(at).join(' L ')} Z`;
    this.el.mmTrack.setAttribute('d', d);
    this.el.mmDone.setAttribute('d', d);
    this._mmLength = this.el.mmDone.getTotalLength();

    // Start/finish tick, drawn across the track at sample 0.
    const p0 = points[0];
    const p1 = points[1 % points.length];
    const tx = p1.x - p0.x, tz = p1.z - p0.z;
    const len = Math.hypot(tx, tz) || 1;
    const nx = (-tz / len) * 4, nz = (tx / len) * 4;
    const sx = this._mm.ox + p0.x * scale, sy = this._mm.oy + p0.z * scale;
    this.el.mmStart.setAttribute('x1', (sx + nx).toFixed(2));
    this.el.mmStart.setAttribute('y1', (sy + nz).toFixed(2));
    this.el.mmStart.setAttribute('x2', (sx - nx).toFixed(2));
    this.el.mmStart.setAttribute('y2', (sy - nz).toFixed(2));
  }

  /**
   * Move the dot and fill the lap in behind it.
   *
   * `lapStarted` matters: the car spawns just BEFORE the start line so that
   * driving forward across it starts the timer. Showing raw centerline
   * position there reads "98%" before you have moved, when what the driver
   * wants is progress through the lap they are actually on -- which is zero
   * until they cross.
   */
  /**
   * @param {object} [race]  when a race is on, the readout counts laps rather
   *   than only the percentage of this one -- "LAP 2/3  47%" answers both "how
   *   far round am I" and "how much of this is left", and the second question
   *   only exists now that a session ends.
   */
  setProgress(progress, carPos, lapStarted = true, race = null) {
    if (!this._mm) return;
    const p = lapStarted ? Math.min(Math.max(progress, 0), 1) : 0;
    this.el.mmDot.setAttribute('cx', (this._mm.ox + carPos.x * this._mm.scale).toFixed(2));
    this.el.mmDot.setAttribute('cy', (this._mm.oy + carPos.z * this._mm.scale).toFixed(2));
    // Reveal the travelled part by growing the dash.
    this.el.mmDone.setAttribute('stroke-dasharray',
      `${(this._mmLength * p).toFixed(1)} ${this._mmLength.toFixed(1)}`);
    this.el.mmBarFill.style.width = `${(p * 100).toFixed(1)}%`;
    const pct = `${Math.round(p * 100)}%`;
    this.el.mmPct.textContent = race
      ? (race.finished
          ? `FINISHED  ${race.totalLaps}/${race.totalLaps}`
          : `LAP ${Math.max(1, race.lapNumber)}/${race.totalLaps}  ${pct}`)
      : `LAP ${pct}`;
  }

  toggleFps() {
    this._fpsOn = !this._fpsOn;
    this.el.fps.classList.toggle('on', this._fpsOn);
    return this._fpsOn;
  }

  toggleDebug() {
    this.el.debug.classList.toggle('on');
    return this.el.debug.classList.contains('on');
  }

  get debugVisible() { return this.el.debug.classList.contains('on'); }

  toast(message, ms = 1600) {
    this.el.toast.textContent = message;
    this.el.toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.el.toast.classList.remove('show'), ms);
  }

  update(dt, vehicle, lapTimer) {
    const instant = 1 / Math.max(dt, 1e-4);
    this._fps += (instant - this._fps) * 0.08;

    // Worst frame in the last two seconds, alongside the smoothed average.
    //
    // An average alone is not enough to compare two render styles: a chain
    // that holds 90 and one that holds 90 while dropping to 40 twice a second
    // report the same number and feel nothing alike, and the second is the one
    // that ruins a corner. Reset by window rather than decayed, so a bad frame
    // ages out cleanly instead of haunting the readout.
    this._fpsWindow = (this._fpsWindow ?? 0) + dt;
    this._fpsWorst = Math.min(this._fpsWorst ?? instant, instant);
    if (this._fpsWindow > 2) {
      this._fpsMin = this._fpsWorst;
      this._fpsWorst = instant;
      this._fpsWindow = 0;
    }

    if (this._fpsOn) {
      const worst = this._fpsMin ?? this._fps;
      this.el.fps.innerHTML =
        `<b>${this._fps.toFixed(0)}</b> FPS <span class="worst">· ${worst.toFixed(0)} low</span>`;
      // Red below 50: that is where a dropped frame starts being something you
      // feel in a corner rather than something you only see in a number.
      this.el.fps.classList.toggle('slow', this._fps < 50);
    }

    // Smooth the needle a touch; raw per-step speed flickers the last digit.
    this._displaySpeed += (vehicle.speedKmh - this._displaySpeed) * Math.min(dt * 12, 1);
    const kmh = Math.abs(this._displaySpeed);
    this.el.speedVal.textContent = Math.round(kmh);
    this._setNeedle(this.el.spdNeedle, kmh / this._speedMax);

    this.setPower(vehicle);

    const e = TUNING.engine;
    this._setNeedle(this.el.tachNeedle, vehicle.rpm / this._tachMax);
    this.el.tachRpmVal.textContent = Math.round(vehicle.rpm);
    this.el.tach.classList.toggle('redline', vehicle.rpm >= e.redlineRpm - 120);
    this._updateGears(vehicle);

    this._updateGMeter(dt, vehicle);
    this._updateBalance(dt, vehicle);

    this.el.lapCur.textContent = formatTime(lapTimer.running ? lapTimer.current : null);
    this.el.lapLast.textContent = formatTime(lapTimer.last);
    this.el.lapBest.textContent = formatTime(lapTimer.best);
  }

  // A g-g plot of the force the driver feels: down under acceleration, up
  // under braking, and out toward the outside of the corner.
  _updateGMeter(dt, vehicle) {
    const k = Math.min(dt * 14, 1);
    this._gx += (vehicle.gLat - this._gx) * k;
    this._gy += (vehicle.gLong - this._gy) * k;

    // The dot shows the force FELT, not the acceleration vector -- which is
    // the reaction, so it points the opposite way. Accelerate and you are
    // pressed back into the seat, so the dot goes south; brake and it goes
    // north; turn right and it swings left. That is what every real g-meter
    // and every telemetry trace does, and plotting the acceleration instead
    // reads backwards to anyone who has watched one.
    const x = 50 - THREE_clamp(this._gx / G_SCALE, -1, 1) * 46;
    const y = 50 + THREE_clamp(this._gy / G_SCALE, -1, 1) * 46;
    this.el.gDot.setAttribute('cx', x.toFixed(1));
    this.el.gDot.setAttribute('cy', y.toFixed(1));

    const mag = Math.hypot(this._gx, this._gy);
    this._peakG = Math.max(this._peakG * (1 - dt * 0.5), mag);
    this.el.gTrail.setAttribute('r',
      (THREE_clamp(this._peakG / G_SCALE, 0, 1) * 46).toFixed(1));

    // One number: total load on the tyres, signed by whether the car is
    // gaining or losing speed, so braking reads negative. Magnitude alone
    // (a bare Math.hypot) showed every hard stop as positive g.
    const signed = this._gy < 0 ? -mag : mag;
    const cls = signed < -0.02 ? 'neg' : signed > 0.02 ? 'pos' : '';
    this.el.gLabel.innerHTML =
      `<span class="${cls}">${signed < 0 ? '\u2212' : ''}${Math.abs(signed).toFixed(2)}</span>` +
      ` <span class="k">g</span>`;
  }

  _updateBalance(dt, vehicle) {
    this._balance += (vehicle.balance - this._balance) * Math.min(dt * 8, 1);
    const deg = this._balance * 180 / Math.PI;
    const norm = THREE_clamp(deg / 8, -1, 1);   // 8 degrees of slip difference = full scale

    const fill = this.el.balanceFill;
    const half = 50;
    if (norm >= 0) {
      fill.style.left = '50%';
      fill.style.width = `${norm * half}%`;
    } else {
      fill.style.left = `${50 + norm * half}%`;
      fill.style.width = `${-norm * half}%`;
    }

    let label = 'NEUTRAL';
    if (deg > 1.2) label = 'OVERSTEER';
    else if (deg < -1.2) label = 'UNDERSTEER';
    this.el.balanceText.textContent = label;
  }

  updateDebug(ctx) {
    if (!this.debugVisible) return;
    const { vehicle, stepper, input, projection, camera, lapTimer, tyreAudio, fx, autopilot } = ctx;
    const deg = (r) => (r * 180 / Math.PI).toFixed(1);

    const lines = [];
    lines.push(
      `fps ${this._fps.toFixed(0)} (worst ${(this._fpsMin ?? this._fps).toFixed(0)})` +
      `   fx ${fx || 'none'}${autopilot ? '   AUTOPILOT' : ''}` +
      `   steps/frame ${stepper.stepsLastFrame}   alpha ${stepper.alpha.toFixed(2)}`,
    );
    lines.push('');
    lines.push(`speed    ${vehicle.speed.toFixed(2)} m/s  (${vehicle.speedKmh.toFixed(1)} km/h)`);
    lines.push(`g        lon ${vehicle.gLong.toFixed(2)}  lat ${vehicle.gLat.toFixed(2)}  total ${Math.hypot(vehicle.gLong, vehicle.gLat).toFixed(2)}`);
    lines.push(`slip     front ${(vehicle.slipFront * 180 / Math.PI).toFixed(1)}deg  rear ${(vehicle.slipRear * 180 / Math.PI).toFixed(1)}deg`);
    lines.push(`balance  ${(vehicle.balance * 180 / Math.PI).toFixed(1)}deg  ${vehicle.balance > 0.02 ? 'oversteer' : vehicle.balance < -0.02 ? 'understeer' : 'neutral'}`);
    lines.push(`rpm      ${vehicle.rpm.toFixed(0)}   gear ${vehicle.gearLabel}${TUNING.transmission.automatic ? ' (auto)' : ' (manual)'}`);
    lines.push(`torque   ${vehicle.engineTorque.toFixed(0)} Nm -> ${(vehicle.driveForce / 1000).toFixed(2)} kN at wheel`);
    lines.push(
      `steer    ${deg(vehicle.steerAngle)} deg   raw ${vehicle.telemetry.steerRaw.toFixed(2)} ` +
      `-> curve ${vehicle.telemetry.steerCurved.toFixed(2)}`,
    );
    lines.push(`pedals   gas ${input.state.throttle.toFixed(2)}  brake ${input.state.brake.toFixed(2)}  hand ${input.state.handbrake.toFixed(2)}`);
    lines.push('');

    // --- tyres --------------------------------------------------------------
    //
    // Utilisation is the important column and the reason this block exists.
    // Rapier's tyres have no slip curve -- full grip until saturation, then
    // saturated -- so slip angle stays near zero until the car has ALREADY
    // let go. Utilisation is |force| / (mu * load): it climbs continuously
    // from 0 and hits 1 exactly at the limit, so it is readable as a warning
    // while there is still time to do something about it.
    const t = vehicle.telemetry;
    lines.push('wheel  susp   grip   load    lat     long   lat use        spin');
    for (let i = 0; i < 4; i++) {
      const w = vehicle.curr.wheels[i];
      const tw = t.wheels[i];
      lines.push(
        `  ${WHEEL_NAMES[i]}  ${w.contact ? ' ' : '~'}${w.suspension.toFixed(3)}  ` +
        `${vehicle.gripMult[i].toFixed(2)}  ${kN(tw.load)}  ${kN(tw.lateral)}  ` +
        `${kN(tw.longitudinal)}  ${meter(tw.utilisation)}` +
        `${(tw.utilisation * 100).toFixed(0).padStart(4)}%` +
        `${tw.atLimit ? ' LIM' : '    '}` +
        // Longitudinal over 100% is wheelspin or a locked wheel: the drive
        // path is not clamped the way the lateral one is.
        `  ${(tw.longUtil * 100).toFixed(0).padStart(3)}%${tw.longUtil > 1.02 ? '!' : ' '}`,
      );
    }
    lines.push(
      `axle     front ${meter(t.frontUtil)} ${(t.frontUtil * 100).toFixed(0).padStart(3)}%   ` +
      `rear ${meter(t.rearUtil)} ${(t.rearUtil * 100).toFixed(0).padStart(3)}%`,
    );
    lines.push(
      `heading  ${deg(t.headingError)} deg off velocity   yaw ${t.yawRate.toFixed(2)} rad/s   ` +
      `scrub ${t.slipSpeed.toFixed(2)} m/s`,
    );
    lines.push(`airborne ${vehicle.airborne ? 'yes' : 'no'}`);

    // What the tyres actually sound like. Worth having next to the grip
    // figures: it is how you check the warning is arriving with the loss of
    // grip rather than after it.
    if (tyreAudio?.ready) {
      const s = tyreAudio.state;
      lines.push(
        `tyre snd front ${meter(s.front)} rear ${meter(s.rear)}  ` +
        `slide ${(s.slide * 100).toFixed(0)}%  road ${s.road.toFixed(2)}`,
      );
    }
    lines.push('');
    lines.push(`lateral  ${projection.lateral.toFixed(2)} m from centerline`);
    lines.push(`progress ${(projection.progress * 100).toFixed(1)}%   sectors ${lapTimer.sectorsHit.size}/2   laps ${lapTimer.lapCount}`);
    lines.push(`camera   ${camera.mode}`);
    lines.push('');
    lines.push(`input    ${input.describe()}`);
    if (input.raw.axes.length) {
      lines.push(`axes     ${input.raw.axes.map((a) => a.toFixed(2).padStart(5)).join(' ')}`);
      lines.push(`buttons  ${input.raw.buttons.map((b, i) => (b > 0.05 ? `${i}:${b.toFixed(1)}` : '')).filter(Boolean).join(' ') || '-'}`);
    }

    this.el.debug.textContent = lines.join('\n');
  }
}
