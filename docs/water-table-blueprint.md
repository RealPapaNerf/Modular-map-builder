# A water table of interchangeable tiles — blueprint

*The design for turning the map builder into a tile set a child shuffles,
and for the editor that draws it. Draft 1, 4 November 2026.*

---

## 1. The change in one sentence

The builder stops making **one map** whose tiles happen to mate, and starts
making a **set** of self-contained tiles from a short, fixed vocabulary of
edges — so any tile can sit next to any tile — plus a **board** that says what
the water will do for whatever arrangement the child has made; and the app
becomes a three-stage editor: **draw** the board and the tiles in 2D, **grow**
them in 3D, **refine** them with brushes and handles, then print.

## 2. The brief, read against what exists

The brief, in its own words:

> Build a water table of interchangeable tiles. Engaging and interesting.
> They operate independently of whatever tile is next to them. They interact
> with other tiles of the same base height. A tall tile next to a short tile:
> a river becomes a waterfall. If the short tile has the flow, the tall tile is
> a dam, and the kid plays with that or removes it and shuffles the set. A 2D
> map that I draw on and define parameters, then I grow the 3D map, then I
> edit it some more.

Most of the hard machinery for this is already in `lib/`, and it was built for
a subtly different thing. Where the two part company:

| the brief wants | the code does today | the gap |
|---|---|---|
| a **set** of tiles, any next to any | a **map**: one world, one river graph, plate levels *solved* from the river so each tile sits exactly where its neighbour needs it | tiles only fit the neighbours they were generated with |
| land edges that always mate | corner heights sampled from the world terrain (`cornerLattice`), quantised to 10 mm but otherwise free | a map of nine tiles has ~16 distinct corner heights; two tiles agree only if they were cut side by side |
| tall tile / short tile as a thing the child decides | the tile's height is the plate stack the *river* demands (`assignLevels`) | the risers are an output of the design, not a thing the child stacks |
| tiles interact: waterfall, dam, pond | `classifySeam` already names plane / cliff / waterfall / dam / ledge, and `buildMap` already ponds a tile behind a dam | per seam only, for the designed layout; nothing follows the water through a *whole arrangement* (a pond backing up three tiles, a dam overtopping a 10 mm rim) |
| draw, grow, refine | a form, a JSON textarea, a hillshade PNG, a download list | no canvas, no 3D, no editing after the build |
| rotate a tile | ports are at the centre of each edge and keys are symmetric about the centre, so rotation *would* work | nothing represents a rotation |

The right reading of this is that the **edge contract was the right idea and
has to become a fixed vocabulary**, the **plate solver becomes a checker**
instead of an oracle, and the UI is a rebuild. Nothing in the terrain, glacier, river,
lake, spring, canopy, key or mesh code has to change in kind.

## 3. The set contract

Everything below is `contract.js` growing, not being replaced. The invariant
that every finished tile honours its declared rim to `< 1e-6 mm` stays; what
changes is **which rims are allowed to be declared**.

### 3.1 A tile is four edges with their own heights, on riser blocks

```
tile design  = { id, corners: {sw,se,nw,ne: 10|20|30|40|50}, edges: {N,E,S,W}, fallMM, features... }
edge         = land                  the rim runs between its two corner heights
             | in  <size> @ 2+fall   a river comes in; 12 on a flat tile, up to 52
             | out <size> @ 2        a river goes out, 2 mm above the tile's bottom
             | drain <size>          out, declared as falling into the tray
placement    = { design, col, row, rot: 0|1|2|3, riserMM: 0|10|20|30|... }
```

**Heights are measured from the tile's bottom, and the river is 12 in, 2 out.**
That is the flow rule the README opens with, unchanged: water leaves a tile
2 mm above its bottom and arrives at the next 12 mm above *its* bottom, so
the next tile stands one riser lower. A steeper tile puts its inlet higher on
the same ladder — 22, 32, 42, 52 — and stands that much further below its
upstream neighbour. There is no level tile; every river tile falls at least
10 mm across itself, and the pump's head is not what moves the water.

**Risers are loose blocks, 10, 20, 30 and 40 mm tall**, stacked however the
kids like, under 200 × 200 mm tiles. A tile's rim in the world is

```
rimWorld(edge) = riserMM + cornerHeight
```

**The rim height belongs to the edge, not the tile.** A tile can be 50 mm
at its north edge and 10 mm at its south: the slab slopes between, and an
outlet on the 10 mm side is a channel 8 mm deep where an outlet on a 50 mm
side is a 48 mm slot — a gorge mouth. Corners carry the heights, as they do
today, and an edge reads its two; a tile that is 50 on one side and 10 on the
other has two ramp edges (`land 50/10`) that mate only with ramp edges the
other way round. That is fewer partners, and it is fine: the catalogue says
so, and the brief says the pieces may be put together in ways nobody planned.

In the code this is the current contract with the corner lattice freed from
the world: `corners` is already a per-tile field, `edgeProfile` already ramps
between two corner heights, `portFloor` already measures from the bottom, and
`conformToContract` already makes the tile meet whatever rim it is given
without flattening it. What goes is `cornerLattice` reading the terrain; what
arrives is a per-design `corners` the author sets, defaulting to one class all
round.

### 3.2 What a tile can hold, and what runs fast

