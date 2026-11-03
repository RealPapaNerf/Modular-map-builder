# Modular map builder

Procedurally generated, 3D-printable terrain tiles that **mate with each other**
and have **rivers that actually run across the seams**. Built on the ideas in
[relief](https://github.com/RealPapaNerf/relief), but for invented ground
rather than real places.

No dependencies. Node 18 or newer and nothing else.

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
lib/canopy.js      woods: conifer spires and broadleaf cauliflower
lib/river.js       least-cost routing over the ground, meanders, and carving
lib/heap.js        a binary min-heap, for the flood and the route
lib/tile.js        the ONE place metres become millimetres
lib/mesh.js        height field -> closed solid, with a watertightness check
lib/stl.js         binary STL, and the stacking plate
lib/preview.js     hillshaded PNG of the assembled map
lib/build.js       spec in, printable tiles out
bin/mmb.mjs        command line
test/              41 checks
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
```

94 checks. The ones that earn their keep:

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
- **a river follows the valley the glacier left** — the regression for a
  router that never read the terrain
- a river will not climb a ridge to save distance
- a river meanders on a floodplain and stays put in a gorge
- the carved bed hits the declared port heights at both ends, and never
  rises along its length

## Status

Working and tested end to end: contract, plate levels, seam proofs, river
routing and carving, tile cutting, watertight meshing, STL, preview.

Not built yet: lakes and tarns as scooped basins — which is what a **dam**
seam needs, since nothing carves the reservoir that ponds behind one yet, and
what the cirque floors the ice now leaves are waiting for;
fountain outlets and buffer chambers; the dog-bone key geometry; the drip
tray; mesa stratigraphy wired into a fluvial incision pass (`makeStrata`
exists, nothing calls it); and a browser UI.

Next: **lakes and tarn basins**, then **fountains**.

Under-tuned: glacial U-widening. `valleyForm` is the metric and `elaM` /
`erosionK` are the levers.

## Licence

MIT.
