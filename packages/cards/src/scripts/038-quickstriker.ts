// #38 Quickstriker (SPEC §8.2): Field Spell, "Your cards gain 'Combo X: deal X damage to the enemy
// hero', X = cards you played earlier this turn". §8 prints NO radiant text for this card, so
// BUILD M4-T1 makes the radiant face equal to the base face; `radiant` below is the same object.
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

import type { Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-038");

export const base: Script = { staticFlags: { quickstriker: true } };

/** §8: no radiant text, so BUILD M4-T1 makes the radiant face the base face. */
export const radiant: Script = base;
