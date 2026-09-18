// Coin flips that buff a unit (SPEC §8.1 #4 Gary the Gambler, §10.4 layer 4, §10.7, R32).
//
// "Cry: flip 5 coins; +1 attack per heads, +1 max health per tails", radiant "7 coins; +2 per
// heads, +2 per tails". #4's Engine cell reads "5 or 7 seeded rolls; permanent buff layer; Lucky
// has no defined 'best' here so does not apply", and all three clauses are decisions this file
// keeps rather than re-makes:
//
//   * SEEDED ROLLS. Every flip is `ctx.rng.coin()`, the only source of randomness §10.7 allows.
//     `Math.random` is banned and lint-enforced (CLAUDE.md rule 4), and a card file may not roll
//     for itself, which is the whole reason this verb exists.
//   * PERMANENT BUFF LAYER. The totals are applied through `buff` from `./buff`, so there is ONE
//     implementation of §10.4's layer 4: nothing here writes `card.buffs`, and the unit's totals
//     stay something `unitView` computes on every read rather than something stored.
//   * NO LUCKY. §6.1's Lucky X is "repeat a luck-based roll X extra times, keep the best", and a
//     flip that pays out on heads AND on tails has no better side, so R32 leaves Gary out of it.
//     There is deliberately no `lucky` option to wire in.
//
// THE FIZZLE IS TOTAL, AND THAT IS A DETERMINISM RULE, NOT TIDINESS. §10.7 stores `rngCursor` in
// state, so the cursor is part of the match: every later draw in the game depends on how many were
// taken before it. If a flip happened only when a target was there, the whole rest of the match's
// randomness would depend on the board at this moment — two replays of the same action list could
// diverge, and §9.3 requires they never do. So the target is resolved FIRST and a missing one takes
// no draws at all, leaving the cursor exactly where it was.

import type { Effect } from "../script";
import { buff, type BuffAmount } from "./buff";
import { instanceOf, type TargetSpec } from "./targets";

/** Heads × per-heads plus tails × per-tails, in one stat. */
function totalFor(
  heads: number,
  tails: number,
  perHeads: BuffAmount,
  perTails: BuffAmount,
  key: "attack" | "health",
): number {
  return heads * Math.trunc(perHeads[key] ?? 0) + tails * Math.trunc(perTails[key] ?? 0);
}

/**
 * §8.1 #4: flip `coins` coins and buff the target by `perHeads` per heads and `perTails` per tails.
 *
 * The two totals are applied as ONE layer-4 buff, so heads + tails always accounts for every flip
 * and there is a single `buffed` event carrying the whole result — which is what §10.10 animates
 * and what a test can read back. A buff that works out to +0/+0 (all five coins landing on a side
 * the card pays nothing for) is silently nothing, like every other no-op buff.
 */
export function flipCoins(args: {
  target: TargetSpec;
  coins: number;
  perHeads?: BuffAmount;
  perTails?: BuffAmount;
}): Effect {
  return {
    kind: "flipCoins",
    apply(ctx): void {
      // Resolved before a single draw: see the determinism note above.
      const unit = instanceOf(ctx, args.target);
      if (unit === null) return;

      const coins = Math.max(0, Math.trunc(args.coins));
      let heads = 0;
      for (let flip = 0; flip < coins; flip += 1) {
        if (ctx.rng.coin()) heads += 1;
      }
      const tails = coins - heads;

      const perHeads = args.perHeads ?? {};
      const perTails = args.perTails ?? {};
      buff({
        target: { of: "instance", instanceId: unit.id },
        attack: totalFor(heads, tails, perHeads, perTails, "attack"),
        health: totalFor(heads, tails, perHeads, perTails, "health"),
      }).apply(ctx);
    },
  };
}
