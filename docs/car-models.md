# Adding a car

Three cars are in the game. Two work perfectly and one does not, and the
difference is entirely in the asset — the loader is the same code for all
three. This is what separated them, measured rather than guessed.

| | triangles | wheel groups | materials | result |
| --- | --- | --- | --- | --- |
| **GT3 RS** | 46k | clean, 4 within 10 mm | mixed | works |
| **Alpine** | 126k | clean, 4 within 10 mm | mixed | works |
| **930 Turbo** | 100k | fragment into rims | all `metalness: 1` | fights the loader |

## What the loader needs

It takes whatever arrives, orients it, scales it to the tuned dimensions and
splits the wheels back out. Four things decide whether that succeeds.

**1. Wheels that are separate, round meshes.**
This is the one that actually breaks models. Wheels are found by name first
(`tire|tyre|wheel|rim`), and when a model has no useful names — plenty export
as `Object_7`, `Object_9` — by geometry: meshes that are low, outboard, small,
and *as tall as they are long*.

That last test is what the 930 fails. Its wheels arrive as separate rims,
brake discs and calipers rather than whole tyres, so the round bits that
survive the filter cluster inboard of the real hub. The probe measured its
half-track at 0.58 m on a 1.75 m wheelbase — far too small for any 911. The
GT3 RS, from the same manufacturer and the same era of asset, measures clean.

Check before you commit to a model: **can you see four wheel objects in the
scene tree, each one a whole wheel?**

**2. Under about 50k triangles.**
The whole game is flat-shaded. The GT3 RS at 46k *reads* as faceted and sits
in the world; the 930 at 100k renders smooth however the material is set,
because its facets are smaller than a pixel. Flat shading is applied to every
material on every car — if a model still looks smooth, it is too dense, and no
material setting will fix it.

Bytes matter far less than triangles. Draco and mesh optimisation took three
cars from 43 MB to 4.5 MB with no visible change; going from 100k to 46k
triangles is what changes how a car *looks*.

**3. Materials that are not all `metalness: 1`.**
Photoreal assets often set every material fully metallic — the 930 has its
chrome, its plastics, its **glass** and its **paint** all at 1. A full metal
has no diffuse term, so its colour never appears; it can only reflect, and
against this game's small sky that is a dark grey car whatever colour the
author chose.

`carmodel.js` caps metalness at 0.45 and clamps roughness into 0.35–0.85 to
bring any model into the same language as the rest of the world. That rescues
most assets, but a model authored sanely still looks better.

**4. Any scale, any orientation — but state which way it faces.**
Scale and axes are worked out from the bounding box, so a model in metres and
one in some private unit a hundred times smaller both load. What *cannot* be
measured is which END is the front: "longest axis" identifies the line the car
lies on, never the direction it points. A car is not reliably taller, wider or
blunter at either end. If it drives backwards, set `modelYaw: Math.PI`.

## Where to get them

Sketchfab, filtered to a licence that permits use — CC-BY needs attribution,
which goes in the README credits alongside the Alpine's. Search for
"game ready" or "low poly" rather than the highest-detail result; a 500k
triangle studio asset is more work to fix than a 40k game asset is to use.

## Preparing one

```bash
npx @gltf-transform/cli optimize in.glb out-optimized.glb --compress draco
```

Target ~30–50k triangles. Keep the raw export locally to re-do this from —
`assets/cars/*.glb` is gitignored except `-optimized.glb`.

## Checking one before wiring it up

Load it in the browser console and look at the numbers rather than the car:

```js
const { loadCarModel } = await import('/src/carmodel.js');
const m = await loadCarModel('./assets/cars/your-car-optimized.glb');
console.log(m.wheelGeoms.length, 'wheel geometries',
            m.bodyParts.length, 'body parts');
```

Four to eight wheel geometries with sane bounds is healthy. Dozens of tiny
ones means the wheels are fragmented, and that model will need its wheel
dimensions stated by hand in `cars.js` — as the 930's are.

## Wiring it in

Add an entry to `src/cars.js`: the file, the card text, and a `tuning` block.
`applyCarTuning` runs before the Vehicle is built, so anything in `tuning`
reaches the simulation — including `wheels.trackHalf`, `frontZ`, `rearZ` and
`radius`, which must be stated per car or the wheels sit outside the arches.
