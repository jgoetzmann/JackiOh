// Lose health: not damage, so no Armor, no hero cap and no on-damage effects (R18).

import { loseHealth as loseHeroHealth } from "../damage";
import type { Effect } from "../script";
import { playerOf, type PlayerSpec } from "./targets";

export function loseHealth(args: { player: PlayerSpec; amount: number }): Effect {
  return {
    kind: "loseHealth",
    apply(ctx): void {
      loseHeroHealth(ctx, playerOf(ctx, args.player), args.amount);
    },
  };
}
