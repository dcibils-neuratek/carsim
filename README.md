# VROOM

A 3D low-poly arcade driving game with real vehicle physics, by Diego Cibils.
Three.js for rendering, Rapier3D for physics, gamepad for control. No build
step, no npm — just static files and an import map.

Aimed squarely at what the arcade and console racers of the 90s and 2000s got
right — Top Gear, Daytona, Cruis'n USA: pick a circuit, drive. No accounts, no
purchases, no tutorial, no menus to climb.

The repository, the module names and the `carsim.*` localStorage keys keep the
old name. Renaming them would throw away every saved setup and gamepad binding
for nothing a player would ever see.

## Run

```bash
cd /Users/diego/Code/Carsim && python3 tools/serve.py 8000
```

Then open <http://localhost:8000/vroom.html>. It has to be served over HTTP;
opening the file from the filesystem will fail on ES module CORS.

`/` is the Megatronik Studio landing page and `/vroom.html` is the game. That
split is for hosting: a static host serves whatever is at the root, and the
studio is the front door. The game keeps its place at the repo root under a
different name rather than moving into a subfolder, so every `./src/` and
`./assets/` path inside it is untouched.

Use `tools/serve.py` rather than `python3 -m http.server`: it disables caching.
The stock server lets the browser cache ES modules, so an edit under `src/` can
silently not take effect and you end up debugging code that isn't running. That
cost a full debugging session once already.

Add `?capture=1` to the URL to enable `preserveDrawingBuffer`, which is needed
for screenshots and canvas readback. It's off by default because it forces an
extra copy every frame.

## Tests

```bash
open http://localhost:8000/test.html
```

Headless physics tests — no renderer, no canvas, no camera. They build the real
Track and Vehicle and step them in **simulated** time, so results don't depend
on frame rate or how fast the machine is. A full lap runs in a few seconds.

The important one is the autopilot lap: a pure-pursuit driver laps the circuit
and fails if the car ever stalls at full throttle. Every "the car hits an
invisible wall" bug this project has had would have been caught by it
automatically, without anyone looking at the screen.

Current baseline — **94 of 95 green**:

| | |
| --- | --- |
| 0–100 km/h | 4.05 s |
| Braking from 100 | 1.36 g, 33 m |
| Top speed | 257 km/h (7th) |
| Handbrake | yaw 1.0 → 5.0 rad/s, rear slip 0.5° → 90° |
| Autopilot lap | all five circuits, never stalls |

The one failure is the closing-join hairpin on Mountains: 4.4 m radius against
11.4 needed. It is driveable — the autopilot laps every circuit — but it reads
as a kink rather than a corner. There is 67 m of clear ground around it, so the
layout simply isn't using the space; opening it out is a job for the editor,
not for more smoothing.

Snow used to fail the same way at 5.6 m. It was reshaped in the editor and now
runs 23.0 m, which is what that page is for.

## Circuits

Five tracks, chosen from a menu on the boot screen. The choice happens **before
the world is built** — switching later would mean tearing down Rapier colliders
and the scene graph mid-frame, which is a rich source of bugs for no benefit.
`T` returns to the menu (a reload, well under a second), or jump straight in
with `?track=snow`.

| | Length | Road | Grip | Character |
| --- | --- | --- | --- | --- |
| **Forest** | 1.3 km | 12.0 m | 1.00 | Fast sweepers, a crest over T1, chicane, long hairpin |
| **Woods** | 0.9 km | 9.2 m | 0.96 | Narrow and twisty, trees crowding the verges, short sightlines |
| **Snow** | 1.4 km | 15.0 m | **0.55** | Wide and flowing — the hard part is stopping |
| **Dirt** | 1.1 km | 15.2 m | **0.62** | Gravel. Steer it on the throttle — 74% of a lap is spent sliding |
| **Mountains** | 1.7 km | 12.4 m | 0.98 | 18 m of climb, then a descent that arrives far too fast |

Dirt is the one that uses the rest of the game hardest: the squeal, the marks,
the smoke, the body lean and the drift-lead camera all exist to say the car has
let go, which on tarmac is a warning and on gravel is the technique. It also
introduced three fields the format was missing, each a tarmac assumption that
had been hardcoded — `road.centerLine` (gravel has no paint), `surface.squeal`
(grip and squeal are different properties: rubber squeals on something hard,
but on dirt the surface gives way first and the tyre scrabbles) and
`palette.dust` (what the tyres throw is the colour of the ground it came off).

