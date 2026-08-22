# Megatronik Studio — style guide

Everything the studio looks like, in one file, so the next thing does not have
to be redesigned from scratch. Copy the token block, use the recipes, follow the
rules at the end.

The look has one idea behind it: **an arcade cabinet in a dark room.** Near-black
surfaces, one bright thing at a time, phosphor colours, and type you can read
from a metre away. Every decision below comes back to that.

---

## 1. Tokens

Drop this into `:root` and build on it. Nothing else in this document invents a
value that is not here.

```css
:root {
  /* --- surfaces ------------------------------------------------------- */
  --bg:      #07080c;              /* the room. Near-black, faintly blue.   */
  --panel:   rgba(255,255,255,.035);
  --line:    rgba(255,255,255,.09);

  /* --- ink ------------------------------------------------------------ */
  --fg:      #eef2f7;              /* headlines, numbers, anything read     */
  --faint:   rgba(238,242,247,.55);/* body copy at rest                     */
  --dim:     #8b96a8;              /* labels, captions, units               */

  /* --- phosphors ------------------------------------------------------ */
  --cyan:    #35e8ff;              /* the studio's voice                    */
  --magenta: #ff2e88;              /* the second voice, used sparingly      */
  --amber:   #ffd23f;              /* action. Buttons, live readouts.       */
  --danger:  #ff4d4d;

  /* --- type ----------------------------------------------------------- */
  --mark: "Bungee", "Impact", sans-serif;
  --body: "Barlow Condensed", "Roboto Condensed", system-ui, sans-serif;
  --game: "Permanent Marker", "Comic Sans MS", cursive;

  /* --- rhythm --------------------------------------------------------- */
  --pad:  clamp(20px, 5vw, 40px);
  --maxw: 1080px;
}
```

One `<link>` covers all three faces:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@300;400;500;600;700&family=Bungee&family=Permanent+Marker&display=swap">
```

`display=swap` and a real fallback in every stack are not optional. If Google is
slow or blocked, text must draw in the fallback and swap in later rather than
sitting invisible while someone waits to press start.

---

## 2. Colour

### The rule

**One bright thing at a time.** The palette is 90% near-black and grey. Cyan,
magenta and amber are events, not surfaces. If two of them are fighting in the
same block, one of them is wrong.

### What each one is for

| Token | Job | Never |
| --- | --- | --- |
| `--cyan` | The studio speaking: section eyebrows, the wordmark's leading edge, one accent word in a headline | On a large fill, or as body text |
| `--magenta` | The second voice — a pull quote, a rule marking something personal | Next to cyan in the same element |
| `--amber` | Something you can do, or a number that is live. Primary buttons, gauges | As decoration. Amber means *act* or *read me* |
| `--danger` | Failure only | Anything merely important |

Amber belongs to the games; cyan and magenta belong to the studio. A game page
should feel like the studio made it, not like the studio painted over it.

### Depth without borders everywhere

Surfaces are separated by a **1px `--line` and a 3.5% white fill**, never by a
lighter grey background. On near-black, a raised grey panel reads as a smudge;
a hairline reads as an edge. Radius is 8px for panels, 12px for anything the
size of a card, 4px for buttons — buttons stay square-ish so they read as
hardware.

### Coloured light, not coloured paint

Big colour arrives as radial gradients at low opacity behind content, never as
a filled block:

```css
background:
  radial-gradient(70% 52% at 18% 0%,   rgba(53,232,255,.16), transparent 64%),
  radial-gradient(66% 56% at 92% 22%,  rgba(255,46,136,.14), transparent 62%),
  radial-gradient(90% 60% at 50% 118%, rgba(255,210,63,.07), transparent 64%);
```

That is a cabinet's bezel lights bouncing off the wall behind it. It gives the
page colour while leaving every surface black enough to read on.

---

## 3. Type

Three faces, three jobs, no overlap. If you are unsure which to use, it is
`--body`.

### `--mark` — Bungee

The studio's name and nothing else. It is signage: designed to be read across a
room, on a sign, at a size. Use it for the wordmark, the nav brand, and small
numeric markers like `01 / 02 / 03`. Never set a sentence in it.

### `--body` — Barlow Condensed

Everything you read. Condensed buys horizontal room back, which matters on a
screen whose edges are all readouts, and it stays legible at a glance — the only
thing that counts on something you look at while doing something else.

It does headlines too. **700, uppercase, `line-height: 1.03`** is the house
headline; it reads as a marquee without needing a display face.

```css
h2 { font-family: var(--body); font-weight: 700; text-transform: uppercase;
     font-size: clamp(30px, 5vw, 48px); line-height: 1.05; }