**Everything cut down into a tile keeps 2 mm of floor.** That is the brief's
number — 0 is a hole, 2 is sturdy without wasting filament — and it is the
*only* depth rule. A channel, a lake bed, a spring pool, a fjord: each is cut
from wherever the water's surface is down to no lower than 2 mm above the
bottom. So on a flat slab the budget is the class less two:

| rim | holds |
|---|---|
| **10** | a creek, 8 mm deep at its mouth. Nothing stands in it |
| **20** | an 18 mm water feature: a river, a pond, the reservoir behind a same-level dam |
| **30** | 28 mm: a lake, the reservoir behind a one-riser dam |
| **40** | 38 mm: a deep lake |
| **50** | 48 mm: a fjord or a bay |

and on a mountain tile the budget is bigger, because the ground around a
lake can stand well above the rim: a tarn 30 mm deep in a cirque on a 10 mm
tile is legal if its bed stays 2 mm off the bottom. The tool measures the
real bed against the real floor and says what it finds — *"this lake is
32 mm deep and its bed is 1 mm above the bottom; raise its surface or
lower its depth"* — instead of guessing from the class.

(`check` will still note that 2 mm under standing water is about ten
layers at 0.2 mm. It is a note. Four perimeters, five floors, and the paint
are the answer, as the README says.)

**Water may narrow and speed up.** A 50 mm fjord entering a tile and leaving
it as a 10 mm creek is a design, not an error: the water gushes. Today
`autoSizeRivers` warns *"it will flood"* when a declared outlet is narrower
than its inflow wants; that becomes a note, *"runs fast"*, and the channel is
cut as declared. The same at a seam on the board: a wide port facing a narrow
one is predicted (the narrow channel takes what it can and the rest spreads
over the banks) and never refused.

**The dam cases come out in neat steps**, because every seam is 12 against 2:

| the next tile stands | what the seam is |
|---|---|
| one riser lower | **flows** — the designed case |
| two risers lower | a **10 mm waterfall** |
| level with this one | a **10 mm dam**: this tile ponds to 12. A 10 mm rim overtops; 20 holds |
| one riser higher | a **20 mm dam**: ponds to 22. 20 overtops; 30 holds |
| land across the seam | a dam to that edge's rim height, overtopping at this tile's own |

Which is to say: whether a tile *holds* its pond is set by its rim, and the
board knows the rim of every edge, so it can say *"B2 fills and runs over its
west side"* before a drop of water is in it.

### 3.3 Rotation is free, and the code should say so

`portPoint` puts every port at the middle of its edge, `edgeProfile` is
symmetric about that middle, and `planKeys` spaces keys at `T(k+1)/(n+1)`,
symmetric about the centre. So a design rotated by 90° mates exactly like the
unrotated one. `board.js` owns the edge map (`N→E→S→W` under `rot`), and a test
asserts that a placed tile's four signatures are the design's, rotated. The
printed piece needs a north mark on the underside and nothing else.

### 3.4 The catalogue

`edgeSignature` already prints `in creek@16 22/22`. Make that canonical and
add `mmb set` (and the same panel in the app), which lists every design, its
four signatures, and **how many distinct signatures the set uses**. A set that
shuffles well has few: flat land at one or two heights, a ramp or two, and
three or four port types. The count going up is the first sign a set has stopped being
interchangeable, which is easier to see as a number than on a table.

## 4. The board: what the water does

New module, `lib/board.js`. Pure, fast (microseconds for 64 tiles), tested on
its own, and the thing the editor calls on every mouse-up.

**In:** the set, a grid of placements, which tiles are fed (a spring, a hose).
**Out:** a water level per tile, a kind per seam, and a list of things worth
saying.

### 4.1 The model

Each placed tile is one pool with a floor at its lowest port and a rim at the
lowest of its four edges, both in world mm (`riserMM + local`). Each outlet faces a
**sill**:

| what is across the seam | the sill |
|---|---|
| an inlet | that inlet's floor |
| a land edge | that edge's land height (the pond would have to overtop it) |
| nothing | the tray — water leaves the board |

and every tile has one more exit, its own rim, which also leads to the tray.

Fed tiles start at their floor. Then a fixed point: a tile's level is the
**lowest sill among its exits**, and where that exit is an inlet whose tile has
ponded higher, the two merge into one pond at the higher level. Levels only
ever rise and are capped at the rim, so it converges; ten passes cover any
board a child can lift.

### 4.2 What it reports, per seam

| situation | kind | what the child sees |
|---|---|---|
| outlet at 2 meets inlet at 12, one riser down | **flow** | the river runs across |
| outlet floor above inlet floor | **waterfall h** | it falls `h` |
| outlet floor below inlet floor, pond held under the rim | **dam, ponds to Z** | the short tile fills up |
| a wide port meets a narrow one | **spreads** | the narrow channel takes what it can; the rest goes over the banks |
| the pond reaches an upstream outlet | **backs up** | the tile behind floods too, as far back as the pond can reach |
| the pond reaches the rim | **overtops** | water sheets over the land into the tray |
| outlet facing land | **blocked** | same as a dam, with the land as the wall |
| outlet facing nothing | **drains** | it runs off the edge into the tray |
| inlet fed by nothing | **dry** | a river bed with no water in it, which is fine |

These are the brief's sentences — *a river becomes a waterfall; if the short
tile has the flow, the tall tile is a dam* — made checkable. The tests are the
same sentences: a pair two risers apart is a 10 mm waterfall; a same-level
pair is a 10 mm dam that a 20 mm rim holds and a 10 mm rim overtops; a pond
backs up into the tile behind it; a ring of tiles at one level is a chain of dams, not an error.

