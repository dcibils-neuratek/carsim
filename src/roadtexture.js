// The road's surface maps.
//
// Loaded asynchronously and attached to a material that is already on screen,
// so the track never waits on them: if the files are missing, slow or blocked,
// the road stays exactly as it was built and the game runs. A photograph of
// tarmac is an improvement to the road, not a dependency of it.
//
// Textures at all are a departure for this project -- scene.js still says the
// look comes from hard facets and a small palette "not from assets", and that
// is still true of everything except this one surface. The road earns the
// exception because it is the only thing in the world you look at from two
// metres away at 200 km/h, and because a surface with no detail on it cannot
// show that it is moving. Measured before any of this: the near field of the
// frame carried no local contrast at all.
//
// Sources: Poliigon's free library. Note they ship GLOSS where some vendors
// ship roughness, and the two are opposites -- see the dirt set below.

import * as THREE from 'three';

const BASE = 'assets/textures/';

// Fallback for anything that does not say. Every set should say.
export const TILE_METRES = 2.0;

/**
 * The surfaces, and what each map is FOR.
 *
 * `tile` is how much ground one repeat covers, in metres, as published by
 * whoever scanned it. Using the real figure is what keeps the grain the size
 * of actual grit rather than of gravel.
 *
 * A map named here is a map this material can use. The sets deliberately do
 * not list everything the vendors ship: ambient occlusion needs a second UV
 * set, bump duplicates the normal map, displacement needs tessellation, and
 * reflectivity belongs to a specular workflow this material is not. Those were
 * downloaded and deleted rather than left lying around looking load-bearing.
 */
const SETS = {
  asphalt: {
    // Poliigon like the gravel, so the same gloss/roughness inversion applies.
    // If the grain ever looks the wrong size on the road, `tile` is the only
    // number to change -- it is metres of ground per repeat, and it is the
    // vendor's figure rather than anything derived.
    tile: 2.0,
    map: 'asphalt_col_2k.jpg',
    normalMap: 'asphalt_nrm_2k.jpg',
    roughnessMap: { file: 'asphalt_gloss_2k.jpg', invert: true },
  },
  dirt: {
    tile: 3.0,
    map: 'dirt_col_1k.jpg',
    normalMap: 'dirt_nrm_1k.jpg',
    // GLOSS, not roughness -- and they are opposites.
    //
    // Poliigon ships gloss where Poly Haven ships roughness, and three has no
    // slot for gloss. Bound straight into roughnessMap it would make the dirt
    // shiniest exactly where it is meant to be most matte, which reads as wet
    // tarmac rather than as a bug. Inverted once at load instead.
    roughnessMap: { file: 'dirt_gloss_1k.jpg', invert: true },
  },
};

/** Metres of ground per repeat, for whoever is generating the UVs. */
export function tileMetres(name) {
  return SETS[name]?.tile ?? TILE_METRES;
}


/**
 * Make a photograph tile.
 *
 * A scanned material tiles because it was made to; a stock photo does not, and
 * this one was measured before use: its wrap-around seam is 1.7x a normal
 * step between neighbouring columns, and -- much worse -- it is lit from above,
 * leaving a 15.6 level brightness gradient top to bottom on a mean of 105.
 * Tiled down a road, where v runs ALONG the direction of travel, that gradient
 * becomes light and dark bands every two metres for the whole lap. The seam is
 * a blemish; the banding is the thing that would have made it unusable.
 *
 * Three steps, all at load, none of them touching the file on disk:
 *
 *   1. Centre-crop to square. The source is 2345x2931, and a rectangular image
 *      stretched onto a square tile would distort the grain by a quarter.
 *   2. Subtract the low frequencies and put the average back. What is left is
 *      the grain, which is the part worth having; what goes is the lighting of
 *      the photograph, which is the part that bands.
 *   3. Hand it back at 1024, which is a fifth of the memory and more detail
 *      than a road surface can show anyway.
 *
 * The remaining seam is dealt with by mirrored wrapping at the sampler, which
 * makes the edges match by construction. Mirroring is visible on anything with
 * structure and invisible on grain, and grain is all this is by the time it
 * gets here.
 */
