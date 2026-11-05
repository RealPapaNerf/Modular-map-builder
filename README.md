# Modular map builder

Procedurally generated, 3D-printable terrain **modules**, built one at a
time, that **mate with each other**: any module's north edge sits against
any module's south edge, whatever is on either of them. Channels are
**drawn** across a module, 10 mm deep, with the cross-section of a
parenthesis on its side. Glaciers carve the ground and then **melt out
entirely**, so what prints is the terrain the ice left and never the ice.

No dependencies. Node 18 or newer and nothing else.

**[Build one in your browser](https://realpapanerf.github.io/Modular-map-builder/app/)** —
the same generator, nothing to install and nothing uploaded. Or on the
command line:

```bash
node bin/mmb.mjs example > module.json
node bin/mmb.mjs check module.json          # the contract and the channels, no ice
node bin/mmb.mjs build module.json --out out/
```

![One module, hillshaded](docs/preview.png)

*The example: a 200 mm module with a range across the middle of it, the
glaciers' valleys down each flank, a cirque lake, and a channel from under
the crest out through the south port. The rim is 22 mm high all the way
round; the only break in it is the port.*

---

## One module at a time

The first version of this built a 3 × 3 map and solved the whole thing at
once: every tile's rim followed the terrain, rivers crossed seams by
standing the downstream tile on a stack of plates, and nine pieces that fit
each other and nothing else. That is gone, on purpose. The builder now grows
**one module**, and the only promise a module makes is at its rim.

### The contract

Three numbers, and every module built to them sits against every other:

| | default | what it says |
|---|---|---|
| `edgeLandMM` | 22 | every edge of every module stands this high at its rim, flat, on all four sides |
| `portWidthMM` | 30 | a channel crossing the rim does so at the **middle** of that side, this wide |
| `channelDepthMM` | 10 | and this deep, in the cross-section below |

So a land edge mates with a land edge, a channel edge mates with a channel
edge, and a land edge against a channel edge is a channel running into a
bank, which is not an error — it is a wall the water stops at. There are no
plate levels, no falls, no corner heights, because there is no map to solve.

The check that the whole repository exists to pass is still there: every
finished module honours its rim to **under a millionth of a millimetre**,
measured on the thing that will be printed.

```
Edges:
  N  land 22                err 0.0000 mm
  E  land 22                err 0.0000 mm
  S  channel 30@12 22       err 0.0000 mm
  W  land 22                err 0.0000 mm
  worst edge error 0.0000 mm — it mates
```

### A level rim on sloping ground

A valley runs *down* through a module, and the rim is level, so the fall
across the module has to come out. The module is leaned onto its rim in two
parts (`conformToContract` in `lib/tile.js`):

- **The tilt.** The best-fit plane through the four rims' residuals is the
  module's overall fall, and it is subtracted everywhere. For a valley that
  falls steadily this leaves the valley's shape with its gradient gone.
- **The rest.** Whatever is left — a ridge running out through a side, a
  bump on the rim — is bent down to the rim over the last `rimBlendMM`
  (60 mm). Spread over the whole module instead, this would take a ridge
  that crosses both the east and the west sides out entirely, because the
  ruled surface between two equal residuals is a constant. Confined to a
  band, it does what a module's edge has to do anyway, and the mountain in
  the middle stands.

Ground that ends up below the rim — a trough the ice cut deeper than the
valley floor at the rim — is squeezed, smoothly, so that it never cuts
through the plate: nothing near the rim's height, saturating 6 mm above the
base. An overdeepening is still a basin, shallower than the metres say, and
the report says by how much.

### The margin

The ground is grown on a world that is the module plus a margin on every
side (`marginMM`, half a module by default), and the module is cut from the
middle of it. A glacier pinned to zero thickness at the edge of its domain
cannot flow into a module from outside, and a mountain that stops dead at
the rim has no catchment. The margin is thrown away; it exists so the ice
has somewhere to come from. The ridge, a volcano and a flat can be drawn
out into it.

## Channels you draw

```json
"channels": [
  { "name": "main", "widthMM": 30, "depthMM": 10,
    "path": [[100, 200], [94, 160], [112, 118], [92, 72], [100, 0]] }
]
```

A channel is a line, a width and a depth, in module millimetres. It is cut
that deep below the ground along its line — **10 mm by default** — and
where either end comes within reach of a side it is **snapped to that
side's port**, so the module hands it over in the one shape every module
agrees on. An end inside the module shallows out to nothing rather than
stopping at a cliff.

**The cross-section is a parenthesis on its side.** One circular arc from
bank top, down through the thalweg, and up to the other bank top: no flat
floor and no break in slope where a bank starts. For a channel deeper than
half its width the arc is a semicircle under straight walls. `channelShape`
in `lib/contract.js` is that curve, and it is the one function both the rim
profile and the carve use, so the channel a module cuts inland is the same
curve it hands over at its edge.

**The floor follows the ground.** A 10 mm channel is 10 mm below the land
along its whole length, with the ground smoothed along the line first so the
bed does not inherit every bump. Where it meets a port it is eased onto the
port's floor over about a width. It only ever *cuts*: across a hillside the
uphill bank is the cut and the downhill bank is the hill. A channel drawn
over a rise climbs it, and the report says so rather than quietly digging a
gorge:

```
note — main climbs 4.2 mm somewhere along its line, because it was drawn over a rise.
Water put in at its start ponds there. Move the line, or dig it with the Lower brush.
```

**Or let the generator route it.** A channel given as two ends and no line
is routed down the valley when the module grows: least cost over the
ground, paying for distance, for height and for climbing, with a little
wander on the flat and meanders where the valley has room. An end is a side
(`"S"`) or a point on the module (`[100, 62]`). The example's channel is one
of these, so it follows the valley whatever the seed; the inspector's
*Take the line it found* turns it into a drawn one you can drag.

Widths are free — the editor offers 20, 30, 40 and 60 mm bank to bank — and
at the rim a channel is the port's width whatever it is inland. Two channels
cannot leave by one side; there is one port a side.

## The glaciers carve, and then they go

The terrain is still made the same way, because the shapes that make
glaciated country recognisable — the U section, the overdeepened floor, the
cirque biting into the divide, the tributary left hanging — are the
signature of a process and no noise function fakes them. Ice is a shallow,
isothermal, Glen-law fluid; erosion follows the sliding; the snowline swings
so that the ice advances and retreats; what it quarries it carries and puts
down as moraine. All of that is in `lib/glacier.js`, with the defects it
shipped with and how each was caught, and it is unchanged.

What is new is the end of the run. The cosine schedule ends warm, but warm
is not gone: the last advance's remnants were still sitting in the cirques
when the run stopped, and on the finished map the summits were painted white
over ground the ice had smoothed, which read as the ice still being there.
So:

- **The ice melts out.** After the last cycle the snowline is lifted clear
  of the summits and the ice is relaxed until there is none. Whatever till
  it was still carrying grounds where it is, as ablation till; what the
  moraine rail will not let stand leaves as outwash, counted. The report
  says how much ice the climate left behind and that **0.0 m remains**, and
  a test asserts the final ice is zero everywhere.
- **The tops are rock.** The hillshade and the 3D view colour the highest
  ground grey-brown, not white.
- **A tarn has to be a tarn.** The hollows the ice leaves are filled with
  water, as before, but a hollow has to be 150 mm² and 1.5 mm deep to count:
  ground pocked with twenty puddles read as a crevassed ice field, not as a
  valley with a lake in it.

What you see is the bed: cirques, troughs, moraines, the lakes behind them.
`glacier.meltOut: false` keeps the old ending, for comparison.

## The rest of the module

Everything that was already here still is, per module rather than per map.

- **Standing water** (`lib/lake.js`): tarns in the hollows the ice left,
  lakes placed at a point or painted along a stroke, each a hole you can
  pour clear epoxy into, with the millilitres reported.
- **Springs** (`lib/fountain.js`): a pool with a lip and one notch, and a
  tube bore straight down through the module. `fountains.auto` puts one at
  the start of every channel, which is where a pump has to put the water.
  `build` writes a tray for the module to stand in.
- **Woods** (`lib/canopy.js`): conifer spires and broadleaf cauliflower,
  placed and stamped, with a treeline in module millimetres. No tree ever
  crosses the rim.
- **Seam keys** (`lib/joint.js`): a dog-bone key dropped into a recess cut
  into the underside, not glued, a slip fit. Every edge gets its recesses at
  the same positions, mirrored about the middle of the side, so the half on
  one module's east edge meets the half on any module's west edge. Where the
  plate runs thin the recess is refused whole, never cut short.
- **Edits by hand** (`lib/edits.js`): raise, lower, smooth, flatten, plant
  and clear, kept as strokes and replayed every time the module grows, so a
  new seed keeps them. The last 12 mm of the rim is locked.

## In the browser

[**realpapanerf.github.io/Modular-map-builder/app/**](https://realpapanerf.github.io/Modular-map-builder/app/)

Four stages over one spec, the spec being the document:

| stage | what it does |
|---|---|
| **Draw** | the module flat, with its margin round it. Channel, Water, Spring, Ridge, Volcano, Flat, Wood. Every tool writes the spec; a hillshade of the ground without its ice lies under the grid while you draw |
| **Grow** | runs the generator in a worker, then stands the module up in 3D as it will print, water in its channels and lakes |
| **Refine** | brushes on the grown ground in 3D: raise, lower, smooth, flatten, paint water, plant, clear, a spring. Every stroke is kept as an edit and the module grows again with it, keeping the ice from last time |
| **Print** | the report and the files: the module's STL, its keys, the tray |

The **Channel** tool is a drag: start or finish on a port mark — the middle
of a side — to cross the rim there, or anywhere within 30 mm of a side, and
the end snaps to its port. The line is shown snapped, with its width, while
you draw. Width and depth are in the palette. Nothing leaves the machine,
and the JSON is in a drawer if you want it.

A spec written for the old board — several tiles, rivers between them — is
refused with a sentence rather than guessed at: which of its nine tiles
would it be?

## The spec

Everything is millimetres on the module, x east, y north, from its
south-west corner. A point may be outside 0..200: that is the margin.

```json
{
  "name": "hanging-valley", "seed": 7, "meshMM": 0.9, "metresPerMM": 25, "marginMM": 100,
  "spineHeightMM": 60, "spineWidthMM": 95,
  "spine": [[-100, 112], [30, 98], [105, 104], [190, 94], [300, 86]],
  "glacier": { "cycles": 30, "elaSwingMM": 18 },
  "channels": [{ "name": "main", "widthMM": 30, "depthMM": 10, "from": [100, 62], "to": "S" }],
  "canopy": [{ "kind": "conifer", "crownMM": 7, "heightMM": 9, "density": 0.4, "minZMM": 28, "maxZMM": 54 }],
  "lakes": { "fillHollows": true, "depthMM": 5, "shoreMM": 10, "profile": "dish",
             "place": [{ "atMM": [60, 140] }, { "pathMM": [[30, 40], [70, 60]], "radiusMM": 12 }] },
  "fountains": { "auto": true, "tubeOdMM": 12.7, "poolRadiusMM": 16, "place": [{ "atMM": [150, 150] }] },
  "edits": [{ "op": "raise", "path": [[30, 45], [90, 45]], "radiusMM": 12, "mm": 8 }],
  "contract": { "tileMM": 200, "edgeLandMM": 22, "portWidthMM": 30, "channelDepthMM": 10 }
}
```

`metresPerMM` is the one place metres appear: the generator works in real
metres, because that is the only scale on which ice behaves like ice, and
25 m per millimetre makes a 200 mm module 5 km of country. The commented
version of this is `lib/example.js`.

## Layout

```
lib/contract.js    the edge contract: the rim, the port, the ) cross-section
lib/channel.js     channels: snapping to ports, routing down the valley, the floor, the carve
lib/tile.js        metres to millimetres: cut from the world, leaned onto the rim, squeezed
lib/build.js       buildWorld (uplift, ice, gravity) and buildTile (the module)
lib/terrain.js     uplift: spine, roughness, flats, volcanoes
lib/glacier.js     shallow-ice flow with sliding, till, and the melt-out at the end
lib/hillslope.js   critical-angle failure, and creep
lib/basins.js      closed hollows, by priority-flood
lib/lake.js        tarns, lakes placed and painted
lib/fountain.js    spring pools, tube bores, and the tray
lib/joint.js       dog-bone keys, their recesses, and the ear clipper
lib/canopy.js      woods
lib/edits.js       edits by hand, kept as operations and replayed
lib/mesh.js        height field -> closed solid, with bores and a watertightness check
lib/stl.js         binary STL
lib/shade.js       the hillshade, as RGB; preview.js wraps it as a PNG
lib/scale.js       metres per millimetre, the margin, and the old-board refusal
lib/example.js     the worked example
bin/mmb.mjs        command line
app/               the editor: main.js holds the state, tilecanvas.js and features.js
                   draw, tools.js and inspector.js edit, specops.js is every edit as a
                   function of the spec, worker.js grows, viewer.js stands the module up
                   in 3D from heights.js's arrays
lib/vendor/        three.js r169 and OrbitControls, MIT
test/              node --test, plus browser.mjs for the editor in Chromium
```

## Tests

```bash
npm test
npm run test:browser      # the editor in Chromium; needs Playwright, skips without it
```

The ones that earn their keep:

- the finished module honours its edge contract **exactly** (< 1e-6 mm),
  and is a **closed solid**
- **two modules built to one contract mate**: different seeds, different
  channels, and the east edge of one is the west edge of the other to the
  last sample, port and all
- the cross-section is a circular arc through the bank tops and the
  thalweg, monotone from the centre out, a semicircle under walls when it is
  deeper than it is wide
- a channel is cut the contract's depth below the ground along its line,
  only ever cuts, snaps an end near a side to its port, and leaves the port
  exactly on the contract whatever its own width and depth
- a channel drawn over a rise is reported as climbing; one on the flat is not
- a routed channel follows the valley the glacier left, will not climb a
  ridge to save distance, meanders on a floodplain and stays put in a gorge
- the module is cut from the middle of its world; a plane tilt leaves the
  middle at the datum; a hole deeper than the plate is squeezed, never cut
  through
- **the ice melts out entirely before the bed is handed on**, on a cold
  climate that would otherwise have left ice in the valley; with the melt
  off, it does
- till conserves mass, with the melt's outwash counted
- every edge gets the same recesses, mirrored about its middle, so any two
  modules' halves meet
- the example can be drawn from a blank module with the tools alone, in node
  and in Chromium with the mouse, the JSON never opened
- a channel drawn with the mouse snaps its ends to the ports and takes the
  palette's width and depth; a routed one can take the line it was grown with
- a draft build is on screen in 3D within a few seconds of the heights
  landing, with water in the channel and **no ice**; orbiting is smooth and
  draws nothing once it has stopped
- a brushstroke in Refine is written as an edit, previewed at once, grown
  again, and undone
- a raised ridge survives a change of seed with the edge check still at zero
- an old board spec is refused, in the CLI and in the editor

## Status

Working and tested end to end: the contract, the channels drawn and routed,
the module cut and leaned onto its rim, the ice carving and melting out,
lakes, springs, woods, keys, hand edits, the editor's four stages, the CLI.

Under-tuned, as before: glacial U-widening (`valleyForm` is the metric,
`elaM` and `erosionK` the levers), and now also how hard the ice may dig
relative to a 22 mm rim — a trough deeper than the rim has room for comes
out as a lake behind the port, which is physics, and more of it than a
200 mm module always wants.

Two design documents in `docs/` pre-date the one-module model and say so at
the top: a staged pipeline, and telling the ice where to go.

## Licence

MIT. See [LICENSE](LICENSE).
