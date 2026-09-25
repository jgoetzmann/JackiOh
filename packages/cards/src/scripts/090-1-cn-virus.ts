// #90.1 CN-Virus (SPEC §8.5, §7, §4.4, R57, R58, R70, R80).
//
// Base: "Cast on draw: take 1 damage; shuffle 2 copies of this into your library".
// Radiant: "Cast on draw: take 2 damage; shuffle 3 copies of this into your library" (§8's cell
// "Take 2 damage; 3 copies", R275: both numbers scale).
// Engine cell: "Damage goes through the pipeline; cast-on-draw chains, capped by R58; copies stop
// at the library cap (R80)."
//
// §7's token rules say the rest: "CN-Virus damage is a normal damage instance to your own hero
// (Armor and Anti-oneshot Armor apply). Its 'shuffle copies' makes an opponent's deck grow without
// bound; the cast-on-draw chain cap (R58) keeps each draw finite and the turn cap keeps the game
// finite." It is a SPELL token, so unlike a unit token it lives in a hand and a library like a real
// card and goes to the graveyard after it resolves (§7, R11).
//
// NOTHING HERE CASTS OR DRAWS. `staticFlags.castOnDraw` is the whole of "Cast on draw": `drawOne`
// (engine/src/draw.ts) reads the flag off the drawn card, casts it, and repeats the draw, stopping
// at `CAST_ON_DRAW_CHAIN_CAP` casts — after which the next such card goes to hand uncast and ends
// the chain (R58). `castCard` makes the cast free, counts it as a card played (R70) and sends the
// spell to the graveyard afterwards. The flag is on BOTH faces: R58's cap is a property of the
// draw, not of the card, and the radiant cell changes only the two numbers.
//
// "TAKE 1 DAMAGE" (radiant 2) IS DAMAGE, TO THE DRAWER'S OWN HERO. `{ of: "selfHero" }` resolves to
// `ctx.controller`, and a cast-on-draw card resolves with `controller === owner` (off the field
// control follows ownership, R12), so the player who drew it takes the hit — which is exactly why
// #90 hands the token to the OPPONENT. It is damage and not "lose health" (R18), so it runs the
// whole §4.4 pipeline: step 2 subtracts the hero's Armor, so Going Long (#84) reduces or removes
// it, and step 3 applies any Anti-oneshot Armor cap. A hit reduced to 0 emits nothing and triggers
// nothing (R63) — and the copies are still shuffled, because the two clauses are independent.
//
// THE COPIES ARE FRESH INSTANCES CARRYING THE RADIANT FLAG. `shuffleCopiesOfSelf` copies
// `ctx.self.radiant` onto each new instance, which is R57's rule for copies shuffled into a library
// and what makes a Radiant virus breed Radiant viruses: each drawn copy casts the radiant face, takes
// 2 and shuffles 3 more. They go to `playerOf(ctx, "self")`'s own library — "into YOUR library" — and
// `shuffleIntoLibrary` places each at a uniformly random position from the match rng, stopping at
// `LIBRARY_CAP` so a copy that would enter a full library is not created (R80).

import type { Effect, Script } from "@jackioh/engine";
import { damage, shuffleCopiesOfSelf } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-090-1");

/** "take 1 damage; shuffle 2 copies", radiant "take 2 damage; 3 copies". */
const BASE = { damage: 1, copies: 2 } as const;
const RADIANT = { damage: 2, copies: 3 } as const;

/** The two numbers are the whole of the radiant text. */
function virus(face: { damage: number; copies: number }): Script {
  return {
    staticFlags: { castOnDraw: true },
    cry: (): Effect[] => [
      damage({ to: { of: "selfHero" }, amount: face.damage }),
      shuffleCopiesOfSelf({ count: face.copies }),
    ],
  };
}

export const base: Script = virus(BASE);

export const radiant: Script = virus(RADIANT);
