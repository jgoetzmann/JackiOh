// Deal damage: one instance through the §4.4 pipeline, for one target or for a whole scope.

import { dealDamage, type DamageArgs } from "../damage";
import type { Effect } from "../script";
import { cardsInScope, resolveTarget, sidesOf, type BoardScope, type TargetSpec } from "./targets";

/** The §4.4 modifiers an effect may put on its own damage; shared by `damage` and `damageAll`. */
type DamageFlagArgs = {
  /** True Strike ignores Armor (§4.4 step 2). */
  ignoreArmor?: boolean;
  combat?: boolean;
  /** R85: this damage has Lifesteal of its own, without the source gaining the keyword. */
  lifesteal?: boolean;
};

export type DamageEffectArgs = {
  to: TargetSpec;
  amount: number;
} & DamageFlagArgs;

/**
 * One spelling of the flag block, so `damage` and `damageAll` cannot drift apart: a sweep must put
 * exactly the same instance through §4.4 as a single-target hit does.
 */
function damageFlags(args: DamageFlagArgs): NonNullable<DamageArgs["flags"]> {
  return {
    ignoreArmor: args.ignoreArmor === true,
    combat: args.combat === true,
    lifesteal: args.lifesteal === true,
  };
}

export function damage(args: DamageEffectArgs): Effect {
  return {
    kind: "damage",
    apply(ctx): void {
      const target = resolveTarget(ctx, args.to);
      if (target === null) return;
      dealDamage(ctx, {
        source: ctx.self,
        target,
        amount: args.amount,
        flags: damageFlags(args),
      });
    },
  };
}

export type DamageAllArgs = {
  amount: number;
  /** Also hit the hero of each scoped side, after every unit (#13's "and the enemy hero"). */
  heroes?: boolean;
} & DamageFlagArgs &
  BoardScope;

/**
 * §6.3 Damage over a scope: one §4.4 damage instance per target, in `cardsInScope` order, then the
 * hero of each scoped side in the same side order when `heroes` is set (#13 Jlockeed Shredder-10,
 * "End of turn: deal 2 damage to each enemy unit and the enemy hero", 5 on the radiant face).
 *
 * The target list is snapshotted before the first hit. SPEC says one instance per target, and §4.5
 * never runs a state check between the hits of one effect (R59), so nothing that happens mid-sweep
 * may change who is hit: a unit dragged to 0 health by the second hit still takes nothing extra,
 * and a unit that was not on the field when the sweep began is not hit at all. Re-reading the row
 * per hit would make the sweep depend on the order deaths were noticed, which is exactly the
 * dependency R59 exists to remove.
 *
 * Each hit is an ordinary `dealDamage`, so Divine Shield, Armor, the hero cap, Indestructible,
 * Poisonous, Lifesteal and Trample all behave per target; a target that absorbs its hit fizzles
 * silently and the sweep continues.
 */
export function damageAll(args: DamageAllArgs): Effect {
  return {
    kind: "damageAll",
    apply(ctx): void {
      const flags = damageFlags(args);
      const targets = cardsInScope(ctx, args);

      for (const instance of targets) {
        dealDamage(ctx, { source: ctx.self, target: { kind: "unit", instance }, amount: args.amount, flags });
      }

      if (args.heroes !== true) return;
      for (const player of sidesOf(ctx, args.side)) {
        dealDamage(ctx, { source: ctx.self, target: { kind: "hero", player }, amount: args.amount, flags });
      }
    },
  };
}