function prepare(image, size = 1024) {
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const sx = (image.naturalWidth - side) / 2;
  const sy = (image.naturalHeight - side) / 2;

  const full = document.createElement('canvas');
  full.width = size; full.height = size;
  const fg = full.getContext('2d', { willReadFrequently: true });
  fg.drawImage(image, sx, sy, side, side, 0, 0, size, size);

  // The low frequencies, obtained by throwing the image away and bringing it
  // back: a 16 px round trip through the browser's own resampler is a blur
  // that costs nothing and needs no kernel.
  const SMALL = 16;
  const small = document.createElement('canvas');
  small.width = SMALL; small.height = SMALL;
  small.getContext('2d').drawImage(full, 0, 0, SMALL, SMALL);
  const blur = document.createElement('canvas');
  blur.width = size; blur.height = size;
  const bg = blur.getContext('2d', { willReadFrequently: true });
  bg.imageSmoothingEnabled = true;
  // Drawn half a cell oversized, so the interpolated grid lines up with the
  // CENTRES of the small image's cells. Drawn flush, bilinear has nothing
  // outside the outermost centres to interpolate from and clamps them flat --
  // which leaves the last half-cell of each edge uncorrected. Measured: it put
  // a 16 level gradient across the image that the correction was supposed to
  // be removing, and it lands on the road's width.
  const half = size / (SMALL * 2);
  bg.drawImage(small, -half, -half, size + half * 2, size + half * 2);

  const a = fg.getImageData(0, 0, size, size);
  const b = bg.getImageData(0, 0, size, size);
  // Per channel, so a colour cast in the lighting goes with it.
  const meanOf = [0, 0, 0];
  for (let i = 0; i < b.data.length; i += 4) {
    meanOf[0] += b.data[i]; meanOf[1] += b.data[i + 1]; meanOf[2] += b.data[i + 2];
  }
  const px = (size * size);
  for (let k = 0; k < 3; k++) meanOf[k] /= px;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      a.data[i + k] = Math.max(0, Math.min(255, a.data[i + k] - b.data[i + k] + meanOf[k]));
    }
  }
  fg.putImageData(a, 0, 0);
  return full;
}

const cache = new Map();
let loader = null;
let maxAnisotropy = 1;

/**
 * Told once, at boot, by whoever owns the renderer.
 *
 * A setter rather than a renderer threaded through Track's constructor and its
 * three call sites -- the editor and the headless tests build tracks too, and
 * neither of them has a renderer to give.
 */
export function setMaxAnisotropy(n) {
  maxAnisotropy = Math.max(1, n | 0);
}

/**
 * Fetch one map.
 *
 * The colour space is the part that is easy to get wrong and impossible to see
 * yourself getting wrong: a diffuse map holds display-referred colour and must
 * be tagged sRGB, while normals and roughness hold measurements and must stay
 * linear. Tag a normal map as sRGB and the lighting bends in a way that looks
 * like a bad surface rather than a bad flag.
 */
/** Flip a greyscale map end for end: gloss in, roughness out. */
function invertMap(image) {
  const size = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  const c = document.createElement('canvas');
  c.width = size; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, 0, 0);
  const d = g.getImageData(0, 0, size, h);
  for (let i = 0; i < d.data.length; i += 4) {
    d.data[i] = 255 - d.data[i];
    d.data[i + 1] = 255 - d.data[i + 1];
    d.data[i + 2] = 255 - d.data[i + 2];
  }
  g.putImageData(d, 0, 0);
  return c;
}

