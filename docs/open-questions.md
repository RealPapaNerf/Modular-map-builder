# Open questions on the one-module refactor

Written 6 November 2026, after the refactor on
`claude/modular-map-builder-refactor-ajx1r5` (commit `eabf53a`) was built
and pushed. Each of these is a judgment call made during that work that may
want changing. None is merged; all are cheap to adjust on the branch.

## 1. What does "compatible" mean?

As built: the rim is one fixed flat height (22 mm) on all four sides, and a
channel crosses a side only at its **middle**, in one standard port shape
(30 mm wide, 10 mm deep). So any module mates with any module. The cost: a
channel can only leave a module at the middle of an edge, and a mountain
has to come down to the rim height at the edge.

The alternative: let a channel exit anywhere along an edge, accepting that
only modules with matching exits would then line up.

Which is wanted?

## 2. Channel depth: below the ground, or below the rim?

As built: a channel is cut 10 mm below the ground along the line you draw,
with the ground smoothed along the line first. It follows the terrain, so a
line drawn over a rise climbs it; the report says where and by how much.

The alternative: a floor that never rises along its length, which digs a
gorge through any high ground on the line, and so is deeper than 10 mm
there.

Which did "10 mm deep" mean?

## 3. Lakes where the ice dug deep

As built: when a glacier overdeepens the valley below the level of the
port, the hollow fills with water, so the example module has a lake in the
middle. That is physics, but it can take a large share of a 200 mm module.

The alternative: hold the ice to digging less deep (the levers are
`erosionK` and `elaMM` in `lib/glacier.js`, and `maxIncisionM` as a rail),
so modules come out mostly dry ground.

Keep the lakes, or tune them down?

## 4. The example

As built: one module with a range across the middle, glaciers down each
flank, and one channel **routed** from under the crest out through the
south port (`lib/example.js`). The channel is routed rather than drawn so
it follows the valley whatever the seed; the inspector can turn it into a
drawn line.

Should the example show a hand-drawn channel instead, or a different kind
of module altogether, such as a valley floor with channels in and out on
two opposite sides?

## 5. Old specs

As built: a spec saved from the board version (several tiles, rivers
between them) is refused with a message in the CLI and the editor, because
there is no honest way to pick one of its nine tiles. The browser's saved
spec resets to the example.

Is that acceptable, or are there saved maps that need carrying over?

## 6. Print height

As built: the rim is 22 mm and the example's mountains are 60 mm, so the
example prints about 62 mm tall on a 200 mm footprint.

Is that the size wanted, or should the defaults (`edgeLandMM`,
`spineHeightMM`) be lower?

---

Also noted in the README's status section, not a question: deep glacial
troughs becoming lakes behind the port is the next thing to tune, and the
levers are the ice's `erosionK` and `elaMM`.