Each is a JSON file under `assets/tracks/`, merged over `defaults.track.json`
so a circuit only states what makes it different — a hand-laid centerline plus
palette, fog, sun angle, scenery density, terrain roughness and surface grip.
Adding a circuit means dropping a file in that directory and adding a line to
`index.json`; no code changes. The road mesh, collider, curbs, terrain, tree
scatter, horizon silhouette and lap timing all derive from it at load time.

The file is a **recipe, not geometry** — see [docs/track-format.md](docs/track-format.md)
for the schema and for why that beats baking a mesh into glTF. Files are
validated on load and the validator names the offending field, so a typo is
"missing required field road.halfWidth" rather than a stack trace from inside a
mesh builder.

Sharp vertices are relaxed automatically: any control point turning more than
55 deg is replaced by two points set back along its own legs (Chaikin corner
cutting), repeatedly, until nothing is too sharp. Turn angle is what governs
corner radius — measured here, ~110 deg gives 20 m and ~148 deg collapses to
9 m — so this removes a whole class of hand-placement mistake.

Two constraints when editing a layout, both learned the hard way:

- **No corner tighter than ~12 m radius.** The road is swept as a ribbon; below
  `halfWidth + curbWidth` the inner edge folds through itself.
- **Watch `terrain.envelope.slope` on circuits that double back over
  themselves.** Terrain is
  the lower envelope of nearby road surfaces, so where a high section passes
  within 70 m of a low one, too shallow a slope digs a trench at the road edge
  that the car falls into — and too steep makes the heightfield chord *above*
  the asphalt over a crest. Mountains needs 0.20 plus deeper `roadClearance`.

The autopilot lap test drives **every** track and fails on anything undriveable,
so run the tests after touching a layout. It caught both of the above.

## Cars

Three, chosen after the circuit — which car you want depends on where you are
going. A car is a model plus a set of `TUNING` overrides in `src/cars.js`, and
the overrides *are* the car: mass, torque, grip, gearing, springs and wheel
geometry are what you feel.

| | Power | Weight | Character |
| --- | --- | --- | --- |
| **Alpine A110** | 300 hp | 1140 kg | Neutral, mid-engined. The baseline everything is tuned against |
| **Porsche 930 Turbo** | 260 hp | 1195 kg | Engine behind the rear axle, turbo arrives late. Rotates on lift |
| **Porsche GT3 RS** | 520 hp | 1430 kg | Same layout, forty years of fixing it. Revs to nine, real downforce |

Adding one is a data change plus an asset that meets four requirements — see
[docs/car-models.md](docs/car-models.md), which is written from what actually
separated the two cars that work from the one that fights the loader.

## The track editor

```bash
open http://localhost:8000/editor.html
```

Layouts are meant to be shaped by hand, so there is a page for it. Open a
circuit, drag its control points, and drive the result — the whole point is
that the loop from "that corner feels wrong" to "that corner is fixed" never
leaves the browser.

| | |
| --- | --- |
| **Plan view** | The layout from above. Drag a point to move it, double-click the road to insert one, `Del` to remove. Arrow keys nudge 1 m, `shift` 10 m |
| **Elevation strip** | Height against distance around the lap. Drag a point to raise or lower it; `PgUp`/`PgDn` do the same on the selected point |
| **3D preview** | The **real** `Track` — same terrain, curbs, trees and palette as the game, rebuilt a few hundred ms after edits settle |
| **Checks** | [`validateTrack()`](src/trackcheck.js) on every edit. Click an issue to jump to it |
| **drive it** | Hands the layout to the game through `localStorage` and opens it at `?track=__editor`. Real physics, unsaved |
| **export** | Writes out only what differs from `defaults.track.json`. Drop it in `assets/tracks/` and add it to `index.json` |

Two things it draws that are worth knowing about, because they turn a feeling
into something you can point at:

- **The road is stroked at its true width**, exactly as the game sweeps its
  ribbon. A corner too tight to sweep visibly folds through itself, and goes
  amber before it goes red — so you can see one coming while you drag, not
  after.
- **The bars under the elevation strip are rate of change of slope**, not
  height. A crest can look gentle in profile and still be a step change in
  gradient, which is what launches the car rather than tilting it. That trace
  is the only place it shows.

