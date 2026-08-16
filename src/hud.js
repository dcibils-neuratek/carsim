// DOM overlay: the twin-dial cluster, lap times, toast, and the debug readout.

import { TUNING } from './tuning.js';
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
    this._displaySpeed = 0;
    this._gx = 0;
    this._gy = 0;
    this._peakG = 0;
    this._balance = 0;
    this._buildTach();
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

    // Speedo, rounded up to a round 30 so the last numeral is not orphaned.
    this._speedMax = Math.max(180, Math.ceil((TUNING.aero ? 300 : 300) / 30) * 30);
    buildDial(this.el.spdTicks, this.el.spdNums, {
      max: this._speedMax, step: 30, minorPer: 3, labelEvery: 30, small: true,
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
  setProgress(progress, carPos, lapStarted = true) {
    if (!this._mm) return;
    const p = lapStarted ? Math.min(Math.max(progress, 0), 1) : 0;
    this.el.mmDot.setAttribute('cx', (this._mm.ox + carPos.x * this._mm.scale).toFixed(2));
    this.el.mmDot.setAttribute('cy', (this._mm.oy + carPos.z * this._mm.scale).toFixed(2));
    // Reveal the travelled part by growing the dash.
    this.el.mmDone.setAttribute('stroke-dasharray',
      `${(this._mmLength * p).toFixed(1)} ${this._mmLength.toFixed(1)}`);
    this.el.mmBarFill.style.width = `${(p * 100).toFixed(1)}%`;
    this.el.mmPct.textContent = `LAP ${Math.round(p * 100)}%`;
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
    this._fps += (1 / Math.max(dt, 1e-4) - this._fps) * 0.08;

    // Smooth the needle a touch; raw per-step speed flickers the last digit.
    this._displaySpeed += (vehicle.speedKmh - this._displaySpeed) * Math.min(dt * 12, 1);
    const kmh = Math.abs(this._displaySpeed);
    this.el.speedVal.textContent = Math.round(kmh);
    this._setNeedle(this.el.spdNeedle, kmh / this._speedMax);

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
    const { vehicle, stepper, input, projection, camera, lapTimer, tyreAudio } = ctx;
    const deg = (r) => (r * 180 / Math.PI).toFixed(1);

    const lines = [];
    lines.push(`fps ${this._fps.toFixed(0)}   steps/frame ${stepper.stepsLastFrame}   alpha ${stepper.alpha.toFixed(2)}`);
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
