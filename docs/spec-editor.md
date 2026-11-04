# Spec: the drawing editor

Status: **design, not built.** Written 2026-11-04.
Companions: [spec-pipeline.md](spec-pipeline.md) (build this first),
[spec-glacier-deposition.md](spec-glacier-deposition.md).

---

## The workflow being built for

In the user's words, which is the acceptance test for the whole thing:

> I should start with a 2d map of the 200×200 mm tile. I tell it how tall the
> map is, I tell it how tall the mountain is, I draw the spine of the mountain,
> I place the glacier, I draw what direction I think the glacier should carve
> if it is not obvious, then I let the glacier carve. Then I come back in and
> draw lakes and rivers. Or I draw where I want the glacier to stop. Or I draw
> a retreating glacier and let it carve a cirque higher up.
>
> If it's a volcano or mesa, I just place those. If it's a hill, I just place
> that. Then we weather it so it looks convincing.

Two things in that are structural, not cosmetic. **It is iterative** — carve,
look, come back in — which is what [spec-pipeline.md](spec-pipeline.md)
exists for. And **it is drawn in plan**, which means every spatial input needs
a place on a canvas, including three the library does not have yet.

## Why the current app is the wrong shape

`app/` as built is a spec editor with a preview. It assumes you know the JSON,
it runs the whole pipeline on every click, and heights are reported as numbers
in a table. The hillshade only appears after a full build and cannot be drawn
on. It is a good harness for the CLI and a bad tool for designing terrain.

Most of it survives, though: the worker protocol, the report tables, the STL
and ZIP export, the dark/light styling and the download set are all reusable.
What changes is that the left column stops being a textarea and becomes a
canvas with tools, and the build stops being one button.

## Layout

```
┌────────────────────────────────────────────────────────────────┐
│  Modular map builder                                   [Export]│
├────────┬──────────────────────────────────────┬────────────────┤
│        │                                      │  STAGES        │
│ TOOLS  │                                      │  ✓ Uplift  2s  │
│        │         plan view, hillshaded        │  ✓ Ice    10s  │
│ ╱ spine│         with the seam grid           │  ⟳ Weather     │
│ ◇ volc │         always visible               │  · Tiles       │
│ ○ hill │                                      │  [Carve ice]   │
│ ▦ mesa │                                      │                │
│ ❄ ice  │                                      │  LAYERS        │
│ ⊥ term │                                      │  ☑ spine       │
│ ~ river│                                      │  ☑ ice mask    │
│ ◉ lake │                                      │  ☑ plate levels│
│        │                                      │  ☐ ice depth   │
├────────┤                                      │                │
│ tool   │                                      │  REPORT        │
│ options│                                      │  (as today)    │
└────────┴──────────────────────────────────────┴────────────────┘
```

### One tile or the whole map?

The quote says *"a 2d map of the 200×200 mm tile"*, singular. **Recommend the
canvas always shows the whole map with the seam grid drawn over it**, with a
zoom-to-tile for detail work.

The reason is the project's own premise: a spine that runs across three tiles
without a step, and a river that lines up across a seam, are the things this
generator exists to produce. Neither is drawable one tile at a time. A 1×1 map
is then just the degenerate case and still works.

## Coordinates

Every existing spatial field is already normalised `[u, v]` in `[0,1]`:
`spec.spine`, `spec.volcanoes[].at`, `spec.flats[].at`. Keep that for
everything new, including the ice mask and terminus from
[spec-glacier-deposition.md](spec-glacier-deposition.md).

**Watch the vertical flip.** Tile row 0 is the *bottom* of the map and
`lib/shade.js` flips for image coordinates. The canvas must use the same
convention or everything drawn will be mirrored against everything generated.
Put the conversion in one pair of functions and let nothing else touch it.

## The spec stays the source of truth

Every tool writes into the spec object. The spec remains exportable as the
same JSON the CLI reads, and the JSON view stays available as a panel.

This is worth being firm about. It keeps `mmb build map.json` working on
anything the editor produces, it keeps the 133 tests meaningful, it makes the
editor's state trivially serialisable, and it means undo is a spec snapshot
rather than bespoke per-tool state. A tool that cannot express itself in the
spec is a tool that is not finished.

## Tools

| Tool | Draws | Writes to | Status |
|---|---|---|---|
| **Spine** | polyline | `spec.spine` | ✅ ready — already a polyline |
| **Map height** | number | `spec.reliefMM` | ✅ |
| **Mountain height** | number | `spec.spineHeightM` | ✅ |
| **Volcano** | click + drag radius | `spec.volcanoes[]` | ✅ incl. `breachAzimuthDeg` as a drag handle |
| **Hill** | click + drag radius | `spec.flats[]` | ✅ |
| **Mesa** | click + radius + bed heights | `spec.strata` | ⚠️ `makeStrata` exists, **nothing calls it** |
| **Ice mask** | brush | `spec.glacier.iceMask` | ❌ needs `iceMask` |
| **Terminus** | polyline | `spec.glacier.terminusLine` | ❌ needs `terminusLine` |
| **Retreat schedule** | ELA per cycle | `spec.glacier.elaSchedule` | ✅ already supported, needs UI |
| **River** | polyline | `spec.rivers[]` | ⚠️ hard — see below |
| **Lake** | click + radius | `spec.lakes.place[]` | ✅ `placeLake` takes `atMM` |
| **Weather** | slider | `spec.reposeDeg`, `reposePasses` | ✅ |

