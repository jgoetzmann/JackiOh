// #55 Lava Golem (SPEC §8.3, §6.3 Tribute/Sacrifice, §3.2, §6.1; R4, R11, R46, R65, R69, R81, R90).
// Unit 10/5 → 20/10, cost 3, Rare.
//   Base:    "Tribute 3, Armor 3, Taunt; may tribute enemy units"
//   Radiant: "Plus Indestructible" — §8 Conventions: "Plus X" adds X to the base keyword list, and
//            every base clause the cell does not restate is kept, so Tribute 3, Armor 3, Taunt and
//            "may tribute enemy units" all carry over unchanged.
//
// KEYWORDS ARE DATA, NOT SCRIPT. `def.base.keywords` is [Armor 3, Taunt] and
// `def.radiant.keywords` is [Armor 3, Taunt, Indestructible], read straight off the def by §10.4
// layer 1 (`faceOf` in engine/src/layers.ts). Granting any of them here would be a second source of
// truth — and a second Armor source would *sum* (§10.4: "Armor sums across sources"), turning a 3
// into a 6. So this file grants nothing. Where that behaviour lives:
//   Taunt          — §4.2 step 3: the enemy must attack a Taunt unit while one is in Attack
//                    Position; R46 suppresses it for the turn an Indestructible unit shrugs off a
//                    destroy (`tauntSuppressedTurn`).
//   Armor 3        — §4.4 step 2: 3 off every damage instance aimed at this unit, before Divine
//                    Shield and before the health subtraction.
//   Indestructible — §4.4 step 4 and §4.5 step 1 / R46: takes no damage and ignores a destroy mark.
//                    R69 still kills it when its max health falls to 0 or less (#46 Suppressive
//                    Aura), and §6.1 leaves Sacrifice and Exile able to remove it — which is
//                    exactly what a Tribute does, so a radiant Lava Golem is still legal Tribute
//                    fodder for another Lava Golem.
//
// THE COST IS THE SCRIPT. §6.3 calls Tribute "an additional cost of playing a card", so it lives in
// the play validator (`playChoices.ts`), and the units chosen travel in the `play` action's own
// `tributes` list rather than in `targets` (R81: "Zone, X, embiggen, Tribute … travel in the `play`
// action"). Reading that validator settles what this file must declare:
//   * `tributeCostOf(card)` reads a `tribute` TargetDecl's `amount` first and falls back to
//     `staticFlags.tribute`. Both spellings work, and this card uses the FLAG and declares no
//     `targets` — a `TargetDecl` would put the picks into the flat `targets` list that R90 splits
//     between declarations, i.e. in a second place, while the payment itself is still validated out
//     of `play.tributes` by `refuseTributes`. One cost, one place. (#66 The Rock reads the same.)
//   * `legalTributeUnits` + `mayTributeEnemyUnits` are "may tribute enemy units": the flag below is
//     the only thing in the game that turns the opponent's units into legal fodder, and §6.3 reads
//     every other Tribute as "sacrifice X of *your* units".
//   * `tributeValueOf` gives the Sheep Token 2 and every other unit 1 (§3.2, §6.3, #41 Sheepish),
//     so one Sheep plus one other unit pays this 3, and `isMinimalTribute` still accepts the pair
//     because dropping either one would leave the cost unpaid.
//   * `refuseTributes` refuses the play outright when the board cannot pay — BUILD M4-T4's "play
//     refused with too few units" — and the units are SACRIFICED, not destroyed (§6.3 Sacrifice):
//     immediate, bypassing Indestructible, counting as a death and firing the Death trigger.
//
// R65/§6.3: a Tribute is an *additional* cost, so a mana price of 0 does not touch it — #41
// Sheepish's radiant "add a Lava Golem costing 0 to your hand" is a `costOverride` of 0 on the mana
// term alone and that free copy still needs three units on the field.
//
// The two flags below are the whole script. `StaticFlags.tribute` carries the cost and
// `StaticFlags.tributeEnemies` the one permission no other Tribute card has (R101); `playChoices.ts`
// reads them through `tributeCostOf` and `mayTributeEnemyUnits`, counts both sides' units with the
// Sheep Token worth 2 (`tributeValueOf`), and `legalTributeSets` enumerates the minimal paying sets
// (R81, R90). Nothing here is a hook: a play cost has to be readable before the card resolves.

import type { Script, StaticFlags } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-055");

/** §8: "Tribute 3", counted with the Sheep Token worth 2 (§3.2). */
const TRIBUTE_COST = 3;

/**
 * The card's whole script: its Tribute cost, and the one permission that makes it unique — "may
 * tribute enemy units", which `playChoices.ts`'s `mayTributeEnemyUnits` reads by this name.
 */
const LAVA_GOLEM_FLAGS: StaticFlags = {
  tribute: TRIBUTE_COST,
  tributeEnemies: true,
};

export const base: Script = { staticFlags: LAVA_GOLEM_FLAGS };

/**
 * The radiant cell adds a printed keyword and restates nothing, so the cost clause is kept and the
 * two faces share one script object (§8 Conventions).
 */
export const radiant: Script = base;
