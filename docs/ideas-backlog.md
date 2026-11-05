# Ideas, tabled

Things worth building that are deliberately NOT being built yet. Each one
says enough to pick up cold, and why it is parked.

---

## Underground streams, and a cave through a mountain

**Tabled 2026-11-04. Not started.**

A stream that goes *into* a mountain, winds through it, and comes out the
other side. The point is the play, not the geology: a kid drops a boat in at
one end and it reappears at the other.

Why it is worth it: it is the first feature where the water does something
the child cannot see, which is the whole appeal — the boat is gone, and then
it is back. Everything the builder makes today is surface.

Why it is parked: it needs rock over water, which is the one thing the
printed format has never had to do. A tile is currently a height field —
one height per point — and a height field cannot express a roof. A cave
needs either a second surface (a floor and a ceiling, which the mesher would
have to close into a tube), or the channel modelled as a solid that is
subtracted from the block. The buffer chambers under a lid in the README's
"not built yet" list are the same problem, so whichever way this is solved
solves both.

Depends on: the single-tile model (the drop living in the rock), because an
underground reach is a fall carved through rock and nothing else.

Two things to get right when it is built:

- **It has to drain.** A tube that traps water is a tube that grows mould and
  cannot be rinsed. The bore wants a continuous fall from inlet to outlet and
  no low point.
- **A boat has to fit, and has to be retrievable.** The bore's cross-section
  is set by the biggest thing a child will push into it, not by the water.
  If it can jam, it will, so the roof probably wants to come off — which
  argues for the cave being a lid over a carved channel rather than a true
  bore, and that is also far easier to print without supports.
