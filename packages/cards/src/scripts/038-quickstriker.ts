// #38 Quickstriker (SPEC §8.2): Field Spell, "Your cards gain 'Combo X: deal X damage to the enemy
// hero', X = cards you played earlier this turn"; radiant "… deal 2X damage …" (R275, R281).
//
// ROUTE: §10.5 step 5 — "Resolve Combo checks, Quickstriker, /fullsend's Combo draw, then the card's
// own Cry or spell script". Quickstriker is one of the two Combo abilities another permanent grants
// everything its controller plays, so the play pipeline resolves it (`playSteps.quickstrikerCombo`)
// for every play and every cast (R70), before the played card's own text, reading this card's
// static flag off the field. X is `turnLog.cardsPlayed` before the card being played (§8.2's Engine
// cell), which the pipeline reads at that moment: 0 for the first play of a turn, 1 for the second.
//
// It used to be a trigger on `cardPlayed`, which read the count whenever the event was dispatched.
// A play dispatches at step 4, but a cast's events wait for the loop of the effect that cast it —
// §2.4's draw — so a chain of two cast-on-draw cards read the count after the chain and dealt 1 and
// 1 rather than 0 and 1. The flag also gives the card the property §8.2 asks for, "nothing when not
// on the field", for free: the pipeline reads permanents on the field and nothing else.
//
// "Your cards" is the controller's own plays (the pipeline reads the playing player's side), and
// R119 excludes the play that puts this Field Spell onto the field: the pipeline never counts the
// card being played as one of its own Quickstrikers.
//
// THE RADIANT FACE (R281). Both faces carry the same flag, one grant each; the multiple of X a
// grant deals is the granting card's face's, `QUICKSTRIKER_COMBO_MULTIPLE` in the engine's config
// (1, radiant 2), which the pipeline picks off the instance as #84's Armor is picked. 2X is ONE hit,
// so Armor and the Anti-oneshot cap apply to it once, and a base and a Radiant Quickstriker together
// deal X and then 2X.
//
// THE PREVIEW (R280). "X = cards you played earlier this turn {n}": the X the next card its
// controller plays would count, which is every play so far this turn (`cardsPlayedThisTurn`, the
// count `playedEarlier` gives a card still in hand, and the one the pipeline reads at step 5). It
// reads the controller's plays this turn, which are public, and the same X shows on both faces.

import type { Script } from "@jackioh/engine";
import { cardsPlayedThisTurn } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-038");

/** R280: the part of the text the value belongs to, on both faces. */
const X_LABEL = "X = cards you played earlier this turn";

const preview: Script["preview"] = (ctx) => [
  { label: X_LABEL, value: cardsPlayedThisTurn(ctx.state, ctx.controller) },
];

export const base: Script = { staticFlags: { quickstriker: true }, preview };

/**
 * R281: the same grant and the same X, so the same script; the Radiant face's 2X is the multiple the
 * engine reads off the instance's face (`QUICKSTRIKER_COMBO_MULTIPLE`), as it reads #84's Armor.
 */
export const radiant: Script = base;