Geometry checks live in `src/trackcheck.js` and are shared with the tests, so
"driveable" has one definition rather than two that drift apart. The editor
checks it on every drag; the test suite checks it on every run, plus the
autopilot lap that the editor is too fast to do.

## Credits

**Engine audio** — the five looping samples in `assets/audio/` are BAC Mono
recordings from [markeasting/engine](https://github.com/markeasting/engine),
MIT licensed, and the four in `assets/audio/procar/` are that project's
"procar" set, used for the GT3 RS. `src/audio.js` is our own implementation, but it follows that
project's approach: four loops (on/off throttle x low/high rpm) pitched by rpm
via `detune` and blended with two equal-power crossfades, plus a limiter layer.

The car model is **"free low poly car" by Vladyslav Holhanov**, used under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — attribution is a
condition of the licence, so keep this credit if you share the game.
[Source on Sketchfab](https://sketchfab.com/3d-models/free-low-poly-car-38d83155e7724a14b300e156b134a1bb).

**Road surfaces** in `assets/textures/` — *City Street Asphalt Generic Clean
001* and *Ground Dirt Weeds Patchy 004*, both from
[Poliigon](https://www.poliigon.com/)'s free library and used under their
licence. Each circuit names its own surface in
`road.surface.texture`; a circuit that names none keeps the flat-shaded road,
which is still what Snow and the rest use.

Both are scans authored to tile. `src/roadtexture.js` also carries the
machinery to condition a surface that is NOT — square crop, low-frequency
removal, mirrored wrapping — because the first gravel attempt was a stock
photograph whose lighting gradient tiled into visible bands down the whole
lap. Nothing uses that path today; it is a flag on the surface, not on the
loader.

Note that Poliigon ships **gloss** where most PBR pipelines expect
**roughness**, and they are opposites. `roadtexture.js` inverts it on the way in — bound straight
into `roughnessMap` a gravel road comes out shiniest exactly where it should
be most matte.

Drop any GLB at `assets/car.glb` to swap it. `src/carmodel.js` works out the
model's own axes from its proportions (longest = length, shortest = height), so
it doesn't matter which way the exporter pointed it; it then scales the car to
the tuned length, splits merged wheels apart, and aligns the hubs to where the
suspension actually holds them. If the file is missing or unusable the game
falls back to the procedural car, so a bad asset can't stop you driving.

## The car

Modelled on an **Alpine A110 S**: 1140 kg, 300 hp / 340 Nm turbo four,
mid-engine RWD, 7-speed dual clutch, 250 km/h. 4.20 × 1.80 × 1.25 m on a 2.40 m
wheelbase.

Understeer and oversteer are emergent, not scripted. `wheels.loadSensitivity`
models the way tyre grip rises *less* than linearly with vertical load, so the
loaded outside wheel gains less than the unloaded inside wheel gives up — which
is what turns weight transfer into real understeer on turn-in and oversteer on
a lifted throttle. The HUD's balance bar shows the front/rear slip-angle
difference live, and the g-meter plots lateral against longitudinal g.

Press any button on the pad (or any key) to start. Chrome deliberately hides
connected gamepads until you press something on them, which is what the boot
screen is waiting for.

## Controls

| Action | Gamepad | Keyboard |
| --- | --- | --- |
| Steer | Left stick X | `A` / `D` or arrows |
| Throttle | Right trigger | `W` / up |
| Brake / reverse | Left trigger | `S` / down |
| Handbrake | `X` | `Space` |
| Shift up / down | `A` / `B` | `Shift` / `Ctrl` |
| Auto ↔ manual gearbox | `Back` | `M` |
| Cycle camera | `Y` | `C` |
| Respawn on track | `Start` | `R` |
| Gamepad bindings | — | `B` |
| Debug telemetry | — | `` ` `` |
| Tuning panel | — | `G` |
| Collider wireframes | — | `P` |
| Clear skidmarks | — | `K` |

Reverse engages by holding the brake at a standstill; in reverse the two
triggers swap roles.

Gear shifts sit on **A** and **B** rather than the shoulders: they are the most
reachable buttons on the pad, and shifting is the thing you do most after
steering and throttle. That puts the handbrake on **X**, where you can reach it
mid-corner.

Every one of these is rebindable. `B` opens the binding screen — pick an
action, press the button you want. It works from the track menu as well as
in-game, because a player whose pad misbehaves should not have to start a race
to fix it, and it is navigable with the pad itself for the same reason.
Bindings persist to `localStorage`. The screen captures whatever index the pad
actually sends, so pads Chrome does not report as "standard" work too.

The track menu is navigable with the d-pad or left stick, `A` to choose.

## Layout

| File | What's in it |
| --- | --- |
| `src/main.js` | Bootstrap and the fixed-step/render loop |
| `src/vehicle.js` | Chassis, suspension, drivetrain, steering, aero |
| `src/physics.js` | Rapier world, step accumulator, collider debug view |
| `src/track.js` | Procedural circuit, terrain, surface grip, projection |
| `src/tracks.js` | Loads the circuit catalogue from `assets/tracks/` |
| `src/trackfile.js` | Track file format: validate, merge, normalise |
| `src/trackcheck.js` | Is this circuit driveable? Shared by editor and tests |
| `src/editor/` | The track editor: plan view, elevation, inspector, 3D preview |
| `src/tuning.js` | Every physics constant, plus save/load |
| `src/telemetry.js` | Per-wheel tyre load, force and friction utilisation |
| `src/music.js` | Background music on its own bus |
| `src/tyreaudio.js` | Tyre squeal (sampled) and road noise |
| `src/input.js` | Gamepad and keyboard |
| `src/scene.js` | Renderer, lights, sky, car mesh |
| `src/camera.js` | Chase / hood / orbit cameras |
| `src/carmodel.js` | Loads a GLB and fits it to the physics |
| `src/skidmarks.js` | Tyre marks under slip, locking and wheelspin |
| `src/hud.js`, `src/laptimer.js`, `src/gui.js` | Overlay, lap timing, tuning panel |
| `test/physics-tests.js` | Headless physics tests + autopilot |
| `tools/serve.py` | No-cache static server |

## Tuning

`G` opens the panel. Everything is live except the values that define the rigid
body itself (mass, centre of mass, wheel positions) — those rebuild the car in
place, keeping it where it sits so you can tune mid-corner.

Setups persist to `localStorage`. **copy setup JSON** puts the current values on
your clipboard; paste them into `DEFAULTS` in `src/tuning.js` to make one stick.
**reset to defaults** clears the saved setup.

Force units are worth knowing before you turn dials: Rapier inherits Bullet's
raycast-vehicle convention, where engine force is in newtons but the brake value
is a per-step impulse. The two live on completely different scales — `maxBrake`
around 900 is what balances a `driveForce` in the low thousands. Don't try to
reconcile them; tune to the g figure from the braking test, or the `accel` line
in the debug panel (`` ` ``).

## Rapier 0.20 gotchas

Four of these cost real debugging time. All are load-bearing:

- **`addForce` is persistent, not per-step.** It accumulates until you call
  `resetForces()`. Without that reset the aero drag and downforce compound every
  step; within seconds the car is pinned under several times its own weight and
  decelerates to a halt at full throttle. It feels exactly like driving into a
  wall. `Vehicle._applyAero()` resets first, every step.
- **The vehicle controller's forward axis defaults to X, not Z.** Our chassis is
  built forward = `+Z`, so it must be set explicitly or every newton of engine
  force is applied sideways — and `currentVehicleSpeed()` reads along that same
  wrong axis, so the car reports ~0 km/h while creeping sideways. The setter is
  *misnamed* in the JS binding: assign `controller.setIndexForwardAxis = 2`,
  because `indexForwardAxis` is getter-only and assigning it does nothing.
- **Don't pass a filter predicate to `castRay`.** Handing a JS closure to
  `castRay` leaves state in the WASM bridge that makes the *next* `world.step()`
  deactivate the vehicle's rigid body — the car then ignores gravity and the
  throttle entirely, while `isEnabled()` quietly reads false. `Track` works
  around this by building the terrain before the road, so an unfiltered cast can
  only hit the terrain.
- **Heightfield indexing is `heights[zIndex + xIndex*(n+1)]`.** The first index
  runs along **Z**, not X. Getting it backwards transposes the terrain about its
  diagonal, which leaves the visual mesh looking perfect while the collider
  throws invisible ridges across the track.

- **Suspension damping is relative, not absolute.** Bullet's convention, which
  Rapier inherits, is `damping = ratio * 2 * sqrt(stiffness)`, so the useful
  scale moves with the spring rate — at stiffness 80, critical damping is ~17.9,
  not 1.0. Setting `compression` to a number that *looks* like a damping ratio
  gives you a damping ratio of about 0.08, and the car pogos over every bump
  like a buggy. Static sag is the sanity check: `g / 4k`, independent of mass.
  ~30 mm is a sports car, ~90 mm is a rally raid truck.

Ground clearance is a related trap that is ours, not Rapier's: the chassis
collider's clearance must comfortably exceed `suspension.maxTravel`, or a bump
bottoms the springs, grounds the chassis and pins the car. Buy clearance with
`chassis.colliderOffsetY`, never by cutting suspension travel — grip scales with
suspension load, so starving the springs of travel costs you all your traction.

## Reading the tyres

`` ` `` opens the telemetry, and the column that matters is **lat use**:
per-wheel lateral friction utilisation, `|force| / (mu * load)`. It runs 0 to 1
and hits 1 exactly when the tyre saturates.

That column exists because of one awkward fact about the physics engine.
Rapier's raycast vehicle has **no tyre slip curve** — it solves a lateral
impulse that cancels sideways velocity, clamped at `mu * load`. A tyre here has
full grip up to saturation and is saturated after it. There is no peak and no
falloff to measure.

The consequence is bigger than it sounds: **slip angle stays near zero until
the car has already let go**. Measured on a skidpad ramp from a standstill to
the limit, rear slip angle never exceeded **0.2°**, and was **0.16°** at the
point lateral utilisation crossed 60%. Anything keyed off slip angle — tyre
audio, camera, an assist — would fire only after the car was gone.

Utilisation carries the information slip angle does not: it climbs smoothly,
and about **40% of the approach to the limit** sits in a readable middle band.
That is the warning channel, and `testUtilisationSignal` guards it.

One asymmetry to know about: Bullet budgets the two directions separately, so
only the *lateral* number is genuinely clamped to 1. The **spin** column
(longitudinal) reads over 100% under wheelspin or a locked wheel — that is real
and useful, but it is why the friction-ellipse figure is for reading rather
than for driving anything from.

## Tyre audio

With no wheel to feel, sound is the only channel that can tell you the limit is
*coming* rather than that it has arrived. `src/tyreaudio.js` plays a looping
screech recording — `assets/audio/tyre-screeching.m4a` — one voice per axle,
pitched and filtered by what the tyre is doing. Road noise is still
synthesised, because a broadband rumble is what filtered noise already is.

Two signals drive it, doing different jobs:

- **Utilisation** climbs 0→1 as the tyre loads up. This is the **warning**, and
  it arrives before the limit. Squeal starts at `squealStart` (0.58), so the
  tyre begins talking with 40% of its grip still in hand.
- **Scrub speed** is ~0 while gripping and grows once sliding. This is the
  **confirmation**. Utilisation is clamped, so it pins at 1.0 and says nothing
  about how far past the limit you are.

Road speed is a third input: a slide at walking pace is a chirp, the same slide
at 150 km/h is a howl.

Together they give a sound that *rises* before the limit and *changes
character* after it. The filter is the trick — a loaded tyre is a muted whine
at 1.5 kHz, a sliding one opens to 7 kHz and gets harsh — and the pitch drops
as it lets go.

Front and rear are separate voices at playback rates 1.18 and 0.82, so you can
hear **which end** let go and correct the right way.

Measured on a skidpad ramp: **2.3 s between the tyre becoming audible and
saturating**, silent below 40% utilisation. `testTyreAudioWarning` guards that.
All of it is in `TUNING.audio.tyre` and live in the `G` panel.

## Handling checks

Worth re-running after any significant tuning change:

- **Skidpad** — a constant-radius circle at rising speed. Grip should build then
  break away progressively, not snap.
- **Braking** — from 100 km/h, watch `accel` in the debug panel. ~1.0–1.2 g is
  a road car on good tyres.
- **Weight transfer** — the `susp` column should visibly compress at the front
  under braking, and unload the inside front mid-corner.
- **Slalom** — responsive without tank-slapping.
- **Rollover** — a deliberate high-speed direction change should not flip it.
- **Grass** — running wide costs grip noticeably but stays recoverable.
- **Frame independence** — throttle the render rate; behaviour should be
  identical. That's the fixed timestep doing its job.

## Not in this milestone

Anti-roll bars, a proper slip-curve tyre model, tyre temperature, AI opponents,
engine audio, external car models.
