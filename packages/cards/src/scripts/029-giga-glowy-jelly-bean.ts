// #29 GIGA Glowy Jelly Bean (SPEC §8.2): "Every card in your hand becomes Radiant", radiant "Hand
// and all your permanents". The radiant cell restates the whole scope, so it replaces the base
// clause and adds the permanents to it (§8 Conventions: a clause the cell restates replaces the
// base version).
//
// "Every card", not "N random cards", so this is not `setRadiantRandom`: that verb would burn rng
// draws to reach a foregone conclusion and would shift the cursor for every later roll in the game
// (§9.3). The hook instead READS `ctx.state` to name the cards — which is not mutation — and
// returns one `setRadiant({ instanceId })` per card. `setRadiant` is a no-op on a card that is
// already Radiant (§6.3 Make Radiant), so the count of effects is the zone size, not the work.
//
// "All your permanents" is §6.3's permanents: your units and your backrow, Field Spells and face-
// down Traps included. `activeUnitsOf` gives the top of each unit pile and only the top, because
// cards under a Stack are not on the field (R13, §3.2). Control, not ownership, decides what is
// yours on the field (R12), and both engine accessors are keyed on the controller.
//
// A permanent converts in place (§5.2, R22): the base-stat layer swaps at once, damage taken and
// buffs stay, newly gained keywords apply immediately, and the Cry does not re-fire.
//
// Cost 6 is catalog data and is not this card's code. MAX_MANA is 4 (engine/src/config.ts), so the
// card is uncastable on a refresh alone and needs temporary mana from #6 Mana Well, #94 Genn's
// Greed or #95 Call to Chaos; §2.3 lets current mana exceed max, and the affordability check is
// `mana.canAfford` on the play.

import type { CardInstance, Effect, EffectContext, Script } from "@jackioh/engine";
import { activeUnitsOf, cardAt, slotsOf, zoneCards } from "@jackioh/engine";
import { setRadiant } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-029");

/**
 * Your hand, through the engine's read-only `zoneCards` (engine/src/query.ts), which hands back a
 * copy. The GIGA Glowy Jelly Bean itself sits in the `resolving` zone while its script runs
 * (§10.5), so it is not in this list and does not flag itself on the way to the graveyard.
 */
function handOf(ctx: EffectContext): readonly CardInstance[] {
  return zoneCards(ctx.state, ctx.controller, "hand");
}

/** Your permanents: units (top of each pile only, R13) then backrow, in lane order. */
function permanentsOf(ctx: EffectContext): CardInstance[] {
  const backrow = slotsOf(ctx.controller, "backrow").flatMap((ref) => {
    const card = cardAt(ctx.state, ref);
    return card === null ? [] : [card];
  });
  return [...activeUnitsOf(ctx.state, ctx.controller), ...backrow];
}

function makeRadiant(cards: readonly CardInstance[]): Effect[] {
  return cards.map((card) => setRadiant({ instanceId: card.id }));
}

export const base: Script = {
  cry: (ctx) => makeRadiant(handOf(ctx)),
};

export const radiant: Script = {
  cry: (ctx) => makeRadiant([...handOf(ctx), ...permanentsOf(ctx)]),
};
