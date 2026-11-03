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

The brief was: **rivers enter a tile 12 mm up and leave 2 mm from the bottom.**
Work out what that forces.

Water leaves tile A at 2 mm above A's base and has to arrive at B's inlet,
12 mm above B's base. For the surface to be continuous:

```
baseZ(A) + 2 = baseZ(B) + 12    ⟹    baseZ(B) = baseZ(A) − 10
```

**The downstream tile sits exactly one 10 mm plate lower.** The plate stack is
not scenery under the map — it *is* the river's gradient, quantised. Every
seam the river crosses spends one plate.

Three consequences worth knowing before you draw a map:

**1. The real contract is `inletZ − outletZ = plateMM`, not "12 and 2".** The
absolute heights are free. That matters, because at `outletZ = 2` there is only
2 mm of plastic under the channel where it leaves the tile — about ten layers
at 0.2 mm, thin for something that holds water and gets handled by a child.
`outletZ 4 / inletZ 14` has the identical 10 mm fall, the identical plate
quantum, and twice the floor. The default is the 12/2 you asked for and
`check` says it's thin rather than deciding for you.

**2. Plate levels are a graph problem, and it can be unsolvable.** Every path
into a tile has to give the same level. Two rivers that meet after running
different numbers of tiles cannot both arrive at 12 mm, and the map is
unbuildable as drawn:

```
error: Tile 2,0 is reached by two rivers that have run different numbers of
tiles, so it would have to sit -1 and -2 plates up at once. Lengthen the
shorter branch by a tile, or move the confluence a tile downstream.
```

Cycles, unmatched ports and mismatched river widths are caught the same way.
This is the thing that will bite when you draw a branching network by hand, and
it is better to be told which two branches than to find out in PLA.

**3. 10 mm over 200 mm is a 5% gradient** — steep for a real river, about right
for a printed channel, where layer lines and surface tension will stall a
shallower one. A map 3 tiles deep spends 2–3 plates, which is well inside the
"a kid can't reach past 400 mm anyway" limit.

---

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

### The rim is a Coons patch

Weighting each edge by how near it is and averaging put every tile **0.33 mm
off its own contract** near the corners: on the south edge the west edge still
had a say, and the average of two profiles is neither. A Coons patch reproduces
all four edge curves exactly:

```
F = (1−u)W(y) + uE(y) + (1−v)S(x) + vN(x)
    − [ (1−u)(1−v)·sw + u(1−v)·se + (1−u)v·nw + uv·ne ]
```

and the blend to the generated interior is a smooth union, not `min()` over the
four edge distances — `min` creases along the diagonals, and those creases were
plainly visible across every corner in the second hillshade.

Current output: **worst edge error across every tile, 0.0000 mm.**

### The contract gets the last word

The river carve runs **before** the rim clamp. In the other order, every tile
with a river came out 4.1–4.7 mm off contract, because the carve re-cut a
channel the clamp had already cut and took the banks down twice. Whoever owns
the boundary has to own it last.

---

## Layout

```
lib/contract.js    the edge contract: ports, corners, plate levels, seam proofs
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

41 checks. The ones that earn their keep:

- every finished tile honours its edge contract **exactly** (< 1e-6 mm)
- every finished tile is a **closed solid** — no unpaired edges, no overused
- the plate stack descends **exactly one plate per tile** along the river
- the same spec builds the **same bytes** twice
- ice cannot accumulate faster than it snows *(guards defects 2 and 3 above)*
- basal shear is capped, so nothing surges permanently
- the glacier overdeepens its bed
- mass wasting conserves rock
- branches of unequal length at a confluence are **reported, not papered over**

## Status

Working and tested end to end: contract, plate levels, seam proofs, river
routing and carving, tile cutting, watertight meshing, STL, preview.

Not built yet: lakes and tarns as scooped basins, fountain outlets and buffer
chambers, the dog-bone key geometry, the drip tray, mesa stratigraphy wired
into a fluvial incision pass (`makeStrata` exists; nothing calls it yet), and a
browser UI.

Under-tuned: glacial U-widening, as described above.

## Licence

MIT.
