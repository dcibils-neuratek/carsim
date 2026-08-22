// The garage.
//
// One module per car, in ./garage. Each is a model plus a set of TUNING
// overrides, and the overrides ARE the car: mass, torque, grip and gearing are
// what you feel, and the model is what you look at while feeling it.
//
// They live in their own files rather than in one list because most of a car
// file is not numbers, it is the reasoning attached to them -- where a figure
// was measured, what it was tried at first, and which ones must not be
// 'corrected' against a spec sheet. That is also why they are modules and not
// JSON, as the circuits are: a track file is mostly coordinates, and a comment
// there would have nothing to attach itself to. Here it would lose the number
// it belongs to.
//
// Adding a car is a file plus a line in CARS. The four are tuned against each
// other rather than each drifting off on its own, which is why they are read
// side by side.

import { TUNING, peakPowerHp } from './tuning.js';
import { alpine } from './garage/alpine.js';
import { gt3rs } from './garage/gt3rs.js';
import { sc18 } from './garage/sc18.js';
import { mclarenf1 } from './garage/mclarenf1.js';
import { mini } from './garage/mini.js';
import { delta } from './garage/delta.js';
import { m3e30 } from './garage/m3e30.js';

/** Least powerful first, so the row reads as a ladder you climb. */
export const CARS = byPower([alpine, gt3rs, sc18, mclarenf1, mini, delta, m3e30]);

export const DEFAULT_CAR = 'alpine';

/**
 * Sort by the same hp the card shows -- peakPowerHp() off each car's own
 * tuning, not a typed figure. A number written down drifts the moment someone
 * edits a torque curve; read from the curve, the ladder reorders itself when a
 * car is retuned and can never disagree with the hp printed beside it.
 */
function byPower(cars) {
  const saved = snapshot();
  const hp = new Map();
  for (const car of cars) {
    applyCarTuning(TUNING, car);
    hp.set(car, peakPowerHp());
  }
  restore(saved);
  return [...cars].sort((a, b) => hp.get(a) - hp.get(b));
}

function snapshot() { return JSON.parse(JSON.stringify(TUNING)); }

/**
 * Put TUNING back exactly, in place.
 *
 * In place and WHOLE: TUNING is a live object the vehicle re-reads every step,
 * and restoring only the keys a car happened to state leaves the rest of that
 * car's setup behind on the next one.
 */
function restore(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(TUNING[k], v);
    else TUNING[k] = v;
  }
}

/**
 * The numbers on a car's card, worked out from the car's own tuning.
 *
 * Derived rather than typed, because a hand-written spec sheet drifts the
 * moment anyone touches a number and then quietly lies. The GT3 RS card said
 * 520 hp while the simulation was making 437, and nothing in the code could
 * ever have noticed. Everything here is what the car will actually do.
 */
export function carStats(TUNING, car) {
  // The whole object, because a partial snapshot leaks: restoring only
  // chassis/engine/transmission left this car's suspension, wheels, brakes,
  // aero and audio behind on the next card.
  const saved = snapshot();
  applyCarTuning(TUNING, car);
  const hp = Math.round(peakPowerHp());
  const out = {
    power: `${hp} hp`,
    torque: `${Math.round(TUNING.engine.peakTorque)} Nm`,
    weight: `${TUNING.chassis.mass} kg`,
    redline: `${(TUNING.engine.redlineRpm / 1000).toFixed(1)}k rpm`,
    drive: car.drive,
  };
  restore(saved);
  return out;
}

export function getCar(id) {
  return CARS.find((c) => c.id === id) || CARS[0];
}

/**
 * Lay a car's overrides onto TUNING, in place.
 *
 * In place, because TUNING is a live object that the vehicle re-reads every
 * step and the GUI mutates as you drag -- handing back a copy would leave both
 * of those pointing at the old one. Only keys the car actually states are
 * touched, so everything it says nothing about keeps the shared default.
 */
export function applyCarTuning(TUNING, car) {
  const merge = (target, source) => {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key]) {
        merge(target[key], value);
      } else {
        target[key] = value;
      }
    }
  };
  merge(TUNING, car.tuning || {});
  return TUNING;
}
