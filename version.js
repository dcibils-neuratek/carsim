// Which build is this?
//
// Deploy metadata, not game code, which is why it sits at the root beside the
// two pages that use it rather than inside src/.
//
// The whole value of a version stamp is that it changes WITHOUT anyone
// remembering to change it. A hand-bumped constant answers "what did I last
// type" rather than "what is actually live", and the one time it matters is
// the one time it was forgotten. So version.json is written by the build from
// the commit it is building, and the copy committed here says "dev" -- which
// is exactly what you want to see when running locally, and a loud signal if
// it ever shows up in production.
//
// Fills every [data-version] element on the page and asks for nothing else.

const FALLBACK = { sha: 'dev', ref: 'local', built: null };

/** Read the stamp. Never throws -- a missing version is not worth a broken page. */
export async function readVersion() {
  try {
    // no-store, or the CDN happily serves yesterday's stamp alongside today's
    // build and the readout says the deploy did not happen when it did. This
    // one file must never be cached; it is the thing that reports caching.
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return FALLBACK;
    const v = await res.json();
    return { ...FALLBACK, ...v };
  } catch {
    return FALLBACK;
  }
}

/** Short, and safe to read at a glance: `a1b2c3d` or `dev`. */
export function shortSha(v) {
  return typeof v.sha === 'string' ? v.sha.slice(0, 7) : 'dev';
}

export async function stampVersion() {
  const targets = document.querySelectorAll('[data-version]');
  if (!targets.length) return null;
  const v = await readVersion();
  const short = shortSha(v);
  const when = v.built
    ? new Date(v.built).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    : null;
  for (const el of targets) {
    el.textContent = when ? `${short} · ${when}` : short;
    el.title = v.built ? `${v.sha} — built ${v.built}` : 'running from a working copy';
    el.classList.toggle('dev', short === 'dev');
  }
  return v;
}

stampVersion();