```

Always set `font-variant-numeric: tabular-nums` on `body`. Any number that
changes while someone is watching — speed, revs, a lap time, a counter — will
shuffle sideways with proportional digits, and the whole layout reads as
twitching.

### `--game` — Permanent Marker

**A game's own name, and nothing else.** VROOM uses it. The next game gets its
own face. This is the one place the system deliberately breaks: each game brings
one typeface and one accent colour of its own, and the studio's chrome stays put
around it. That is how a catalogue page reads as a catalogue instead of a
uniform.

Marker faces have no tabular figures and their small caps are barely legible, so
nothing numeric or small ever goes in one.

### Scale

| Role | Size | Weight | Tracking |
| --- | --- | --- | --- |
| Wordmark | `clamp(38px, 9.2vw, 96px)` | Bungee 400 | `-.005em` |
| Page headline | `clamp(34px, 6.6vw, 68px)` | 700 caps | normal |
| Section headline | `clamp(30px, 5vw, 48px)` | 700 caps | `.01em` |
| Lede | `clamp(19px, 2.4vw, 24px)` | 400 | normal |
| Body | 18px / 1.65 | 400 | normal |
| Sub-head | 20px caps | 600 | `.06em` |
| Eyebrow | 13px caps | 600 | **`.28em`** |
| Caption / unit | 12–14px caps | 500 | `.16em`–`.26em` |

The pattern in that last column is the whole trick: **the smaller the text, the
wider the tracking.** Small caps set tight turn into a grey bar. At `.28em` a
13px eyebrow reads as a label on a machine.

---

## 4. The wordmark

The studio name is set in Bungee and reproduced three times, a couple of pixels
apart, in cyan, magenta and white. That is a CRT with its convergence out — the
same misregistration that put a coloured fringe on every white letter on a
monitor in 1996.

```html
<h1 class="wordmark" aria-label="Megatronik">
  <span class="ghost c" aria-hidden="true">MEGATRONIK</span>
  <span class="ghost m" aria-hidden="true">MEGATRONIK</span>
  <span class="top">MEGATRONIK</span>
</h1>
```

If the mark is not a heading, name it as a single image instead — the same fix
in the shape that container takes:

```html
<span class="mk" role="img" aria-label="Megatronik Studio"> … three copies … </span>
<a class="mk" href="/" aria-label="Megatronik Studio">  … three copies … </a>
```

```css
.wordmark { position: relative; display: inline-block; font-family: var(--mark);
            font-size: clamp(38px, 9.2vw, 96px); line-height: .96; }
