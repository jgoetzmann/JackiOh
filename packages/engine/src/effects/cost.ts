// Cost changes on one card instance: the two inputs R65 reads before any player discount. Both
// persist in every zone (R78), so a card discounted in hand is still discounted from the graveyard.
// The order the two combine is `effectiveCost`'s (§6.3 Cost, R65); nothing here recomputes it.

import { effectiveCost } from "../mana";
import type { Effect, EffectContext } from "../script";
import type { CardInstance } from "../state";
import { resolveTarget, type TargetSpec } from "./targets";

/** A cost change names a card instance in any zone, so a hero selection is not one of them. */
function cardOf(ctx: EffectContext, spec: TargetSpec): CardInstance | null {
  const target = resolveTarget(ctx, spec);
  return target === null || target.kind !== "unit" ? null : target.instance;
}

/** R65: the event reports what the card costs now, which is `effectiveCost` and nothing else. */
function emitCost(ctx: EffectContext, card: CardInstance): void {
  ctx.events.push({ type: "costChanged", instanceId: card.id, cost: effectiveCost(ctx.state, card) });
}

/**
 * Add to this instance's `costMod` (#7 Jewelosco Scarab's −1, #31 KY's Math Equation's +1 per
 * return, #37r Gravedigger). The change is permanent and travels with the card between zones (R78).
 */
export function setCostMod(args: { target?: TargetSpec; amount: number }): Effect {
  return {
    kind: "setCostMod",
    apply(ctx): void {
      const card = cardOf(ctx, args.target ?? { of: "self" });
      if (card === null) return;
      const amount = Math.trunc(args.amount);
      if (amount === 0) return;
      card.costMod += amount;
      emitCost(ctx, card);
    },
  };
}

/**
 * Set this instance's `costOverride`: #54 Straaza's "they cost 1", #41r Sheepish's 0-cost Lava
 * Golem, Craft a Card's 0 (R77). R65 starts the calculation from the override in place of the
 * printed cost, then still adds `costMod` and the player's discounts.
 */
export function setCostOverride(args: { target?: TargetSpec; cost: number }): Effect {
  return {
    kind: "setCostOverride",
    apply(ctx): void {
      const card = cardOf(ctx, args.target ?? { of: "self" });
      if (card === null) return;
      card.costOverride = Math.max(0, Math.trunc(args.cost));
      emitCost(ctx, card);
    },
  };
}
