// DOM overlay: speed cluster, tach, lap times, toast, and the debug readout.

import { TUNING } from './tuning.js';
import { formatTime } from './laptimer.js';

const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'];

// Tachometer dial geometry: a 240 degree sweep starting at the lower left.
const TACH_START = -210;
const TACH_SWEEP = 240;
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

function tachPoint(angleDeg, radius = 50) {
  const rad = (angleDeg * Math.PI) / 180;
  return `${(60 + Math.sin(rad) * radius).toFixed(2)} ${(60 - Math.cos(rad) * radius).toFixed(2)}`;
}

export class Hud {
  constructor() {
    this.el = {
      speed: document.querySelector('#speed .val'),
      gear: document.getElementById('gear'),
      tach: document.getElementById('tach'),
      tachValue: document.getElementById('tachValue'),
      tachRed: document.getElementById('tachRed'),
      tachTicks: document.getElementById('tachTicks'),
      tachNeedle: document.getElementById('tachNeedle'),
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

  // The dial sweeps 240 degrees, from -210 to +30 measured from 12 o'clock.
  _buildTach() {
    const e = TUNING.engine;
    const max = e.maxRpm;
    const ticks = [];
    for (let rpm = 0; rpm <= max; rpm += 1000) {
      const a = TACH_START + (rpm / max) * TACH_SWEEP;
      const rad = (a * Math.PI) / 180;
      const sin = Math.sin(rad), cos = -Math.cos(rad);
      const r0 = 40, r1 = 34;
      ticks.push(
        `<line x1="${(60 + sin * r0).toFixed(1)}" y1="${(60 + cos * r0).toFixed(1)}" ` +
        `x2="${(60 + sin * r1).toFixed(1)}" y2="${(60 + cos * r1).toFixed(1)}" />`,
      );
    }
    this.el.tachTicks.innerHTML = ticks.join('');

    // Redline segment drawn as its own arc.
    const t0 = e.redlineRpm / max;
    const p0 = tachPoint(TACH_START + t0 * TACH_SWEEP);
    const p1 = tachPoint(TACH_START + TACH_SWEEP);
    const large = (1 - t0) * TACH_SWEEP > 180 ? 1 : 0;
    this.el.tachRed.setAttribute('d', `M ${p0} A 50 50 0 ${large} 1 ${p1}`);
    this._tachLength = (TACH_SWEEP / 360) * 2 * Math.PI * 50;
    this.el.tachValue.setAttribute('stroke-dasharray', String(this._tachLength));
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
    this.el.speed.textContent = Math.round(this._displaySpeed);
    this.el.gear.textContent = vehicle.gearLabel;

    const e = TUNING.engine;
    const frac = THREE_clamp(vehicle.rpm / e.maxRpm, 0, 1);
    this.el.tachValue.setAttribute('stroke-dashoffset',
      String(this._tachLength * (1 - frac)));
    const angle = TACH_START + frac * TACH_SWEEP;
    const rad = (angle * Math.PI) / 180;
    this.el.tachNeedle.setAttribute('x2', (60 + Math.sin(rad) * 42).toFixed(2));
    this.el.tachNeedle.setAttribute('y2', (60 - Math.cos(rad) * 42).toFixed(2));
    this.el.tachRpmVal.textContent = Math.round(vehicle.rpm);
    this.el.tach.classList.toggle('redline', vehicle.rpm >= e.redlineRpm - 120);

    this._updateGMeter(dt, vehicle);
    this._updateBalance(dt, vehicle);

    this.el.lapCur.textContent = formatTime(lapTimer.running ? lapTimer.current : null);
    this.el.lapLast.textContent = formatTime(lapTimer.last);
    this.el.lapBest.textContent = formatTime(lapTimer.best);
  }

  // Dot position is lateral vs longitudinal g, the way a real g-g plot reads:
  // right on the dial = pushed right, up = accelerating, down = braking.
  _updateGMeter(dt, vehicle) {
    const k = Math.min(dt * 14, 1);
    this._gx += (vehicle.gLat - this._gx) * k;
    this._gy += (vehicle.gLong - this._gy) * k;

    const x = 50 + THREE_clamp(this._gx / G_SCALE, -1, 1) * 46;
    const y = 50 - THREE_clamp(this._gy / G_SCALE, -1, 1) * 46;
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
        `tyre snd front ${meter(s.front / TUNING.audio.tyre.volume)} ` +
        `rear ${meter(s.rear / TUNING.audio.tyre.volume)}  ` +
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
