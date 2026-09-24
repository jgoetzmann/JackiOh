// Mana effects: temporary mana now, and a change to a player's next refresh (§2.3).

import { NEXT_REFRESH_MODIFIER_ID, gainMana as addMana, manaEvent } from "../mana";
import type { Effect } from "../script";
import { playerOf, type PlayerSpec } from "./targets";

/** Temporary mana, which may take current above max (§2.3). */
export function gainMana(args: { amount: number; player?: PlayerSpec }): Effect {
  return {
    kind: "gainMana",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      const side = ctx.state.players[player];
      addMana(side, args.amount);
      ctx.events.push(manaEvent(player, side));
    },
  };
}

/**
 * Hinder and Efficiency Dividend: change a player's next refresh, which floors at 0 (§2.3).
 *
 * §6.3 Mana stores "next turn" mana as a modifier for the next refresh, so the rider is one of the
 * player's badges (R169): the view lists it under `NEXT_REFRESH_MODIFIER_ID` while it is not 0, and
 * `modifierChanged` names that id as it appears or changes, and as it goes — here, when a second
 * rider cancels the first, or at the refresh that spends it (`turn.startTurn`). A change of 0 (#24
 * with X of 1 or less) changes nothing, and announces nothing.
 */
export function nextTurnMana(args: { amount: number; player?: PlayerSpec }): Effect {
  return {
    kind: "nextTurnMana",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      const side = ctx.state.players[player];
      const before = side.mana.nextTurnMod;
      side.mana.nextTurnMod += args.amount;
      if (side.mana.nextTurnMod === before) return;
      ctx.events.push({
        type: "modifierChanged",
        player,
        modifierId: NEXT_REFRESH_MODIFIER_ID,
        added: side.mana.nextTurnMod !== 0,
      });
    },
  };
}
