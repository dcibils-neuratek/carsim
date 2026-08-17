// Every post effect, in one pass, each gated by a uniform.
//
// One shader rather than five chained passes, because every extra pass is a
// full-screen read and write of a half-float buffer for work that is a few
// dozen instructions. The branches are on uniforms, so they are uniform
// control flow -- the whole warp takes the same side and a switched-off effect
// costs a compare.
//
// The exception is bloom, whose expensive part is not the composite but the
// three downsampled draws that produce it. Those are skipped outright when it
// is off, not multiplied by zero.
//
// Runs in linear space and outputs linear; an OutputPass after this does the
// sRGB conversion, which is the only place three will do it correctly once a
// composer is involved.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Keep what is brighter than the threshold, and keep it softly -- a hard step
// makes a light pop in and out of glowing as the car moves, which reads as
// flicker rather than as brightness.
const THRESHOLD_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uThreshold, uKnee;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + uKnee, l), 1.0);
}`;

const BLUR_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  float w[5];
  w[0] = 0.2270; w[1] = 0.1946; w[2] = 0.1216; w[3] = 0.0540; w[4] = 0.0162;
  vec3 sum = texture2D(tDiffuse, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = uDir * float(i) * 2.0;
    sum += texture2D(tDiffuse, vUv + o).rgb * w[i];
    sum += texture2D(tDiffuse, vUv - o).rgb * w[i];
  }
  gl_FragColor = vec4(sum, 1.0);
}`;

const FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tBloom;
uniform vec2  uTexel;
uniform float uNear, uFar;

uniform float uInk, uInkWidth, uInkDepth, uInkColorEdge;
uniform float uInkDepthThreshold, uInkColorThreshold;
uniform vec3  uInkColor;

uniform float uBlur, uBlurMax, uBlurNear, uBlurFar;
uniform int   uBlurSamples;
uniform mat4  uInvViewProj, uPrevViewProj;

uniform float uBloom;
uniform vec3  uLift, uGamma, uGain;
uniform float uExposure, uVignette, uVignetteSoft, uAberration;

varying vec2 vUv;

float linearDepth(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

float luma(vec3 c) {
  return pow(clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0), 0.45454545);
}

// One place the image is sampled, so the lens split applies to every tap the
// motion blur takes as well as to the plain read.
vec3 fetch(vec2 uv) {
  if (uAberration <= 0.0) return texture2D(tDiffuse, uv).rgb;
  vec2 shift = (uv - 0.5) * uAberration * uTexel * 2.0;
  return vec3(
    texture2D(tDiffuse, uv + shift).r,
    texture2D(tDiffuse, uv).g,
    texture2D(tDiffuse, uv - shift).b);
}

