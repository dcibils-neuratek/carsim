// The track file format: load, validate, normalise.
//
// A `.track.json` describes a circuit as a RECIPE, not as geometry: a
// centerline, road width, terrain rules and a palette. The road mesh,
// collider, curbs, terrain heightfield, tree scatter and lap timing are all
// derived from it at load time by src/track.js.
//
// That choice is deliberate. Baking the geometry into the file would make an
// editor WYSIWYG, but it would also freeze every track against the smoothing
// pipeline of the day it was saved -- and this project has changed that
// pipeline three times, reshaping all four circuits each time. Keeping the
// file parametric and having the editor call the *same* sampleCircuit() the
// game calls gets WYSIWYG without the staleness, and keeps a track at ~5 kB of
// hand-editable text.
//
// This module is the schema boundary. The file layout is nested and semantic
// (road / terrain / environment / scenery) because that is what an editor and
// a human want; the runtime shape it normalises to is flat because that is what
// Track and Scene already consume. When the format goes to v2, only `normalise`
// and `migrate` here need to change -- no renderer or physics code does.

export const FORMAT = 'carsim.track';
export const VERSION = 1;

// ---------------------------------------------------------------- colours --

/**
 * Colours are `#rrggbb` strings in the file and 24-bit numbers at runtime.
 *
 * JSON has no hex literal, so `0x74b6e8` would have to be written as the
 * decimal 7648488 -- unreadable in a diff and unwritable by hand. Every colour
 * tool and every editor colour-picker speaks `#rrggbb`, so the file does too.
 */
export function parseColor(value, where) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new TrackFormatError(`${where}: expected a colour like "#rrggbb", got ${JSON.stringify(value)}`);
  }
  return parseInt(value.slice(1), 16);
}

/** The inverse, for an editor or exporter writing a file back out. */
export function formatColor(value) {
  if (typeof value === 'string') return value;
  return `#${(value >>> 0).toString(16).padStart(6, '0')}`;
}

// ------------------------------------------------------------- validation --

export class TrackFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrackFormatError';
  }
}

function require_(obj, path, kind) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === undefined || cur === null) {
      throw new TrackFormatError(`missing required field "${path}"`);
    }
    cur = cur[p];
  }
  if (cur === undefined || cur === null) {
    throw new TrackFormatError(`missing required field "${path}"`);
  }
  if (kind === 'number' && (typeof cur !== 'number' || !Number.isFinite(cur))) {
    throw new TrackFormatError(`"${path}" must be a finite number, got ${JSON.stringify(cur)}`);
  }
  if (kind === 'string' && typeof cur !== 'string') {
    throw new TrackFormatError(`"${path}" must be a string, got ${JSON.stringify(cur)}`);
  }
  if (kind === 'array' && !Array.isArray(cur)) {
    throw new TrackFormatError(`"${path}" must be an array, got ${JSON.stringify(cur)}`);
  }
  return cur;
}

function positive(obj, path) {
  const v = require_(obj, path, 'number');
  if (v <= 0) throw new TrackFormatError(`"${path}" must be greater than zero, got ${v}`);
  return v;
}

function range2(value, where) {
  if (!Array.isArray(value) || value.length !== 2 ||
      !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new TrackFormatError(`${where}: expected a [min, max] pair of numbers`);
  }
  if (value[0] > value[1]) {
    throw new TrackFormatError(`${where}: min ${value[0]} is greater than max ${value[1]}`);
  }
  return [value[0], value[1]];
}

/**
 * Structural validation: is this a well-formed track file?
 *
 * This checks the *shape* only -- that fields exist, have the right types and
 * are within sane bounds. It says nothing about whether the resulting circuit
 * is driveable; that needs the sampled centerline, and lives in the geometry
 * checks in test/physics-tests.js (corner radius, self-overlap, terrain
 * clearance). An editor wants both: this one on every keystroke, those on
 * every drag of a control point.
 *
 * Throws TrackFormatError with a message naming the offending field, because
 * "missing required field road.halfWidth" is worth ten minutes of a stack
 * trace from somewhere inside the mesh builder.
 */
