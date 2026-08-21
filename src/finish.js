// The results screen, and the bit of it that matters: entering your initials.
//
// Three letters is the whole ceremony an arcade cabinet gave you for winning,
// and it is the reason anyone remembers those boards at all. A dialog asking
// for a display name is not the same thing -- the constraint IS the ritual.
//
// Owns its own DOM and its own key handling. It is modal by nature: while it
// is up, the game is over and nothing else on screen wants the keyboard, so
// taking the keys outright is simpler and less surprising than threading a
// "who has focus" flag through the main loop.

import { formatTime } from './laptimer.js';
import {
  ALPHABET, INITIALS, BOARD_SIZE, board, rankFor, submit,
  lastInitials, rememberInitials, sanitiseInitials,
} from './leaderboard.js';

const ORDINAL = ['', '1st', '2nd', '3rd'];
const ordinal = (n) => ORDINAL[n] ?? `${n}th`;

export class FinishScreen {
  /**
   * @param {HTMLElement} root  the #finish container from index.html
   * @param {(action: string) => void} onAction  'again' | 'menu'
   */
  constructor(root, onAction) {
    this.el = root;
    this.onAction = onAction;
    this.open = false;
    this.entering = false;
    this.letters = lastInitials().split('');
    this.slot = 0;
    this._ctx = null;

    this._onKey = this._onKey.bind(this);
    window.addEventListener('keydown', this._onKey);

    root.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (act) this._act(act);
    });
  }

  /**
   * @param {object} ctx
   *   race     the finished Race
   *   track    { id, name }
   *   car      { id, name }
   *   counted  false when the autopilot drove it
   */
  show(ctx) {
    this._ctx = ctx;
    this.open = true;
    // A rank is only offered if the run counts. The autopilot's laps are shown
    // and timed -- watching it drive is the point of it -- but it does not get
    // to sign the wall.
    this.rank = ctx.counted ? rankFor(ctx.track.id, ctx.race.total) : null;
    this.entering = this.rank !== null;
    this.letters = lastInitials().split('');
    this.slot = 0;
    this.el.classList.add('on');
    this._render();
  }

  hide() {
    this.open = false;
    this.entering = false;
    this.el.classList.remove('on');
  }

  _act(action) {
    if (action === 'submit') return this._commit();
    if (action === 'skip') { this.entering = false; this._render(); return; }
    this.hide();
    this.onAction(action);
  }

  _commit() {
    if (!this.entering || !this._ctx) return;
    const who = sanitiseInitials(this.letters.join(''));
    rememberInitials(who);
    this.rank = submit(this._ctx.track.id, {
      who,
      total: this._ctx.race.total,
      car: this._ctx.car.name,
      carId: this._ctx.car.id,
      bestLap: this._ctx.race.laps[this._ctx.race.bestLapIndex] ?? null,
      // Passed in rather than read here so a replay of the same run cannot
      // quietly restamp itself as newer than the board it is joining.
      at: this._ctx.at ?? 0,
    });
    this.justEntered = who;
    this.entering = false;
    this._render();
  }

  _onKey(e) {
    if (!this.open) return;

    if (this.entering) {
      const step = (d) => {
        const i = ALPHABET.indexOf(this.letters[this.slot]);
        this.letters[this.slot] = ALPHABET[(i + d + ALPHABET.length) % ALPHABET.length];
      };
      if (e.code === 'ArrowUp') { step(1); }
      else if (e.code === 'ArrowDown') { step(-1); }
      else if (e.code === 'ArrowLeft') { this.slot = (this.slot + INITIALS - 1) % INITIALS; }
      else if (e.code === 'ArrowRight') { this.slot = (this.slot + 1) % INITIALS; }
      else if (e.code === 'Backspace') {
        this.slot = Math.max(0, this.slot - 1);
        this.letters[this.slot] = 'A';
      } else if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        this._commit();
        return;
      } else if (/^(Key[A-Z]|Digit[0-9])$/.test(e.code)) {
        // Typing straight in. The stick-and-button version is the authentic
        // one and has to work for a pad, but anyone at a keyboard will try to
        // type their initials first and be annoyed when it does nothing.
        this.letters[this.slot] = e.code.startsWith('Key') ? e.code.slice(3) : e.code.slice(5);
        if (this.slot < INITIALS - 1) this.slot++;
      } else {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      this._render();
      return;
    }

    if (e.code === 'KeyR' || e.code === 'Enter') { this._act('again'); }
    else if (e.code === 'KeyT' || e.code === 'Escape') { this._act('menu'); }
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  _render() {
    const { race, track, car, counted } = this._ctx;
    const best = race.bestLapIndex;
    const rows = race.laps.map((t, i) =>
      `<div class="fRow"><span class="k">LAP ${i + 1}</span>` +
      `<span class="t${i === best ? ' hot' : ''}">${formatTime(t)}` +
      `${i === best ? ' <b>&#9733;</b>' : ''}</span></div>`).join('');

    const list = board(track.id);
    const boardRows = list.length
      ? list.map((e, i) => {
          const mine = this.justEntered && e.who === this.justEntered
            && Math.abs(e.total - race.total) < 1e-6;
          return `<div class="bRow${mine ? ' me' : ''}">` +
            `<span class="pos">${String(i + 1).padStart(2, ' ')}</span>` +
            `<span class="who">${e.who}</span>` +
            `<span class="tot">${formatTime(e.total)}</span>` +
            `<span class="car">${e.car || '—'}</span></div>`;
        }).join('')
      : '<div class="bEmpty">no times yet</div>';

    let entry = '';
    if (this.entering) {
      const slots = this.letters.map((ch, i) =>
        `<span class="slot${i === this.slot ? ' on' : ''}">${ch === ' ' ? '&nbsp;' : ch}</span>`).join('');
      entry = `
        <div class="fEntry">
          <div class="fRank">&#9733; ${ordinal(this.rank)} place &mdash; enter your initials</div>
          <div class="slots">${slots}</div>
          <div class="fHint">type, or <b>&uarr;&darr;</b> letter <b>&larr;&rarr;</b> slot &nbsp;·&nbsp;
            <b>Enter</b> to sign &nbsp;·&nbsp;
            <button type="button" data-act="skip">skip</button></div>
        </div>`;
    } else if (this.justEntered) {
      entry = `<div class="fRank">&#9733; ${ordinal(this.rank)} place</div>`;
    } else if (!counted) {
      entry = '<div class="fNote">autopilot &mdash; not eligible for the board</div>';
    } else {
      entry = `<div class="fNote">${list.length >= BOARD_SIZE
        ? 'not quick enough for the board'
        : 'no place on the board'}</div>`;
    }

    this.el.innerHTML = `
      <div class="fTitle">RACE COMPLETE</div>
      <div class="fWhere">${track.name} &nbsp;·&nbsp; ${car.name} &nbsp;·&nbsp; ${race.totalLaps} laps</div>
      <div class="fTotal">${formatTime(race.total)}</div>
      <div class="fLaps">${rows}</div>
      ${entry}
      <div class="fBoard">
        <div class="bTitle">BEST TIMES &mdash; ${track.name}</div>
        ${boardRows}
      </div>
      <div class="fActions">
        <button type="button" class="go" data-act="again">RACE AGAIN <b>R</b></button>
        <button type="button" data-act="menu">CIRCUITS <b>T</b></button>
      </div>`;
  }
}