void main() {
  vec2 dx = vec2(uTexel.x * uInkWidth, 0.0);
  vec2 dy = vec2(0.0, uTexel.y * uInkWidth);

  vec3 color;

  // --- motion blur --------------------------------------------------------
  //
  // Reprojection, not a radial smear. The pixel's depth gives its world
  // position; running that through the PREVIOUS frame's view-projection says
  // where it was on screen last frame, and the line between the two is the
  // direction this pixel actually travelled. A radial smear from the centre of
  // the screen only happens to look right when driving dead straight, and an
  // earlier attempt at one here darkened the image by fifty levels without
  // blurring anything.
  //
  if (uBlur > 0.0) {
    float raw = texture2D(tDepth, vUv).x;
    // Nothing close gets blurred, and the car is the closest thing there is.
    //
    // The reprojection is only correct for what stands still in the world, so
    // the car -- which travels with the camera -- is handed a false velocity
    // larger than anything else in the frame. Rather than pay for a per-object
    // velocity buffer to tell them apart, distance does it: at a five-metre
    // chase the car spans about three to eight metres and the world worth
    // blurring is well beyond that. Measured before this ramp existed, the car
    // lost 35% of its detail against the world's 9.5%.
    //
    // The cost is honest and small: the strip of road immediately under the
    // camera is left sharp too. It is a sliver at the very bottom of the
    // frame, and near-field road is where a smear reads as mud anyway.
    float near = uBlurNear <= 0.0 ? 1.0
      : smoothstep(uBlurNear, uBlurFar, linearDepth(vUv));
    vec4 clip = vec4(vUv * 2.0 - 1.0, raw * 2.0 - 1.0, 1.0);
    vec4 world = uInvViewProj * clip;
    world /= world.w;
    vec4 prev = uPrevViewProj * world;
    vec2 prevUv = (prev.xy / prev.w) * 0.5 + 0.5;

    vec2 velocity = (vUv - prevUv) * uBlur * near;
    float len = length(velocity);
    if (len > uBlurMax) velocity *= uBlurMax / len;

    vec3 sum = vec3(0.0);
    float total = 0.0;
    for (int i = 0; i < 16; i++) {
      if (i >= uBlurSamples) break;
      float t = float(i) / float(uBlurSamples - 1) - 0.5;
      sum += fetch(clamp(vUv + velocity * t, 0.0, 1.0));
      total += 1.0;
    }
    color = sum / max(total, 1.0);
  } else {
    color = fetch(vUv);
  }

  // --- ink ----------------------------------------------------------------
  //
  // Depth uses the SECOND difference. A flat plane receding from the camera is
  // a huge depth gradient, so a first-difference detector inks the entire
  // ground near the horizon; the second difference cancels any linear ramp and
  // only a real discontinuity survives. Divided by distance so a silhouette
  // 200 m away inks as readably as one at 5 m.
  if (uInk > 0.0) {
    float c  = linearDepth(vUv);
    float ex = abs(linearDepth(vUv - dx) + linearDepth(vUv + dx) - 2.0 * c);
    float ey = abs(linearDepth(vUv - dy) + linearDepth(vUv + dy) - 2.0 * c);
    float dEdge = smoothstep(uInkDepthThreshold, uInkDepthThreshold * 2.2,
                             max(ex, ey) / max(c, 1e-3));

    // Colour catches what depth cannot: the boundary between two materials on
    // one solid object, and the step between two shading bands.
    float gx = abs(luma(texture2D(tDiffuse, vUv - dx).rgb)
                   - luma(texture2D(tDiffuse, vUv + dx).rgb));
    float gy = abs(luma(texture2D(tDiffuse, vUv - dy).rgb)
                   - luma(texture2D(tDiffuse, vUv + dy).rgb));
    float cEdge = smoothstep(uInkColorThreshold, uInkColorThreshold * 2.0, max(gx, gy));

    float e = clamp(max(dEdge * uInkDepth, cEdge * uInkColorEdge), 0.0, 1.0) * uInk;
    color = mix(color, uInkColor, e);
  }

  // Added, not mixed. Glow is light arriving on top of what is already there.
  if (uBloom > 0.0) color += texture2D(tBloom, vUv).rgb * uBloom;

  color *= uExposure;
  color = uGain * pow(max(color + uLift, 0.0), 1.0 / uGamma);

  float r = length(vUv - 0.5) * 1.4142;
  color *= 1.0 - uVignette * smoothstep(uVignetteSoft, 1.0, r);

  gl_FragColor = vec4(color, 1.0);
}`;

const RT_OPTS = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };

export class CompositePass extends Pass {
  constructor(params, fx, camera) {
    super();
    this.params = params;
    this.fx = fx;
    this.camera = camera;
    this.superScale = 1;
    this.frameDelta = 1 / 60;
    // How fast the car is going, so the blur can stay out of the way until it
    // means something. null when nobody told us, in which case it does not
    // gate at all -- the editor has no car.
    this.speedKmh = null;

    this._prevViewProj = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._historyValid = false;


    this.rtA = new THREE.WebGLRenderTarget(1, 1, RT_OPTS);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, RT_OPTS);
    this._bloomTexel = new THREE.Vector2(1, 1);

    this.thresholdMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.8 }, uKnee: { value: 0.5 } },
      vertexShader: VERT, fragmentShader: THRESHOLD_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: VERT, fragmentShader: BLUR_FRAG,
      depthTest: false, depthWrite: false,
    });

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        tBloom: { value: null },
        uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uNear: { value: camera.near },
        uFar: { value: camera.far },

        uInk: { value: 0 },
        uInkWidth: { value: 1 },
        uInkDepth: { value: 1 },
        uInkColorEdge: { value: 0.5 },
        uInkDepthThreshold: { value: 0.014 },
        uInkColorThreshold: { value: 0.1 },
        uInkColor: { value: new THREE.Color(0x1a1720) },

        uBlur: { value: 0 },
        uBlurMax: { value: 0.05 },
        uBlurNear: { value: 9 },
        uBlurFar: { value: 16 },
        uBlurSamples: { value: 8 },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },

        uBloom: { value: 0 },
        uLift: { value: new THREE.Vector3() },
        uGamma: { value: new THREE.Vector3(1, 1, 1) },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uExposure: { value: 1 },
        uVignette: { value: 0 },
        uVignetteSoft: { value: 0.7 },
        uAberration: { value: 0 },
      },
      vertexShader: VERT, fragmentShader: FRAG,
      depthTest: false, depthWrite: false,
    });

    this.quad = new FullScreenQuad();
  }

  resetHistory() {
    this._historyValid = false;
  }

  setSize(width, height) {
    this.material.uniforms.uTexel.value.set(1 / width, 1 / height);
    const w = Math.max(1, Math.ceil(width / 4));
    const h = Math.max(1, Math.ceil(height / 4));
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this._bloomTexel.set(1 / w, 1 / h);
  }

  bloomAmount() {
    return this.fx.bloom ? this.params.bloom : 0;
  }

  syncUniforms() {
    const p = this.params;
    const f = this.fx;
    const u = this.material.uniforms;

    u.uInk.value = f.ink ? p.inkStrength : 0;
    // In supersampled pixels, so the line keeps the thickness asked for on
    // screen. The kernel doubles as the detector's sampling distance, so this
    // also keeps the thresholds meaning the same thing at every resolution --
    // without it, raising the render scale quietly stops finding edges as well
    // as making them look better.
    u.uInkWidth.value = p.inkWidth * this.superScale;
    u.uInkDepth.value = p.inkDepth;
    u.uInkColorEdge.value = p.inkColorEdge;
    u.uInkDepthThreshold.value = p.inkDepthThreshold;
    u.uInkColorThreshold.value = p.inkColorThreshold;
    u.uInkColor.value.set(p.inkColor);

    // Speed gate, on top of the frame-rate normalisation.
    //
    // The reprojection is proportional to how far the camera moved, so without
    // a gate there is a little blur at every speed -- which reads as a soft
    // picture rather than as going fast. Held at zero up to blurFromKmh and
    // faded in over the next stretch, so it arrives as something that happens
    // when you are quick, which is the whole point of it.
    let gate = 1;
    if (this.speedKmh !== null && p.blurFromKmh > 0) {
      const span = Math.max(1, p.blurFullKmh - p.blurFromKmh);
      gate = Math.min(1, Math.max(0, (Math.abs(this.speedKmh) - p.blurFromKmh) / span));
    }
    // Normalised to a 60 Hz frame: the reprojection measures how far the
    // camera moved since the LAST frame, so on a slow frame it moved further
    // and the smear would grow. Blur must not advertise the frame rate.
    u.uBlur.value = f.motionBlur
      ? p.blurStrength * gate * (1 / 60) / Math.max(this.frameDelta, 1e-4)
      : 0;
    u.uBlurMax.value = p.blurMax;
    u.uBlurNear.value = p.blurNear;
    u.uBlurFar.value = p.blurFar;
    u.uBlurSamples.value = Math.max(2, Math.min(16, Math.round(p.blurSamples)));

    u.uBloom.value = this.bloomAmount();

    if (f.grade) {
      u.uLift.value.fromArray(p.lift);
      u.uGamma.value.fromArray(p.gamma);
      u.uGain.value.fromArray(p.gain);
      u.uExposure.value = p.exposure;
    } else {
      u.uLift.value.set(0, 0, 0);
      u.uGamma.value.set(1, 1, 1);
      u.uGain.value.set(1, 1, 1);
      u.uExposure.value = 1;
    }
    u.uVignette.value = f.vignette ? p.vignette : 0;
    u.uVignetteSoft.value = p.vignetteSoftness;
    u.uAberration.value = f.aberration ? p.aberration : 0;

    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
  }

  /**
   * The reprojection: where each pixel's world point sat on last frame's
   * screen. Correct for anything that stands still in the world, which is the
   * road, the scenery and the hills -- and wrong for the car.
   *
   * Wrong because the car travels WITH the camera, so its world position moves
   * between frames, and this assumes it did not. The maths then hands it a
   * screen displacement equal to the camera's own travel; since the car sits
   * five metres from the eye and the road ahead sits thirty, that false
   * displacement is the largest in the frame. Measured at 160 km/h: the car
   * lost 35% of its detail and the world only 9.5%, so the one object that
   * should be sharp was four times the blurriest thing on screen.
   *
   * There is no second matrix that fixes it. Anchoring the reprojection to the
   * car looks like it should -- and is exactly nothing, because with a chase
   * camera rigidly following the car, a "previous camera in the car's frame"
   * IS the previous camera. Car pixels and world pixels genuinely need
   * different transforms, which is why real engines render a velocity buffer
   * per object rather than deriving one from the camera.
   *
   * What this does instead is refuse to blur what is close. See uBlurNear.
   */
  updateMatrices() {
    const cam = this.camera;
    this._viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.material.uniforms.uInvViewProj.value.copy(this._viewProj).invert();
    // First frame, or the first after a respawn: there is no previous camera to
    // reproject from, and using a stale one smears the entire screen.
    if (!this._historyValid) this._prevViewProj.copy(this._viewProj);
    this.material.uniforms.uPrevViewProj.value.copy(this._prevViewProj);
    this._prevViewProj.copy(this._viewProj);
    this._historyValid = true;
  }

  render(renderer, writeBuffer, readBuffer) {
    this.syncUniforms();
    this.updateMatrices();

    if (this.bloomAmount() > 0) {
      const t = this.thresholdMat.uniforms;
      t.tDiffuse.value = readBuffer.texture;
      t.uThreshold.value = this.params.bloomThreshold;
      t.uKnee.value = this.params.bloomKnee;
      this.quad.material = this.thresholdMat;
      renderer.setRenderTarget(this.rtA);
      this.quad.render(renderer);

      this.blurMat.uniforms.tDiffuse.value = this.rtA.texture;
      this.blurMat.uniforms.uDir.value.set(this._bloomTexel.x, 0);
      this.quad.material = this.blurMat;
      renderer.setRenderTarget(this.rtB);
      this.quad.render(renderer);

      this.blurMat.uniforms.tDiffuse.value = this.rtB.texture;
      this.blurMat.uniforms.uDir.value.set(0, this._bloomTexel.y);
      renderer.setRenderTarget(this.rtA);
      this.quad.render(renderer);
    }

    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    // Read off the incoming buffer rather than held from construction, so a
    // resize that reallocates the target cannot leave this pointing at a
    // disposed texture. Null when nothing asked for depth, in which case
    // neither branch that reads it is running.
    u.tDepth.value = readBuffer.depthTexture || null;
    // Always bound: an unbound sampler is a warning in every browser, and
    // stale contents multiplied by a bloom of zero contribute nothing.
    u.tBloom.value = this.rtA.texture;

    this.quad.material = this.material;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (!this.renderToScreen && this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.thresholdMat.dispose();
    this.blurMat.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
