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
lib/hillslope.js   nothing stands steeper than its critical angle
lib/river.js       routing between ports, and carving to the 12 -> 2 profile
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

57 checks. The ones that earn their keep:

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

## Status

Working and tested end to end: contract, plate levels, seam proofs, river
routing and carving, tile cutting, watertight meshing, STL, preview.

Not built yet: lakes and tarns as scooped basins — which is what a **dam**
seam needs, since nothing carves the reservoir that ponds behind one yet;
fountain outlets and buffer chambers; the dog-bone key geometry; the drip
tray; mesa stratigraphy wired into a fluvial incision pass (`makeStrata`
exists, nothing calls it); and a browser UI.

Under-tuned: glacial U-widening, as described above.

## Licence

MIT.
