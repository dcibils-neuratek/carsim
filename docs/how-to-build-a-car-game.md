# How to Build a Car Game

*The maths, the code, and the mistakes that taught us the difference.*

---

## Why this book exists

Most driving-game tutorials show you an engine curve and a `applyForce` call and
leave you there. The gap between that and a car you want to drive is enormous,
and almost none of it is written down.

This book tries to close that gap in three passes over every topic:

1. **The physics.** The actual equation, its units, and what each term means.
2. **The implementation.** How that equation becomes code that runs 120 times a
   second without going unstable.
3. **What we got wrong.** Because over four days and seventy-seven commits
   building a game called VROOM, one shape kept repeating:

> We believed X. We measured. X was false.

The autopilot that knew exactly how fast to take a corner and did not brake. The
four cars that had been spinning their wheels backwards since the day they were
added. The test that passed *because* of the bug it should have caught. The
50/50 four-wheel-drive split that makes a car slower than driving two wheels.
The closer camera that gave *less* sense of speed.

Those are not padding. In every case the wrong answer was the intuitive one, and
knowing why it was wrong is worth more than the right answer alone.

**What you need.** Secondary-school mechanics — force, acceleration, torque —
and enough programming to write a loop. The worked example is JavaScript, but
the equations are the equations.

**Notation.** SI throughout: metres, kilograms, seconds, newtons. Where a
figure is conventionally quoted in something else (hp, mph, lb-ft) the
conversion is given once and then dropped.

---

## Part I — The physics of a car

### 1. Torque, power, and why a spec sheet is two numbers about one curve
The relationship every engine model rests on:

$$P = \tau \cdot \omega, \qquad \omega = \frac{2\pi \cdot \text{rpm}}{60}$$

Why a manufacturer quotes peak torque at one rpm and peak power at another, why
those two figures *constrain each other*, and how to recover the whole curve
from them. **→ Written in full below.**

### 2. From crank to contact patch
Gear ratios, final drive, efficiency, and the two equations that turn an engine
into motion:

$$F_{\text{wheel}} = \frac{\tau \cdot i \cdot \eta}{r}, \qquad v = \frac{\omega \cdot r}{i}$$

Deriving road speed per 1000 rpm in any gear, and using it to check your gearing
against the real car before you drive it. **→ Also in the chapter below.**

### 3. Tyres: the friction circle
The one idea that explains understeer, oversteer, trail braking, power-on
push and why four-wheel drive is subtle:

$$\left(\frac{F_{\text{long}}}{\mu N}\right)^2 + \left(\frac{F_{\text{lat}}}{\mu N}\right)^2 \le 1$$

A tyre spending a fraction $u$ of its grip sideways keeps $\sqrt{1-u^2}$ for
driving or braking. Everything else in this part is a consequence.

### 4. Cornering, braking, and the two numbers that size a circuit
$$v_{\text{corner}} = \sqrt{\mu g r}, \qquad d_{\text{brake}} = \frac{v^2}{2\mu g}$$

Corner speed scales with the **square root** of grip, which is why halving grip
does not halve your speed. And the deceleration a corner *demands* from where
you are now:

$$a_{\text{required}} = \frac{v^2 - v_{\text{corner}}^2}{2d}$$

That third equation is a control law, and getting it wrong is the single
biggest reason computer drivers run wide.

### 5. Weight transfer
Why the outside front tyre is the one that gives up first:

$$\Delta W_{\text{long}} = \frac{m \cdot a \cdot h}{L}, \qquad \Delta W_{\text{lat}} = \frac{m \cdot a_{\text{lat}} \cdot h}{t}$$

$h$ is centre-of-gravity height, $L$ wheelbase, $t$ track. Lowering the centre
of gravity is the single most effective handling change available, and this is
why.

### 6. Aerodynamics
$$F_{\text{drag}} = \tfrac{1}{2}\rho C_d A v^2, \qquad F_{\text{down}} = \tfrac{1}{2}\rho C_l A v^2$$

