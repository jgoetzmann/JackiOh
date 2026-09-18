// Mana effects: temporary mana now, and a change to a player's next refresh (§2.3).

import { gainMana as addMana, manaEvent } from "../mana";
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

/** Hinder and Efficiency Dividend: change a player's next refresh, which floors at 0 (§2.3). */
export function nextTurnMana(args: { amount: number; player?: PlayerSpec }): Effect {
  return {
    kind: "nextTurnMana",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      const side = ctx.state.players[player];
      side.mana.nextTurnMod += args.amount;
      ctx.events.push({
        type: "modifierChanged",
        player,
        modifierId: `nextTurnMana:${args.amount}`,
        added: true,
      });
    },
  };
}
