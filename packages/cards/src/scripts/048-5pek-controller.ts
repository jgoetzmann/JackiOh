// #48 5pek Controller (SPEC §8.2): "Switch the position of every unit", radiant "Choose: all enemy
// units, or all units".
//
// The radiant cell restates the whole clause (§8 Conventions), so it replaces the base one: the
// radiant face switches one side or both, whichever the play named, and "all units" is the base
// behaviour offered as one of the two options.
//
// R81 lists #48: the radiant choice is a DECLARED mode, so it travels in the play action's `modes`
// and never pauses resolution — no `chooseMode`, no `PendingChoice`, and `chosenOptions(ctx)` reads
// it back out of the context. The base face declares nothing, because it has nothing to ask.
//
// R20 is the §8.2 Engine cell: a position switch from a spell spends no exertion. That is not this
// card's code either — `effects/position.ts` calls `combat.switchPosition` with
// `spendExertion: false`, so `exertion.switched` stays false on every unit the effect touches and a
// unit that has already attacked this turn still flips. §4.1's "one exertion per turn" is about the
// player's own switch action, which `reduce` handles.
//
// §4.1's other ruling belongs to the same helper: "Spikey Pillow cannot be switched to Defense",
// by an action or by an effect. `combat.switchPosition` refuses a switch to DEF when the unit's
// script sets `StaticFlags.neverDefense` (#65.1), so an Attack-Position Spikey Pillow is skipped
// and stays in Attack while everything around it flips, and a hypothetical one already in Defense
// would still be allowed back to Attack.
//
// Every unit on the field switches, in each side's lane order: `switchAllPositions` walks
// `activeUnitsOf`, so only the top card of a Stack pile is touched (R13) — a dormant card is not
// on the field.

import type { Script } from "@jackioh/engine";
import { chosenOptions, switchAllPositions } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-048");

/** §8.2's two radiant options, as the play action spells them (R81). */
const ENEMY = "enemy";
const ALL = "all";

export const base: Script = {
  cry: () => [switchAllPositions({ side: "both" })],
};

export const radiant: Script = {
  modes: [{ kind: "mode", options: [ENEMY, ALL] }],
  cry: (ctx) => {
    // R81: the mode arrived with the play, and R90 validated it against this declaration, so the
    // only way it is anything else is that no mode was carried. "All units" is what the card does
    // when it is not narrowed, so that is the reading an unnarrowed play gets.
    const mode = chosenOptions(ctx)[0];
    return [switchAllPositions({ side: mode === ENEMY ? "enemy" : "both" })];
  },
};