.wordmark .ghost   { position: absolute; inset: 0; pointer-events: none; }
.wordmark .ghost.c { color: var(--cyan);    transform: translate(-.028em, .014em); opacity: .85; }
.wordmark .ghost.m { color: var(--magenta); transform: translate( .028em,-.014em); opacity: .85; }
.wordmark .top     { position: relative; color: var(--fg); }
```

Two things that matter:

- **Offsets are in `em` above ~30px, and whole pixels below it.** A big mark
  scales from 38px to 96px, so a proportional fringe is the only way it stays
  the same mark at both ends. A small one — the publisher card on a title
  screen, 15–20px — is a different problem: `.05em` there is two thirds of a
  pixel, the browser resolves it into a faint grey tint, and the fringe simply
  disappears. Below about 30px, use `translate(-1px, .5px)` and
  `translate(1px, -.5px)` and let the mark stay crisp. A fringe you cannot see
  is not a fringe.
- **Name the container explicitly, and `aria-hidden` the colour copies.** Both,
  not either. `aria-hidden` alone is not enough: name-from-content still walked
  all three copies and the heading came out as *"MEGATRONIK MEGATRONIK
  MEGATRONIK"* in the accessibility tree. The `aria-label` on the container is
  what actually settles it. Check it — this one is invisible until you look at
  the tree.

Give the ghosts a slow drift (7s, ease-in-out, ±50% of the offset) and the mark
looks like a screen warming up rather than a static logo. Wrap it in
`@media (prefers-reduced-motion: no-preference)`.

---

## 5. Texture

### Scanlines

One fixed overlay across the whole page, and it must be almost invisible:

```css
body::after {
  content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 100;
  background: repeating-linear-gradient(to bottom, rgba(0,0,0,.16) 0 1px, transparent 1px 3px);
  opacity: .5; mix-blend-mode: multiply;
}
```

If you can see the scanlines when you are reading a paragraph, turn them down.
They are there to make the page feel like a screen, not to be noticed. `z-index`
above everything, `pointer-events: none` so they never eat a click.

### Screenshots

Use real frames from the running product, at the real resolution, never
mock-ups. A mock-up starts drifting from the thing the day it is made. Behind
type, push a screenshot to **~17% opacity with reduced saturation and a gradient
mask fading to transparent at the bottom** — it should say "this is a driving
studio" at a glance and never compete with the headline sitting on it.

---

## 6. Components

### Buttons

```css
.btn { display: inline-flex; align-items: center; gap: 10px;
       font-family: var(--body); font-weight: 700; text-transform: uppercase;
       font-size: 19px; letter-spacing: .1em; padding: 13px 28px;
       border-radius: 4px; text-decoration: none; border: 1px solid transparent;
       transition: transform .12s ease, background .16s ease, border-color .16s ease; }
.btn:active { transform: translateY(1px); }

.btn-primary { background: var(--amber); color: #10141a;
               box-shadow: 0 0 0 1px rgba(255,210,63,.4), 0 10px 34px rgba(255,160,40,.22); }
.btn-ghost   { border-color: var(--line); color: var(--fg); }
.btn-ghost:hover { border-color: rgba(255,255,255,.28); background: var(--panel); }
```

**One primary per screen.** The amber button is the thing you came to press. A
second one halves the first. `:active` moves the button down 1px, because a
button that does not physically move does not feel like a button.

### Stat strip

Numbers big, labels small and tracked. The grid is `1px` gapped over a `--line`
background, so the dividers are the gaps themselves — no borders to keep in sync.

```css
.specs { display: grid; gap: 1px; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
         background: var(--line); border: 1px solid var(--line); border-radius: 8px;
         overflow: hidden; }