function fetchMap(file, srgb, anisotropy, condition, invert) {
  const key = `${file}|${anisotropy}|${condition ? 1 : 0}|${invert ? 1 : 0}`;
  if (cache.has(key)) return cache.get(key);

  loader = loader || new THREE.TextureLoader();
  const promise = new Promise((resolve, reject) => {
    loader.load(BASE + file, resolve, undefined, reject);
  }).then((loaded) => {
    if (invert) {
      const tex = new THREE.CanvasTexture(invertMap(loaded.image));
      loaded.dispose();
      return tex;
    }
    if (!condition) return loaded;
    const tex = new THREE.CanvasTexture(prepare(loaded.image));
    loaded.dispose();
    return tex;
  }).then((tex) => {
    // Mirrored on a conditioned photograph, plain repeat on a scan that was
    // authored to tile: mirroring costs a two-tile symmetry that is free to
    // ignore on grain and obvious on anything with structure.
    const wrap = condition ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
    tex.wrapS = wrap;
    tex.wrapT = wrap;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    // The single biggest quality lever on a tiled road, and one line. Without
    // it a surface receding to the horizon turns into crawling noise, because
    // each far pixel is averaging a patch of texture that is much wider than
    // it is tall and an isotropic mip cannot represent that.
    tex.anisotropy = anisotropy;
    return tex;
  });

  cache.set(key, promise);
  return promise;
}

/**
 * The average colour of an image, in the renderer's working space.
 *
 * Measured rather than declared. The first version of the tint below carried a
 * hand-written "this photo looks like #3a3f47", which is a guess about an
 * image nobody had sampled -- and since the tint is a DIVISION by it, a guess
 * that is wrong by a little pushes every circuit's road the wrong way by a
 * lot. Sampling costs one 64x64 draw at load and cannot be wrong.
 */
function meanColour(image) {
  const N = 64;
  const c = document.createElement('canvas');
  c.width = N; c.height = N;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, 0, 0, N, N);
  const d = g.getImageData(0, 0, N, N).data;
  let r = 0, gr = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
  const n = N * N;
  // The pixels are display-referred, so the Color has to be told that or the
  // ratio is taken between values in two different spaces.
  return new THREE.Color().setRGB(r / n / 255, gr / n / 255, b / n / 255, THREE.SRGBColorSpace);
}

/**
 * Attach a surface to a road material, if that surface has one.
 *
 * Fire and forget. Returns a promise for tests, but nothing in the game waits
 * on it, and a failure is logged and dropped rather than thrown -- a missing
 * JPEG must not be able to stop you driving.
 */
export function applyRoadTexture(material, name, paletteColour = null) {
  const set = SETS[name];
  if (!set) return Promise.resolve(false);

  const anisotropy = maxAnisotropy;
  const wanted = Object.entries(set)
    .filter(([slot]) => !['prepare', 'tile'].includes(slot));

  return Promise.all(
    wanted.map(([slot, spec]) => {
      const file = typeof spec === 'string' ? spec : spec.file;
      const invert = typeof spec === 'object' && spec.invert;
      const condition = typeof spec === 'object' && spec.prepare;
      return fetchMap(file, slot === 'map', anisotropy, condition, invert)
        .then((tex) => [slot, tex]);
    }),
  ).then((pairs) => {
    for (const [slot, tex] of pairs) material[slot] = tex;

    // Put each circuit's own road colour back on top of the photograph.
    //
    // A textured road takes its colour from the photo, which quietly threw
    // away the fact that Mediterranean's tarmac is warmer than Forest's, that
    // Woods' is darker and that Snow's is a cool grey -- all four rendered the
    // same image. Dividing the circuit's asphalt by what the photo actually
    // averages gives a multiplier that restores the difference, and leaves a
    // circuit that already agrees with the photo at exactly 1.
    const diffuse = pairs.find(([slot]) => slot === 'map')?.[1];
    if (paletteColour !== null && diffuse?.image) {
      const mean = meanColour(diffuse.image);
      const own = new THREE.Color(paletteColour);
      material.color.setRGB(
        Math.min(4, own.r / Math.max(mean.r, 1e-4)),
        Math.min(4, own.g / Math.max(mean.g, 1e-4)),
        Math.min(4, own.b / Math.max(mean.b, 1e-4)),
        THREE.LinearSRGBColorSpace,
      );
    }
    // Normals from a photograph are strong for a world lit this flatly; half
    // of it reads as grit rather than as a corrugated road.
    if (material.normalScale) material.normalScale.set(0.5, 0.5);
    material.needsUpdate = true;
    return true;
  }).catch((err) => {
    console.warn('road texture unavailable, keeping the plain surface:', err?.message || err);
    return false;
  });
}

export function hasRoadTexture(name) {
  return Boolean(SETS[name]);
}
