// Cost changes on one card instance: the two inputs R65 reads before any player discount. Both
// persist in every zone (R78), so a card discounted in hand is still discounted from the graveyard.
// The order the two combine is `effectiveCost`'s (§6.3 Cost, R65); nothing here recomputes it.

import { PLAYER_IDS } from "@jackioh/shared";
import { effectiveCost } from "../mana";
import type { Effect, EffectContext } from "../script";
import type { CardInstance } from "../state";
import { resolveTarget, type TargetSpec } from "./targets";

/** A cost change names a card instance in any zone, so a hero selection is not one of them. */
function cardOf(ctx: EffectContext, spec: TargetSpec): CardInstance | null {
  const target = resolveTarget(ctx, spec);
  return target === null || target.kind !== "unit" ? null : target.instance;
}

/**
 * R4: a price a card is given as it returns to a hand — #31's "return to hand with cost +1", #37r's
 * and #72's "it costs 1 less", #72r's "it costs 0" — is the card's price in that hand. A full hand
 * burns the card instead (§2.4), and a burned card is an ordinary graveyard card that R78 would carry
 * the change into every later zone, so with `inHandOnly` the change lands only on a card that is in
 * a hand when it applies: written after the move, it is skipped for a card the move burned. The same
 * reading `addToHand`'s own riders and radiant #52's "costing 0" already have.
 */
function priced(card: CardInstance, inHandOnly: boolean | undefined): boolean {
  return inHandOnly !== true || card.zone.z === "hand";
}

/**
 * R65: the event reports what the card costs now, which is `effectiveCost` and nothing else.
 *
 * R177: a change made to a card in a library is one nobody could read where it happened (§3), and a
 * library-wide change (#95's "every card in your hand and library costs 2 less") emits one event per
 * card in library order — so the event says it was made there (`hiddenFrom`), and a view keeps it
 * unread for good, or the recruited card's event would give away its place in the batch once the
 * card reads openly.
 */
function emitCost(ctx: EffectContext, card: CardInstance): void {
  ctx.events.push({
    type: "costChanged",
    instanceId: card.id,
    cost: effectiveCost(ctx.state, card),
    ...(card.zone.z === "library" ? { hiddenFrom: [...PLAYER_IDS] } : {}),
  });
}

/**
 * Add to this instance's `costMod` (#7 Jewelosco Scarab's −1, #31 KY's Math Equation's +1 per
 * return, #37r Gravedigger). The change is permanent and travels with the card between zones (R78).
 */
export function setCostMod(args: { target?: TargetSpec; amount: number; inHandOnly?: boolean }): Effect {
  return {
    kind: "setCostMod",
    apply(ctx): void {
      const card = cardOf(ctx, args.target ?? { of: "self" });
      if (card === null || !priced(card, args.inHandOnly)) return;
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
export function setCostOverride(args: { target?: TargetSpec; cost: number; inHandOnly?: boolean }): Effect {
  return {
    kind: "setCostOverride",
    apply(ctx): void {
      const card = cardOf(ctx, args.target ?? { of: "self" });
      if (card === null || !priced(card, args.inHandOnly)) return;
      card.costOverride = Math.max(0, Math.trunc(args.cost));
      emitCost(ctx, card);
    },
  };
}