export function validateTrackFile(raw, source = 'track file') {
  if (!raw || typeof raw !== 'object') {
    throw new TrackFormatError(`${source}: not a JSON object`);
  }
  if (raw.format !== FORMAT) {
    throw new TrackFormatError(
      `${source}: expected "format": "${FORMAT}", got ${JSON.stringify(raw.format)}`,
    );
  }
  if (raw.version !== VERSION) {
    throw new TrackFormatError(
      `${source}: version ${raw.version} is not supported (this build reads version ${VERSION})`,
    );
  }

  require_(raw, 'id', 'string');
  require_(raw, 'name', 'string');

  positive(raw, 'road.halfWidth');
  const curb = require_(raw, 'road.curbWidth', 'number');
  if (curb < 0) throw new TrackFormatError('"road.curbWidth" cannot be negative');

  const pts = require_(raw, 'road.controlPoints', 'array');
  if (pts.length < 4) {
    throw new TrackFormatError(
      `"road.controlPoints" needs at least 4 points to close a loop, got ${pts.length}`,
    );
  }
  pts.forEach((p, i) => {
    if (!Array.isArray(p) || p.length !== 3 ||
        !p.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new TrackFormatError(
        `road.controlPoints[${i}]: expected [x, y, z] of finite numbers, got ${JSON.stringify(p)}`,
      );
    }
  });

  const grip = require_(raw, 'road.surface.roadGrip', 'number');
  if (grip <= 0 || grip > 2) {
    throw new TrackFormatError(`"road.surface.roadGrip" should be in (0, 2], got ${grip}`);
  }

  const bank = require_(raw, 'road.banking.maxDegrees', 'number');
  if (bank < 0 || bank > 25) {
    throw new TrackFormatError(`"road.banking.maxDegrees" should be in [0, 25], got ${bank}`);
  }

  const slope = require_(raw, 'terrain.envelope.slope', 'number');
  if (slope <= 0) throw new TrackFormatError('"terrain.envelope.slope" must be greater than zero');

  const palette = require_(raw, 'environment.palette');
  for (const [key, value] of Object.entries(palette)) {
    parseColor(value, `environment.palette.${key}`);
  }
  parseColor(require_(raw, 'environment.sun.color'), 'environment.sun.color');

  const sunPos = require_(raw, 'environment.sun.position', 'array');
  if (sunPos.length !== 3 || !sunPos.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new TrackFormatError('"environment.sun.position" must be [x, y, z]');
  }

  if (raw.environment.ambient !== undefined) {
    const amb = raw.environment.ambient;
    if (typeof amb !== 'object' || amb === null || Array.isArray(amb)) {
      throw new TrackFormatError('"environment.ambient" must be an object');
    }
    if (typeof amb.intensity !== 'number' || !(amb.intensity >= 0 && amb.intensity <= 4)) {
      throw new TrackFormatError(
        `"environment.ambient.intensity" should be a number in [0, 4], got ${amb.intensity}`,
      );
    }
    if (amb.sky !== undefined) parseColor(amb.sky, 'environment.ambient.sky');
    if (amb.ground !== undefined) parseColor(amb.ground, 'environment.ambient.ground');
  }

  const fogNear = require_(raw, 'environment.fog.near', 'number');
  const fogFar = require_(raw, 'environment.fog.far', 'number');
  if (fogFar <= fogNear) {
    throw new TrackFormatError(`environment.fog: far (${fogFar}) must exceed near (${fogNear})`);
  }

  range2(require_(raw, 'scenery.trees.height'), 'scenery.trees.height');
  range2(require_(raw, 'scenery.trees.radius'), 'scenery.trees.radius');
  range2(require_(raw, 'scenery.ridges.height'), 'scenery.ridges.height');

  // Reserved sections. Accepted by the schema so an editor can round-trip a
  // file without losing work, but nothing renders them yet -- warn rather than
  // fail, so a file authored against a later build still loads and drives.
  for (const key of ['water', 'features', 'props']) {
    if (raw[key] !== undefined) {
      console.warn(
        `${source}: "${key}" is reserved and not implemented in this build -- ignoring it.`,
      );
    }
  }

  return raw;
}

