// Heal (§6.3): a unit loses damage, never past its max health; a hero simply gains health, with no
// cap (§3). R19 lets a heal name any unit or hero. The `healed` event comes from damage.ts.

import { healHero, healHeroUpTo, healToFull, healUnit } from "../damage";
import { unitView } from "../layers";
import type { Effect } from "../script";
import { resolveTarget, type TargetSpec } from "./targets";

export type HealArgs =
  /** "Heal X": up to X damage off a unit, or X health onto a hero with no cap (#5, #47, R19). */
  | { target: TargetSpec; amount: number }
  /** "Heal to full": all of a unit's damage (#19 Midrange Menace). */
  | { target: TargetSpec; toFull: true }
  /** "Heal up to N": raise health to at least N, still bounded by a unit's max health (§6.3). */
  | { target: TargetSpec; upTo: number };

export function heal(args: HealArgs): Effect {
  return {
    kind: "heal",
    apply(ctx): void {
      const target = resolveTarget(ctx, args.target);
      if (target === null) return;

      if ("amount" in args) {
        if (target.kind === "hero") healHero(ctx, target.player, args.amount);
        else healUnit(ctx, target.instance, args.amount);
        return;
      }

      if ("toFull" in args) {
        // §3 gives a hero no maximum health, so a hero has no "full" to be healed to; no Core card
        // asks for one. The hero form of this reading is `upTo` (§6.3's "Heal up to 30").
        if (target.kind === "unit") healToFull(ctx, target.instance);
        return;
      }

      if (target.kind === "hero") {
        healHeroUpTo(ctx, target.player, args.upTo);
        return;
      }
      // A unit reaches N only if its own damage is in the way; healing never raises max health.
      healUnit(ctx, target.instance, args.upTo - unitView(ctx.state, target.instance).health);
    },
  };
}
