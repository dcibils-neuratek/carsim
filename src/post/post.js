// Post-processing: an ordered stack of effects, each switched on its own.
//
// This started life alongside two alternative render styles -- a ligne-claire
// look and a synthwave night -- which were built, driven, and dropped: they
// made the game prettier and no more fun to play, which is the only test that
// counts here. What survived is this, because effects that can be flipped on
// and off while driving are useful whatever the world looks like.
//
// The one rule that cannot bend: with every effect off, nothing renders
// through a composer at all. EffectComposer draws into a render target, and
// the canvas's own `antialias: true` does not apply there -- routing an
// untouched frame through it would cost a full-screen blit AND lose the MSAA.
// No effects means renderer.render(), straight to the canvas, exactly as the
// game has always drawn it.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CompositePass } from './compositePass.js';
import { TARGET_IS_LINEAR } from './colorspace.js';

/**
 * Which effects are on. All off by default -- the game as it is.
 *
 * Order here is the order of the number keys AND the order things happen to
 * the picture, which is one less thing to hold in your head.
 */
export const FX = {
  supersample: false,
  ink: false,
  motionBlur: false,
  bloom: false,
  grade: false,
  vignette: false,
  aberration: false,
};

export const EFFECTS = [
  { id: 'supersample', label: 'supersample (AA)' },
  { id: 'ink', label: 'ink outline' },
  { id: 'motionBlur', label: 'motion blur' },
  { id: 'bloom', label: 'bloom' },
  { id: 'grade', label: 'colour grade' },
  { id: 'vignette', label: 'vignette' },
  { id: 'aberration', label: 'colour fringe' },
];

/** Every knob every effect has. Read each frame, so sliders move the picture. */
export const POST = {
  // Drawn this much bigger than the canvas, then averaged down.
  //
  // The only thing that antialiases a line computed in post. Multisampling
  // resolves the geometry before the ink is drawn, so it cannot help it --
  // measured on Forest, the ink took the share of partially-covered edge
  // pixels from 42% down to 4%. Combined with the device pixel ratio and
  // capped at MAX_RATIO, because a Retina panel already supplies the density.
  renderScale: 1.5,

  // --- ink ------------------------------------------------------------------
  inkStrength: 1.0,
  inkWidth: 1.8,
  inkDepth: 1.0,          // weight of silhouette and depth discontinuities
  inkColorEdge: 0.5,      // weight of material and shading boundaries
  inkDepthThreshold: 0.014,
  inkColorThreshold: 0.10,
  inkColor: 0x1a1720,

  // --- motion blur ----------------------------------------------------------
  // Reprojected from the previous frame's camera, not a radial smear from the
  // centre of the screen. An earlier attempt at this was radial, was measured
  // to darken the image by 45-51 levels without blurring anything, and was
  // taken out because it hurt to drive with. It is opt-in now, which is what
  // it should always have been.
  // Raised once the near cutoff arrived: with the whole near field excluded,
  // the effect only has the far half of the frame to work in, and 0.6 there
  // barely showed. Measured at 160 km/h it takes 3.6% of the world's detail at
  // 0.6 and 5.2% at 1.2, with the car untouched at either.
  // Nothing below blurFromKmh, full by blurFullKmh. A little blur at every
  // speed just reads as a soft picture; arriving with speed is what makes it
  // mean speed.
  blurFromKmh: 100,
  blurFullKmh: 190,
  // Raised again with the gate in place: it now has only the fast half of the
  // range to work in, so it can afford to be worth seeing when it shows up.
  blurStrength: 2.2,
  blurSamples: 8,
  // The cap was clipping the top end: 60 and 160 km/h were coming out only
  // 1.6x apart in blur when they should be nearly three. Blur that does not
  // grow with speed is not telling you anything about speed.
  blurMax: 0.09,          // cap on the smear, in screen widths
  // Everything nearer than blurNear stays sharp, ramping to full by blurFar.
  // This is what keeps the car out of it -- see compositePass.
  blurNear: 9,
  blurFar: 16,

  // --- bloom ----------------------------------------------------------------
  bloom: 0.8,
  bloomThreshold: 0.8,
  bloomKnee: 0.45,

  // --- grade ----------------------------------------------------------------
  exposure: 1.0,
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],

  // --- lens -----------------------------------------------------------------
  vignette: 0.28,
  vignetteSoftness: 0.7,
  aberration: 1.0,        // px at the corners
};

// Total pixel density the chain will ever draw at, device ratio included.
const MAX_RATIO = 2;

let composer = null;
let composite = null;
// Everything the built chain depends on. The camera is in here because both
// the RenderPass and the reprojection hold a reference to it from build time:
// hand renderFrame a different camera and the chain would keep drawing with
// the old one, or throw on a half-built matrix. It cannot happen in the game,
// where there is exactly one camera for the session -- but a module that
// silently ignores one of its own inputs is a trap for whoever adds the second.
let builtFor = { w: 0, h: 0, dpr: 0, scale: 0, depth: false, camera: null };
const _size = new THREE.Vector2();

/** Anything on? If not, the composer never runs and never gets built. */
export function postActive() {
  return EFFECTS.some((e) => FX[e.id]);
}