What `assignLevels` does today — refusing a layout whose two ways round a loop
drop differently — becomes a **note on the board** rather than a reason not to
build. In a set the piece is right; it is the arrangement that dams, and the
child will move it.

### 4.3 It also drives the design

The same solver, run on the *design* board in the editor, is how the author
sees what the set can do before printing: lay out the pieces, drag one, watch
the badges on the seams change. The badges are the first thing the
editor shows, because they cost nothing and they are the play the brief
describes.

## 5. The pipeline, in stages

`buildMap` is one long synchronous call: world, glacier, every tile, every
feature, every mesh, then back. The editor needs to run the cheap parts on
every click and the slow part once. So `build.js` splits along lines it
already has:

```
plan     (ms)    contract, set catalogue, board hydrology            → badges, report
grow     (slow)  the set's world: uplift, volcanoes, ice, hillslope  → one cached bed
cut      (fast)  per design: window, cutTile, route, conform, carve  → a height field
refine   (fast)  per design: replay edits, lakes, springs, woods,
                 recesses, conform again, verifyEdges                → the final field
mesh     (medium) per design: meshTile, checkWatertight             → triangles, STL
```

Each stage caches its output in the worker and invalidates only what its
inputs touched: change a tree density and only `refine` and `mesh` rerun for
that one design; change the seed and everything does. The cache keys are the
JSON of the inputs each stage reads, which is the same idea relief's `viewKey`
/ `warpKey` use.

**Where a design's ground comes from.** Keep one world per set — the glacier
needs its 16 km to behave and it is the expensive thing — and give each design
a **window** into it (`world: { at: [u, v], spanFrac, rot }`) plus its own
seed for everything downstream (river wander, meanders, tree scatter, lake
lobes). Designs are cut from the world on a *design grid*, not the board grid;
the board grid is where the child puts them. A design that wants its own
world (a lone volcano) says `world: 'own'` and gets a small one.

**Edits are operations, not pixels.** The refine stage replays a list:

```json
"edits": { "ridge-3": [
  { "op": "raise",   "path": [[80,40],[120,90]], "radiusMM": 12, "mm": 4 },
  { "op": "flatten", "at": [140,60], "radiusMM": 20, "toMM": 30 },
  { "op": "lake",    "atMM": [60,120], "depthMM": 5 },
  { "op": "spring",  "atMM": [30,100] },
  { "op": "smooth",  "path": [[...]], "radiusMM": 10 }
] }
```

Brushes are masked to zero within `rimLockMM` (12 mm) of the rim with a
smoothstep, applied after `carve` and before the lakes, and followed by
`conformToContract` and `verifyEdges` as now — so **an edited tile still
proves its contract exactly**, and the "same spec builds the same bytes"
test still holds with edits in the spec. It also means the author can change
the glacier's climate and keep every brushstroke, because the strokes are
replayed onto the new ground.

## 6. The editor

Three stages, one project file, the same `lib/` the CLI runs, no bundler.

### 6.1 Layout

```
[ Draw | Grow | Refine | Print ]                            stage tabs
┌──────────┬────────────────────────────────────┬──────────────┐
│ tools    │ canvas: the board, or one tile     │ inspector    │
│ palette  │ (2D canvas in Draw, 3D in Grow     │ parameters   │
│ designs  │  and Refine, 2D hillshade under)   │ of selection │
├──────────┴────────────────────────────────────┴──────────────┤
│ status · badges · report                     ▸ Spec JSON     │
└──────────────────────────────────────────────────────────────┘
```

The JSON textarea moves into a drawer and stays the single source of truth,
as it is now: every tool writes the spec and reads it back.

### 6.2 Draw

**The board canvas.** A grid of cells. Tools: *place* (drag a design from the
palette; `R` rotates, `Delete` removes), *risers* (paint 0, 10, 20… on a cell),
*river* (drag a line across cells; it writes `rivers[].path` and the ports
fall out, as `portsFromRivers` does now), *fall* (click a cell, pick 0/10/20/
30/40/50), *spring* and *drain* (click an open port). Every mouse-up runs
`plan`, and the seams show their kind as badges — a blue arrow, a white
waterfall bar with its height, a red dam with its pond level, a dashed
"overtops". This is §4 made visible and it is most of the fun.

**The tile canvas.** Double-click a cell to zoom into its design. Paint intent
as shapes, in tile-local millimetres, each of which is already a spec field
or a small extension of one:

| you draw | it writes | exists today |
|---|---|---|
| a polyline | `spine` (ridge) or a `valley` | `spine` yes; valley is a negative spine |
| a point with a radius | `volcanoes[]`, `flats[]` | yes |
| a point | `lakes.place[]`, `fountains.place[]` | yes |
| a polygon | `canopy[].region` | new: a mask on `scatterCanopy` |
| a corner toggle | `corners` at +1 plate | yes (`corners`) |
| the window | `world.at / spanFrac / rot` | new |

No map library: Leaflet is for geography, and this is a 200 mm square. A
plain `<canvas>` with a transform, and the existing hillshade drawn under it
once there is one.

### 6.3 Grow

