> **Status, November 2026.** Part 1, till transport and deposition, is built, and so is a melt-out at the end of the run: the ice now leaves the bed entirely before the module is cut. The board this document refers to is gone; the builder makes one module at a time.

# Spec: moraines, and telling the ice where to go

Status: **part 1 BUILT 2026-11-04** (till transport and deposition, in
`lib/glacier.js`); **part 2 still design** (iceMask, terminusLine). Written
2026-11-04.

What was built follows this document closely, with two departures worth
noting. The guard rail is on how much higher a point finishes than the bed
it started from, not on a separate standing-till field -- that field does
not survive mass wasting, which moves the bed without knowing about it.
And `tillYield` ships at 0.55 rather than the 0 this document recommends:
the staged landing was the right call for a change that had to be invisible,
but moraines were the point, so they are on.
Companions: [spec-pipeline.md](spec-pipeline.md), [spec-editor.md](spec-editor.md).

---

## Two separate gaps

The observation that started this: *"I don't think we have let the glaciers
push moraines up, they aren't producing lakes like I expected them to."*

That is correct, and `lib/glacier.js:38` already says so in its own header:

> WHAT IS LEFT OUT, deliberately: thermomechanics ...; isostasy ...;
> **sediment transport and deposition, so there are no moraines** — the
> troughs come out cleaner than real ones, and the fluvial pass afterwards
> puts some mess back.

Separately, every knob in `GLACIER_DEFAULTS` is a **global scalar**. Ice
appears wherever the bed rises above the ELA (`lib/glacier.js:363`) and flows
down the surface gradient. There is nowhere to say *this* glacier, *here*,
flowing *that* way, stopping *there*.

These are independent and can be built in either order. Moraines are the one
that fixes something visibly wrong; spatial control is the one the editor
needs.

---

## Part 1: till, transport, deposition

### Why it gets you lakes for free

`fillHollows` (`lib/lake.js:185`) is **not cirque-specific**. It calls
`depressionStats` and floods *any* closed depression above a minimum area and
depth. It already runs on every tile.

So a moraine ridge that closes a basin produces a lake through the path that
exists today. No new lake code. That is the whole argument for doing this: the
reason alpine maps look wrong without it is that most real alpine lakes are
moraine-dammed, and the model can currently only make the other kind — an
overdeepened rock basin, which needs the trough's long profile to close on its
own and often does not.

### The model

Keep it the same level of theory as the rest of the file: simple, defensible,
and honest in the comments about what is cut short.

**A till field `T[k]`, in metres of loose sediment**, carried alongside the bed
`b[k]`. Three operations per geomorphic cycle, all inside the existing cycle
loop (`lib/glacier.js:458`), after the erosion block:

**1. Entrainment.** Erosion already computes `cut` per cell
(`lib/glacier.js:517-520`). Today it vanishes into `b[k] -= cut`. Instead:

```
b[k]  -= cut
T[k]  += cut * tillYield        // tillYield ~ 0.6; the rest leaves as rock flour
```

`tillYield < 1` because a real glacier exports a great deal of its load as
suspended silt that ends up far downstream, not in a moraine.

**2. Transport.** Till moves with the ice, not with gravity. Upwind-advect `T`
along the ice velocity for `erodeYears`:

```
u = -D grad(s) / H          the depth-averaged velocity the flux already implies
T  <- T - dt * div(T * u)
```

The sliding field `slide[k]` (`lib/glacier.js:486`) and the face diffusivities
`Dx`/`Dy` are both already computed and in scope. Use the same CFL-limited
sub-stepping the ice uses; till advection is cheaper than the ice solve and
should not dominate.

**3. Deposition.** Till drops where the ice can no longer carry it. Two rules,
both needed:

- **At the snout.** Where `H` falls below a threshold or goes to zero, deposit
  everything arriving. This is the terminal moraine: a ridge across the valley
  at the ice limit.
- **At the margins.** Where the ice edge is roughly along-flow rather than
  across it, deposit along the flank. These are the lateral moraines, and they
  are what makes a trough read as glacial from above.

A simple capacity rule covers both: carrying capacity scales with sliding
speed, so `deposit = max(0, T - capacity(slide))`, with `capacity → 0` as the
ice thins. Then "snout" and "margin" are the same rule applied where the ice
is slow or thin, which is the right physics and less code than two cases.

### Recessional moraines come free

`elaAt(cycle)` (`lib/glacier.js:229`) already oscillates the snowline, and the
header explains why. Each advance has a different terminus. Once deposition
exists, **every stillstand leaves its own ridge** and a retreating sequence
leaves a staircase of them down the valley — which is exactly the landform the
user described wanting to draw. Nothing extra to implement; it falls out of
the oscillation that is already there.

### New options

```js
tillYield: 0.6,        // fraction of eroded rock that stays as transportable till
tillCapacityK: ...,    // carrying capacity per (m/yr) of sliding
tillDiffusion: ...,    // slumping of deposited till toward repose, per cycle
maxTillM: 60,          // guard rail, in the spirit of maxIncisionM
```