With $\rho \approx 1.225\ \text{kg/m}^3$. Why you should lump $\tfrac{1}{2}\rho
C_d A$ into a single coefficient in code, and the trap that follows: that number
is **not** the car's $C_d$, and everyone who reads your config will assume it
is. Solving terminal velocity analytically instead of driving until the number
stops going up.

### 7. Springs
Static sag, ride height and natural frequency:

$$f_n = \frac{1}{2\pi}\sqrt{\frac{k}{m}}$$

Why a game car is sprung far stiffer than a road car and still needs visible
travel.

---

## Part II — Turning equations into a car

### 8. The fixed timestep is not optional
Suspension and tyre models go unstable on a variable `dt`. The accumulator, and
interpolating the render pose between physics steps. The one architectural
decision that cannot be retrofitted later.

### 9. What a raycast vehicle gives you, and what it does not
Four springs and a contact patch. Everything with character — the engine, the
gearbox, the differential, weight transfer you can feel — sits *above* that API
and is yours to write.

### 10. Gearboxes that shift like a gearbox
An upshift point above the rev limiter is an upshift that never happens: the
engine pins against the limiter in first and the car never leaves it. Then
kickdown, and why a rule that forbids downshifting at full throttle is exactly
backwards.

### 11. Differentials
Four-wheel drive is not "all four tyres get torque". It is a centre
differential moving torque to the axle with grip left. Weighting each axle by
its remaining $\sqrt{1-u^2}$ — and why a *fixed* split is worse than not having
one at all.

### 12. Numerical hygiene
The per-step force buffer that one code path forgot to clear, became a running
total, reached 183 kN against a 2.7 kN cap, and launched the car off the map
every time you braked to a stop.

---

## Part III — Make it feel like a car

### 13. You have no steering wheel
A real simulator keeps itself playable through force feedback. You do not have
one. Everything in this part exists to replace that channel with sound and
motion — and the warning must arrive **before** the limit, not after.

### 14. Tyres that warn you
Driving sound from continuous slip rather than a boolean. Two signals, because
utilisation saturates and slide starts too late. Front and rear as separate
voices so the player can hear *which end* went.

### 15. Show the load moving
Exaggerating rendered body roll 1.3–1.6× beyond the physical angle, and why it
must come from suspension compression rather than world attitude — or every
hill pitches a car that is sitting perfectly level on its springs.

### 16. A camera that leans, and knows when to stop
Following the velocity vector so a slide stays readable, clamped at about 15°.
Includes the version that reached 26° median and 71° peak, which is a replay
camera, not one you can drive from.

### 17. Sense of speed is optical flow
Angular rate scales as $v/d$, so what governs perceived speed is *nearby*
detail, not the speedometer. Why filling the screen with your own car makes it
worse.

---

## Part IV — Make it fun

### 18. "Too sim" is three bugs wearing one costume
Mute, unforgiving past peak slip, and instant on input. Diagnose which you have
before changing anything.

### 19. Never fix a communication problem with grip
The most expensive mistake available: the symptom vanishes, the car ends up on
rails, and the evidence that you did it is gone.

### 20. Steering needs a time constant
A stick travels lock to lock in one frame; no steering rack does. Rate-limit
angular velocity rather than capping angle, and return to centre faster than you
leave it — that asymmetry is most of what reads as mass.

### 21. The computer driver that would not brake
An autopilot whose speed target was right the whole way in, arriving at a
101 km/h corner doing 153. A brake driven by how far past the limit you already
are cannot work; one driven by $a_{\text{required}}$ is a fixed point.

### 22. One recording, three answers
A delta bar, sector splits and a ghost car are the same question asked three
ways. Sample against *distance*, not time, and any two laps become comparable.

---

## Part V — Make a world

### 23. Circuits from a centreline
Extruding a road from a closed spline, and the geometry checks that catch a
layout which folds through itself before anyone drives it.