Runs `grow` once and `cut` + `refine` + `mesh` per design, with progress per
stage as now. The result arrives in the main thread as one `Float32Array` of
heights per design (transferred, not copied), from which the viewer builds a
`BufferGeometry` directly. At draft mesh that is 81² vertices per tile — the
3D view is instant; the 0.9 mm printable mesh is 50 k vertices per tile and
WebGL does not notice nine of them.

**The viewer** is relief's `viewer.js` with the geography taken out:
`three.module.min.js` and `OrbitControls.js` vendored under `lib/vendor/` with
their licences, as relief already does, z-up tipped to y-up, render on change
only. Drawn: each tile on its plates, the water as a
translucent surface from the `wet` mask and the board's pond levels, trees as
the field already has them, seams as thin lines, badges floating at the seams.
The board's hydrology drives what the water looks like, so a dam *shows* as a
flooded tile before anything is printed.

### 6.4 Refine

Brushes on the 3D view (ray-cast to the tile, write an `edits` op, rerun
`refine` for that design): raise, lower, smooth, flatten-to, dig a lake, place
a spring, plant or clear trees. Handles on things already placed: drag a lake,
a spring, a volcano, a ridge vertex. The rim is drawn locked and the brush
visibly fades to nothing over the last 12 mm — the author should see the
contract, not be surprised by it. Undo is popping the ops list.

### 6.5 Print

What the download panel is today, plus the set catalogue, a per-design print
list ("print 2 of `ridge-3`, 1 of `fall-20`"), the plates or integral risers
(§8), keys and the tray. Unchanged in kind.

### 6.6 The worker protocol

Today: `run` / `stl` / `zip`. Add `plan`, `grow`, `cut`, `refine`, `mesh`
with a design id, all cached in the worker; `heights` returning transferred
arrays for the viewer; `cancel` by termination as now. One worker to begin
with; a pool of `hardwareConcurrency` for `cut`/`refine`/`mesh` is a later
speed-up that the per-design split makes trivial.

## 7. What stays, what changes, file by file

| file | change |
|---|---|
| `lib/contract.js` | corner heights from the class ladder {10..50}, per design; `check()` gains the 2 mm floor rule and loses the width-never-narrows error; the lip at 2 × 1 mm with the rebate on the inlet; canonical catalogue signature |
| `lib/board.js` | **new**: placements, rotation, riser heights, the hydrology fixed point, seam kinds, the catalogue count |
| `lib/build.js` | split into `plan` / `grow` / `cut` / `refine` / `mesh` with caches; `cornerLattice` replaced by the set rule; `assignLevels` kept as the *designer's* checker, no longer the oracle |
| `lib/edits.js` | **new**: the op list, the rim mask, replay |
| `lib/canopy.js` | a `region` polygon mask on `scatterCanopy` |
| `lib/river.js`, `lake.js`, `fountain.js`, `joint.js`, `mesh.js`, `stl.js`, `glacier.js`, `terrain.js`, `hillslope.js`, `basins.js`, `noise.js`, `field.js`, `tile.js` | unchanged in kind; `tile.js` reads the window instead of the board cell |
| `lib/vendor/` | three.js and OrbitControls, with licences, as in relief |
| `app/` | `board.js` (2D canvas), `tilecanvas.js`, `viewer.js`, `tools.js`, `inspector.js`; `main.js` becomes the stage switcher; `worker.js` gains the stage messages |
| `bin/mmb.mjs` | `mmb set` (catalogue), `mmb board` (hydrology report) |
| `test/` | board hydrology cases; rotation; set signatures; edits replay determinism; the freeboard rule |
| `README.md` | the set contract and the board, written the way the flow rule is |

The spec file grows two top-level keys and loses nothing:

```json
{ "contract": {...}, "world": {...},
  "designs":  [ { "id": "ridge-3", "corners": { "sw": 10, "se": 10, "nw": 20, "ne": 20 }, "fallMM": 10, "edges": {...}, "world": {...}, "canopy": [...] } ],
  "board":    { "cols": 4, "rows": 3, "place": [ { "design": "ridge-3", "col": 0, "row": 2, "rot": 1, "riserMM": 20 } ] },
  "edits":    { "ridge-3": [ ... ] } }
```

Today's `rivers` / `falls` / `waterfalls` / `levels` keep working as a
**map-style** spec: it is read as a board whose designs are generated in
place, with `assignLevels` supplying the riser heights. The example map
builds the same bytes as before, which is the regression that proves the
refactor did not change the generator.

## 8. Physical decisions the brief raises

**Risers are loose blocks — decided.** 10, 20, 30 and 40 mm tall, 200 ×
200 mm, the same parts under every set, which is what lets any map interact
with any other. The consequence is that **keying the blocks to each other,
and the tile to the block under it**, moves from "the obvious next piece" to
a requirement: a 10 mm summit on a 40 and a 20 is three loose parts, and a
child leaning on it is the test. Same dog-bone, same 0.35 mm slip fit, cut
into the top of each block and the underside of the next; the tile's own
underside recesses already exist. `plate.stl` becomes four keyed blocks.

**The lip is 2 mm out and 1 mm tall.** The outlet's channel floor carries on
2 mm past the tile face as a 1 mm tongue; the inlet's floor has a matching
rebate, 2.3 mm in and 1.3 mm down, that the tongue drops into. The seam gap
is then under the water rather than in it, as the README argues, and the
inlet floor has 12 mm of material to cut the rebate from — so the README's
objection that an overlapping seam needs 4 mm of plate under the *outlet*
falls away: nothing is cut from the outlet, the tongue is added to it.
Two things to test on the first pair: a 1 mm tongue 2 mm proud of a tile
face is the first thing a child will snap, and a tile with tongues on one
side and rebates on another has to be set down from above, not slid in.
`tongueMM: 2, tongueThickMM: 1` in the contract; the geometry in
`seamGeometry` and the cut in `mesh.js`.