// ------------------------------------------------------------------ merge --

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep-merge a track over the shared defaults, so a file only states what
 * differs from `defaults.track.json`. Arrays replace wholesale -- a partially
 * overridden control-point list or [min, max] pair is never what anyone means.
 */
export function mergeDefaults(defaults, override) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeDefaults(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// -------------------------------------------------------------- normalise --

/**
 * Turn a validated file into the flat object the runtime consumes.
 *
 * The file layout and the runtime layout are deliberately allowed to diverge:
 * the file is grouped by what a person thinks about (the road, the terrain,
 * the weather), the runtime shape is flat because Track and Scene read it on
 * hot paths. This function is the only place that knows both.
 */
export function normaliseTrack(raw) {
  const palette = {};
  for (const [key, value] of Object.entries(raw.environment.palette)) {
    palette[key] = parseColor(value, `palette.${key}`);
  }

  const trees = raw.scenery.trees;
  const ridges = raw.scenery.ridges;

  return {
    id: raw.id,
    name: raw.name,
    tagline: raw.tagline ?? '',
    difficulty: raw.difficulty ?? 'Medium',
    notes: raw.notes ?? [],

    halfWidth: raw.road.halfWidth,
    curbWidth: raw.road.curbWidth,
    // Painted markings are a sealed-road thing. A gravel stage has none, and
    // a dashed white line down the middle of one is the single fastest way to
    // make dirt read as badly-coloured tarmac.
    centerLine: raw.road.centerLine !== false,
    controlPoints: raw.road.controlPoints.map((p) => [p[0], p[1], p[2]]),
    banking: { ...raw.road.banking },
    surface: { ...raw.road.surface },

    hills: { ...raw.terrain.hills },
    envSlope: raw.terrain.envelope.slope,
    roadClearance: raw.terrain.envelope.roadClearance,

    palette,
    fog: { ...raw.environment.fog },
    sun: {
      color: parseColor(raw.environment.sun.color, 'sun.color'),
      intensity: raw.environment.sun.intensity,
      position: [...raw.environment.sun.position],
    },
    // Sky fill. Optional, and the shape of it is what makes a time of day:
    // the ratio between this and the sun is what sets how deep a shadow goes,
    // which reads as the hour far more strongly than the sun's colour does.
    // Omitted means the old fixed 1.15, i.e. midday.
    ambient: raw.environment.ambient ? {
      intensity: raw.environment.ambient.intensity,
      ...(raw.environment.ambient.sky
        ? { sky: parseColor(raw.environment.ambient.sky, 'ambient.sky') } : {}),
      ...(raw.environment.ambient.ground
        ? { ground: parseColor(raw.environment.ambient.ground, 'ambient.ground') } : {}),
    } : null,

    scenery: {
      treeCount: trees.count,
      treeHeight: [...trees.height],
      treeRadius: [...trees.radius],
      treeSegments: trees.segments,
      treeClearance: trees.clearance,
      ridgeCount: ridges.count,
      ridgeHeight: [...ridges.height],
      ridgeRadius: ridges.radius,
      ridgeJitter: ridges.jitter,
      postSpacing: raw.scenery.posts.spacing,
    },

    // The file this came from, verbatim and post-merge. An editor needs the
    // authored form to write back out, and keeping it here means a round trip
    // never has to reconstruct one from the flattened runtime values.
    source: raw,
  };
}

// ------------------------------------------------------------------- load --

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new TrackFormatError(`could not load ${url} (HTTP ${res.status} ${res.statusText})`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new TrackFormatError(`${url} is not valid JSON: ${err.message}`);
  }
}

/**
 * Read one track file from a URL and return it ready for `new Track(...)`.
 * `defaults` is an already-loaded defaults file, or null to use the file alone.
 */
export async function loadTrackFile(url, defaults = null) {
  const raw = await fetchJson(url);
  const merged = defaults ? mergeDefaults(defaults, raw) : raw;
  // Identity fields come from the track, never from the defaults it merged over.
  merged.format = raw.format ?? merged.format;
  merged.version = raw.version ?? merged.version;
  validateTrackFile(merged, url);
  return normaliseTrack(merged);
}
