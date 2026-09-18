// #98 Heroic Power (SPEC §8.5, §6.2 "Start of Game"/"Once per Turn"/Quickdraw, R43, R45, R46, R18,
// R65). Field Spell, tags Quickdraw, cost X, Mythic.
//   Base:    "Indestructible. Start of game: gain one of 7 random powers, each 'Once per turn,
//             spend X': (3) Recruit a permanent; (1) lose 2 health, draw 1; (1) deal 1 damage to a
//             target; (1) deal 2 damage to each opposing hero; (2) summon a Rush Token;
//             (1) summon a Felinor Token; (2) Discover a Unit. Playing it costs the power's X and
//             activates it once"
//   Radiant: "Powers become: Recruit and make it Radiant; lose 2, draw 2; deal 2; 4 to each
//             opposing hero; two Rush Tokens; two Felinor Tokens; Discover a Radiant Unit" — the
//             cell restates the seven powers and nothing else, so Indestructible, the start-of-game
//             roll, the once-per-turn limit and "playing it costs X and activates it once" are all
//             kept (§8 Conventions).
//
// THE SEVEN POWERS LIVE IN `subsystems/heroPower.ts`, NOT HERE. R43 makes this card a subsystem:
// `HERO_POWERS` is the table with each power's X, its base clause and its radiant clause;
// `rollPower` is the roll, `usePower` one activation plus this turn's use, `powerCostOf` the cost,
// `heroPower` the continuation a prompted power (the ping's target, the Discover) comes back to, and
// `activatePower`/`whyCannotActivate` the §10.2 action. This file is the four lines that wire the
// card's `Script` to them, which is what keeps two Heroic Powers in one game independent: everything
// is on the instance (`memory.power`, `memory.usedTurn`), never in a module variable (R43, §10.1).
//
// COST (R43, R65). "Its cost is always the power's X, never chosen by the player." The catalog's
// printed cost is "X", and R65 would normally let the player choose it up to their current mana; the
// `cost` hook pre-empts that, because `mana.printedCost` reads `script.cost` ahead of the printed
// cost, so the play validator, `legalActions`, `effectiveCost` and the client all see the power's X
// with no special case. R65's "an X-cost card costs exactly X: `costMod` and discounts don't change
// it" is `effectiveCost`'s business, not this hook's.
//
// PLAYING IT (R43). "Playing it pays X and activates the power once, which is that turn's use;
// afterwards `activatePower` uses it once per turn for X." §6.2's Cry is the hook a card runs when
// it is played (§10.5 step 5), so the play's activation is the `cry` and `usePower` marks
// `memory.usedTurn` before the power's own effects run — a power that pauses on a prompt has
// already spent the turn's use and the answer cannot buy a second one.
//
// THE PROMPTED POWERS (§10.6). "Deal 1 damage to a target" and "Discover a Unit" pause, and
// `heroPower` is the step they resume at, so the card exposes it under the key the subsystem names
// (`POWER_RESUME`). R81 lets the `activatePower` action carry the ping's target instead, in which
// case nothing pauses at all.
//
// WHAT THIS FILE DELIBERATELY DOES NOT SAY:
//   * Indestructible is a printed keyword on both catalog faces, so it is a §10.4 layer, not a
//     script. R46: "an Indestructible Field Spell (Heroic Power) simply stays" — §4.5 step 1 drops
//     the destroy mark and the card keeps its zone, with no position or Taunt clause to apply
//     because it is not a unit.
//   * Quickdraw is `staticFlags.quickdraw`, which `setup.ts` step 2 reads to put the card in the
//     opening hand instead of a draw (§6.2). The catalog's Quickdraw *tag* is what a filter sees;
//     the flag is what setup sees.
//   * "each opposing hero" future-proofs multiplayer (R45): with two players it is the one enemy
//     hero, and `burnEffects` uses `{ of: "enemyHero" }`, so the iteration lives in the engine's
//     player map rather than in this card.
//   * "lose 2 health" is a loss and not damage (R18): no Armor, no Anti-oneshot cap, no on-damage
//     trigger. `drawEffects` uses `loseHealth`, which is that rule.
//
// R43'S LAST ROLL IS THE ENGINE'S, NOT THIS FILE'S (R151). "one created later rolls when it is
// created, and one that ends up in a hand or library with no `memory.power` (a bounced or reset
// instance, R78) rolls as it arrives". `startOfGame` covers the two copies R43 names at setup —
// `setup.finishSetup` runs it for every card in both hands and both libraries, a mulliganed one
// included, and `ensurePower` is idempotent so a re-run keeps the roll. R151 makes that hook a rule
// about a card's whereabouts rather than about a moment, so the engine now runs it on ARRIVAL too:
// `draw.ts`'s `runArrivalHooks` fires a card's `startOfGame` as it reaches a hand (a draw, a bounce,
// #72 Reminisce out of a graveyard, an effect that created it) or a library, which is every path
// §2.4 routes an arrival down. Nothing is added here for it: the roll this card already declares is
// the one that runs, and a rule written in this file would be a second source of truth for something
// `subsystems/heroPower.ts` owns.

import type { Script } from "@jackioh/engine";
import { subsystems } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-098");

/**
 * Both faces are the same wiring: `usePower` picks the base or radiant clause of whichever power
 * the instance rolled, and `radiant` is passed explicitly so the face that is running decides
 * (§5.2) rather than the instance being read a second time.
 */
function heroicPower(radiant: boolean): Script {
  return {
    // §6.2: starts in the opening hand instead of a draw (setup step 2).
    staticFlags: { quickdraw: true },
    // R43, R65: the cost is the power's X, and the player never chooses it.
    cost: ({ instance }) => subsystems.powerCostOf(instance),
    // R43: every copy in either hand or library rolls its power after the mulligan (§6.2).
    startOfGame: () => [subsystems.rollPower()],
    // R43: "Playing it pays X and activates the power once, which is that turn's use".
    cry: () => [subsystems.usePower({ radiant })],
    // §10.9's activated-ability hook. The §10.2 `activatePower` action runs the same effect itself
    // after `whyCannotActivate` has checked R43's once per turn, the mana and the phase, so only
    // one of the two paths ever runs for one activation.
    activate: () => [subsystems.usePower({ radiant })],
    // §10.6: where the ping's target prompt and the Discover come back to.
    resume: { [subsystems.POWER_RESUME]: subsystems.heroPower },
  };
}

export const base: Script = heroicPower(false);

export const radiant: Script = heroicPower(true);