**Weight and filament.** A 50 mm class tile is a 2-litre slab. It is the
slicer's job to hollow it — sparse infill, five floors under the water — and
the plan should say per class roughly what it weighs and how long it prints,
measured off the first one.

**Everything stands in the tray.** It already exists (`tray.stl`) and the
dam case makes it mandatory: water held against a butt seam weeps through it,
and the pump puts it back. *You do not need watertight; you need all of it to
come back.* The lip is only for outlet-to-inlet; a pond held against a land
edge weeps through the butt seam, and the pump puts it back.

**The dam with a spillway.** A land edge with a notch at a set height
(`spillway@Z`) is a new edge type that turns "the pond overtops somewhere" into
"the pond spills *here*, as a waterfall". It is the single most engaging
tile this set can have, and it is a Phase 6 item because it needs the edge
vocabulary settled first.

**Tile size stays 200 mm.** The brief's child-scale pieces, the 220 mm bed,
and every number in the contract agree on it.

## 9. Phases

**The editor comes first.** It is the part most likely to be built as
something other than what was pictured, and a wrong editor is the costly
rewrite; a wrong solver is a file. So the first phases put the four stages on
screen against the generator *as it is today*, with the board solver only as
far as the badges need it, and the contract work follows behind a UI that can
already show it. Each phase leaves the tests green and the example map
building the same bytes.

1. **The editor shell and Draw.** `app/` becomes the four-stage layout in
   §6.1 — stage tabs, tool palette, canvas, inspector, status strip, the JSON
   in a drawer — with the **Draw** stage working: the board canvas with
   place / rotate / risers / river / fall / spring / drain tools writing the
   spec, and the tile canvas writing `spine`, `flats`, `volcanoes`,
   `lakes.place`, `fountains.place`, `corners` and a canopy `region`. Badges
   on the seams come from a **first `lib/board.js`** that does only what the
   badges need: rotation, riser heights, and the seam table in §3.2 and §4.2
   — flow, waterfall, dam-and-ponds-to, overtops, drains, dry, spreads — with
   tests for each row. The pond backing up through several tiles can wait
   for phase 4. *Done when* the example map can be drawn from an empty board
   without opening the JSON, and dragging one tile up a riser flips its
   seams' badges live. **Built** — both checked in Chromium by
   `test/browser.mjs`; what it had to decide on the way is in §11.
2. **Grow.** The three.js viewer (relief's `viewer.js`, geography removed,
   `three.module.min.js` and `OrbitControls.js` vendored with licences)
   showing what `buildMap` returns today: each tile on its risers, water as
   a translucent surface from the `wet` mask, seams, badges floating at the
   seams. Heights cross the worker boundary as one transferred
   `Float32Array` per tile. The hillshade stays as the board canvas's
   background. *Done when* a draft-mesh build is on screen in 3D within a
   few seconds and orbiting it is smooth. **Built** — both checked in
   Chromium by `test/browser.mjs`; what it measured and decided is in §12.
3. **Refine, as a shell.** The brush and handle tools on the 3D view
   writing `edits` ops into the spec, with undo, the rim lock drawn — and the
   ops **replayed by a first `lib/edits.js`** inside today's `buildMap`,
   after the carve and before the lakes, followed by the conform. The
   whole map rebuilds on each stroke at this stage; it is slow and it is
   correct. *Done when* a raised ridge survives a change of seed and the
   edge check still reads zero. **Built** — checked in Chromium by
   `test/browser.mjs` and in node by `test/edits.test.mjs`; what it decided
   is in §13.
4. **The board, properly.** `lib/board.js` grows the fixed point: ponds that
   back up, merged ponds, the design checker reporting what a layout wants.
   `mmb board`. *Done when* the test boards in §4.2 all report as written.
5. **The set rule.** Corner heights per design from the class ladder, not
   from the world; the design window; the 2 × 1 mm lip; the 2 mm floor
   rule; width may narrow; the catalogue and `mmb set`; keyed riser blocks.
   The Draw palette now holds *designs*, placed many times. *Done when* two
   designs cut from opposite ends of the world, rotated, verify flush at
   `< 1e-6 mm`, and the catalogue counts the set's edge types.
6. **The staged pipeline.** `plan` / `grow` / `cut` / `refine` / `mesh`
   with caches in the worker, so a brushstroke reruns one design in well
   under a second; a worker pool after that. Then the spillway edge.

Phases 1–3 touch `lib/` only to add `board.js` and `edits.js`, both small and
both tested on their own, so the UI can be judged before the generator is
reorganised under it. If the editor in phase 1 is not the one that was
pictured, nothing below it has been built yet.

### 9.1 What phase 1 must not do

So that a session building it does not guess:

- **Not a form.** No stack of labelled inputs as the primary surface. The
  canvas is the editor; the inspector shows the parameters of what is
  selected and nothing else.
- **Not a map library.** No Leaflet, no tiles, no lat/lon. A `<canvas>` with
  a transform, in tile millimetres.
- **Not a new spec.** Every tool writes the spec the CLI reads, and the JSON
  drawer shows it changing. The example in `lib/example.js` loads and draws.