### 24. Constants that are densities, not counts
Scale your circuits and a constant written as "720 samples" silently changes
meaning, while "one sample every 1.8 m" does not. Four separate visible bugs,
one cause.

### 25. Surfaces
Gloss maps and roughness maps are opposites and two major libraries ship
opposite conventions. Making a photograph tile when it was never meant to.

### 26. The build that took fifty seconds
Replacing a per-cell expanding-ring search with one multi-source flood fill:
50 s to 2.9 s, and why the editor felt broken until it was fixed.

---

## Part VI — Make it look right

### 27. Flat shading is a budget, not a switch
Why a 78,000-triangle car renders smooth however you set the material.

### 28. The colour-space trap
Rendering to an off-screen target silently changes what your shaders must
output. Enabling any post effect repainted the sky and nothing warned us.

### 29. Loading models people actually download
Four ways a downloaded car breaks a loader: quantized meshes whose scale lives
in the node matrix, scenes shipping a ground plane and a backdrop, wheels named
only by their material, and rims left behind in the bodywork.

---

## Part VII — How we knew

### 30. Measure, do not assert
Instrument first. Several numbers that did not survive sounded more convincing
than the ones that did.

### 31. Tests that pass because of the bug
A gearbox test read the final gear after 25 seconds of full throttle. It passed
because the gearbox could not downshift, so the car sat in top doing 40 km/h.
Fix the bug and the test fails.

### 32. When the eye beats the instrument
Three times in one project the person driving was right and the measurement was
wrong — because the measurement was of the wrong thing.

### 33. Write down why, next to the number
Twenty-seven percent of this codebase is prose. The comment saying "this looks
wrong, and here is the measurement proving it is right" is what stops the next
person — usually you — from reverting it.

---
---

# Chapters 1 & 2 — The engine and the drivetrain

You have a spec sheet. It says something like:

> **618 hp @ 7400 rpm · 479 lb-ft @ 5600 rpm · 6-speed · final drive 2.37 ·
> top speed 240 mph**

By the end of this chapter that becomes a car that accelerates correctly, pulls
the right gear at the right moment, and runs out of breath at the right speed —
and you will be able to check each step before you drive it.

## 1.1 The one equation

Power is torque times angular velocity:

$$P = \tau \cdot \omega$$

$\tau$ in newton-metres, $\omega$ in radians per second, $P$ in watts. Engines
are quoted in rpm, so:

$$\omega = \frac{2\pi \cdot \text{rpm}}{60} \approx \frac{\text{rpm}}{9.549}$$

Which gives the form you will use constantly:

$$P[\text{kW}] = \frac{\tau[\text{Nm}] \cdot \text{rpm}}{9549}$$

And for the units spec sheets insist on: $1\ \text{hp} = 745.7\ \text{W}$,
$1\ \text{lb-ft} = 1.35582\ \text{Nm}$, $1\ \text{mph} = 1.60934\ \text{km/h}$.

**Everything about how an engine feels lives in this equation.** Torque is the
shove you feel. Power is torque *multiplied by how often you get it*, which is
why a small engine that revs can out-accelerate a big lazy one despite making
less torque everywhere.

## 1.2 A spec sheet is over-determined, and that is a gift

Look again at the two headline figures. They are not independent — they are two
points on the same curve, and each one tells you the torque at a different rpm.

Peak torque is stated directly: 479 lb-ft = **650 Nm at 5600 rpm**.

Peak power gives you a second point. 618 hp = 460.8 kW at 7400 rpm, so:

$$\tau_{7400} = \frac{P}{\omega} = \frac{460{,}800}{2\pi \cdot 7400 / 60} = \frac{460{,}800}{774.9} = 595\ \text{Nm}$$

So this engine still makes **595 Nm at 7400 rpm** — 91.5% of its peak, 1800 rpm
past it. That single derived number constrains the entire top end of the curve,
and it is why you cannot draw the curve freehand: pick a shape that falls away
faster and your engine will not make its quoted power.

