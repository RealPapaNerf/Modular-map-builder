> **Status, November 2026.** Written for the 3 x 3 board the builder used to make. The builder now grows ONE module at a time (see the README); `buildMap` is `buildTile`, the stages below still describe the real seams in it, and the costs are per module. The editor already keeps the grown world between builds, which is the first of these stages.

# Spec: a staged pipeline

Status: **design, not built.** Written 2026-11-04.
Companions: [spec-glacier-deposition.md](spec-glacier-deposition.md),
[spec-editor.md](spec-editor.md). Build this one first — both of the others
stand on it.

---

## The problem

`buildMap` (`lib/build.js:271`) is one call. Spec in, finished tiles out:
contract, levels, keys, world, corners, seams, then every tile cut, routed,
carved, watered, planted, meshed. There is no way in partway and no way to
keep half of it.

The workflow this project is heading for is the opposite of one call:

> I draw the spine. I place the glacier. **I let the glacier carve.** I look at
> it. **Then I come back in** and draw lakes and rivers. Or I draw where I want
> the glacier to stop and carve again.

Every "then" in that sentence is a checkpoint `buildMap` does not have.

## What it costs today

Measured on the 3×3 example, Node 22:

| | time |
|---|---|
| World: uplift, volcano, 30 glacial cycles, mass wasting | **~10 s** |
| Tiles: cut, route, carve, water, canopy, mesh at 0.9 mm | **~7 s** |
| Tiles at 2.5 mm | ~0.8 s |
| Whole build at 0.9 mm | 16.9 s |

The ice is two thirds of the cost and **nothing downstream of it changes the
bed**. Today, nudging one river re-runs the glacier. That is the argument for
this work independent of the GUI: cache the world and an edit to the water
costs under a second instead of seventeen.

## Stage boundaries

These are the real seams in `buildMap` today, in order. Each depends only on
those above it.

| # | Stage | Produces | Reads | Cost |
|---|---|---|---|---|
| 1 | `contract` | contract, notes, seam geometry | `spec.contract` | ~0 |
| 2 | `plan` | tiles map, ports, sizes, levels, keys, problems | `rivers`, `falls`, `levels`, `joints`, `cols/rows` | ~0 |
| 3a | `uplift` | bed after `baseTerrain` + volcanoes | `spine`, `spineHeightM`, `flats`, `volcanoes`, `seed`, `worldGrid`, `worldSizeM` | ~1 s |
| 3b | `ice` | bed after `glaciate`, ice/till diagnostics | 3a + `glacier` | ~10 s |
| 3c | `weather` | bed after `massWaste` | 3b + `reposeDeg`, `reposePasses` | ~0.3 s |
| 4 | `corners` | corner lattice, seam checks | 1, 2, 3c + `reliefMM`, `terraceMM` | ~0 |
| 5 | `tiles` | per-tile surface, water, canopy, mesh, STL | all of the above + `meshMM`, `lakes`, `fountains`, `canopy` | 0.8–7 s |

`buildWorld` (`lib/build.js:163`) currently fuses 3a–3c. **Splitting it is the
central change.** The editor needs to show the bed after uplift, let the user
place ice on *that*, carve, show the result, and let them carve again from
where it stopped — which means 3b must be re-runnable against a kept 3a, and
must be able to take its own previous output as input.

## Proposed shape

A `Project` holding the spec and a cache of stage outputs.

```js
// lib/pipeline.js  (new)
export const STAGES = ['contract', 'plan', 'uplift', 'ice', 'weather', 'corners', 'tiles'];

export function createProject(spec) -> Project
export function run(project, upTo, { onProgress, onStage }) -> Project
export function invalidate(project, stage) -> Project
export function stageInputs(spec, stage) -> object   // exactly what that stage reads
```

Each cache entry is `{ value, key }` where `key` is a stable hash of
`stageInputs(spec, stage)` plus the key of the stage before it. `run` walks the
list, reuses an entry whose key still matches, recomputes from the first that
does not, and drops everything after it. Nothing needs manual invalidation and
nothing can silently go stale — change `spec.spine` and `uplift` onward
recompute; change `spec.meshMM` and only `tiles` does.

