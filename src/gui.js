// lil-gui panel over the TUNING object.
//
// Most values are read fresh every physics step, so they take effect as you
// drag. The handful that define the rigid body itself (mass, centre of mass,
// dimensions, wheel positions) need the car rebuilt, and are wired to do that.

import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { TUNING, saveTuning, resetTuning, dumpTuning } from './tuning.js';

export function createGui({ onRebuild, onToast }) {
  const gui = new GUI({ title: 'carsim tuning', width: 310 });
  gui.close();

  const save = () => saveTuning();
  const rebuild = () => { saveTuning(); onRebuild(); };

  const chassis = gui.addFolder('chassis (rebuilds car)');
  chassis.add(TUNING.chassis, 'mass', 700, 2200, 10).onFinishChange(rebuild);
  chassis.add(TUNING.chassis, 'comY', -0.8, 0.2, 0.01).name('com Y (lower = stabler)').onFinishChange(rebuild);
  chassis.add(TUNING.chassis, 'comZ', -0.8, 0.8, 0.01).name('com Z (rear = oversteer)').onFinishChange(rebuild);
  chassis.add(TUNING.chassis, 'halfHeight', 0.25, 0.8, 0.01).onFinishChange(rebuild);
  chassis.add(TUNING.chassis, 'colliderOffsetY', -0.2, 0.6, 0.01).name('body lift (clearance)').onFinishChange(rebuild);
  chassis.add(TUNING.chassis, 'inertiaScale', 0.4, 2.0, 0.05).name('yaw inertia').onFinishChange(rebuild);
  chassis.add(TUNING.chassis, 'angularDamping', 0, 1.5, 0.01).onFinishChange(rebuild);
  chassis.add(TUNING.chassis, 'linearDamping', 0, 0.5, 0.005).onFinishChange(rebuild);
  chassis.close();

  const susp = gui.addFolder('suspension');
  // Damping is relative to 2*sqrt(stiffness), so these ranges have to reach
  // well past 1 -- at stiffness 80, critical damping is about 17.9.
  susp.add(TUNING.suspension, 'restLength', 0.10, 0.6, 0.01).onChange(save);
  susp.add(TUNING.suspension, 'stiffness', 10, 200, 1).onChange(save);
  susp.add(TUNING.suspension, 'compression', 0.1, 20, 0.1).name('damping: bump').onChange(save);
  susp.add(TUNING.suspension, 'relaxation', 0.1, 25, 0.1).name('damping: rebound').onChange(save);
  susp.add(TUNING.suspension, 'maxTravel', 0.05, 0.6, 0.01).onChange(save);
  susp.add(TUNING.suspension, 'maxForce', 5000, 80000, 500).onChange(save);
  susp.close();

  const grip = gui.addFolder('grip');
  grip.add(TUNING.wheels, 'frictionFront', 0.3, 5, 0.05).onChange(save);
  grip.add(TUNING.wheels, 'frictionRear', 0.3, 5, 0.05).onChange(save);
  grip.add(TUNING.wheels, 'sideFrictionStiffness', 0.1, 3, 0.05).onChange(save);
  grip.add(TUNING.wheels, 'loadSensitivity', 0, 0.6, 0.01).name('load sensitivity').onChange(save);
  grip.add(TUNING.surfaces, 'grassGripMult', 0.05, 1, 0.01).name('grass grip').onChange(save);
  grip.add(TUNING.surfaces, 'grassDrag', 0, 30, 0.5).onChange(save);
  grip.close();

  const wheels = gui.addFolder('wheels (rebuilds car)');
  wheels.add(TUNING.wheels, 'radius', 0.2, 0.6, 0.01).onFinishChange(rebuild);
  wheels.add(TUNING.wheels, 'trackHalf', 0.5, 1.2, 0.01).name('track/2').onFinishChange(rebuild);
  wheels.add(TUNING.wheels, 'frontZ', 0.8, 2.0, 0.01).onFinishChange(rebuild);
  wheels.add(TUNING.wheels, 'rearZ', 0.8, 2.0, 0.01).onFinishChange(rebuild);
  wheels.add(TUNING.wheels, 'connectionY', -0.6, 0.3, 0.01).onFinishChange(rebuild);
  wheels.close();

  const engine = gui.addFolder('engine');
  engine.add(TUNING.engine, 'idleRpm', 500, 1500, 10).onChange(save);
  engine.add(TUNING.engine, 'redlineRpm', 4000, 9500, 50).onChange(save);
  engine.add(TUNING.engine, 'maxRpm', 4000, 10000, 50).onChange(save);
  engine.add(TUNING.engine, 'engineBrakeTorque', 0, 200, 1).name('engine braking').onChange(save);
  engine.add(TUNING.engine, 'revSpeed', 1, 20, 0.1).onChange(save);
  engine.close();

  const trans = gui.addFolder('transmission');
  trans.add(TUNING.transmission, 'automatic').onChange(save);
  trans.add(TUNING.transmission, 'final', 2, 6, 0.05).name('final drive').onChange(save);
  trans.add(TUNING.transmission, 'efficiency', 0.5, 1, 0.01).onChange(save);
  trans.add(TUNING.transmission, 'autoUpshiftRpm', 3000, 9000, 50).onChange(save);
  trans.add(TUNING.transmission, 'autoDownshiftRpm', 1000, 6000, 50).onChange(save);
  trans.add(TUNING.transmission, 'shiftTime', 0, 1, 0.01).onChange(save);
  TUNING.transmission.gears.forEach((_, i) => {
    trans.add(TUNING.transmission.gears, String(i), 0.4, 5, 0.01).name(`gear ${i + 1}`).onChange(save);
  });
  trans.close();

  const brakes = gui.addFolder('brakes');
  brakes.add(TUNING.brakes, 'maxBrakeForce', 0, 40000, 250).name('brake force (N)').onChange(save);
  brakes.add(TUNING.brakes, 'frontBias', 0.3, 0.9, 0.01).onChange(save);
  brakes.add(TUNING.brakes, 'holdBrake', 0, 400, 5).name('hold at rest').onChange(save);
  brakes.add(TUNING.brakes, 'handbrake', 0, 800, 5).onChange(save);
  brakes.add(TUNING.brakes, 'handbrakeGripMult', 0.05, 1, 0.01).name('handbrake grip').onChange(save);
  brakes.close();

  const steer = gui.addFolder('steering');
  steer.add(TUNING.steering, 'maxAngleLow', 0.1, 1.0, 0.01).name('lock at 0 km/h').onChange(save);
  steer.add(TUNING.steering, 'maxAngleHigh', 0.02, 0.6, 0.01).name('lock at speed').onChange(save);
  steer.add(TUNING.steering, 'falloffSpeed', 10, 100, 1).onChange(save);
  steer.add(TUNING.steering, 'rateLimit', 0.5, 12, 0.1).onChange(save);
  steer.add(TUNING.steering, 'returnRate', 0.5, 20, 0.1).onChange(save);
  steer.add(TUNING.steering, 'inputExponent', 0, 2, 0.05).name('stick curve').onChange(save);
  steer.add(TUNING.steering, 'deadzone', 0, 0.4, 0.01).onChange(save);
  steer.add(TUNING.steering, 'counterSteerAssist', 0, 1, 0.02).name('counter-steer assist').onChange(save);
  steer.close();

  const aero = gui.addFolder('aero');
  aero.add(TUNING.aero, 'dragCoeff', 0, 3, 0.02).name('drag').onChange(save);
  aero.add(TUNING.aero, 'downforce', 0, 20, 0.1).onChange(save);
  aero.add(TUNING.aero, 'rollingResistance', 0, 150, 1).onChange(save);
  aero.close();

  // Per-source levels. Each is its own bus, so these balance sources against
  // each other rather than just moving everything together -- which is what
  // you need when the question is "can I hear the tyres over the engine".
  const mix = gui.addFolder('audio mix');
  mix.add(TUNING.audio, 'volume', 0, 1, 0.02).name('master').onChange(save);
  mix.add(TUNING.audio, 'engineVolume', 0, 2, 0.02).name('engine').onChange(save);
  mix.add(TUNING.audio, 'tyreVolume', 0, 2, 0.02).name('tyres').onChange(save);
  mix.add(TUNING.audio, 'roadVolume', 0, 2, 0.02).name('road').onChange(save);
  mix.add(TUNING.audio, 'musicVolume', 0, 2, 0.02).name('music').onChange(save);

  const snd = gui.addFolder('engine audio');
  snd.add(TUNING.audio, 'pitchPerRpm', 0.05, 0.5, 0.01).name('pitch / rpm').onChange(save);
  snd.add(TUNING.audio, 'blendLowRpm', 500, 6000, 100).name('blend low rpm').onChange(save);
  snd.add(TUNING.audio, 'blendHighRpm', 2000, 9000, 100).name('blend high rpm').onChange(save);

  // The tyre squeal is the car's warning channel, so squealStart -- how much
  // notice you get before the limit -- is the single most consequential
  // number in this folder.
  const tyre = gui.addFolder('tyre audio');
  tyre.add(TUNING.audio.tyre, 'volume', 0, 1.5, 0.02).onChange(save);
  tyre.add(TUNING.audio.tyre, 'squealStart', 0.3, 0.95, 0.01).name('squeal starts at').onChange(save);
  tyre.add(TUNING.audio.tyre, 'loadVolume', 0, 1, 0.02).name('loaded loudness').onChange(save);
  tyre.add(TUNING.audio.tyre, 'slideVolume', 1, 3, 0.05).name('slide loudness').onChange(save);
  tyre.add(TUNING.audio.tyre, 'pitchFront', 0.5, 2, 0.02).name('front pitch').onChange(save);
  tyre.add(TUNING.audio.tyre, 'pitchRear', 0.5, 2, 0.02).name('rear pitch').onChange(save);
  tyre.add(TUNING.audio.tyre, 'speedPitch', 1, 2, 0.02).name('pitch from speed').onChange(save);
  tyre.add(TUNING.audio.tyre, 'toneLoaded', 300, 8000, 100).name('tone gripping').onChange(save);
  tyre.add(TUNING.audio.tyre, 'toneSliding', 300, 12000, 100).name('tone sliding').onChange(save);
  tyre.add(TUNING.audio.tyre.road, 'volume', 0, 0.5, 0.01).name('road noise').onChange(save);
  snd.close();

  const skid = gui.addFolder('skidmarks');
  skid.add(TUNING.skidmarks, 'enabled').onChange(save);
  skid.add(TUNING.skidmarks, 'opacity', 0, 1, 0.02).onChange(save);
  // Marks and squeal are one condition seen two ways, so their thresholds are
  // one set of controls rather than two that can disagree.
  const tyres = gui.addFolder('sliding (marks + squeal)');
  tyres.add(TUNING.tyres, 'slideStart', 0.2, 6, 0.1).name('scrub start (m/s)').onChange(save);
  tyres.add(TUNING.tyres, 'slideFull', 1, 12, 0.1).name('scrub full (m/s)').onChange(save);
  tyres.add(TUNING.tyres, 'lockStart', 0.5, 1.2, 0.01).name('locking start').onChange(save);
  tyres.add(TUNING.tyres, 'spinStart', 0.8, 1.6, 0.01).name('wheelspin start').onChange(save);
  tyres.close();
  skid.add(TUNING.skidmarks, 'minSpeed', 0, 10, 0.5).name('min speed (m/s)').onChange(save);
  skid.close();

  const cam = gui.addFolder('camera');
  cam.add(TUNING.camera, 'distance', 2, 16, 0.1).onChange(save);
  cam.add(TUNING.camera, 'height', 0.5, 8, 0.1).onChange(save);
  cam.add(TUNING.camera, 'lookAhead', 0, 30, 0.5).onChange(save);
  cam.add(TUNING.camera, 'stiffness', 1, 25, 0.5).onChange(save);
  cam.add(TUNING.camera, 'velocityBlend', 0, 1, 0.02).name('drift follow').onChange(save);
  cam.add(TUNING.camera, 'fovBase', 40, 100, 1).onChange(save);
  cam.add(TUNING.camera, 'fovGain', 0, 45, 1).onChange(save);
  cam.close();

  const actions = {
    copySetup() {
      dumpTuning();
      onToast('setup copied to clipboard');
    },
    resetDefaults() {
      resetTuning();
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      onRebuild();
      onToast('tuning reset to defaults');
    },
  };
  gui.add(actions, 'copySetup').name('copy setup JSON');
  gui.add(actions, 'resetDefaults').name('reset to defaults');

  gui.hide();
  return gui;
}