Deposited till should be subject to `massWaste` along with everything else, so
a moraine ridge sits at a plausible repose angle rather than a knife edge. It
already runs at the end of each cycle (`lib/glacier.js:533`, after the creep pass at `:527`) — the till just
needs to be added into `b` before it, or wasted separately and added after.
**Decide which**: adding before means the moraine can be eroded by later
advances, which is correct and is how recessional sequences get overridden by
a bigger readvance.

### Tests

`test/glacier.test.mjs` exists and is the model to follow.

- **Mass is conserved.** Total eroded ≈ total deposited + total exported, to a
  tolerance. This is the invariant that catches an advection bug, and it is
  worth writing first.
- A ridge appears **across** the valley at the terminus, and its crest is
  higher than the bed immediately up-valley and down-valley of it.
- A **closed basin** exists behind that ridge — assert via `depressionStats`,
  which is the same call `fillHollows` makes, so this is a direct test of
  "does this produce a lake".
- A retreating ELA schedule leaves **more than one** ridge.
- With `tillYield: 0` the output is **byte-identical to today's**. This is the
  regression that lets the change land without re-tuning every existing map.

That last one matters: the example map is tuned, `docs/preview.png` is
committed, and the README's numbers are quoted from real runs. Default
`tillYield` to 0 at first, land the machinery green, then turn it on in a
separate commit that re-tunes and re-shoots the preview.

---

## Part 2: spatial control

### Where the hooks go

**Place the glacier — `iceMask`.** Mass balance is one expression
(`lib/glacier.js:363`):

```js
mdot[k] = dz >= 0 ? Math.min(maxAccumM, accumGradient * dz)
                  : Math.max(-maxAblateM, ablateGradient * dz);
```

Gate the accumulation term by a mask in [0,1]:

```js
const acc = Math.min(o.maxAccumM, o.accumGradient * dz) * mask[k];
```

Ablation is **not** masked. Ice that flows out of the painted region must
still melt, or it runs forever. This is the right physics too: a mask is a
statement about where snow collects, not about where ice is allowed to exist —
and a glacier flowing beyond its accumulation area is exactly what a glacier
does.

Blur the mask a little on the way in, or the ice sheet has a visible seam
along the brush stroke.

**Where it stops — `terminusLine`.** A polyline past which ablation is forced
to maximum:

```js
if (beyondTerminus(k)) mdot[k] = -o.maxAblateM;
```

Pins the snout without breaking the solver, because it works through the mass
balance rather than by clamping `H`. Ice still *reaches* the line and still
deposits its load there — which, with Part 1 in place, is precisely how the
user gets a terminal moraine exactly where they drew it.

**Carve direction — `flowHint`.** The honest one. Flux is
`q = -D grad(s)`, so direction is **not a free parameter**: it is determined by
the ice surface, which is determined by the bed and the mass balance. Three
ways to influence it, in descending order of defensibility:

1. **Do nothing; let the mask do it.** Where the user paints accumulation
   decides where ice is thick, which decides the surface slope, which decides
   the flow. Most of the intent in "I think it should carve this way" is
   expressible as "the snow collects over here".
2. **Anisotropic diffusivity.** Scale `Dx`/`Dy` by a direction field so ice
   spreads more readily along the hinted axis. Physically it is a fudge, but
   a contained one — it biases a rate, it does not invent flux.
3. **Nudge the bed.** Lower a shallow trough along the drawn line before the
   ice runs. Guaranteed to work, and the most dishonest: the user is drawing
   the valley and then watching the ice "discover" it.

**Recommend trying (1) alone first** and only building (2) if real use shows
the mask is not enough. (3) should be a separate, clearly-labelled "guide
trough" tool if it happens at all, not a flow hint pretending to be physics.
The file's own header argues the glacier is simulated precisely because the
landform *is* the signature of the process; a flow hint that paints the answer
takes that back.

### Signature

```js
glaciate(bed, {
  ...,
  iceMask: null,        // Float32Array(N) in [0,1], or null for everywhere
  terminusLine: null,   // [[u,v], ...] in normalised world coords, or null
  flowHint: null,       // deferred — see above
})
```

Normalised `[u,v]` to match `spec.spine` and `spec.volcanoes[].at`, so the
editor's drawing surface maps to every spatial field the same way.

---

## Order of work

1. Till field, entrainment, deposition, **`tillYield` defaulting to 0**. Mass-conservation test. Lands green, changes nothing.
2. Turn it on. Re-tune the example, re-shoot `docs/preview.png`, update the README's quoted figures.
3. `iceMask`. Cheap, large payoff, unblocks the editor's main glacier tool.
4. `terminusLine`.
5. Revisit `flowHint` only if 3 and 4 in real use prove insufficient.

## Open questions

- Till under the ice changes the bed the ice slides on. Should sliding respond
  to till depth (deformable bed, faster sliding)? Real, and a rabbit hole.
  **Recommend: no, and say so in the header** alongside the other exclusions.
- Does `maxIncisionM` need a deposition counterpart beyond `maxTillM`?
- Does the fluvial pass need to know about till? A moraine is loose sediment
  and a river cuts it far faster than rock — which is how a moraine-dammed
  lake eventually drains. `makeStrata` (`lib/terrain.js:210`) already returns
  an erodibility multiplier and **nothing calls it**; a till layer and a
  stratigraphy layer want the same consumer. Worth noting that the unbuilt
  fluvial-incision pass now has two reasons to exist.