This is worth internalising, because it also tells you what *kind* of engine you
are modelling before you write a line:

| Falls away | Character |
|---|---|
| Steeply after the torque peak | Small turbo. All done by 4500, then holding on. |
| Barely at all | Big naturally aspirated. Keeps pulling to the limiter. |

A turbo four might make peak torque from 1450 to 4500 rpm and then drop hard. A
6.1-litre V12 gives up 8% across the 1800 rpm above its peak. Both are "correct
curves"; they are completely different cars.

## 1.3 Author the curve as a *shape*

The naive approach is a lookup table of `[rpm, Nm]` pairs. It works, and it makes
the engine impossible to tune: change the peak torque and you have to redraw
every point.

Instead, treat the table as a **normalised shape** and let one number scale it:

```js
// The authored curve is a SHAPE. Only its proportions matter.
const shape = [
  [1000, 430], [2000, 520], [3000, 580], [4000, 620], [5000, 643],
  [5600, 650], [6200, 640], [6800, 620], [7400, 595], [7500, 583],
];

// Normalise so the peak is exactly 1.0, then scale by one tunable.
const peak = Math.max(...shape.map(([, t]) => t));
const torqueAt = (rpm) => lerp(shape, rpm) / peak * TUNING.engine.peakTorque;
```

Now `peakTorque` is a slider that means something, the shape survives
independently, and — critically — the number on the car's spec card can be
*read out of the running simulation* rather than typed in beside it.

That last point is not cosmetic. In this project a car's card claimed 520 hp
while the simulation was making 437, and nothing in the code could ever have
noticed. Derive every displayed figure:

```js
function peakPowerHp() {
  let best = 0;
  for (let rpm = 1000; rpm <= TUNING.engine.maxRpm; rpm += 10) {
    best = Math.max(best, torqueAt(rpm) * rpm / 9549 / 0.7457);
  }
  return best;
}
```

If the card and the car disagree, the card is wrong by construction — which
means it cannot be.

**Check it.** Sweep the curve and confirm peak power lands where the spec sheet
says. Our V12 came out at 618 hp at 7400 rpm, on the nose. When it instead
landed at 7500, the tail of the curve was one point too flat: without a drop
between 7400 and the limiter, peak power lands on the limiter rather than where
the manufacturer put it.

## 2.1 From crank to contact patch

Torque at the crank is multiplied by the gearbox and the final drive, loses a
little to friction, and is divided by the wheel radius to become a force:

$$F_{\text{wheel}} = \frac{\tau \cdot i \cdot \eta}{r}, \qquad i = i_{\text{gear}} \cdot i_{\text{final}}$$

$\eta$ is drivetrain efficiency, around 0.9 for a manual. $r$ is the loaded
wheel radius in metres.

Worked, in first gear of that V12: $i = 3.23 \times 2.37 = 7.66$, and at 650 Nm
with $r = 0.344$:

$$F = \frac{650 \times 7.66 \times 0.9}{0.344} = 13{,}024\ \text{N}$$

On a 1140 kg car that is $F/m = 11.4\ \text{m/s}^2$, or **1.16 g** — which
immediately tells you something useful: that is more than the tyres will take.
First gear is traction-limited, not power-limited, and you have learned that
before writing any tyre code.

## 2.2 Road speed, and checking your gearing

The wheel turns at engine speed divided by the overall ratio, and road speed is
that times the radius:

$$v = \frac{\omega_{\text{engine}} \cdot r}{i}$$

Substituting the rpm form gives a formula worth memorising, because
manufacturers publish exactly this figure:

$$\text{km/h per 1000 rpm} = \frac{377 \cdot r}{i}$$

For sixth gear of that V12 — $i = 0.93 \times 2.37 = 2.204$, $r = 0.344$:

$$\frac{377 \times 0.344}{2.204} = 58.8\ \text{km/h per 1000 rpm}$$

Now check it against the spec sheet, which says 53. **They disagree by 11%.**

