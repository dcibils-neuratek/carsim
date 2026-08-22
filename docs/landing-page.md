# Megatronik Studio — landing page

One self-contained `index.html`, at the site root. No build step, no dependencies beyond Google
Fonts, same as the rest of the project. Open it over HTTP alongside the game:

```bash
python3 tools/serve.py 8000   # then http://localhost:8000/site/
```

## Layout on disk

```
site/
  index.html          the whole page — markup, styles, no JS
  media/
    vroom-hero.jpg    the game card shot (SC18, Forest, on the curbs)
    vroom-alt.jpg     the faint backdrop behind the hero type
```

Both images are real 1600×900 frames captured from the running game with
`?capture=1`, which turns on `preserveDrawingBuffer` so the canvas can be read
back. They are the renderer's own output, not mock-ups, so they cannot drift
from what the game actually looks like without someone noticing.

## Links out

`vroom.html` (play) and `../about.html` (about VROOM) are relative, so the
folder can be moved or served from a subpath without editing anything.

## If this becomes the front door

Right now `/` is the game and `/site/` is the studio, which is backwards for a
studio site. When there is a domain, point it at `site/` and let the game live
at `/play` — that only needs hosting config, not a change in here.
