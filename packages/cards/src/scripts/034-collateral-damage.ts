// #34 Collateral Damage (SPEC §8.2 row 34): "Exile target permanent and a random card from the
// opponent's library", radiant "Also the permanents adjacent to the target in its row".
//
// "Also …" adds a clause and keeps every base clause (§8 Conventions), so the radiant form exiles
// the target, its two neighbours and a library card.
//
// Exile bypasses Indestructible and bumps the game exile counter, and neither is this file's work:
// `exile` (effects/move.ts) calls `moveToZone`, which never asks about keywords, and increments
// `state.counters.exiled` for R55. A unit token ceases to exist instead of entering the pile (R11).
//
// R81: "target permanent" is a unit or a backrow card on either side, declared here and carried in
// the `play` action; resolution never pauses.
//
// §3.1: adjacent is lane N−1 and N+1 on the SAME side and the SAME row, and it does not wrap.
// `zones.adjacent` is the single implementation of that and the verb below must use it.
//
// ORDER MATTERS, unlike #16 Hit Job's. Destroy only marks a card, so Hit Job can destroy the target
// before its neighbours; Exile moves the card at once, so once the target has left the field its
// zone is gone and `slotOf` can no longer find the neighbours. The neighbours are therefore exiled
// FIRST, while the target still stands in its lane.
//
// TWO MISSING VERBS (reported; both are already imported by sibling cards in this wave, so one
// implementation of each serves several cards):
//
//   exileRandomFromLibrary({ count, player? })    — #42 Eugenics imports the same verb
//       `count` different cards drawn uniformly from `player`'s library through `ctx.rng`, or the
//       whole library when it holds fewer, each going through the §6.3 Exile verb so the exile
//       counter moves (R55) and a unit-token card ceases to exist instead (R11). An empty library
//       costs nothing. `TargetSpec` has no library-card form — it is self / selfHero / enemyHero /
//       chosen — so no composition of the current barrel can name a card in a library.
//
//   exileAdjacentTo({ target: TargetSpec })       — mirrors #16 Hit Job's `destroyAdjacentTo`
//       Resolves `target` to a card on the field, reads its zone with `slotOf`, and exiles every
//       card `zones.adjacent(ref)` reports: lane N−1 and N+1 on the TARGET's own side and row,
//       never across sides and never wrapping. Silently does nothing when the target is not on the
//       field or has no occupied neighbour. A backrow target takes its backrow neighbours, since
//       §8's clause says "in its row".

import type { Script } from "@jackioh/engine";
import { exile, exileAdjacentTo, exileRandomFromLibrary } from "@jackioh/engine/effects";
import type { TargetDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-034");

/** R81: "target permanent" — a unit or a backrow card, either side (§8 Conventions, §5.1). */
const targets: TargetDecl[] = [
  { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit", "backrow"] } },
];

export const base: Script = {
  targets,
  cry: () => [
    exile({ target: { of: "chosen" } }),
    exileRandomFromLibrary({ count: 1, player: "enemy" }),
  ],
};

export const radiant: Script = {
  targets,
  cry: () => [
    // First, while the target is still in its lane for `adjacent` to read (see the header).
    exileAdjacentTo({ target: { of: "chosen" } }),
    exile({ target: { of: "chosen" } }),
    exileRandomFromLibrary({ count: 1, player: "enemy" }),
  ],
};
