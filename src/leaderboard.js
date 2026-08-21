// The high score table, in the arcade sense: ten times per circuit, three
// letters each, and your initials only go up if you earned them.
//
// One board per CIRCUIT, not per circuit and car. Best laps are split by car
// because a time in the SC18 tells you nothing about how well you are driving
// the Alpine -- that is a practice tool and it has to compare like with like.
// A high score table is the opposite: it is one wall that everything competes
// on, the car you brought is part of what you chose, and the board records it
// next to your name so the fast entries have to explain themselves. Splitting
// it thirty-six ways would give a solo player thirty-six empty boards, which
// is not a leaderboard, it is a filing system.

const STORAGE_KEY = 'vroom.leaderboard.v1';

export const BOARD_SIZE = 10;
export const INITIALS = 3;

/** Letters, then a space, so someone can leave a slot blank the way you could. */
export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';

const DEFAULT_INITIALS = 'AAA';

/** Every board, as { circuitId: entry[] }. Empty if unreadable. */
function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};   // private browsing, or someone else's JSON in our key
  }
}

/**
 * Drop anything that is not a well-formed entry.
 *
 * localStorage is a text field the user can edit and an older build may have
 * written, so nothing that comes out of it is trusted enough to render or to
 * sort against without checking first.
 */
function clean(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e === 'object'
      && typeof e.total === 'number' && Number.isFinite(e.total) && e.total > 0
      && typeof e.who === 'string')
    .map((e) => ({
      who: sanitiseInitials(e.who),
      total: e.total,
      car: typeof e.car === 'string' ? e.car : '',
      carId: typeof e.carId === 'string' ? e.carId : '',
      bestLap: typeof e.bestLap === 'number' && Number.isFinite(e.bestLap) ? e.bestLap : null,
      at: typeof e.at === 'number' ? e.at : 0,
    }))
    .sort((a, b) => a.total - b.total)
    .slice(0, BOARD_SIZE);
}

/** Uppercase, only letters the entry screen can produce, exactly three of them. */
export function sanitiseInitials(text) {
  const up = String(text ?? '').toUpperCase();
  let out = '';
  for (const ch of up) {
    if (out.length >= INITIALS) break;
    if (ALPHABET.includes(ch)) out += ch;
  }
  return (out.padEnd(INITIALS, ' ').trim() || DEFAULT_INITIALS)
    .padEnd(INITIALS, ' ').slice(0, INITIALS);
}

/** The board for one circuit, quickest first. */
export function board(circuitId) {
  return clean(loadAll()[circuitId]);
}

/**
 * Where a total would land, 1-based, or null if it would not make the board.
 *
 * Ties go to the time already up there. Whoever set it got there first, and an
 * arcade board that demotes a standing record for an equal time is one that
 * rewards showing up late.
 */
export function rankFor(circuitId, total) {
  if (!(total > 0)) return null;
  const list = board(circuitId);
  const at = list.findIndex((e) => total < e.total);
  if (at === -1) return list.length < BOARD_SIZE ? list.length + 1 : null;
  return at + 1;
}

/**
 * Insert an entry and write the board back. Returns its 1-based rank, or null
 * if it did not make the cut and nothing was written.
 */
export function submit(circuitId, entry) {
  const rank = rankFor(circuitId, entry.total);
  if (rank === null) return null;

  const row = {
    who: sanitiseInitials(entry.who),
    total: entry.total,
    car: entry.car ?? '',
    carId: entry.carId ?? '',
    bestLap: entry.bestLap ?? null,
    at: entry.at ?? 0,
  };

  try {
    // Read-modify-write. The game holds one circuit at a time, so every other
    // board in there belongs to a session that is not this one.
    const all = loadAll();
    all[circuitId] = clean([...clean(all[circuitId]), row]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch { /* full, or private browsing -- the result still stands on screen */ }

  return rank;
}

/** The initials used last, so a returning player does not retype them. */
export function lastInitials() {
  try {
    const v = localStorage.getItem(`${STORAGE_KEY}.who`);
    return v ? sanitiseInitials(v) : DEFAULT_INITIALS;
  } catch {
    return DEFAULT_INITIALS;
  }
}

export function rememberInitials(who) {
  try {
    localStorage.setItem(`${STORAGE_KEY}.who`, sanitiseInitials(who));
  } catch { /* nothing to do -- it is a convenience, not state */ }
}