This is the moment that matters, and the temptation is to "fix" it by changing
the ratios you were given. Do not: the ratios are real and measurable, so the
disagreement is in $r$. Back-solving, the spec implies a 0.31 m wheel radius,
where the model measured 0.344.

Which is right? For *rendering*, the model's radius — the wheels must sit in the
arches the artist drew. For *gearing*, it means your top gear is 11% taller than
the real car's. You can absorb that in the final drive, or you can let it stand
and set the top speed with drag instead, which is what we did. Either is
defensible. What is not defensible is not noticing.

## 2.3 rpm is kinematic, and that has consequences

Above the clutch's slip range, engine speed is not a state you integrate. It is
*determined* by road speed:

$$\text{rpm} = \frac{v \cdot i \cdot 60}{2\pi r}$$

This is the single most useful implementation fact in the drivetrain, because it
makes the gearbox a lookup rather than a simulation. The rpm a different gear
*would* produce is today's rpm scaled by the ratio between the two:

$$\text{rpm}_{\text{new}} = \text{rpm} \cdot \frac{i_{\text{new}}}{i_{\text{current}}}$$

So a kickdown — deciding which gear to drop to when the driver floors it —
becomes exact and instant:

```js
// The shortest gear that will not immediately need shifting back up.
for (let g = gear - 1; g >= 1; g--) {
  if (rpm * (gears[g - 1] / gears[gear - 1]) > ceiling) break;
  best = g;
}
```

It also gives you a free guarantee against hunting. Dropping back into the gear
you just left returns you to *precisely* the rpm you upshifted at — so if your
ceiling sits below the upshift point, that gear can never qualify. No timers, no
hysteresis, no tuning.

Below walking pace this breaks down: the clutch is slipping and the equation
would report zero rpm at a standstill, making zero torque, so the car could
never pull away. Blend toward a free-revving engine as speed approaches zero.

## 2.4 The lesson that cost us a second per corner

Here is the mistake, and it is a good one because the code looked reasonable for
months.

The gearbox had exactly one downshift rule: drop a gear below 2600 rpm. That is
an **anti-bog** rule — it exists so the engine does not fall on its face. It is
not a *performance* rule, and 2600 rpm in fourth is around 60 km/h. No corner is
that slow.

Worse, the rule carried a guard: `&& throttle < 0.9`. Flooring the pedal was the
one condition under which the gearbox was *forbidden* to drop a gear — backwards
from every automatic ever built, where the pedal on the floor is the kickdown
signal.

Measured, accelerating out of an 88 km/h corner at full throttle: the car sat in
fourth the whole way and took **3.8 s to reach 120 km/h**. With the gear it
refused to select, it took **2.8**.

The engine was fine. At 3800 rpm that turbo four was already making its full
340 Nm. What was missing was the *multiplication*: third against fourth is 1.515
against 1.156, which is **31% more force at the contact patch**, available the
whole time and simply not taken.

The general lesson: **keep both rules, and split them by the pedal.** Lift, and
you want the anti-bog rule. Floor it, and you want the shortest gear that will
pull. They are answers to different questions and one rule cannot serve both.

## 2.5 A checklist before you drive

Everything above is verifiable without rendering a frame:

- [ ] Sweep the curve. Does peak power land at the quoted rpm, at the quoted
      figure?
- [ ] Does peak torque land at its quoted rpm?
- [ ] Compute km/h per 1000 rpm in top. Does it match the spec sheet? If not,
      you have a wheel-radius problem, and you should decide what to do about it
      deliberately.
- [ ] First-gear wheel force divided by mass — is it above 1 g? It should be, or
      your car has no launch.
- [ ] Solve terminal velocity (Chapter 6) and compare with the quoted top speed.

Five checks, no graphics, and they catch the errors that are almost impossible
to diagnose by feel — because a car that is 11% wrong in the gearing does not
feel broken. It just feels a bit off, and you will spend a week adjusting grip
trying to fix it.

---

*Chapters 3–33 are outlined above and not yet written.*
