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
| tall tile / short tile as a thing the child decides | the tile's height is the plate stack the *river* demands (`assignLevels`) | height is an output, not a property of the piece |
| tiles interact: waterfall, dam, pond | `classifySeam` already names plane / cliff / waterfall / dam / ledge, and `buildMap` already ponds a tile behind a dam | per seam only, for the designed layout; nothing follows the water through a *whole arrangement* (a pond backing up three tiles, a two-plate dam overtopping) |
| draw, grow, refine | a form, a JSON textarea, a hillshade PNG, a download list | no canvas, no 3D, no editing after the build |
| rotate a tile | ports are at the centre of each edge and keys are symmetric about the centre, so rotation *would* work | nothing represents a rotation |

The right reading of this is that the **edge contract was the right idea and
has to become stricter**, the **plate solver becomes a checker** instead of an
oracle, and the UI is a rebuild. Nothing in the terrain, glacier, river,
lake, spring, canopy, key or mesh code has to change in kind.

## 3. The set contract

Everything below is `contract.js` growing, not being replaced. The invariant
that every finished tile honours its declared rim to `< 1e-6 mm` stays; what
changes is **which rims are allowed to be declared**.

### 3.1 A tile is (height class, four edges, a rotation)

```
tile design  = { id, height: 0|1|2|3, edges: {N,E,S,W}, fallMM, features... }
edge         = land            land at the datum, rim corners both at +0
             | land+          a land edge one plate up at one or both corners (a ramp tile)
             | in <size>      a river comes in, floor at outletZ + fallMM
             | out <size>     a river goes out, floor at outletZ
             | drain <size>   out, declared as falling into the tray
placement    = { design, col, row, rot: 0|1|2|3 }
```

**Height class** replaces the solved plate level. A class-1 tile stands one
plate (10 mm) above a class-0 tile, whether that plate is loose or printed
into the tile (see §8). It is written on the piece, it is what "tall" and
"short" mean in the brief, and it is the *only* thing that moves a tile up
or down in the world.

**The land datum is one number.** Every land edge of every tile sits at
`edgeLandMM` above that tile's own base, at both corners, unless the edge is
explicitly a ramp. That is what makes a class-0 land edge mate with every
other class-0 land edge, and it is the single biggest change from today, where
`cornerLattice` reads the world. The tile's own ground still rises to whatever
it likes inland — `conformToContract` adds a residual, it never flattens —
so a mountain tile is a mountain that comes down to the datum at its rim, and
the large-scale relief of the *board* comes from the height classes, as the
brief describes it: mountains are tiles standing higher.

A **ramp tile** declares one or more corners at `+1 plate`. Its signature is
different (`land 22/32`) and so is which neighbours it fits, and the catalogue
says so. Most sets want two or three of them and no more.

### 3.2 The port ladder gets a zero

Today `FALLS = [10..50]` and every river tile drops at least one plate across
itself, which is what *forces* the downstream tile a plate lower. In a set,
that is the wrong default: two class-0 river tiles side by side must flow.

So `fallMM: 0` is allowed, and it is the **standard river tile**: inlet and
outlet floors both at `outletZMM`. The flow across it is driven by the pump's
head, as it is on any water table. Tiles with a fall of 10–50 mm become the
*step* tiles — rapids, cascades — and they carry their own meaning: a fall-10
tile's inlet is one plate up, so it wants a class-(n+1) tile upstream or it
dams. That is not a fault in the set; it is a piece with a rule, and the board
(§4) tells the child which.

> Decision to take with the first printed pair: whether the level tile should
> carry a 2 mm bias (inlet 8, outlet 6) so a chain of them has a visible
> direction. It costs a 2 mm pond at every same-class seam. Try both in water.

The checks that go with it, all closed-form:

- `edgeLandMM ≥ outletZMM + plateMM + bankAboveMM`, so a **one-plate dam ponds
  and holds**: with the example's 6/22, a short tile backed against a tall one
  fills to 16 mm and has 6 mm of freeboard. (`check()` today only requires the
  land to clear the default inlet.)
- A **two-plate dam overtops** at the rim and runs into the tray. Legal,
  reported, and in a water table it is a feature.
- The widest port plus banks still fits the tile; the levee rule in
  `edgeProfile` is unchanged.

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
shuffles well has few: a reasonable target is land, land+, and three or four
port types. The count going up is the first sign a set has stopped being
interchangeable, which is easier to see as a number than on a table.

## 4. The board: what the water does

New module, `lib/board.js`. Pure, fast (microseconds for 64 tiles), tested on
its own, and the thing the editor calls on every mouse-up.

**In:** the set, a grid of placements, which tiles are fed (a spring, a hose).
**Out:** a water level per tile, a kind per seam, and a list of things worth
saying.

### 4.1 The model

Each placed tile is one pool with a floor at its lowest port and a rim at its
land datum, both in world mm (`height × plateMM + local`). Each outlet faces a
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
| outlet floor = inlet floor, same level | **flow** | the river runs across |
| outlet floor above inlet floor | **waterfall h** | it falls `h` |
| outlet floor below inlet floor, pond held under the rim | **dam, ponds to Z** | the short tile fills up |
| the pond reaches an upstream outlet | **backs up** | the tile behind floods too — a chain of level tiles floods back to the last step |
| the pond reaches the rim | **overtops** | water sheets over the land into the tray |
| outlet facing land | **blocked** | same as a dam, with the land as the wall |
| outlet facing nothing | **drains** | it runs off the edge into the tray |
| inlet fed by nothing | **dry** | a river bed with no water in it, which is fine |

