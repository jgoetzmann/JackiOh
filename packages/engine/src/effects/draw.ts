// Draw: takes the top card, with cast-on-draw, fatigue, the hand cap and R58's chain cap (§2.4).

import { draw as drawCards } from "../draw";
import type { Effect } from "../script";
import { playerOf, type PlayerSpec } from "./targets";

export function draw(args: { count: number; player?: PlayerSpec }): Effect {
  return {
    kind: "draw",
    apply(ctx): void {
      drawCards(ctx, playerOf(ctx, args.player ?? "self"), args.count);
    },
  };
}
