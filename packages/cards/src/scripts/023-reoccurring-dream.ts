// #23 Reoccurring Dream (SPEC §8.2, R60, R68, §5.1).
//
// Base: "30% chance a random card in your hand becomes Radiant. End of turn: returns from the GY to
// your hand". Radiant restates the roll only — "Lucky 1 (two rolls, keep the success) at 40%" — so
// the return-from-the-graveyard clause is kept (§8 Conventions).
//
// The pick is `setRadiantRandom`, which is R60's random pick: it draws from the non-Radiant cards of
// the zone and does nothing when none are left. The spell itself is in `resolving` while its script
// runs (§10.5), so it can never pick itself.
//
// Both rolls go through the seeded `ctx.rng` (CLAUDE.md rule 4), the base one roll at 0.3 and the
// radiant `lucky(1, …)` — two rolls at 0.4, keeping a success, which is §6.1's Lucky X read on a
// yes/no roll. No effect verb gates on a probability, so the hook does the roll and returns either
// the effect or nothing; see the report for the `chanceOf` verb this wants. With an empty hand the
// effect has nothing to do, so it rolls nothing (R129, R60). A hand that is all Radiant is rolled
// like any other: whether the hand holds a base-face card is the hand's (§9.1), so neither the roll
// nor the cue may hang on it — a success over it cues the pick it could not make on a Radiant card
// (R177's `cueUnpicked`), and the hand's size, which decides the roll, is public (R177).
//
// §5.1: "Spells with 'End of turn: add this back to your hand' are flagged
// `returnToHandAtEndOfTurn` when played and return from the graveyard at the end of that turn, as
// graveyard triggers (R68)". No effect verb sets that flag yet (reported), so the hook gates on the
// flag OR this turn's play log, which is the same set of cards for a spell played normally: a copy
// that reached the graveyard by being discarded or milled is not in the log and stays there.

import type { Effect, EffectContext, Script } from "@jackioh/engine";
import { wasPlayedThisTurn, zoneCards } from "@jackioh/engine";
import { bounce, setRadiantRandom } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-023");

const BASE_CHANCE = 0.3;
const RADIANT_CHANCE = 0.4;

/** R60: one random non-Radiant card in the caster's hand becomes Radiant. */
function makeOneRadiant(): Effect[] {
  return [setRadiantRandom({ zones: "hand", count: 1 })];
}

/**
 * R129: the roll is taken only when the pick has a hand to look in. The hand's size is public; which
 * of its cards are Radiant is not (§9.1), so an all-Radiant hand is rolled too and its success is
 * cued on a Radiant card (R177).
 */
function anyToMakeRadiant(ctx: EffectContext): boolean {
  return zoneCards(ctx.state, ctx.controller, "hand").length > 0;
}

/**
 * §5.1 and R68: at the end of the turn it was played on, the spell goes from the graveyard back to
 * its owner's hand, and a full hand burns it (§2.4, R4) — both of which `bounce` does.
 */
function returnsToHand(ctx: EffectContext): boolean {
  const self = ctx.self;
  if (self === null) return false;
  if (self.returnToHandAtEndOfTurn === true) return true;
  return wasPlayedThisTurn(ctx.state, self.controller, self);
}

const endOfTurn: Script["endOfTurn"] = (ctx) =>
  returnsToHand(ctx) ? [bounce({ target: { of: "self" } })] : [];

export const base: Script = {
  cry: (ctx) => (anyToMakeRadiant(ctx) && ctx.rng.chance(BASE_CHANCE) ? makeOneRadiant() : []),
  endOfTurn,
};

export const radiant: Script = {
  // Lucky 1: roll twice and keep the success (§6.1), each roll at 40%.
  cry: (ctx) => {
    if (!anyToMakeRadiant(ctx)) return [];
    const hit = ctx.rng.lucky(
      1,
      () => ctx.rng.chance(RADIANT_CHANCE),
      (a, b) => a || b,
    );
    return hit ? makeOneRadiant() : [];
  },
  endOfTurn,
};