- **Not a bundler.** ES modules from `lib/` and `app/`, served static, as
  now. Three.js vendored under `lib/vendor/` with its licence, the way
  relief does it.
- **Not a framework.** Plain DOM and canvas, as the current app is. One
  `state` object, one `render()`, tools as objects with `down / move / up`.
- **Not silent.** Every spec change runs `plan` and redraws the badges; the
  status strip says what the board would do, in the sentences of §4.2.

## 10. Decisions

Taken, 4 November 2026:

- **The river is 12 in, 2 out, measured from the tile's bottom.** Every
  river tile falls at least 10 mm; steeper ones put the inlet higher on the
  ladder. There is no level tile.
- **Risers are loose blocks, 10 / 20 / 30 / 40 mm.** Block keys become a
  requirement (§8).
- **Rim heights are per edge, 10–50 mm, carried on the corners.** A tile may
  be 50 on one side and 10 on the other.
- **Everything cut into a tile keeps 2 mm of floor.** That is the only depth
  rule; the tool measures rather than guesses (§3.2).
- **Water may narrow and run fast.** Not an error, in a tile or at a seam.
- **The lip is 2 mm out, 1 mm tall**, tongue on the outlet, rebate on the
  inlet.
- **The board predicts and never refuses.** Putting it together wrong is a
  way to play; the design checker still tells the author what a layout wants.

Still open:

1. **Does a tall edge always carry a tall inlet?** This draft keeps them
   separate — a 20 mm slab with an ordinary river is 12 in, 2 out — so an
   inlet's height is its fall and the edge's height is its rim. Tying them
   (a 50 edge means an inlet at 52) halves the catalogue and is one line to
   change.
2. **How tall a stack?** Risers are a play-time choice, so the limit is a
   guide, not a rule: `maxStackPlates` stays and the board warns past it.

## 11. Phase 1, as built

Built 4 November 2026. Both *done when* conditions are checked by
`npm run test:browser`, which draws the example from an empty board with the
mouse and the inspector and compares the result with `lib/example.js` key for
key, then drags B1 up a riser and reads B1/B2 as a dam before the pointer is
released. `test/specops.test.mjs` draws the same example through the spec
operations, in node.

What exists:

| piece | what it is |
|---|---|
| `lib/board.js` | `solveBoard` (placements, rotation, risers, springs → seams, ponds, the water's order), `describeBoard` (the §4.2 sentences), `boardFromSpec` (a map-style spec read as a board), `plan` (both, never throws) |
| `app/` | the §6.1 layout: stage tabs, tools, palette and the board's tiles on the left, the canvas, the inspector, the status strip, the JSON drawer |
| `app/specops.js` | every edit a tool makes, as a function of the spec, so the tools hold no document of their own and the edits are tested in node |
| `mmb board` | the board's sentences and seam table from the command line — the first of phase 4's |

Decisions the build had to take, because a map-style spec could not say what
§6.2 assumed it could:

1. **The board is the map's rectangle.** A map-style spec has no holes:
   `completeGrid` fills `cols × rows`. So *place* adds a row or a column (ghost
   cells round the board) and *Delete* takes an outer one off. A river through
   a removed strip is cut, and each cut end becomes what it now is — an inlet
   from off the map, or a drain — keeping the width the board read there.
   Holes, and the palette holding designs, arrive with `designs`/`board` in
   phase 5.
2. **A riser is the design's `levels`** in a map-style spec, not a loose
   block: the corner lattice and any dam reservoir are cut for it, so it
   changes the print. A level the river would choose anyway is not written
   down. In phase 5 risers become `board.place[].riserMM`, which is play.
3. **A turn is play: `rot: {"col,row": quarterTurns}`.** It does not change
   what is printed, so `buildMap` ignores it; `plan`, the hillshade under the
   board and `mmb board` read it. A turned tile shows its design's north as
   an arrow, and the tile view shows it as designed, unturned, because that is
   the frame its lakes and woods are written in.
4. **The corner toggle is `cornerRaise: {"cc,rr": mm}`.** Map-style corners
   come from one shared lattice, so a corner of one tile is a corner of up to
   four, and raising it raises them all — every seam still mates, which a
   build test checks. `cornerLattice` takes the raise, and also a null world
   (flat ground, corners at their floor) so the board can plan before anything
   is grown. Per-design corners from the class ladder are phase 5.
5. **A wood's shape is `canopy[].region`** in the tile's millimetres, with
   `tiles` naming the tile. `scatterCanopy` rejects a trunk outside it, so the
   density inside the line is still the density the number says.
6. **Ridge, volcano and flat are on the board as well as in a tile.** In a
   map-style spec they are world features — the example's spine crosses three
   tiles — so they are drawn in board millimetres and stored as the fractions
   the generator reads. Growing the board keeps them over the same tiles.
7. **The fall picker is 10–50.** §6.2 still said 0; §10 decided there is no
   level tile.
8. **Seam kinds beyond §4.2's table**, because the arrangements reach them:
   `spills` (an outlet above lower land pours onto it), `head-on` (two
   outlets facing; the higher falls into the lower's channel, level ones go
   nowhere), `spring` (a fed open inlet), and `cliff`/`plane` for land.
   **An inlet is a notch in the rim too**: one facing off the board, onto
   land or into another inlet is an exit at its floor (or over what is
   across it), so a pond spills back out there instead of climbing past it.
   Water never leaves by the notch it arrived through — two tiles joined that
   way are one pond, which is phase 4. `backs up` is a flag on a tile whose
   pond rises above the inlet its river comes in by, said in a sentence.
9. **Rims before anything is grown.** The board needs rims for *holds* and
   *overtops*, and in a map-style spec they come from the world. A second
   worker grows the ground without its ice (≈0.1 s) whenever the fields it
   depends on change, and the board reads the lattice from that; once the map
   is grown, the grown bed replaces it. For the example the two lattices are
   identical, because the lattice is quantised to the plate. With neither,
   corners sit at their floor, which only errs toward overtopping. The status
   strip says which it is.

Left for later, as planned: the 3D viewer and per-tile height arrays across
the worker boundary (phase 2), brushes and `lib/edits.js` (phase 3), merged
ponds and the full `mmb board` (phase 4), designs, the window and the lip
(phase 5).

## 12. Phase 2, as built

Built 4 November 2026. Both *done when* conditions are checked by
`npm run test:browser`, which grows the example at the draft mesh, times it
onto the screen, then orbits it with the mouse and times every frame.
`test/heights.test.mjs` covers the arrays the view is made of, in node.

What exists:

| piece | what it is |
|---|---|
| `app/heights.js` | pure: a built tile as transferable arrays (`tileHeights`), where the water stands once the board has had its say (`waterSurface`), and the vertex, normal, colour and index arrays of the ground, the walls, the rim and the water |
| `app/viewer.js` | relief's viewer with the geography taken out: render on change, z-up tipped to y-up, the board's badges on a 2D canvas laid over it, picking, a quick mode for slow machines |
| `lib/vendor/` | three.js r169 and `OrbitControls.js`, copied from relief with the licence, mapped by an import map in `app/index.html` |
| `app/worker.js` | after every build, a `heights` message: per tile one `Float32Array` of heights, one of standing water and one byte per cell saying what it is, all transferred |
| `app/main.js` | Grow and Refine show the 3D view once something is grown; `Board`/`3D` swap it for the 2D board |

What it measured, in Chromium's software renderer (the test machine has no
GPU), on the example at 2.5 mm:

