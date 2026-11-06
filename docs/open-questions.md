# Open questions on the one-module refactor, answered

The six questions written after the one-module refactor (commit `eabf53a`)
have been answered by the owner. This page keeps each question, the answer,
and what was built on `claude/terrain-tile-specs-j665ce` as a result.

## 1. What does "compatible" mean?

**Answer.** Channels enter and leave only through the middle of a side, but
they may enter or leave through any side and take any route across the
module. Mountains may run right up to an edge and stop in a steep cliff, or
slope down to it. Each edge is a CLASS the author picks: 10, 20, 30 mm and so
on. The ground may go below the lowest edge it has, for lakes or low ground,
but it has to come back up to the edges.

**Built.**
- Every side has its own class (`contract.edges`, in rim millimetres: class
  plus the 2 mm base). A side mates flush with any side of its class. The
  ladder runs 10 to 190, so a side that is all mountain can stand as high as
  the print.
- Where two sides of different classes meet, the step is fanned in from the
  corner (`conformToContract` in `lib/tile.js`).
- Each side also has a blend (`contract.blends`): a few millimetres stands
  the ground up to the rim as a cliff, a long blend slopes it down.
- The ground is squeezed only against the LOWEST rim, so a lake or a low
  floor may sit below every edge but never near the base.

## 2. Channel depth: below the ground, or below the rim?

**Answer.** 10 mm deep, unless it crosses a line of higher terrain. Then it
is a gorge.

**Built.** The floor follows the smoothed ground 10 mm down, but never rises
(`profileChannels` in `lib/channel.js`). Through high ground it cuts a gorge
as deep as the rise is high, and the report says how much deeper than drawn.
If the line has already gone below the exit port's floor, the water stands
behind the port, and the report says how deep.

Water comes in at 12, 22, 32, 42 or 52 mm and leaves at 2, 12, 22, 32 or 42
mm: a port's floor is its side's rim less the channel depth. A channel that
comes in lower than it goes out is warned about before anything grows.

Every port's bed has a groove across it at the seam, 3 mm wide and 1 mm
deep, for a bead of silicone. Two beads press together when the modules are
locked.

## 3. Lakes where the ice dug deep

**Answer.** Large lakes are fine. The owner wants to click a lake, see its
size, and change it: 40 mm wide instead of 150, 30 mm long instead of 100.

**Built.** Every lake the build makes is measured along its long axis
(`lakeShape` in `lib/lake.js`). In the editor a lake is clicked in 3D or on
the flat view, and the inspector shows its length, width, bearing, area,
depth and epoxy. A tarn the ice dug gets Length and Width fields, a Fill it
in button and a Back to as dug button. These write `lakes.resize` entries,
found again by position when the module regrows. A resized tarn keeps its
own outline, scaled. Ground it gives up becomes a flat just above the
water, and low ground at its new edge is raised to hold the water in.

## 4. The example

**Answer.** No feedback yet. The example is unchanged.

## 5. Old specs

**Answer.** Refusing them is fine; no maps need carrying over.

## 6. Print height

**Answer.** Up to 200 mm high should be possible. The 62 mm default is fine.

**Built.** Nothing caps the height. Mountains are whatever `spineHeightMM`
says, and a side can be any class up to 190.

---

## Also asked for in the same message

- **Spacer plates**, 200 x 200 mm, offered in 10, 20, 30, 40 and 50 mm
  (`lib/plate.js`; `mmb plate --height 10,20`, and in the editor's Print
  stage). They are not part of a module: they are there to print when
  wanted. Each is an open-bottom shell, 61% hollow, with a 2 mm skin, ribs
  on a 40 mm grid and 72 tube holes on a 20 mm grid. It has the same cam
  lock on its sides as a module, and a socket in each corner of both faces
  with a loose pin to stack on.
- **A twist lock that holds modules tightly together** (`lib/joint.js`,
  `lib/cam.js`). Each side has a cam housing and a key pocket either side of
  the port. The key is flat, with a round head. Its pad sits in the
  underside of one module and its head goes into the other module's cam. A
  quarter turn with a coin draws the head 1.5 mm and pulls the faces
  together, with 0.2 mm of preload. The cam is printed as tall as its rim.

## Still open

- The plate's tube holes keep clear of the locks and sockets, so 28 of the
  100 grid positions have no hole. A tube that has to come up at one of
  those spots needs a hole drilled by hand.
- The cam lock has not been printed. The clearances (0.3 mm slip, 0.2 mm
  preload, 1.5 mm draw) are a first guess for a 0.4 mm nozzle and want a test
  print of `key-one.stl` and `cam-one.stl` in a scrap of module.
- Assembly order: keys lie on the table and the modules are lowered over
  them, then the cams go in. To lift one module out of a locked set, lift its
  cams and the neighbours' cams on its sides first.
