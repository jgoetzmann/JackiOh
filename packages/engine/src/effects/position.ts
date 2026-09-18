// Switch position as an effect: 5pek Controller and friends spend no exertion (R20).

import { switchPosition } from "../combat";
import type { Effect } from "../script";
import { activeUnitsOf } from "../zones";
import { playerOf, type PlayerSpec, resolveTarget, type TargetSpec } from "./targets";

export function switchPositionOf(args: { to?: "ATK" | "DEF"; target: TargetSpec }): Effect {
  return {
    kind: "switchPosition",
    apply(ctx): void {
      const target = resolveTarget(ctx, args.target);
      if (target === null || target.kind !== "unit") return;
      switchPosition(ctx, target.instance, { spendExertion: false, ...(args.to === undefined ? {} : { to: args.to }) });
    },
  };
}

/** #48: switch every unit, or only one side's, spending no exertion (R20). */
export function switchAllPositions(args: { side: PlayerSpec | "both" } = { side: "both" }): Effect {
  return {
    kind: "switchAllPositions",
    apply(ctx): void {
      const players =
        args.side === "both"
          ? ([playerOf(ctx, "self"), playerOf(ctx, "enemy")] as const)
          : ([playerOf(ctx, args.side)] as const);
      for (const player of players) {
        for (const unit of activeUnitsOf(ctx.state, player)) {
          switchPosition(ctx, unit, { spendExertion: false });
        }
      }
    },
  };
}
