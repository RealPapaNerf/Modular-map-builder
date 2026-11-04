# Modular map builder

Procedurally generated, 3D-printable terrain tiles that **mate with each other**
and have **rivers that actually run across the seams**. Built on the ideas in
[relief](https://github.com/RealPapaNerf/relief), but for invented ground
rather than real places.

No dependencies. Node 18 or newer and nothing else.

**[Build one in your browser](https://realpapanerf.github.io/Modular-map-builder/app/)** — same
generator, same contract checks, nothing to install and nothing uploaded. Or on the
command line:

```bash
node bin/mmb.mjs example > map.json
node bin/mmb.mjs check map.json          # contract, plate levels and seams
node bin/mmb.mjs build map.json --out tiles/
```

![A 3x3 map, hillshaded](docs/preview.png)

*Nine 200 mm tiles. The river enters each tile 12 mm up and leaves 2 mm from
the bottom, so every tile it crosses sits one 10 mm plate lower than the one
before. The mountain runs across three seams without a step; the terraces are
the plate levels.*

---

## The flow rule, and what it actually fixes

Water leaves tile A at `outletZ` above A's base and arrives at B's inlet,
`inletZ` above B's base. For the surface to be continuous:

```
baseZ(A) + outletZ = baseZ(B) + inletZ
  ⟹  baseZ(A) − baseZ(B) = inletZ − outletZ = the tile's FALL
```

**The downstream tile sits lower by exactly the fall**, and since tiles stand
on 10 mm plates the fall has to be a whole number of them. The plate stack is
not scenery under the map — it *is* the river's gradient, quantised.

### Falls are per tile, 10 to 50 mm

| fall | gradient | what it is |
|---|---|---|
| 10 mm | 5% | a river |
| 20 mm | 10% | a fast river |
| 30 mm | 15% | rapids |
| 40 mm | 20% | a torrent |
| 50 mm | 25% | a cascade |

A tile declares its own, and stands that many plates below its upstream
neighbour. `inletZ = outletZ + fallMM`, so the steepest puts an inlet 52 mm up.

Two consequences worth knowing before you draw a map:

**The real invariant is `inletZ − outletZ = fallMM`, not "12 and 2".** The
absolute heights are free, and at `outletZ = 2` there is only 2 mm of plastic
under the channel where it leaves the tile — about ten layers at 0.2 mm, thin
for something that holds water and gets handled by a child. `outletZ 4` keeps
every fall identical and doubles the floor. The default is the 12/2 you asked
for and `check` says it is thin rather than deciding for you.

**Plate levels are a difference-constraint system.** Each arc says
`level(upstream) − level(downstream) = plates`, and that is *all* it says. The
first solver treated it as a longest path with every source pinned at level 0,
and that produced a **false error on the most ordinary thing a river does**:
two tributaries of different lengths meeting. They do not conflict — their
sources simply end up at different heights, which is what tributaries look
like. A real conflict needs a **loop**: a channel that splits and rejoins, so
going round it has to sum to zero and does not.

```
error: Tile 1,1 is reached by two rivers that have fallen different amounts,
so it would have to sit -4 and -2 plates up at once. The river splits and
rejoins somewhere, and the two ways round do not drop the same. Change a fall
on one of them, or add a waterfall to the shallower.
```

### Rivers get wider as they gather

Width goes as the **square root of discharge** — hydraulic geometry, good
across four orders of magnitude of real river — and discharge adds at a
confluence. So widths add in quadrature:

```
w_out = ceil_to_ladder( √( Σ w_in² ) )
```

Rounded **up**, because a channel narrower than its flow is the failure that
floods the tile. Two 10 mm creeks give 14.1 mm → 20. Three give 17.3 mm → 20.
Both are exactly what the brief said, which is a good sign the brief was
hydraulics all along rather than a guess.

| ladder | | |
|---|---|---|
| creek | 10 mm | channel |
| stream | 20 mm | channel |
| river | 30 mm | channel |
| bay | 40 mm | **opening** |
| fjord | 50 mm | **opening** |

The two widest are mouths, not rivers — a bay, a fjord or the neck of a lake —
so they are cut as openings with a short steep lip instead of long banks.

**Steeper tiles need less width.** Manning gives `Q ∝ w · d^(5/3) · S^(1/2)`,
so for a fixed flow the width needed falls as the square root of the gradient:
a 30 mm river on a 10 mm fall only needs 20 mm on a 30 mm fall. A declared
width is never silently changed — the width is visible on the printed tile —
but one that is too narrow for its inflow is reported:

```
warning: B2 S is declared 10 mm but takes in 20 mm of river over a 30 mm
fall, which wants 20 mm. It will flood.
```

### A step at a seam is a feature, not a fault

In the first version both sides had to declare the same height or the map was
refused. That throws away the most useful thing the system can do. A seam is
now **classified**:

| | |
|---|---|
| **plane** | both sides at one height, the ground runs straight across |
| **cliff** | a step in the land, no water crossing it |
| **waterfall** | a step the river falls down |
| **dam** | a step the river would have to climb; it ponds behind instead |
| **ledge** | the water runs level and the ground either side steps |

A 50 mm edge against a 10 mm edge is a 40 mm cliff. Declare `waterfalls:
{"1,1": 20}` and that tile sits 20 mm further below its upstream neighbour
than its own fall accounts for, and the river free-falls the difference.

The sign is read **from where the water comes from**, not from the order the
tiles happen to be checked in. Keying it to iteration order reported every
waterfall on a north-flowing river as a dam.

**A waterfall at a seam is also the best answer to leaking** — water that is
*airborne* across the seam cannot find the gap at all. See below.

### Banks become levees where they have to

With a 50 mm fall an inlet sits 52 mm above the tile's base, well above any
land datum, so the ground beside it is not a bank at all and the water runs
out sideways. The bank therefore climbs to whichever is higher — the
surrounding land, or a freeboard above the water — and eases back down beyond.
Away from a port the profile is exactly what it always was. relief does the
same for a pool that has to hold its level: *"wherever its rim is lower than
that a lip is built up."*

The first attempt instead raised the whole corner lattice to clear the deepest
port, which dragged every rim on the map above the terrain and brought the
picture-frame moat straight back, inverted as a wall.

## Making the water stay in the river

This is the hard part and it was asked as: *a key and half an o-ring, or a
rubber band glued in and squished?*

**Neither, and the reason is worth being clear about: a gasket needs clamping
force, and tiles sitting loose on a table have none.** An o-ring seals when it
is compressed 20–30% of its cord diameter and *held* there. The seam between
two tiles is a vertical face; gravity does not act across it at all. A few
newtons of tile weight is nowhere near a seal, and a rubber band takes a
compression set and perishes besides. To make a face gasket work you would need
magnets or a cam latch pulling every seam closed — real clamping force, and a
lot of mechanism for a map a child assembles.

### Move the gap out of the water's path instead

The seam does not have to be watertight. It has to not be *where the water is*.

Give the outlet a **shelf that reaches past the tile's footprint**, and the
inlet a **matching rebate** so the shelf lands flush with the downstream
channel floor. Water then runs from A's floor, across the shelf, onto B's floor
with no step and no gap under it. The seam gap sits *underneath* the shelf, and
anything that does creep past drips into the rebate — which is already part of
B's channel, so it rejoins the river.

That is a drip edge. It works on a roof for the same reason, and it has no
gasket to compress, nothing to glue, and nothing to perish.

```js
seamGeometry(makeContract({ seam: 'overlap', outletZMM: 6 }))
// { style:'overlap', ok:true, tongueMM:6, tongueThickMM:2.5,
//   rebateMM:6.3, rebateDepthMM:2.8 }
```

**But not at `outletZ = 2`.** The shelf has to be cut from the plate under the
outlet floor, and 2 mm is not enough to take a 2.5 mm shelf. The code refuses
it and says what to change:

```
error: An overlapping seam cuts a 2.5 mm shelf out of the 2 mm of plate under
the outlet, leaving -0.8 mm. Raise outletZMM to 4 or more (inletZMM follows
it, and the 10 mm fall is unchanged).
```

This is the single strongest argument for moving off 12/2 to **14/4**.

### Then catch what gets through

Every modular water feature that survives has a drip tray, and relief already
has the right shape for it: the fountain reservoir is *"a tub the plate sits
down into, with a slot around its edge so runoff from the plate's edges drains
straight in."* Do the same here — the assembled map sits in a shallow tray, the
pump draws from the tray.

That reframes the whole problem. **You do not need watertight. You need most of
the water to go where you're looking, and all of it to come back.** Seepage is
return flow, not failure.

### Within a tile is a different, easier problem

A channel leaking *downward through the print* is a slicer question, not a
design one: 4+ perimeters, 5+ top/bottom layers, and a real floor under the
channel (`minChannelFloorMM`, default 3). FDM is not watertight along layer
lines by default. Your pieces are already painted — acrylic plus a clear coat,
or a thin brush of epoxy in the channel, *is* the sealant, and you're most of
the way there.

### The key

Keep the dog-bone key from relief, but **do not glue it** and open the
clearance to 0.3–0.4 mm. Glued at 0.15 mm it is a permanent joint, which is the
opposite of what a map assembled every game night wants. Un-glued it is a
registration pin: it stops tiles sliding apart, the overlap handles the water,
and the whole thing lifts off the table in pieces.

One caveat the geometry forces: **neighbours at different plate levels cannot
share an underside key**, because their undersides are 10 mm apart. Along the
river — which is where every level change is — registration comes from the
plate stack underneath instead.

---

## What makes the terrain

### Glaciers are simulated, and should be

relief's overhangs brief argues simulation is unnecessary at print scale, and
for a sandstone cliff that is right — the shape comes from a seepage band and a
beam limit, both closed-form. It does not transfer. A glacial valley's shape
*is* the signature of the process, and none of it is a function of a footprint
you could draw.

Ice is modelled as a shallow, isothermal, Glen-law fluid — the standard
shallow-ice approximation, flux written as a diffusion of the ice **surface**:

```
q = −D ∇s,   s = b + H
D = (2A/(n+2))(ρg)ⁿ H^(n+2) |∇s|^(n−1)   internal deformation
  + C_s (ρg)² H³ |∇s|                     basal sliding
ė = K · u_b                               abrasion follows the SLIDING, not the ice
```

Flowing on the *surface* slope rather than the bed slope is why a glacier
overdeepens its bed and leaves a basin behind, where a river never can. That
is also the test:

> **the glacier overdeepens its bed — the signature a river cannot fake**
> A river bed can never rise downstream. The test asserts the starting valley
> falls monotonically and that glaciation leaves at least one reverse slope
> along the floor. It does: ~130 m of back-tilted bed where there was none.

Erosion follows sliding, not ice thickness, because cold-based ice frozen to
its bed erodes nothing — which is why plateaux survive between glaciated
troughs.

### Cut, retreat, cut again

One glaciation at one climate carves one trough and nothing else. The
landforms that make glaciated country *recognisable* are the work of repeated
advances with the snowline moving between them, so the ELA swings as a cosine:
warm at the start, coldest half way through each cycle, warm at the end —
which leaves the map deglaciated, the state you would print.

| | |
|---|---|
| **cirques** | bite in at the snowline. A snowline that *moves* leaves a staircase of them at different heights instead of one |
| **hanging valleys** | a tributary carries less ice than the trunk and cuts less deep. Every advance widens the gap |
| **waterfalls** | are what a hanging valley is, once the ice has gone |
| **tarns** | sit in the overdeepened cirque floors afterwards |

```json
"glacier": { "elaSwingM": 450, "glacialCycles": 3, "cycles": 60 }
```

**Cycling needs more total cycles than a steady climate, not the same.** Each
advance only erodes while it is cold, so three cycles over 36 geomorphic steps
does *less* work than one steady climate over 36 and comes out softer. Sixty
gives each advance about twenty steps, which is where the troughs start
showing rounded heads instead of a uniform comb.

### Two things that had to be put in by hand

**The glacial buzzsaw.** Erosion scaling with sliding alone *cannot* make a
cirque, and that is a limitation of the shallow-ice approximation rather than
a bug. Sliding goes as the square of basal shear, which goes as ice thickness,
so the **head** of a glacier — where the ice is thin — erodes least. Real
cirques are excavated at exactly that spot, by rotational flow in a closed
cell that the SIA has no way to represent. So the observation goes in
directly: erosion is multiplied by a bump centred on the ELA, which is why
cirque floors across a range cluster at one elevation. `buzzsawGain: 0` turns
it off and leaves sliding alone.

**Quarrying.** Abrasion is ice dragging grit over rock; it scales with speed
alone, polishes evenly, and never steepens anything. Quarrying is blocks being
levered out, and it concentrates where the bed is already steep — the lee of a
bedrock step, the back wall of a hollow. That is the term that makes a
headwall *retreat* into a cirque instead of being smoothed off.

It is keyed to a **smoothed** bed, which is not a detail. Read off the raw
grid, quarrying responds to single-cell noise, and that is a positive feedback
— a cell slightly below its neighbours has a steeper local gradient, so it
quarries harder, so it drops further. The first run turned a valley into 175
pits and reported them as basins.

### Creep is what sorts cirques from pits

Diffusion damps a feature at a rate going as the **square** of its wavenumber,
so a 300 m pit is smoothed roughly fifty times faster than a 2 km cirque.
Without it the bed ends up covered in single-cell hollows that nothing
counting closed depressions can tell from corries. With it, the small ones
fill and the big ones stay — which is what talus and till do on real ground.

The critical-angle rule cannot do this job: on a 133 m grid, 55° allows a
190 m step between neighbours, so a 40 m pit is nowhere near steep enough to
trigger it.

`lib/basins.js` finds closed hollows by priority-flood, which is both the
proof the ice worked and the input lake carving will need.

**Four numerical mistakes, all of which shipped wrong before being caught**, are
documented in `lib/glacier.js` because each is the obvious thing to do:

1. **Sliding coefficient out by 11 orders of magnitude.** Nothing slid, nothing
   eroded, and the run looked "stable".
2. **ADI is only unconditionally stable for the *linear* problem.** D goes as
   H⁵. A fixed 3-year step reached an ice thickness of **1e303**.
3. **Diffusive stability is not the only limit.** With the step taken only from
   `dx²/4D`, the model grew **2500 m of ice in 76 years** on a climate capped
   at 1.3 m/yr — the explicit bed term `∇·(D∇b)` is enormous at a valley axis
   and delivers ice that does not exist. The step is now also held to a maximum
   change in thickness.
4. **One balance gradient for both snowfall and melt builds an ice cap on every
   terrain.** Melt responds to temperature far more steeply than snowfall
   responds to height, and that asymmetry is the *only* thing that stops the
   height/mass-balance feedback running away.

Plus one physical one: basal shear **yields**. Uncapped, a 1200 m trough
glacier reached 5.4 bar and slid at 1460 m/yr — a permanent surge everywhere —
and erosion saturated its limiter on the first cycle, merely lowering the block
instead of carving it.

**Honest state:** the ice is numerically sound, confined to valleys, and
produces overdeepening and realistic rates (≈2 mm/yr, 100–200 m of trough over
100 kyr). The U-widening is **weaker than it should be** — `valleyForm` moves
from 0.22 to 0.25 where a real trough is 0.4+. The glacier narrowly fills the
valley rather than reaching wall to wall, so it deepens more than it widens.
`elaM` and `erosionK` are the levers and `valleyForm()` is the metric. This is
the most under-tuned part of the repo.

### Mesas and volcanoes are built, not simulated

Different reason for each, and neither is a cop-out.

A **mesa** is a consequence, not a shape: a resistant layer over a weak one.
`makeStrata` gives the erosion pass a stack of beds with different
erodibilities and the flat tops, cliff bands and detached buttes follow. The
contacts carry a noise term so the benches don't all break along one contour.

A **volcano** is a handful of numbers — a cone steepening toward the vent, a
crater, a breached rim, radial gullies. Simulating magma buys nothing. Then the
erosion passes work it over, which is what sells it.

### Walls come down

Abrasion alone *deepens* a valley and never widens one; run ice on a V and you
get a sharper V. What widens a trough is the wall above the ice failing once
the glacier has undercut it. `lib/hillslope.js` is that: nothing stands steeper
than its critical angle, and what comes off piles up where it lands.

---

## Rivers that follow their valley

The first version drew a Bezier between the two ports with a little noise on
the control points, and **never read the terrain at all**. So the ice would
spend thirty seconds carving a trough and the river would then wander across
it, over the shoulder and down the other side. A river that ignores its own
valley is the most visible thing that can be wrong with a map like this.

It is now a least-cost route over the ground, with three terms plus one that
is not physics:

| term | why |
|---|---|
| distance | so it does not take scenic detours for nothing |
| height | water prefers low ground, normalised against the tile's own relief so the same weight behaves the same on a mountain and a plain |
| climbing | paid only going **up**. Without it a path will happily cross a ridge if the far side is low enough to pay for it |
| wander | small deterministic noise, because on a floodplain every route costs the same and the shortest is a straight line |

Measured against a valley whose axis swings 55 mm off the straight port-to-port
line: the routed river sits **1.6 mm** from the axis, the old curve **27.8 mm**.

### Route before conforming

This one is subtle and cost a rebuild to spot. Conforming the tile to its rim
*first* digs a trough: the rim profile has a deep notch at each port, and the
transfinite patch that fits the interior to it interpolates between those
notches, leaving a straight channel-shaped depression down the middle of the
tile. Route on that and every river comes out dead straight — faithfully
following a valley the rim fitting invented. So the order is **route, then
conform, then carve, then conform again**.

### Meandering is confinement, not noise

Raising the wander term does not make a river meander: it saturates around
sinuosity 1.07, because a detour has to pay for its own extra length and a
cost field can only discount so much.

So meandering goes in as what it actually is. A river meanders where it has
**room** — on a floodplain, by eroding one bank and building the other — and
it does not meander in a gorge, because the walls are in the way. The lateral
offset is scaled by how free each point is: probe the ground either side, and
where it rises steeply, stop pushing.

One number, both behaviours. On a floodplain sinuosity comes out around 1.2;
in a gorge the river does not move off its axis at all. Both ends taper to
zero so the ports stay exactly where the contract put them, and bends are
clamped clear of the rim so they cannot fight the contract — which always
wins.

## Standing water

Tarns, lakes and the mouths of bays are **one operation**, not three. All of
them are a flat surface at some level, everything below it connected to a
seed, and a bed scooped under it. What differs is only where the seed comes
from and what sets the level: the glacier's own hollow, a point on the map, or
the port in the rim.

```json
"lakes": { "fillHollows": true, "depthMM": 5, "shoreMM": 10, "profile": "dish",
           "place": [{ "tile": "B2", "atMM": [120, 80], "depthMM": 6 }] }
```

### Tarns are the payoff for the glacier

A river **cannot** leave a closed hollow — water running downhill fills them
as it goes — so every hollow on the map is somewhere the ice overdeepened its
bed. `lib/basins.js` finds them by priority-flood, and the water sits at the
**sill**: the lowest point it would have to cross to get out, which the flood
has already computed.

A shallow hollow gets a shallow lake. Scooping a fixed 5 mm out of a 1 mm dip
would turn a damp patch into a quarry.

### Flood or excavate

Two ways to decide how far water reaches, and they are not interchangeable:

| | |
|---|---|
| **flood** | everything below the surface connected to the seed. Right for a lake filling ground that is already low |
| **excavate** (`radiusMM`) | a lobed disc, dug out whatever the ground was doing. Right for a bay or fjord mouth, where the water is a given and the land gets out of its way |

Flooding a bay mouth silently produced *nothing*: its surface sits at the port
floor, near the very bottom of the tile, no ground inland is below that, so
the fill found zero cells and reported "too small".

### What the geometry forces

- **A lake is a hole**, not a painted surface — so you can pour clear epoxy
  into it. Volume is reported in millilitres, per lake and per map.
- **The bed is only ever cut down.** Setting it outright would fill a deep
  cirque back in to a fixed depth, so a tarn in a 25 mm hollow would come out
  5 mm deep.
- **Carved after the tile is conformed**, because the contract is fitted by
  adding a smooth correction across the whole tile and that would *tilt* a
  flat water surface.
- **Nothing is clipped at a seam.** A hollow that reaches the rim is reported
  and left alone, not cut in half. Same rule as trees and alcoves.
- **The fill is four-connected.** Eight-connected leaks diagonally through a
  one-cell gap, and a lake that escapes its basin is invisible until it is
  printed.
- A bay's depth is limited by `outletZMM`, because its surface is the lowest
  water on the map. At the original 2 mm there is no room for a bed at all and
  it says so. The example now uses **6 mm** — same fall, same plate counts,
  three times the floor under the channel.

`dish`, `flat` and `cone` are the bed profiles. Both `dish` and `flat` reach
full depth `shoreMM` in from the shoreline; they differ only in the shape of
the ramp, and the rounded one gets there sooner — so a **dish holds more than
a flat bed**, which is the opposite of what the names suggest.

## Seam keys

A seam butts on nothing. Two tiles sitting side by side on a table slide
apart the moment a child leans on them, and a river that was lined up to a
hundredth of a millimetre is then a river with a step in it.

So every seam that can take one gets a **dog-bone key**: a wide pad in each
tile joined by a narrow neck across the seam, dropped into a recess cut in
the **underside** of the two plates. The map face above is untouched. Pulling
the tiles apart would mean dragging a pad through the neck, so the seam cannot
open, and the pads register the two tiles in every direction at once.

```json
"joints": { "padMM": 20, "neckMM": 9, "reachMM": 14,
            "depthMM": 3, "clearanceMM": 0.35, "spacingMM": 120 }
```

**Square shoulders, not a dovetail.** They hold the same — it is the neck
being narrower than the pad that locks, not the angle — and they print without
feather edges. A dovetail would in any case only work along one axis, and a
tile in the middle of a grid has seams on four sides; you cannot slide it in
from four directions at once.

**Not glued.** This is where it parts company with relief, which keys a seam
at 0.15 mm and glues it because a wall map is assembled once. This one comes
apart on the table every time it is played with, so the fit is a **0.35 mm
slip fit** and the key is a loose part you drop in. The clearance is the whole
difference between a map you can put away and a map you have built.

### Most seams get no key, and you should know which

A key is cut into both undersides, so the two tiles have to **be at the same
plate level**. Two tiles one plate apart have undersides 10 mm apart and
cannot share anything cut into them — and every level change on a map is along
the river, because that is what the plate stack *is*.

On the example map that is **7 of 12 seams**, and the plan says so:

```
Seam keys: 10 planned, 20 of 20 recesses cut.
  7 seam(s) have a plate step and take no key: B2/B3, B2/C2, B1/B2, ...
  Those tiles are registered by the plate stack under them, not by a key.
```

Keying the **plates** to each other, and the tile to its topmost plate, would
close that gap. It is the obvious next piece and it is not built.

### Refused whole, never cut short

Where the plate runs thin — under a river channel, under a lake bed, beside a
tube bore — the key is **left out entirely** and counted:

```
the plate is only 2.5 mm there, and a 3 mm recess would leave -0.5 mm
```

A recess a key cannot sit in is worse than no recess at all: the tile rocks.
relief makes the same call for the same reason.

### Ear clipping, because a dog-bone is not convex

Both shoulders are reflex corners, so a triangle fan from one vertex puts
faces outside the shape. The alternative — decomposing it into three
rectangles by hand — leaves a T-junction where the narrow neck meets the wide
pad, and the solid leaks there. Thirty lines of ear clipping, and the outline
vertices are shared by the top, the underside and the walls, so it closes by
construction.

`build` writes `keys.stl` (a sheet of as many as the map actually needs) and
`key-one.stl`. Print them flat.

## Fountains

```json
"fountains": { "auto": true, "tubeOdMM": 12.7, "poolRadiusMM": 16 }
```

**The circuit.** A pump sits in a tray under the assembled map. A tube runs
up through the plate stack and comes out at a spring near the top. From there
the water is on its own: down the channel, over each seam, one plate lower
every tile, and off the drain edge back into the tray. Nothing is pumped
sideways and **no tube crosses a seam**, because a tube across a seam is a map
that cannot be taken apart.

**The map already knew where the fountains go.** An inlet with nothing
upstream of it is a port taking water from off the map — which `check` has
been reporting all along as *"takes a river in at its N side from off the map.
That needs a fountain or a hose."* `auto` puts a spring at exactly those
points, on the channel, far enough in that its lip clears the rim.

### A spring is a pool, not a nozzle

A tube opening straight onto a hillside squirts — there is nothing between the
pump and the air — and a jet at the top of a map is where you least want one.
So the tube opens into a small pool with a raised lip and **one notch**, and
the water leaves over the notch at whatever rate it arrives. The pool takes
the velocity out. The notch faces down-channel, worked out from the river's
own direction at that point.

relief solves this with a buffer chamber under a lid whose top is the real
ground, so from above there is no pool at all. That needs rock standing over
air — a column holding more than one solid interval — and nothing here does
that yet. A pool is the honest version: all height field, watertight by
construction, and it works.

### A round hole through a height field

This is the one piece of geometry that cannot be done by moving vertices up
and down, so it has a construction of its own. A **block of grid cells is
removed**, leaving a rectangular hole whose corners are exact grid vertices,
and the gap between that rectangle and the circle is stitched as an annulus.
Both loops are closed and both are walked by bearing about the bore's axis, so
the stitch cannot tangle however the counts differ.

The obvious alternative — clipping each straddling cell against the circle —
is marching squares: a different case per cell and three chances per cell to
leave an unpaired edge. This way the only new vertices are *on* the circle,
and they are shared by the top, the shaft and the underside because all three
are built from the same list.

One consequence: with a bore, the underside can no longer be a fan from the
middle, because the fan would cross the hole. It is meshed as a grid instead,
which costs triangles on exactly the tiles that need it and nothing on the
rest.

### Drilled plates are a different part

A plate with a tube through it does not swap with one without. The plan says
which is which — *"the 6 plates under B3 need the same hole, 13.5 mm at
115,161 mm"* — and `build` writes `plate-drilled-B3.stl` alongside the plain
`plate.stl`.

### The tray

Written as `tray.stl` whenever the map has a spring: a flat floor, four walls,
and a ledge the plates rest on so the map sits a little above the water with a
gap all round for runoff to fall back in. The pump lives under the map and its
cord leaves through a notch in the back wall.

It comes out the size of the whole map, so **it will need splitting for your
bed** — the tool says so rather than pretending otherwise.

## Woods

Trees are **placed and stamped**, not noised. A noise field tuned to look
bumpy gives bumpy ground; what reads as forest from above is a field of
separate crowns. It also means size is a number you set rather than a
frequency you fiddle with — the same stamp at 4 mm is a hedge, at 9 mm scrub,
at 16 mm a mature canopy.

```json
"canopy": [
  { "kind": "conifer",   "crownMM": 7,  "heightMM": 9, "density": 0.45,
    "minZMM": 34, "maxZMM": 96, "thinningMM": 18, "maxSlopeDeg": 36 },
  { "kind": "deciduous", "crownMM": 12, "heightMM": 7, "density": 0.35,
    "maxZMM": 40, "thinningMM": 10, "maxSlopeDeg": 24 }
]
```

### Density

`density` is **the fraction of ground under canopy** — one number from bare to
closed, meaning something you can see rather than a distance you have to work
out from the crown size:

| | |
|---|---|
| 0.05 | a few scattered trees |
| 0.25 | open woodland, gaps everywhere |
| 0.55 | proper wood, crowns nearly touching |
| 1.0 | closed canopy, crowns overlapping |

Spacing follows from it, so changing crown size does not silently undo it.
Set `spacingMM` instead to drive it the other way round.

The footprint it divides by is **measured, not assumed**. A cone fills its
nominal circle give or take, but a lobed broadleaf crown has gaps between its
lobes and covers only about 73% of one — so using πr² for both priced
deciduous 27% too high and `density: 1` came out at 58% measured cover, which
made the number in the spec file mean nothing in particular. It is now
measured at runtime by stamping one tree and counting, because every shape
parameter changes the answer and a constant calibrated once would drift the
next time one was tuned.

**Crowns are meant to overlap, and the spacing law has to allow for it.**
Dividing the footprint by the target cover assumes they never land on each
other. They do, and once they do every extra tree covers less new ground than
the last — so `density: 1` came out at 0.89 of a crown diameter, crowns just
touching, ground visible between them, and a closed canopy that still read as
a scatter of separate trees.

Scattered crowns cover ground like a Poisson process, so

```
cover = 1 − exp(−A / s²)    ⟹    s = √( A / −ln(1 − cover) )
```

At `1.0` that is **0.39** of a crown diameter instead of 0.89, which is proper
overlap, and measured cover goes from 58% to 94%. (An earlier version of this
file claimed you simply cannot cover every square millimetre by scattering
discs. That was over-general — you cannot at a *fixed* spacing, but the
spacing is not fixed.)

And they fuse rather than crease. A plain `max` of two crowns leaves a sharp
V where they cross, so a dense stand reads as separate trees pressed together.
A soft union blends them over `mergeFraction` of the tree height: far apart it
is exactly `max`, so a lone tree is untouched and low density still reads as
distinct trees — where they overlap, they interlock, as crowns do in a closed
stand.

To see the range rather than guess at it:

```bash
node bin/mmb.mjs canopy --kind conifer --crown 8 --out sheet.png
```

seven patches left to right from 0.05 to 1.0, with the measured cover of each
printed. `thinningMM` makes a treeline a band rather than a line — the wood
thins out over the last few mm instead of stopping dead, which is what the
edge of a real one does.

**Conifer** is a cone with a slightly convex spire and a few branch whorls
stepped into the flank, because a plain cone reads as a traffic bollard. Plus
a small out-of-round plan and a lean, so no two are identical.

**Deciduous is cauliflower, not a dome.** This took three attempts. A dome
prints as a blister and reads as a boulder. Four lobes at half the crown
radius measured as 15% variation around a ring and *still* read as a smooth
ball — because at that scale the lobes **are** the dome. Broadleaf canopy from
above is many bumps at a quarter the width of the crown, so it is nine lobes
at under a third of the radius, over a small core that only exists to stop the
crown having a hole in the middle.

Crowns combine with a **smooth max**, never by adding. Adding makes a dense
wood swell into one mound and lose every crown edge.

| rule | why |
|---|---|
| `maxZMM` | a treeline, in **world** mm. The cheapest thing in the file that makes a mountain read right |
| `maxSlopeDeg` | nothing grows on a cliff |
| water | nothing is planted in the river, or within `bankMM` of it |
| the rim | a trunk that cannot stand clear of the seam by its own radius simply does not stand. **No tree ever crosses a seam** |

A treeline has to be read in world height. Tiles stand on different numbers of
plates, so local heights say nothing about how high a piece of ground actually
is — read locally, the treeline planted woods over every summit on the map,
because a tile six plates up looks exactly like a valley tile from the inside.

Crowns too coarse for the mesh are reported rather than silently printed as
lumps: below about five cells across, you want a finer `meshMM` or a bigger
crown.

## The edge contract

Everything else is downstream of this.

relief guarantees two tiles meet because they are cut from one global grid of
one map. That is **not** the guarantee wanted here. Here any piece's north edge
has to mate with any piece's south edge, across different maps, printed months
apart. So a tile's boundary is a **declared profile** that every tile is held
to, and the generator is free only in the middle.

### Corners, not a flat datum

The first version clamped every rim to one flat height. The first hillshade
showed what that does: **every tile came out as a plateau in a picture frame**,
because the generated terrain rose 40 mm above a rim pinned at 18 and the clamp
dug a moat around every piece.

A modular edge has to be *declared*; it does not have to be *level*. So land
height lives on a lattice of tile **corners**, shared by the four tiles meeting
there and quantised to the plate. An edge reads its two corners and ramps
between them.

- Two tiles agree along a seam because they read the same two corners.
- All four agree at a corner because there is only one of it.
- Terrain runs across the map in 10 mm steps instead of being flattened at
  every rim.
- A piece still mates with any piece declaring the same corners — which is what
  *"all pieces of a certain size should match"* means in practice.

### Interpolate the discrepancy, not the target

Three ways this has been wrong, and the third is the subtle one:

1. **Blend toward a flat datum near the rim.** Every tile came out a plateau
   in a picture frame — the generator rose 40 mm above a rim pinned at 18 and
   the clamp dug a moat round each piece.
2. **Blend toward a Coons patch of the declared edges.** Exact at the rim, but
   it still *overwrites* the terrain near the boundary with the rim surface.
   When a corner is shared with a tile five plates higher, that corner sits
   50 mm above where the generator put the ground — and the moat comes back,
   inverted, as a wall. This is what the second hillshade showed.
3. **Interpolate the discrepancy.** For each edge, take the residual between
   what the contract declares and what the generator produced *along that
   edge*. Build a Coons patch of those four residual curves and add it to the
   whole tile.

```
correction = (1−u)R_W(y) + u·R_E(y) + (1−v)R_S(x) + v·R_N(x)
             − [ (1−u)(1−v)·sw + u(1−v)·se + (1−u)v·nw + uv·ne ]
```

At the rim the residual *is* the gap, so the boundary lands exactly on the
contract. Inland the correction is a smooth low-order surface — a tilt, or a
gentle dome — so the terrain keeps all of its own shape and simply leans to
meet its neighbours. There is no blend distance to tune and nothing to
flatten, because nothing is ever replaced.

Getting the two north corner indices the wrong way round in that bilinear term
put every tile **0.86 mm** off its own contract — exactly the gap between its
two north corners. An exactness bug shows up as a small number, not an obvious
one, which is why the test asserts `< 1e-6` and not "looks right".

Current output: **worst edge error across every tile, 0.0000 mm.**

### The contract gets the last word

The tile is conformed to its contract, *then* the river is carved into ground
already at the right height, *then* conformed again so the rim is exact
whatever the carve did near it. In the other order every river tile came out
4.1–4.7 mm off contract, because the carve re-cut a channel the clamp had
already cut and took the banks down twice. Whoever owns the boundary has to
own it last.

The carve both **cuts and fills**, for the same reason the edge profile does:
with a 52 mm inlet the bed usually enters above the ground, and a carve that
only ever removed material left the top of the river with no channel at all.

---

## Layout

```
lib/contract.js    the edge contract: ports, falls, widths, corners, seam kinds
lib/field.js       the height grid, and the adapter to relief's terrain duck type
lib/noise.js       value noise, a pure function of WORLD position so seams agree
lib/terrain.js     uplift: spine, roughness, flats, volcanoes, stratigraphy
lib/glacier.js     shallow-ice flow with sliding, abrading its own bed
lib/hillslope.js   critical-angle failure, and creep
lib/basins.js      closed hollows, by priority-flood — the proof the ice worked
lib/lake.js        tarns, lakes and bay mouths: one carve, three ways in
lib/fountain.js    spring pools, tube bores, drilled plates and the tray
lib/joint.js       dog-bone keys, their recesses, and the ear clipper
lib/canopy.js      woods: conifer spires and broadleaf cauliflower
lib/river.js       least-cost routing over the ground, meanders, and carving
lib/heap.js        a binary min-heap, for the flood and the route
lib/tile.js        the ONE place metres become millimetres
lib/mesh.js        height field -> closed solid, with bores and a watertightness check
lib/stl.js         binary STL, and the stacking plate
lib/preview.js     hillshaded PNG of the assembled map
lib/build.js       spec in, printable tiles out
lib/board.js       what the water does on a board: seam kinds, ponds, sentences
bin/mmb.mjs        command line
app/               the editor: main.js holds the state, board.js and tilecanvas.js
                   draw, tools.js and inspector.js edit, specops.js is every edit
                   as a function of the spec, worker.js grows, viewer.js stands
                   the grown map up in 3D from heights.js's arrays
lib/vendor/        three.js r169 and OrbitControls, as relief vendors them, MIT
test/              node --test, plus browser.mjs for the editor in Chromium
```

## Where this meets relief

`field.js` exports `toReliefTerrain()`, which returns
`{n, values, min, max, sample(x,y)}` — the whole duck type relief's
`createGround()` touches. Nothing downstream in relief knows or cares that the
ground was invented, so a field generated here can in principle be meshed,
scooped, keyed and risered by relief's existing code.

Two blockers in relief, documented in its own README, land squarely on this
project and are **not** worked around here:

1. **Alcoves are not supported with tiling.** This matters less than it looks,
   because the brief for this repo is that an alcove must be contained within
   one tile anyway — *"modular so the terrain can't go past a tile"*. That is a
   stricter constraint than relief's, and it sidesteps the untested path rather
   than needing it fixed.
2. **Riser blocks are measured off the top surface** (`measurePlan` in
   `plan.js`, `lowestPoint` in `model.js`), so a tile holding an alcove can get
   a block that swallows its void. Plate stacking here is load-bearing in a way
   relief's risers are not, so this would have to be fixed before the two are
   joined.

## Tests

```bash
npm test
npm run test:browser      # the editor in Chromium; needs Playwright, skips without it
```

201 checks, and 23 steps in the browser. The ones that earn their keep:

- every finished tile honours its edge contract **exactly** (< 1e-6 mm)
- every finished tile is a **closed solid** — no unpaired edges, no overused
- the plate stack descends **exactly one plate per tile** along the river
- the same spec builds the **same bytes** twice
- ice cannot accumulate faster than it snows *(guards defects 2 and 3 above)*
- basal shear is capped, so nothing surges permanently
- the glacier overdeepens its bed
- mass wasting conserves rock
- two tributaries of different lengths are **fine** — the regression for the
  false error the first level solver raised
- a channel that splits and rejoins **must drop the same both ways round**
- confluences widen by quadrature — both cases from the brief, asserted
  directly
- a waterfall reads as a waterfall **from either side of the seam**
- a steeper tile carries the same water in a narrower channel
- an oscillating snowline makes the ice **advance and retreat**
- the buzzsaw concentrates cutting near the snowline
- creep is what sorts cirques from grid noise
- glacial cutting is counted apart from creep
- a broadleaf crown is markedly lumpier round a ring than a conifer
- **a tree built the way `scatterCanopy` builds one** is still lumpy — the
  regression for a bug where `placeTrees` dropped a shape field, every outer
  lobe came out `NaN`, and deciduous trees rendered as bare domes while the
  unit test passed on a hand-built object
- no tree crosses a seam; the rim is byte-identical after planting
- a treeline is a world elevation, not a tile-local one
- density is monotone, and means measured ground cover where crowns do not
  pile up
- a lobed crown does not fill its nominal circle and a cone roughly does —
  the reason the footprint is measured rather than assumed
- spacing accounts for crowns landing on each other; density 1 is a closed
  canopy with the ground hidden
- crowns fuse where they overlap instead of creasing, and a lone tree is
  untouched by the fusing
- a closed hollow becomes a tarn, and its surface is flat
- a lake is a hole: it never raises the ground
- a tarn in a deep cirque is not made shallower than the hollow it sits in
- no lake touches the rim; one that would is reported, not clipped
- the fill does not leak diagonally through a one-cell gap
- volume in millilitres matches the geometry
- a bore leaves the mesh closed, at four radii and with two bores at once
- the bore is round, not a staircase
- the tube comes out under water, in the middle of the pool
- a pool too small for its own tube is refused, not fudged
- every plate under a spring needs the same hole
- the key is a closed solid despite its reflex corners
- the two halves of a key land on the same point of the seam
- keys go only between tiles at the same plate level
- a recess never breaks through to the map face
- a recess where the plate runs thin is refused **whole**, not cut short
- the key is smaller than its recess by the clearance, so it drops in
- **a river follows the valley the glacier left** — the regression for a
  router that never read the terrain
- a river will not climb a ridge to save distance
- a river meanders on a floodplain and stays put in a gorge
- the carved bed hits the declared port heights at both ends, and never
  rises along its length
- every row of the blueprint's seam table, as a test: one riser lower
  **flows**, two is a **10 mm waterfall**, level is a **10 mm dam** a 20 mm rim
  holds and a 10 mm rim overtops, and a ring at one level is a chain of dams,
  not an error
- a turned tile's four edge signatures are the design's, turned
- **the example can be drawn from an empty board with the tools alone** —
  in node through the spec operations, and in Chromium with the mouse, with
  the JSON never opened
- dragging B1 up one riser flips its seam with B2 from a flow to a dam
  **while the pointer is still down**
- the example builds the same bytes with the three new spec fields absent
- **a draft build is on screen in 3D** well under a second after the
  heights land, each tile's heights crossing from the worker as one
  Float32Array
- **orbiting is smooth** — every frame of a drag timed, and the view drawing
  nothing once it has stopped; held even on a software renderer
- a river runs in its channel only where the board says the water reaches,
  a pond fills everything under its level, and a lake keeps its own surface
- `R` over a tile in 3D turns it, the badges follow, and nothing is grown
  again

## In the browser

[**realpapanerf.github.io/Modular-map-builder/app/**](https://realpapanerf.github.io/Modular-map-builder/app/)

An editor you draw the map in, built on the same `lib/` the CLI imports and
served as ES modules — no bundler, no build step, no copy of the generator that
can drift from the one the tests cover. Four stages over one spec:

| stage | what it does |
|---|---|
| **Draw** | the board in 2D, and any one tile close up. Every tool writes the spec |
| **Grow** | runs the generator in a worker, then stands the grown map up in 3D: each tile on its risers, turned the way it sits, with the water where the board says |
| **Refine** | brushes and handles on the grown ground — phase 3 of the [blueprint](docs/water-table-blueprint.md), not built yet |
| **Print** | the report and the STLs, as files or one ZIP, exactly what `mmb build` writes |

### The board says what the water does

Every change re-reads the spec as a board and follows the water through it
(`lib/board.js`, well under a millisecond), so each seam carries a badge and the
status strip says what will happen, in sentences: *"B3 falls 20 mm into B2."
"B2 meets B1 10 mm higher, so B2 ponds to 26 mm and runs on into B1; its rim
holds at 40 mm."* Drag a tile up a riser and the badges change while you drag.

| badge | the seam |
|---|---|
| blue dot, arrow | the river runs across |
| `↓20` | a waterfall, and how far it falls |
| red `dam ≈26` | the tile upstream is dammed and fills to 26 mm, which its rim holds |
| dashed `overtops` | it would have to fill higher than its own rim, so it runs over the rim into the tray instead |
| red `bank ≈30` | the river runs into land, and the tile fills until it gets over |
| amber `↘12` | the river pours down onto lower ground |
| purple `⇄` | two rivers sent at each other |
| `tray` | it drains off the board, into the tray |
| `↩ tray`, `↩ spills` | the pond rose to an inlet's floor and spilled back out through its notch |
| teal ring | a spring: where the pump's water comes up |
| grey hollow | a dry bed or a dry inlet — nothing feeds it, which is fine |
| amber `⋔` beside one | wide into narrow: the channel takes what it can and the rest spreads over the banks |
| `cliff 30` | the land steps at the seam |

Heights in the sentences are on the table: the riser under a tile plus the
tile's own height. **The board predicts and never refuses** — putting the
pieces together wrong is a way to play. Whether the map can be *built* is a
different question, and the inspector says that separately.

Rims depend on the ground, so until something is grown they come from the
ground *without its ice*, worked out in a second worker in about a tenth of a
second. The corner lattice is quantised to the plate, so the ice rarely moves a
corner; once the map is grown, the grown bed replaces the estimate. A pond that
rises past its own inlet is flagged as backing up into the tile behind; how far
it goes is phase 4.

### The tools

| on the board | | | in a tile (double-click it) | |
|---|---|---|---|---|
| Select `V` | inspect, drag ridge points and volcanoes, pan | | Corner `C` | raise a corner a plate |
| Place `P` | add a row or a column | | Lake `K` | a lake at a point |
| Turn `T`, or `R` over a tile | a quarter turn | | Spring `S` | a spring at a point |
| Risers `H` | drag a tile up or down, or paint a height | | Wood `G` | a wood drawn as a shape |
| River `W` | drag across tiles | | Ridge, Volcano, Flat | as on the board |
| Fall `F` | a tile's fall, 10–50 mm | | | |
| Spring `S`, Drain `D` | on a river's open end | | | |
| Ridge `I`, Volcano `O`, Flat `L` | the ground | | | |

A river stroke that starts off the board comes in from that side; one that
finishes off it drains there; one that ends on another river joins it, and
drawing back over a tile rubs the loop out. The line says which tiles and which
sides — the channel itself is still routed down the valley when it grows.
`Shift` snaps to 10 mm, `Delete` removes what is selected, `Esc` steps back,
`Ctrl+Z` undoes a whole drag at once. The inspector shows what is selected and
nothing else; with nothing selected, that is the map itself.

The JSON is in a drawer and stays the document: every tool writes it, it shows
which keys the last edit changed, and anything typed into it is read straight
back. The spec is kept in the browser between visits, and `Save`/`Open` move it
as a file.

### What a map-style spec can say, and the three things added for it

This is phase 1 of the [water table](docs/water-table-blueprint.md), so the
editor writes the spec the generator reads today, where every tile is its own
design, generated in place. That fixes three things about the board: it is a
rectangle (tiles come and go a row or a column at a time, and a river through
a removed strip is cut, coming in from or draining off the new edge); a tile's
riser is part of its design (`levels`), because the corners and any dam
reservoir are cut for it; and a design cannot move to another cell.

Three spec fields are new, all optional, and the example builds the same bytes
without them:

```json
{
  "rot": { "1,1": 1 },
  "cornerRaise": { "2,2": 10 },
  "canopy": [{ "kind": "conifer", "tiles": ["B2"], "region": [[20, 20], [90, 20], [60, 90]] }]
}
```

| field | what it says |
|---|---|
| `rot` | how a piece sits on the table, in quarter turns clockwise, by tile |
| `cornerRaise` | lift one corner of the lattice by so many mm. Keyed like tiles, from the south-west — `"2,2"` is B2's north-east corner — and shared, so the four tiles round it rise together and still mate |
| `canopy[].region` | a wood drawn as a shape, in the millimetres of the tile `tiles` names. Trees stand only inside the line |

A turn does not change what is printed — it is the piece on the table — so the
build ignores it and the board does not. `mmb board map.json` prints what the
board says, turns and all.

### The grown map in 3D

Once a map is grown, Grow shows it in 3D (`app/viewer.js`, three.js): each tile
on its stack of plates, turned the way it sits on the table, a line round the
top of every piece where the seams are, and the board's badges floating over
the seams — the same badges, drawn by the same code, as on the 2D board.

The water is the board's. A lake, a tarn, a bay or a spring pool is held by the
print, so it is always there, at its own surface. A river channel only has
water in it if the board says the water reaches that tile, and a tile the board
says ponds is under water to the level it ponds to — so a dam *shows* as a
flooded tile before anything is printed. A turn is play, so `R` over a tile
turns it in 3D and the water and the badges follow at once, without growing
anything again.

Drag to orbit, right-drag to pan, scroll to zoom, double-click a tile to go to
it. A click selects a tile or a seam for the inspector; hovering a badge says
its sentence. `Board` and `3D` swap between the two views, and the hillshade
still lies under the board in Draw. Change the spec after growing and the 3D
view keeps showing what was grown, says so, and still answers turns.

three.js is fetched the first time Grow is opened, never while drawing. The
view draws only when something changes. On a machine drawing WebGL without a
GPU (a virtual machine, a blocklisted driver), it goes into a quick mode while
the camera moves — half the pixels and a quarter of the ground's triangles —
and draws one full frame when it stops.

### Running it

**Growing is the slow part, and it is real work.** A 3x3 map at the example's
0.9 mm mesh is around fifteen seconds and a quarter of a million triangles. It
runs in a web worker, so the page stays live and `Cancel` actually cancels, but
start on the draft mesh: the contract, the plate levels, the seams and the keys
are all identical at 2.5 mm. The example still takes about ten seconds there,
because most of it is the ice, which costs the same at any mesh; `Check` skips
the ice and comes back in a second or two.

**Nothing leaves the machine.** There is no server to send a spec to; the whole
generator is in the page.

Locally it needs a static server, not a `file://` open — ES modules are fetched,
and the browser will refuse the fetch from the filesystem:

```bash
python3 -m http.server 8000     # from the repository root, then open /app/
```

## Status

Working and tested end to end: contract, plate levels, seam proofs, river
routing and carving, tile cutting, watertight meshing, STL, preview, the
editor's Draw stage with the board that says what the water does, and the
grown map in 3D (phases 1 and 2 of the
[water table](docs/water-table-blueprint.md)).

Not built yet: keys between the **plates** (so a seam with a level change is
registered by more than friction); a manifold, for feeding more than one
spring from one pump; buffer chambers under a lid, which need rock over air;
and mesa stratigraphy wired into a fluvial incision pass (`makeStrata` exists,
nothing calls it).

Next: **phase 3 of the water table**, Refine — brushes and handles on the 3D
view writing `edits` into the spec, replayed by a first `lib/edits.js`. Keying
the plates to each other, which the seven unkeyed seams on the example map are
waiting for, is now phase 5's keyed riser blocks; mesa stratigraphy wired into
a fluvial pass is still waiting for its turn.

Where this is going: a **set** of interchangeable tiles for a water table,
any piece next to any piece, with a board that says what the water will do and
an editor you draw in. The design is in
[`docs/water-table-blueprint.md`](docs/water-table-blueprint.md); phase 1, the
editor shell and Draw, and phase 2, the grown map in 3D, are built.

Under-tuned: glacial U-widening. `valleyForm` is the metric and `elaM` /
`erosionK` are the levers.

## Licence

MIT. See [LICENSE](LICENSE).
