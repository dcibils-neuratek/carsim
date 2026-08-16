# Carsim

A 3D low-poly arcade driving sim with real vehicle physics. Three.js for
rendering, Rapier3D for physics, gamepad for control. No build step, no npm —
just static files and an import map.

## Run

```bash
cd /Users/diego/Code/Carsim && python3 tools/serve.py 8000
```

Then open <http://localhost:8000>. It has to be served over HTTP; opening
`index.html` from the filesystem will fail on ES module CORS.

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

Current baseline — **45 of 48 green**:

| | |
| --- | --- |
| 0–100 km/h | 4.05 s |
| Braking from 100 | 1.36 g, 33 m |
| Top speed | 257 km/h (7th) |
| Handbrake | yaw 1.0 → 5.0 rad/s, rear slip 0.5° → 90° |
| Autopilot lap | all four circuits, never stalls |

The 3 failures are all the same known issue: a corner tighter than the road can
be swept around, at the closing join of Forest (10.7 m), Snow (5.1 m) and
Mountains (4.9 m). They are driveable — the autopilot laps every track — but
they read as a kink. See the note under Circuits.

## Circuits

Four tracks, chosen from a menu on the boot screen. The choice happens **before
the world is built** — switching later would mean tearing down Rapier colliders
and the scene graph mid-frame, which is a rich source of bugs for no benefit.
`T` returns to the menu (a reload, well under a second), or jump straight in
with `?track=snow`.

| | Length | Road | Grip | Character |
| --- | --- | --- | --- | --- |
| **Forest** | 1.3 km | 12.0 m | 1.00 | Fast sweepers, a crest over T1, chicane, long hairpin |
| **Woods** | 0.9 km | 9.2 m | 0.96 | Narrow and twisty, trees crowding the verges, short sightlines |
| **Snow** | 1.6 km | 15.0 m | **0.55** | Wide and flowing — the hard part is stopping |
| **Mountains** | 1.7 km | 12.4 m | 0.98 | 18 m of climb, then a descent that arrives far too fast |

Each is pure data in `src/tracks.js`: a hand-laid centerline plus palette, fog,
sun angle, scenery density, terrain roughness and surface grip. Adding a circuit
means adding an entry and nothing else — the road mesh, collider, curbs,
terrain, tree scatter, horizon silhouette and lap timing all derive from it.

Two constraints when editing a layout, both learned the hard way:

- **No corner tighter than ~12 m radius.** The road is swept as a ribbon; below
  `halfWidth + curbWidth` the inner edge folds through itself.
- **Watch `envSlope` on circuits that double back over themselves.** Terrain is
  the lower envelope of nearby road surfaces, so where a high section passes
  within 70 m of a low one, too shallow a slope digs a trench at the road edge
  that the car falls into — and too steep makes the heightfield chord *above*
  the asphalt over a crest. Mountains needs 0.20 plus deeper `roadClearance`.

The autopilot lap test drives **every** track and fails on anything undriveable,
so run the tests after touching a layout. It caught both of the above.

## Credits

**Engine audio** — the five looping samples in `assets/audio/` are BAC Mono
recordings from [markeasting/engine](https://github.com/markeasting/engine),
MIT licensed. `src/audio.js` is our own implementation, but it follows that
project's approach: four loops (on/off throttle x low/high rpm) pitched by rpm
via `detune` and blended with two equal-power crossfades, plus a limiter layer.

The car model is **"free low poly car" by Vladyslav Holhanov**, used under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — attribution is a
condition of the licence, so keep this credit if you share the game.
[Source on Sketchfab](https://sketchfab.com/3d-models/free-low-poly-car-38d83155e7724a14b300e156b134a1bb).

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
| Handbrake | `A` | `Space` |
| Shift up / down | `RB` / `LB` | `Shift` / `Ctrl` |
| Auto ↔ manual gearbox | `Back` | `M` |
| Cycle camera | `Y` | `C` |
| Respawn on track | `Start` | `R` |
| Debug telemetry | — | `` ` `` |
| Tuning panel | — | `G` |
| Collider wireframes | — | `P` |
| Clear skidmarks | — | `K` |

Reverse engages by holding the brake at a standstill; in reverse the two
triggers swap roles.

## Layout

| File | What's in it |
| --- | --- |
| `src/main.js` | Bootstrap and the fixed-step/render loop |
| `src/vehicle.js` | Chassis, suspension, drivetrain, steering, aero |
| `src/physics.js` | Rapier world, step accumulator, collider debug view |
| `src/track.js` | Procedural circuit, terrain, surface grip, projection |
| `src/tuning.js` | Every physics constant, plus save/load |
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
