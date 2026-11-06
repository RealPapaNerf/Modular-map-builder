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
  together, with 0.2 mm of preload. Everything is in the underside: the
  cam sits in a blind bore 8.4 mm deep, every cam is 8.4 mm tall, and
  nothing shows on the top.

## Still open

- The plate's tube holes keep clear of the locks and sockets, so 28 of the
  100 grid positions have no hole. A tube that has to come up at one of
  those spots needs a hole drilled by hand.
- The cam lock has not been printed. The clearances (0.3 mm slip, 0.2 mm
  preload, 1.5 mm draw) are a first guess for a 0.4 mm nozzle and want a test
  print of `key-one.stl` and `cam-one.stl` in a scrap of module.
- Assembly order: lay the modules face down, butted together; drop a key
  into each seam and a cam into each bore over its head, coin slot up; turn
  each cam a quarter turn; turn the map over. To take one module out of a
  locked set, turn the map over and turn back its cams and the neighbours'
  cams on its sides first.
- The terrain is grown, not drawn, so a seed can still come out lumpy:
  rounded moraine hummocks on a plain are real, but the model makes them a
  little too regular, and a crest the ice planed near its snowline stays a
  flat summit plateau rather than towers. Cirques placed round a summit are
  the way to get a horn where you want one.
- A grow of the example takes about 75 s, most of it the ice. The ice's
  cost grows about seven-fold each time its grid is halved, which is why
  towers and gullies come from a fine pass after it instead.

## Answered 7 November 2026

The owner saw the first modules and asked for real U valleys, spires and
cirques they can place, for the cams to go in from the underside, and for a
ridge that runs to a side to meet it as a cliff. All built:

- **Rivers before the ice** (`lib/fluvial.js`), **jointed rock**
  (`lib/rock.js`), a **fine pass for towers and gullies**
  (`lib/detail.js`), **vertical exaggeration**, **cirques** you place and
  a lower snowline on the **shaded side**. See "How the ground is grown" in
  the README.
- **A bug fixed:** the step that slumps moraine to 33 degrees ran over the
  whole bed, so no glaciated module had a steeper slope than that.
- **The cams go in from the underside.** Lay the modules face down, drop
  the keys and cams in, turn, turn the map over. Nothing is cut into the
  top. The key's pad is now as thick as its pocket is deep, so it cannot
  drop out of line once the map is the right way up.
- **A ridge meets a side as a cliff** by default (`contract.autoCliff`);
  low ground still slopes up to the rim. A side given its own blend keeps
  it.
- **Springs are placed by hand** in the example, once the module has grown.

Asked at the same time, and built after:

- **Springs as a chamber under a screened lid**, as relief makes them: a
  room cut into the ground, a lift-out lid whose top is the ground, its
  screen opening twice the tube's bore and solid over the jet. A spring
  placed in a lake is the tube straight into the lake. The open pool is
  still there as `kind: "pool"`.
- **A gorge only where a channel crosses a ridge.** A line that rises over
  ground well above both of its ends is cut as a gorge; any other is a creek
  that follows the surface down the face. Each channel can be set to auto,
  creek or gorge.