.spec  { background: #0a0c11; padding: 16px 18px; }
.spec b    { display: block; font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.spec span { font-size: 12px; letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
```

### Eyebrow + headline

The house section opener. Cyan for a normal section, magenta when the section is
personal or a position rather than a fact.

```html
<p class="eyebrow">What this is</p>
<h2>Bringing back the game<br>you could just start</h2>
```

### Pull quote

A 3px magenta rule on the left, and the quote set as a headline rather than in
italics.

```css
.quote { border-left: 3px solid var(--magenta); padding: 4px 0 4px 24px; }
.quote p { font-weight: 600; text-transform: uppercase;
           font-size: clamp(24px, 3.6vw, 36px); line-height: 1.14; }
```

### Marquee ticker

A horizontal strip of small tracked caps, duplicated once and translated `-50%`
for a seamless loop. Mask both ends so items fade in and out instead of popping,
pause on hover, and under reduced motion stop the animation **and hide the
duplicate** — otherwise the list simply reads twice.

---

## 7. Motion

Fast, small, and mechanical. Nothing eases in from off-screen; nothing fades up
on scroll.

| Thing | Duration |
| --- | --- |
| Hover / colour change | `.12s`–`.16s ease` |
| Button press | `.12s ease` |
| Ambient drift (wordmark) | `7s ease-in-out infinite` |
| Ticker | `42s linear infinite` |

Every ambient animation sits behind `@media (prefers-reduced-motion:
no-preference)`, or has a `reduce` branch that turns it off **and fixes up any
layout the animation was papering over.**

---

## 8. Voice

The visual system carries a tone, and copy that fights it undoes the design.

- **Short declaratives.** "Coin in, four seconds, you are at speed." The
  studio's own line is built the same way: **Real physics. Arcade fun.** Two
  sentences, four words, and it says what the whole catalogue is for.
- **Say the number.** Six cars. Six circuits. Zero accounts. Concrete beats
  adjectives, and it is checkable.
- **Name what you are against.** No accounts, no subscriptions, no launcher, no
  season pass. The list is the position.
- **Admit the limit before someone finds it.** If the game needs a keyboard,
  the page says so next to the play button. A landing page that oversells the
  first click costs more than the sentence saves.
- **No exclamation marks, no "revolutionary", no "experience".** Arcade
  cabinets did not need adjectives.

---

## 9. Rules that are not negotiable

1. **Contrast before flourish.** Body copy sits at `--faint` on `--bg`, which
   clears WCAG AA. Never put body text in cyan, magenta or amber.
2. **Every font stack has a real fallback**, and every webfont loads with
   `display=swap`.
3. **`tabular-nums` on `body`**, always.
4. **Decorative layers are `pointer-events: none`** and `aria-hidden`.
5. **Reduced motion is honoured everywhere**, including fixing the layout the
   animation assumed.
6. **One primary action per screen.**
7. **Real screenshots only.**
8. **Dark only.** There is no light theme. The look is a lit screen in a dark
   room, and a light version of it is a different design, not a variant. Set an
   explicit background on `body` so nothing borrows the host's theme.

---

## 10. Starter

A blank page already in the house style:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#07080c">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@300;400;500;600;700&family=Bungee&display=swap">
<style>
  :root { /* paste the token block from §1 */ }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font-family: var(--body); font-size: 18px; line-height: 1.65;
    font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased;
  }
  body::after { /* scanlines, §5 */ }
  .wrap { max-width: var(--maxw); margin: 0 auto; padding: 0 var(--pad); }
</style>
</head>
<body><div class="wrap"><!-- … --></div></body>
</html>
```

---

## 11. Putting it on a game

A game is not a landing page, and the system has to give ground in one specific
place: **anything you read while playing keeps the colours it was tuned for.**

VROOM is the worked example. What the studio system took over:

- **The title card.** Background down to `--bg`, the two phosphors added to the
  bezel gradients, scanlines over the whole screen.
- **A studio credit at the foot of it** — the mark alone, in Bungee with the
  convergence fringe, below the byline and linking back to the studio.

### Where the studio's name goes on a game

**Once, at the bottom.** It first went above the game's wordmark, as a publisher
card of the kind that came up before the logo on a console boot. That was wrong,
and obviously so once it was on screen: nobody opened the page for the studio,
and putting its name where the eye lands first says otherwise. The game's own
wordmark leads. The studio signs the bottom of the page, the way a credit does.

Two things that follow from "non-obtrusive" being a real constraint and not an
adjective:

- **No ambient animation on a footer mark.** The drift that makes the mark look
  like a warming screen in a hero is a footer asking for attention. Bring the
  fringe up on hover instead, and leave it still otherwise.
- **Match it by eye, not by opacity.** Bungee carries far more ink per point
  than the condensed body face, so a footer mark at the same alpha as the line
  above it reads as considerably louder. VROOM's sits at `.42` against a byline
  at `.38` and only then looks like the quieter of the two.
- **No `A GAME BY` label.** It sat above the mark at first and had to go: the
  byline directly above it already opens *"A game built just for fun"*, so the
  same three words appeared twice in four lines. A mark at the foot of a page
  is understood to be a credit without a caption explaining that it is one.

What it deliberately did **not** touch:

- **The HUD.** Dials, grip meter, lap panel, gear readout — all still amber on
  `--panel`, at the game's slightly lighter `#10141a`. Those values were tuned
  against a sunlit road, and cyan and magenta over grass and asphalt are two
  more colours competing with the one that means *read me*.
- **Scanlines while driving.** They cost contrast at 200 km/h and buy nothing;
  on a menu they cost nothing and are the entire look.

The general rule: **the studio owns the chrome, the game owns the instrument.**
Boot screens, menus, credits, pause overlays, marketing — studio. Anything a
player's eye lands on mid-input — the game's, at whatever colour and contrast it
needs.

---

Reference implementations: [`index.html`](../index.html) -- the studio landing
page, now the site root -- uses every token and component above and nothing
that is not here. [`vroom.html`](../vroom.html) shows the same system applied to
a running game, including where it stops.
