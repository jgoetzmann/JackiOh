// #36 Magic Jammed (SPEC §8.2): "Destroy target backrow card; Lock its zone", radiant "Steal
// target backrow card; Lock its original zone". The radiant cell restates BOTH base clauses, so it
// replaces both and nothing base-only survives (§8 Conventions).
//
// The target is a DECLARED play-time choice, so it travels in the `play` action and never pauses
// resolution (R81); `legalActions` builds the picker from the declaration below without running
// this script. §8's Conventions paragraph says "target" means "from all legal units and heroes on
// either side unless narrowed", and neither cell narrows it, so an ALLY backrow card is a legal
// pick (unlike #49, which prints "target enemy permanent"). Stealing your own card does nothing
// (`steal` refuses a card you already control, R76) while the Lock still lands, which is the
// literal reading of the cell.
//
// EFFECT ORDER is load-bearing. `lock({ zone: { of: "chosen" } })` resolves the zone from where the
// chosen card sits right now (see the `ZoneSpec` comment in `effects/counters.ts`), and `steal`
// MOVES the card to the thief's side (R15: same lane if free, else the first free zone, else it
// stays put). So the lock runs FIRST, and the zone it locks is the original one — the opponent's.
// `destroy` only marks the card for the next state check (§4.5), so it never moves it and the base
// order is not load-bearing; it is written the same way so the two faces read alike.
//
// Nothing else is this card's business:
//   - R15's placement is inside `steal`.
//   - §3.2's "the zone accepts no summons for the rest of the game" is inside `lock`/`isOpen`, so
//     "locked zone rejects play" is the engine's refusal, not a clause here.
//   - R33 ("only the current controller sees a face-down trap's identity") is decided by `viewFor`
//     from `controller`, and `effects/steal.ts` deliberately leaves `faceUp` untouched, so a stolen
//     face-down trap needs no line here: moving `controller` IS the visibility change.

import type { TargetDecl } from "@jackioh/shared";
import type { Script } from "@jackioh/engine";
import { destroy, lock, steal } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-036");

/** R81: one backrow card, picked with the play. Unnarrowed, so either side (§8 Conventions). */
const backrowTarget: TargetDecl[] = [
  { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["backrow"] } },
];

export const base: Script = {
  targets: backrowTarget,
  // Lock before Destroy: §6.3 Destroy only marks, but the two faces stay in one order.
  cry: () => [lock({ zone: { of: "chosen" } }), destroy({ target: { of: "chosen" } })],
};

export const radiant: Script = {
  targets: backrowTarget,
  // Lock strictly before Steal, so "its original zone" is the zone the card is still sitting in.
  cry: () => [lock({ zone: { of: "chosen" } }), steal({ target: { of: "chosen" } })],
};