Four of these are blocked on library work. **An editor shipped before that
work has dead controls in its palette**, which is worse than not having them.
Either hide them until their backing exists, or do the glacier work first.

## Layers

Overlays, independently toggleable, drawn above the hillshade:

- **Vector layers** — what the user drew: spine, ice mask, terminus, rivers,
  lakes, feature markers. Always editable, with draggable handles.
- **Diagnostic layers** — what the model produced: ice depth, sliding speed,
  till depth, incision, **plate levels**, flooded cells.

**Plate levels is the one that matters most.** The project's central idea is
that the plate stack *is* the river's gradient, quantised. Showing the level of
each tile live, as the river is drawn, turns the thing most likely to go wrong
into something seen rather than discovered in the report. Colour each tile by
its level and label it with its plate count.

## Rivers: the hard tool

Everything else is a direct mapping. Rivers are not.

A river today is declared as a **tile path** with edge ports:

```js
{ name: 'main', sourceEdge: 'N', path: [[1,2],[1,1],[1,0]], sinkEdge: 'S', sinkSize: 'bay' }
```

`portsFromRivers` (`lib/build.js:26`) turns that into per-tile in/out ports and
**throws** if consecutive tiles are not edge-adjacent. Then `autoSizeRivers`
widths them and `assignLevels` derives the plate staircase, which can fail with
real problems the user must resolve.

Converting a freehand stroke needs:

1. Sample the polyline, find the ordered list of tiles it crosses.
2. **Drop diagonal steps.** A stroke that clips a corner yields a
   non-adjacent pair and throws. Insert the intermediate tile, or refuse the
   stroke and say why.
3. Collapse re-entry — a stroke that wanders back into a tile it has left.
4. Derive `sourceEdge` / `sinkEdge` from where it crosses the map boundary.
5. Choose a `fallMM` per tile. **Cannot be inferred from a plan-view stroke**:
   the gradient is the user's decision and it is the decision the whole print
   geometry hangs on.

Recommended interaction: the stroke sets the *route*, then each tile the river
crosses gets an inline control on the canvas for its fall (10/20/30/40/50 mm),
defaulting to 10. The plate-levels layer updates as those change, so the
staircase is visible while it is being chosen. If `assignLevels` reports a
contradiction, highlight the offending seam on the canvas rather than only
listing it in the report.

Note that the stroke is **not** the carved channel. `planChannels` /
`valleyPath` (`lib/river.js`) route the river within each tile over the
glaciated ground, deliberately — see the comment at `lib/build.js` about
routing before conforming. The drawn line declares which tiles and which
edges; the generator still finds the valley. Say so in the UI, or the first
time the river does not follow the drawn line it will read as a bug.

## Rendering

Two stacked canvases. A raster below holding the hillshade, repainted only
when a stage completes. A vector above holding overlays and handles, repainted
on pointer move. Never re-hillshade on a drag.

This needs `shadeField(field, opts)` from
[spec-pipeline.md](spec-pipeline.md) — `shadeMap` currently takes a build
result and cannot draw a bare world bed, which is exactly what stages
uplift/ice/weather produce.

Diagnostic layers are the same renderer with a different ramp over a different
field. `glaciate` already returns ice and incision diagnostics and already
records per-cycle `{ cycle, elaM, icedFraction }` in its history — enough for
a scrub-through-the-glaciation timeline, which would be the cheapest way to
make the ice legible.

## Undo, persistence, export

- **Undo/redo**: snapshot the spec before each committed edit. Specs are small
  (the example is 1.8 kB of JSON); a 100-deep ring costs nothing.
- **Persistence**: spec to `localStorage` on change. Stage caches are too big.
- **Export**: the spec as JSON (CLI-compatible), the STL set and ZIP as today,
  `preview.png` as today.

## Out of scope for v1

Say these out loud so they do not creep in: 3D view, per-cell height painting,
texture or colour authoring, multi-user anything, undo across stage boundaries
(an undo that crosses a carve just re-runs it).

## Order of work

0. **Prerequisite:** [spec-pipeline.md](spec-pipeline.md) steps 1–4.
1. Canvas shell: stacked canvases, coordinate transform with the vertical flip tested, pan/zoom, seam grid.
2. The ✅ tools: spine, volcano, hill, heights, weathering. Already fully backed.
3. Stage buttons and the cache view.
4. Plate-levels layer. High value, no new library work.
5. Glacier tools — **after** [spec-glacier-deposition.md](spec-glacier-deposition.md) parts 3–4.
6. Rivers, with per-tile fall controls.
7. Lakes, mesas.

## Open questions

- **`relief`'s interaction model.** The brief was "similar to relief", and
  `RealPapaNerf/relief` could not be attached to the session that wrote this
  (permission denied on `add_repo`). Nothing here is informed by it. Before
  step 1, either grant access or settle the question by hand: tool palette
  layout, how a drawn feature is re-selected and edited, whether there are
  layers, how it handles re-running a simulation.
- Brush or polygon for the ice mask? A brush suits "snow collects roughly
  here"; a polygon is easier to edit afterwards. Possibly both.
- Should the fall controls live on the canvas or in a table beside it?
- What happens to drawn features when `cols`/`rows` change? Normalised
  coordinates mean they stretch with the map rather than staying put in mm.
  That is probably wrong for a volcano and probably right for a spine.
  **Decide before the first tool is written** — it determines whether the
  canonical coordinate is `[u,v]` or millimetres.