// Only two effects read depth, and attaching a depth texture is not free --
// so the target carries one exactly when something wants it.
const wantsDepth = () => FX.ink || FX.motionBlur;
const wantedScale = () => (FX.supersample ? Math.max(1, POST.renderScale) : 1);

function disposeComposer() {
  if (!composer) return;
  composer.renderTarget1.depthTexture?.dispose();
  composer.renderTarget1.dispose();
  composer.renderTarget2.depthTexture?.dispose();
  composer.renderTarget2.dispose();
  for (const pass of composer.passes) pass.dispose?.();
  composer = null;
  composite = null;
}

function build({ renderer, scene, camera }) {
  disposeComposer();

  const size = renderer.getSize(_size);
  const dpr = renderer.getPixelRatio();
  const scale = wantedScale();
  const depth = wantsDepth();
  // Supersampling lives in the composer's pixel ratio, so one number reaches
  // the targets, the depth texture and the passes' idea of a texel together
  // and they cannot disagree. Capped: on a 2x panel the density is already
  // there and multiplying would draw nine times the pixels of a normal screen
  // for a line that was already fine.
  const ratio = Math.max(dpr, Math.min(dpr * scale, MAX_RATIO));
  const w = Math.max(1, Math.floor(size.x * ratio));
  const h = Math.max(1, Math.floor(size.y * ratio));

  // samples: 4 buys back the geometry antialiasing that rendering off-canvas
  // costs -- cheaper and better than an SMAA pass, and it resolves the depth
  // attachment along with the colour.
  const target = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    samples: 4,
  });
  if (depth) target.depthTexture = new THREE.DepthTexture(w, h);

  composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(ratio);
  composer.setSize(size.x, size.y);
  composer.addPass(new RenderPass(scene, camera));
  composite = new CompositePass(POST, FX, camera);
  composite.superScale = ratio / dpr;
  composer.addPass(composite);
  // Linear in, sRGB out. Three only encodes inside the material shaders when
  // the target is the canvas, so the moment a composer is involved the whole
  // chain runs linear and something has to close it.
  composer.addPass(new OutputPass());

  builtFor = { w: size.x, h: size.y, dpr, scale, depth, camera };
}

function stale({ renderer, camera }) {
  if (!composer) return true;
  const size = renderer.getSize(_size);
  return builtFor.w !== size.x || builtFor.h !== size.y
      || builtFor.dpr !== renderer.getPixelRatio()
      || builtFor.scale !== wantedScale()
      || builtFor.depth !== wantsDepth()
      || builtFor.camera !== camera;
}

/**
 * Draw the frame through whatever is switched on.
 *
 * Returns false when nothing is, so the caller can take the direct path --
 * this deliberately does NOT quietly render an untouched frame through the
 * composer, because that is exactly the cost the rule at the top forbids.
 */
/**
 * Draw one frame: through the enabled effects, or straight to the canvas.
 *
 * The single exit point for the whole game. `ctx` is { renderer, scene,
 * camera }; `state` is passed through untouched for effects that ever need to
 * know what the car is doing.
 */
export function renderFrame(dt, ctx, state) {
  if (!renderWithPost(ctx, dt, state)) ctx.renderer.render(ctx.scene, ctx.camera);
}

/** The stack, in pipeline order, which is also number-key order. */
export function listEffects() {
  return EFFECTS.map((e) => ({ id: e.id, label: e.label, on: !!FX[e.id] }));
}

/** Toggle by position, 0-based. Null if there is no effect at that index. */
export function toggleEffect(index) {
  const e = EFFECTS[index];
  if (!e) return null;
  FX[e.id] = !FX[e.id];
  try { localStorage.setItem(FX_KEY, JSON.stringify(FX)); } catch { /* ignore */ }
  return { label: e.label, on: FX[e.id] };
}

const FX_KEY = 'vroom.fx';

/** Restore last session's switches. Only keys we know about, so a stale entry
 *  from an older build cannot switch on something that no longer exists. */
export function loadEffects() {
  try {
    const raw = JSON.parse(localStorage.getItem(FX_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      for (const e of EFFECTS) if (e.id in raw) FX[e.id] = !!raw[e.id];
    }
  } catch { /* private browsing */ }
  // A query param pins the stack for a link or a screenshot: ?fx=bloom,ink
  const asked = new URLSearchParams(location.search).get('fx');
  if (asked !== null) {
    const want = new Set(asked.split(',').map((s) => s.trim()));
    for (const e of EFFECTS) FX[e.id] = want.has(e.id);
  }
}

export function renderWithPost(ctx, dt, state) {
  // Told before anything draws, because the hand-written shaders -- sky, skid
  // marks, smoke -- have to know whether they are writing to the canvas or
  // into a linear target, and pre-cancel the encode when it is the latter.
  // Without it, switching on any effect visibly repainted the sky: measured
  // on Forest, (12,51,114) became (62,123,178). See colorspace.js.
  TARGET_IS_LINEAR.value = postActive() ? 1 : 0;

  if (!postActive()) {
    disposeComposer();
    return false;
  }
  if (stale(ctx)) build(ctx);
  composite.frameDelta = dt;
  composite.speedKmh = state?.vehicle?.speedKmh ?? null;
  composer.render(dt);
  return true;
}

/** Reset the reprojection history. Call after a teleport, or the first frame
 *  back from a menu smears the whole screen. */
export function resetPostHistory() {
  composite?.resetHistory();
}