- **On screen in 3D 0.3–0.4 s after the heights land.** The build before it
  is 8–10 s, and 8 s of that is the ice, which runs on the 128-cell world
  whatever the mesh. The 3D view's share is held under 2.5 s by the test;
  the build's is reported and is phase 6's to cut, by caching the world.
- **Orbiting: a median 30–33 ms a frame (30–34 fps), 90% within 40 ms,**
  with under a millisecond of script in each. A full-quality software frame is 136 ms with
  multisampling and 58 ms without, so that is quick mode, below. A GPU draws
  the nine draft tiles in a millisecond or two and never needs it.

Decisions the build had to take:

1. **The view shows what was grown, standing the way the board says now.**
   A turn is play (§11, decision 3), so `R` over a tile in 3D turns it, the
   board is solved again and the water and badges follow, and nothing is
   grown. Once the spec has moved on, the view keeps the grown tiles and
   solves the board for *the spec they were grown from*, with today's turns,
   so the water drawn is always the water on the pieces drawn, and the crumbs
   say it is out of date.
2. **Standing water is the tile's; running water is the board's.** A lake, a
   tarn, a bay, a dam's reservoir or a spring pool is held by the print, so it
   is always drawn, flat at its own surface. A channel has water in it only if
   the board says water reaches the tile, drawn 3 mm over its bed (half the
   bank's freeboard). A tile the board says ponds is under water everywhere
   below the level it ponds to, so a dam shows as a flooded tile. The surface
   is grown one vertex past the wet cells and the ground hides what it covers,
   which is what puts the shoreline exactly where the water meets the land.
   Running water is decided per tile, not per channel: the build's wet mask
   is one union, so a tile with one fed branch and one dry one shows both
   running. Per-channel masks are a small addition to `carveChannels` when
   it matters.
3. **Two outputs added to `lib/`, neither changing a byte of any tile.**
   `fillHollows` gives each tarn its own cells as `wet`, the way `placeLake`
   already did for a placed lake, because the union cannot say which surface a
   cell is under. `scatterCanopy` returns the `mask` of cells under crowns,
   because once the canopy is added to the ground nothing can tell them
   apart, and the view colours woods as woods. The example builds the same
   bytes, at its own mesh and at draft.
4. **The geometry is built from the heights, not from the STL.** One vertex
   per sample, normals from the height field so neighbouring cells agree,
   colours from the hillshade's bands so the board and the 3D view are one
   map. The walls come down to the piece's bottom; the bottom is not drawn.
   Risers are drawn as the plates they are, one block each, pale, with a gap
   between, so a stack reads as parts under a tile and not as more tile.
5. **Badges are the board's own.** `drawBadge` draws them onto a canvas over
   the WebGL one, at a point a little above the higher side of the seam, with
   the arrow turned to wherever the camera is. Hovering one says its sentence,
   clicking it selects the seam; clicking a tile selects it, through a coarse
   copy of its surface on a layer the camera never draws.
6. **three.js loads when Grow is first opened.** Drawing never fetches it.
   Opening Grow starts the fetch, so it is there when the build lands. A
   browser that cannot start WebGL keeps the hillshade under the board and
   says why.
7. **Quick mode.** While the camera moves, frames drawn on consecutive ticks
   more than 45 ms apart halve the pixel ratio and draw the ground from every
   other row and column, which is a second draw range in the same index
   buffer. Only those count: two redraws a moment apart with the camera still
   (a hover, a turn), or a pointer that only moves every tenth of a second,
   say nothing about how fast the machine draws. One full
   frame is drawn once the camera stops. A software renderer also does without
   multisampling, which is more than half its frame.
8. **Render on change means a visible change.** The camera counts as moved
   when it has moved a quarter of a pixel since the frame on screen, whoever
   moved it, and the glide after letting go is short (damping 0.16). The tail
   of a glide stops being drawn when it stops being visible, a little over a
   second after letting go even in software, and nothing is drawn after that.

Left for later: an ungrown board in 3D (until something is grown, Grow shows
the 2D board and says so), the tray and shadows, and a worker pool. The
brushes on this view are phase 3.

## 13. Phase 3, as built

Built 4 November 2026. The *done when* is checked twice. `npm run
test:browser` draws an 8 mm ridge across B2 with the mouse on the 3D view,
lets the map grow again, changes the seed, grows again, and compares the
crest with the same ground grown without it. `test/edits.test.mjs` does the
same in node on two seeds, exactly.

What exists:

| piece | what it is |
|---|---|
| `lib/edits.js` | the op list, the rim lock and the replay: `applyGroundEdits` for raise, lower, smooth and flatten; `clearFilter` and `plantings` for the woods. Pure and tested on its own |
| `lib/build.js` | replays a tile's ground ops after the carve and its conform, then conforms again; the tree ops where the woods are planted; and takes a `world` already grown for the same `worldKey` |
| `app/viewer.js` | a brush that paints along the ground, a place tool, handles to drag, the rim lock drawn, and a cursor tinted by the brush's real weight |
| `app/specops.js` | `addStroke` (a stroke on the board → an edit on every tile it reaches, in each tile's own frame), `moveFeature`, `removeEdit`, `clearEdits` |
| Refine | the stage: tools, palettes, an instant preview, a regrow after every change, and each tile's edits listed in the inspector |

What it measured, on the example at 2.5 mm in Chromium's software renderer:
the crest stood **8.00 mm** proud of the same ground at every bare point
along it (13 points on seed 8, 12 on seed 9). The worst edge error read
**0.0000 mm** on both seeds. A stroke grew again in **0.9 s**, the ground
kept.

Decisions the build had to take:

1. **An edit is keyed by tile and written in the tile's own frame.** A
   map-style spec has no designs to key by, so it is the label, as a wood's
   `tiles` and a lake's `tile` are. A stroke drawn on the board is turned back
   by the tile's `rot`, so it stays on the ground it was drawn on whichever
   way the piece sits. A stroke across a seam becomes one edit on each tile,
   and a tile it only grazes gets none: under half a percent of the stroke,
   anywhere on the tile, once the rim lock has faded it.
2. **The rim lock is a fade, not a dead band.** The weight is 0 on the rim
   and 1 from `rimLockMM` (12, in the contract if it needs to change) in,
   smoothstepped between, so a stroke near a seam does something and nothing
   on the seam itself. Nothing is pushed below the 2 mm floor (§10) that was
   above it.
3. **A stroke is a line and a radius.** The weight is a cosine of the distance
   to the line, so a raise is a ridge with a level crest, not a row of bumps.
   Smooth eases towards a box average read from a frozen copy, so the order the
   cells are visited in does not matter. Flatten goes to `toMM`. The tool
   writes the height *on the table* where the stroke began, less each tile's
   riser, so a terrace across two tiles is one height. Unknown ops are reported
   and skipped, never guessed at.
4. **The woods are edits too, replayed where the woods are planted.**
   `clear` is a `where` filter on every wood on the tile. `plant` is a wood
   of its own, kept off canopy already there, with its seed taken from the
   stroke, so it keeps its trees whatever the map's seed.
5. **A lake and a spring stay the fields they are.** The Refine tools write
   the same `lakes.place` / `fountains.place` entries the tile view's tools
   do; the generator already reads them. The handles drag those, and
   volcanoes, flats and ridge points, along the ground.
6. **The whole map rebuilds on every change, but not the ice.** The ground is
   a pure function of `worldKey(spec, { ice: true })`, so the worker keeps the
   last one and `buildMap` takes it when the key matches. A stroke then costs
   the tiles alone: 0.9 s at draft, against 8–10 s with the ice. A test builds
   the same bytes either way. This is a first slice of phase 6's `grow` cache.
   The rest of phase 6, rerunning only the design that changed, is still to
   come.
7. **A stroke shows at once.** The same `applyGroundEdits` runs on the
   heights the view is showing, so the ground moves when the pointer lets go.
   The regrow then replaces it with the real replay; trees, lakes and springs
   wait for that. In Refine a change of any kind grows the map again once
   things settle (a drag counts once it ends), and a change made during a
   build is grown next.
8. **The brush follows the ground the pointer is over.** In perspective that
   can be the far wall of a gorge, which is what the cursor shows, so it is
   what happens. Left paints, right orbits, Shift-right pans; on a touch
   screen one finger paints and two turn and zoom.
9. **Undo is the editor's undo,** which is the spec before the stroke. The
   inspector lists a tile's edits in the order they are replayed, each
   removable, with Clear all.

Left for later: rerunning only the edited design (phase 6), and strokes
drawn on the 2D board.
