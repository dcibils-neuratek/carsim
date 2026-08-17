// Speed blur.
//
// RADIAL, not full-frame. A true motion blur needs a velocity buffer and a
// second render of the whole scene, which this game cannot afford -- it has
// already lost 20 fps once to a single extra pass. It would also be the wrong
// effect: blurring everything uniformly reads as a dirty lens, not as speed.
//
// What actually sells speed is the periphery smearing while the thing you are
// looking at stays sharp, which is what your own vision does at pace. So the
// blur is zero at the centre of the screen and grows toward the edges, along
// the line from the centre outward -- the direction scenery is travelling when
// you are going fast and straight, which is when it matters.
//
// It is off entirely below the threshold, so an ordinary lap costs nothing.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { TUNING } from './tuning.js';

const RadialBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0 },      // 0 = pass through, 1 = full strength
    uCentre: { value: new THREE.Vector2(0.5, 0.5) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    uniform vec2 uCentre;
    varying vec2 vUv;

    // Eight taps. Enough to read as a smear rather than as ghosting, few
    // enough to stay cheap; the samples are short so gaps do not show.
    const int TAPS = 8;

    void main() {
      vec2 toCentre = vUv - uCentre;
      float r = length(toCentre);

      // Quadratic falloff from the centre. The middle of the screen -- where
      // the road you are aiming at sits -- stays untouched however fast you go,
      // and only the outer third smears meaningfully.
      float edge = smoothstep(0.18, 0.75, r);
      float strength = uAmount * edge * 0.055;

      if (strength < 0.0005) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      vec4 sum = vec4(0.0);
      float total = 0.0;
      for (int i = 0; i < TAPS; i++) {
        float t = float(i) / float(TAPS - 1);       // 0..1 along the streak
        // Weighted toward the true position so the image stays anchored
        // rather than sliding outward.
        float w = 1.0 - t * 0.65;
        sum += texture2D(tDiffuse, vUv - toCentre * t * strength) * w;
        total += w;
      }
      gl_FragColor = sum / total;
    }`,
};

export class SpeedBlur {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.amount = 0;
    this.enabled = true;

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.pass = new ShaderPass(RadialBlurShader);
    this.composer.addPass(this.pass);

    this.pass.renderToScreen = true;

    const size = renderer.getSize(new THREE.Vector2());
    this.composer.setSize(size.x, size.y);
    this.composer.setPixelRatio(renderer.getPixelRatio());
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
  }

  /**
   * Render the frame, with as much blur as the speed asks for.
   *
   * Below the threshold this skips the composer entirely and renders straight
   * to the screen -- not merely setting the amount to zero, because the pass
   * still costs a full-screen read and write even when it does nothing. Most
   * of a lap is spent under the threshold, and it should cost exactly what it
   * did before this file existed.
   */
  render(scene, camera, speedKmh) {
    const c = TUNING.camera;
    const start = c.blurStart ?? 150;
    const full = Math.max(c.blurFull ?? 260, start + 1);

    const target = this.enabled
      ? Math.min(Math.max((speedKmh - start) / (full - start), 0), 1) * (c.blurAmount ?? 1)
      : 0;

    // Eased, so a shift or a kerb cannot flicker it on and off.
    this.amount += (target - this.amount) * 0.15;
    if (this.amount < 0.004) {
      this.amount = 0;
      this.renderer.render(scene, camera);
      return;
    }

    this.pass.uniforms.uAmount.value = this.amount;
    this.composer.render();
  }
}