`buildMap` stays, as `run(createProject(spec), 'tiles')` returning the same
shape it does now, so the CLI and the 133 tests are untouched.

### Ice as a resumable stage

3b is the one stage that is not a pure function of the spec, because the user
wants to carve, look, and carve *again from there*. Two options:

1. **Declarative.** Every intervention is recorded in the spec (an ice mask,
   a terminus line, an ELA schedule) and `ice` always re-runs from the 3a bed.
   Deterministic, reproducible, exports to JSON, replays on the CLI.
   Re-carving costs the full 10 s every time.
2. **Incremental.** The `ice` stage can take its own output as input and run
   *n* more cycles. Cheap, but the bed becomes a function of click history,
   the spec no longer reproduces the map, and CLI parity is gone.

**Recommend (1).** The whole project rests on a spec that reproduces a map;
the CLI, the tests and the example all assume it. Buy back the cost with a
coarser `worldGrid` while editing (a preview ice run at 64² instead of 128²
is roughly four times cheaper) and a full-resolution pass on demand. Worth
measuring before committing — if a 64² carve does not predict the 128² one
well enough to design against, option 2 comes back onto the table.

### Progress and cancellation

`onProgress(message)` exists and is threaded through. Add `onStage({ stage,
index, cached })` so the UI can show which stages were reused — a live cache
view is the clearest way to teach someone which edits are cheap.

Cancellation stays what it is in the app today: terminate the worker. Each
stage is a long synchronous call and nothing short of termination interrupts
one. Because the cache lives in the worker, **terminating loses it.** Either
hold the cache on the main thread (structured-clone cost on every stage — the
tile stage alone is 60 MB, so no), or keep a second idle worker that owns the
cache and hand work to short-lived children (complex), or accept that cancel
drops the cache and re-runs. **Recommend accepting it for v1** and revisiting
if it bites; a cancel is already a decision to throw work away.

## Worker protocol

Today: `{type:'run', spec, mode}` → `{type:'report'|'progress'|'error'}`.

Needed:

```
→ {type:'run', spec, upTo}          run to a stage, reusing the cache
→ {type:'preview', stage}           hillshade a cached stage without recomputing
→ {type:'stl', id} / {type:'zip'}   unchanged
← {type:'stage', stage, cached, elapsedMS}
← {type:'bed', stage, rgb, w, h}    a hillshade of an intermediate bed
← {type:'report', ...}              unchanged, only after 'tiles'
```

`shadeMap` (`lib/shade.js`) takes a *build result*, not a bed. The editor needs
to hillshade a bare world bed at stages 3a–3c, before tiles exist. Add
`shadeField(field, opts)` that shades a plain field, and have `shadeMap` call
it after assembling tiles into one grid. Small, and it removes the only reason
the editor would need a full build to show anything.

## Order of work

1. `shadeField`, so an intermediate bed can be drawn at all. Smallest useful piece.
2. Split `buildWorld` into `uplift` / `ice` / `weather`. No behaviour change; the existing tests must still pass unchanged.
3. `lib/pipeline.js`: stages, `stageInputs`, hashing, cache, `run`.
4. Re-express `buildMap` on top of it. **The 133 tests passing is the acceptance criterion** — this stage is a refactor and should be invisible.
5. Worker protocol, then the stage buttons in the UI.

## Open questions

- **Hashing.** `stageInputs` must enumerate what each stage reads, by hand, and
  a field left out of the list is a stale-cache bug that will be maddening to
  find. Alternative: hash the whole spec for every stage and accept that any
  edit busts everything (correct, loses the benefit). A middle path is a dev
  assertion that re-running a "cached" stage would have produced the same bytes.
  **Decide before writing the hash.**
- Does `worldGrid` 64 predict 128 well enough to use as a preview? Measure.
- Should the cache survive a page reload (IndexedDB)? A 128² bed is ~130 kB as
  Float32 — cheap to keep. Tile meshes are not.