These are the brief's sentences — *a river becomes a waterfall; if the short
tile has the flow, the tall tile is a dam* — made checkable. The tests are the
same sentences: a tall-to-short pair is a 10 mm waterfall; a short-to-tall pair
ponds to 16 and holds; a two-plate dam overtops; three level tiles behind a dam
all flood; a loop of level tiles is a pond, not an error.

What `assignLevels` does today — refusing a layout whose two ways round a loop
drop differently — becomes a **note on the board** rather than a reason not to
build. In a set the piece is right; it is the arrangement that dams, and the
child will move it.

### 4.3 It also drives the design

The same solver, run on the *design* board in the editor, is how the author
sees what the set can do before printing: lay out the pieces, drag one, watch
the badges on the seams change. That is the first thing worth building,
because it costs nothing and it is the play the brief describes.

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
palette; `R` rotates, `Delete` removes), *height* (paint 0–3 on a cell),
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
only. Drawn: each tile at its height class on its plates, the water as a
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
| `lib/contract.js` | `fallMM: 0` on the ladder; `check()` gains the freeboard rule; canonical catalogue signature; corner vocabulary {0, +1 plate} |
| `lib/board.js` | **new**: placements, rotation, the hydrology fixed point, seam kinds, the catalogue count |
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
  "designs":  [ { "id": "ridge-3", "height": 1, "fallMM": 0, "edges": {...}, "world": {...}, "canopy": [...] } ],
  "board":    { "cols": 4, "rows": 3, "place": [ { "design": "ridge-3", "col": 0, "row": 2, "rot": 1 } ] },
  "edits":    { "ridge-3": [ ... ] } }
```

Today's `rivers` / `falls` / `waterfalls` / `levels` keep working as a
**map-style** spec: it is read as a board whose designs are generated in
place, with `assignLevels` supplying the height classes. The example map
builds the same bytes as before, which is the regression that proves the
refactor did not change the generator.

## 8. Physical decisions the brief raises

**Height: plates or printed in?** Today a class-2 tile is a tile on two loose
plates. For a map on a wall that is right; for a set a child shuffles, loose
plates are parts to lose and a seam to wobble on. Offer `riser: 'integral'`
(the tile prints with its plates as part of it, hollowed by the slicer) next
to `riser: 'plates'`. Integral is heavier and slower to print; it is also the
only version of a "tall tile" a four-year-old can pick up as one thing.
Recommend integral for the set, plates for development.

**Everything stands in the tray.** It already exists (`tray.stl`) and the
dam case makes it mandatory: water held against a butt seam weeps through it,
and the pump puts it back. *You do not need watertight; you need all of it to
come back.* The seam overlap (`seam: 'overlap'`) is only for outlet-to-inlet
and stays optional.

**The dam with a spillway.** A land edge with a notch at a set height
(`spillway@Z`) is a new edge type that turns "the pond overtops somewhere" into
"the pond spills *here*, as a waterfall". It is the single most engaging
tile this set can have, and it is a Phase 6 item because it needs the edge
vocabulary settled first.

**Tile size stays 200 mm.** The brief's child-scale pieces, the 220 mm bed,
and every number in the contract agree on it.

## 9. Phases

Each phase leaves the tests green and the example building the same bytes.

1. **The board, on paper.** `lib/board.js` with the hydrology fixed point,
   rotation, and `mmb board`; `fallMM: 0`; the freeboard check. Tests are the
   sentences in §4.2. *Done when* a hand-written four-tile board reports a
   waterfall, a dam that ponds to 16, and a two-plate dam that overtops.
2. **The set rule.** Corners from the height class, not the world; the design
   window; the catalogue and `mmb set`. *Done when* two designs cut from
   opposite ends of the world, rotated, verify flush against each other at
   `< 1e-6 mm`.
3. **The staged pipeline.** `plan`/`grow`/`cut`/`refine`/`mesh` with caches
   in the worker; `edits.js` with replay. *Done when* a brushstroke on one
   design reruns in well under a second at draft mesh and the whole set still
   builds the same bytes twice.
4. **Draw.** The board canvas with badges live from `plan`; the tile canvas
   writing spec fields; the JSON in a drawer. *Done when* the example map can
   be drawn from an empty board without touching the JSON.
5. **Grow.** The three.js viewer from transferred height fields, with water
   at the board's pond levels and plates at the height class.
6. **Refine.** Brushes and handles writing `edits`; undo; the rim lock
   visible. Then the spillway edge, `riser: 'integral'`, and a worker pool.

Phase 1 is a week of pure logic with no UI and it is the one that answers
whether the brief's rules hold in the contract's numbers; it should go first
even though the UI is the visible ask. Phases 4–6 are the bulk of the work
and are independent of each other once 3 is in.

## 10. Open questions, with a recommendation on each

1. **Level tiles: fall 0, or a 2 mm bias?** Recommend 0 and test in water.
2. **Height classes: 0–3, or 0–2?** Three plates is 30 mm of wall between
   neighbours; above that a seam is a cliff a small hand cannot reach over.
   Recommend 0–3 allowed, 0–2 in the first set.
3. **Integral risers from the start?** Recommend yes for the first printed set,
   with `plates` kept for iterating designs cheaply.
4. **One world per set, or per tile?** Recommend per set with windows (§5);
   `world: 'own'` for the odd piece.
