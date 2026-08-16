// The track registry.
//
// Circuits are no longer written in code. Each one is a `.track.json` under
// assets/tracks/, listed in assets/tracks/index.json and merged over
// defaults.track.json, so adding a circuit is a data change and an editor can
// write one without touching the game. See docs/track-format.md for the schema
// and src/trackfile.js for the loader, validator and normaliser.
//
// Everything here is async by necessity -- the files are fetched. The whole
// catalogue is loaded once during boot, before the menu is drawn, so after
// `loadTracks()` resolves the rest of the game can use `getTrack()`
// synchronously exactly as it did when the definitions were a module.

import { loadTrackFile, TrackFormatError } from './trackfile.js';

const INDEX_URL = './assets/tracks/index.json';

let catalogue = null;   // id -> normalised runtime definition

export let TRACK_IDS = [];
export let DEFAULT_TRACK = 'forest';

/** Resolve a sibling file against the index's own directory. */
function resolveFrom(indexUrl, name) {
  return indexUrl.replace(/[^/]*$/, '') + name;
}

/**
 * Fetch the catalogue. Idempotent: later calls return the first result.
 *
 * A track that fails to load or validate is skipped with a console error
 * rather than taking the whole game down -- one malformed file out of a
 * directory of them should cost you that circuit, not the ability to drive.
 * If *nothing* loads there is no game, so that does throw.
 */
export async function loadTracks(indexUrl = INDEX_URL) {
  if (catalogue) return catalogue;

  const res = await fetch(indexUrl);
  if (!res.ok) {
    throw new TrackFormatError(`could not load ${indexUrl} (HTTP ${res.status})`);
  }
  const index = await res.json();
  if (index.format !== 'carsim.trackindex') {
    throw new TrackFormatError(
      `${indexUrl}: expected "format": "carsim.trackindex", got ${JSON.stringify(index.format)}`,
    );
  }

  const defaults = index.defaults
    ? await (await fetch(resolveFrom(indexUrl, index.defaults))).json()
    : null;

  // In parallel: four small files, and one slow one shouldn't gate the others.
  const results = await Promise.all(index.tracks.map(async (name) => {
    const url = resolveFrom(indexUrl, name);
    try {
      return await loadTrackFile(url, defaults);
    } catch (err) {
      console.error(`track "${name}" could not be loaded and will be skipped:`, err.message);
      return null;
    }
  }));

  catalogue = {};
  for (const def of results) {
    if (def) catalogue[def.id] = def;
  }

  TRACK_IDS = Object.keys(catalogue);
  if (TRACK_IDS.length === 0) {
    throw new TrackFormatError(`no usable track files found via ${indexUrl}`);
  }
  DEFAULT_TRACK = catalogue[index.default] ? index.default : TRACK_IDS[0];

  return catalogue;
}

/** Every loaded circuit, by id. Empty until `loadTracks()` has resolved. */
export function allTracks() {
  return catalogue ?? {};
}

/** Whether a circuit exists. Safe to call before loading (returns false). */
export function hasTrack(id) {
  return Boolean(catalogue && catalogue[id]);
}

/**
 * One circuit, ready to hand to `new Track(...)`. Falls back to the default
 * circuit for an unknown id, which is what makes `?track=typo` harmless.
 */
export function getTrack(id) {
  if (!catalogue) {
    throw new Error('getTrack() called before loadTracks() resolved');
  }
  return catalogue[id] || catalogue[DEFAULT_TRACK];
}
