// #86 "Miss" Mrow (SPEC §8.5, R11, R12, R13, R15, R59, R78).
//
// Base: "Can't attack. Death: steal all enemy units". Radiant: "Can attack; same".
//
// The radiant cell names no effect of its own beyond "same", and §8's Conventions make "same" the
// explicit "the base clause is kept": so both faces run one Death clause and differ only in the
// printed face. That difference is entirely the catalog's:
//
//   - the base face prints the keyword `Can't attack`, which `combat.ts`'s `whyAttackRefused`
//     reads off `unitView(...).keywords` ("that unit cannot attack"), and
//   - the radiant face prints `keywords: []`, so "Can attack" is simply the absence of that
//     keyword — a radiant cell that lists keywords without "Plus" gives the radiant form's
//     COMPLETE keyword list (§8 Conventions).
//
// So neither face needs a line of script for the attack clause, and a script that tried would be
// wrong: the printed keyword is a §10.4 layer-1 value the attack validator already reads. The test
// proves both halves off the catalog and off `keywordsOf`, so a catalog edit that dropped the
// keyword would fail there rather than silently making the base face able to attack.
//
// The Death clause is one effect. `stealAll` (engine/src/effects/steal.ts) walks
// `slotsOf(opponent, "units")`, which is lane order (§3.2), and places each card with R15's rule —
// the same lane on the thief's side when it is free, else that row's first free zone — so a card
// that finds no free zone simply stays with its owner ("excess stay put", §8's Engine cell). Only
// the top of a Stack pile is on the field, so a dormant card under one is not taken (R13).
//
// Control, not ownership: a stolen unit keeps its owner and still goes to that owner's graveyard,
// hand, library or exile when it later leaves the field (R12), and because it never leaves the
// field it keeps its damage, buffs, counters and position (R78). A stolen face-down trap would
// stay face-down (R33) — but this card names the unit row only, so the enemy backrow is untouched.
//
// Mrow's own death is what runs this, so its lane is already empty when the steal looks for a free
// zone: the Death hook runs at §4.5 step 3, after step 1 moved the dying units, and it reads the
// pre-death snapshot (R78, R89), so `ctx.controller` is the side Mrow was on when it died — a
// stolen Mrow steals for whoever controlled it.

import type { Effect, Hook, Script } from "@jackioh/engine";
import { stealAll } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-086");

/** "Death: steal all enemy units" — identical on both faces ("same", §8 Conventions). */
const death: Hook = (): Effect[] => [stealAll({ row: "units" })];

export const base: Script = { death };

export const radiant: Script = { death };
