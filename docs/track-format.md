# The Carsim track format

A circuit is a JSON file. `assets/tracks/index.json` lists them; each one is
merged over `defaults.track.json`, so a file only states what makes it
different. Nothing about a track lives in code any more — adding a circuit
means dropping a file in that directory and adding a line to the index.

```
assets/tracks/
  index.json             which files to load, and which is the default
  defaults.track.json    the values every circuit inherits
  forest.track.json      a circuit
  woods.track.json
  snow.track.json
  mountains.track.json
```

Read by `src/trackfile.js`, which validates, merges and normalises. That module
is the only place that knows both the file layout and the runtime layout, so a
future v2 of this format changes it and nothing else.

## The core decision: a recipe, not geometry

A track file stores **what the circuit is**, not **what it looks like**. There
is no mesh in it, no heightfield, no vertex — just a centerline, some widths
and some rules. The road surface, its collider, the curbs, the terrain, the
tree scatter and the lap timing are all derived at load time by `src/track.js`.

The alternative — baking the geometry — would make an editor trivially
WYSIWYG, and it is what glTF or a `.obj` would give you. It was rejected
because:

- **A track is mostly not geometry.** Grip, banking, fog, the terrain envelope,
  which surface is drivable, where the lap starts — none of that is a triangle.
  Rapier needs a heightfield and a swept ribbon; the lap timer needs the
  centerline as a *curve*, not as a mesh.
- **Baking freezes a track against the pipeline of the day it was saved.** The
  smoothing here has been rewritten three times (Catmull-Rom → closed B-spline
  → curvature diffusion → automatic corner relaxation) and every one reshaped
  all four circuits for the better. Recipes inherit those improvements; baked
  meshes would not.
- **5 kB of readable text diffs, merges and hand-edits.** A baked circuit does
  none of those.

The usual objection to recipes is that an editor can't show you the real shape.
That is solved by sharing code rather than by changing format: `sampleCircuit()`
is exported from `src/track.js`, and the boot menu already calls it to draw
each preview. An editor calls the same function and gets exactly what the game
will build.

**Where glTF still belongs:** assets a track *references* — the car, props, a
bridge deck. Geometry as geometry. Not the circuit itself.

## Schema (version 1)

Every file starts with the format tag and version. A mismatch is a hard error,
not a warning — half-loading a track from an unknown schema is worse than
refusing it.

```json
{ "format": "carsim.track", "version": 1, "id": "forest", "name": "Forest" }
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique; used by `?track=<id>` |
| `name` | string | Shown on the menu card and in the HUD |
| `tagline` | string | One line under the name |
| `difficulty` | string | Free text: `Medium`, `Hard`, `Slippery` |
| `notes` | string[] | Authoring notes. Purely descriptive — JSON has no comments, and the reasoning behind a layout is worth keeping next to it |

### `road`

| Field | Type | Notes |
| --- | --- | --- |
| `halfWidth` | number | Metres from centerline to edge. The road is 2× this wide |
| `curbWidth` | number | Curb strip outside the asphalt, flush with it |
| `controlPoints` | `[x, y, z][]` | The centerline, in metres. At least 4. **Implicitly closed** — do not repeat the first point |
| `banking.gain` | number | Curvature (rad/m) → cross-slope |
| `banking.maxDegrees` | number | Ceiling on the above |
| `surface.roadGrip` | number | 1.0 is dry tarmac; snow runs 0.55 |
| `surface.grassGrip` | number | Off-track grip |

### `terrain`

| Field | Type | Notes |
| --- | --- | --- |
| `hills.amplitude` | number | Height of the background undulation |
| `hills.scale` | number | Its horizontal wavelength |
| `envelope.slope` | number | Rise per metre once past the verge |
| `envelope.roadClearance` | number | How far the terrain sits below the road |

### `environment`

`palette` is `#rrggbb` strings — 15 keys covering sky, ground, asphalt, curbs,
trees, posts and (optionally) `skidmark`. `fog` is `{near, far}` in metres.
`sun` is `{color, intensity, position}`.

Colours are strings and not numbers because JSON has no hex literal:
`0x74b6e8` would have to be written as `7648488`, which is unreadable in a diff
and unwritable by hand. The loader converts to the numbers three.js wants.

### `scenery`

`trees` `{count, height: [min,max], radius: [min,max], segments, clearance}`,
`ridges` `{count, height: [min,max], radius, jitter}`, `posts` `{spacing}`.

All scatter is seeded deterministically, so the file completely determines the
world — a circuit never looks different from one load to the next.

## Reserved, not implemented

`water`, `features` and `props` are accepted by the validator and ignored with
a console warning. That is so a file written against a later build still loads
and drives here rather than failing outright.

They are deliberately unimplemented rather than half-implemented. Both need
real systems that don't exist yet, and one of them needs a change to how
terrain works:

- **Bridges** fight the current terrain model directly. Terrain is built as the
  lower envelope of nearby road surfaces, so it would raise ground *under* the
  bridge. A bridge needs the envelope to skip that span, plus a deck and piers.
- **Water** needs a surface, a shoreline against the heightfield, and a
  drag/reset rule for driving into it.
- **A global heightfield cannot express overhangs or tunnels at all.** If those
  are ever wanted, terrain near the road has to become a mesh skirt following
  the ribbon — the same change that rally-scale elevation on Mountains needs.

When features do land, they should be anchored by **lap progress** (`"from":
0.42, "to": 0.45`) rather than world coordinates, so that moving a layout
doesn't strand every prop on it.

## Two rules for laying out a circuit

Both learned the hard way, and both checked automatically by the tests:

- **No corner tighter than about 12 m radius.** The road is swept as a ribbon;
  below `halfWidth + curbWidth` the inner edge folds through itself. Turn angle
  at a control point is what governs radius — roughly 110° gives 20 m, and 148°
  collapses to 9 m. Points turning more than 55° are relaxed automatically
  (Chaikin corner cutting) before the spline is fitted, which removes most
  hand-placement mistakes but cannot rescue a genuinely folded layout.
- **Watch `envelope.slope` on a circuit that doubles back over itself.** Too
  shallow and a low section's envelope wins next to a much higher one, digging
  a trench at the road edge that the car falls into. Too steep and the
  heightfield chords *above* the asphalt over a crest. Mountains needs 0.20 and
  a deeper `roadClearance`.

The closing join deserves specific care: a closed B-spline's tangent at the
start line is set by the *last* control point, so putting it off the line of
the start straight whips the spline into a tiny-radius loop right at the join.
That is the one corner every circuit here has failed on at some point.

## Validation

`validateTrackFile()` checks structure — fields present, types right, values in
range — and throws a `TrackFormatError` naming the offending field. It runs on
every load and is covered by its own tests.

It says nothing about whether a circuit is *driveable*. That needs the sampled
centerline, and lives in `test/physics-tests.js`: minimum corner radius,
self-overlap, terrain clearance, and an autopilot lap that fails if the car
ever stalls.

An editor wants both, at different rates — the schema check on every keystroke,
the geometry checks on every drag of a control point.
