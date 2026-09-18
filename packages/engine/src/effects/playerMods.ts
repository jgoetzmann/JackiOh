// Player modifiers as a verb (SPEC §2.2's cleanup, §2.3, §6.3 Cost, §10.1, R30, R48, R65).
//
// A modifier is the one kind of effect that hangs off a PLAYER rather than a card: "your next Spell
// costs 1 less" (#35 Lunar Eclipse), "your 4-cost cards cost 1 less through your next turn" (#77
// Professor Curvature), "your cards cost 1 less this turn" and "gain Combo: draw 1" (#78 /fullsend)
// and "your next spell resolves twice" (#79 Twinspell). `state.ts` holds the shapes, `mana.ts`
// reads them in R65's order, `modifiers.addModifier` assigns the id, pushes it and emits
// `modifierChanged`, and §2.2's cleanup calls `modifiers.expireModifiers`. Every part of that
// exists; this file is only the verb in front of it, so a card file never writes player state
// (CLAUDE.md rule 5).
//
// THE UNION IS NOT RE-DECLARED HERE. `PlayerModifier` in `state.ts` is the single definition of
// what a modifier can be, and the expiry ladder of §2.2 (`thisTurn`, `nextTurnOf`, `used`, `never`)
// is part of it. Narrowing or copying it here would mean two places to change when a set adds a
// modifier and would let a card write a shape `mana.ts` cannot read, so the argument is exactly
// `DistributiveOmit<PlayerModifier, "id">` — the whole union minus the field the engine assigns.

import type { DistributiveOmit } from "@jackioh/shared";
import { addModifier } from "../modifiers";
import type { Effect } from "../script";
import type { PlayerModifier } from "../state";
import { playerOf, type PlayerSpec } from "./targets";

/**
 * §6.3's cost and draw riders as one verb. The id is the engine's (`m<seq>`, so it is deterministic
 * under replay) and `modifierChanged` is emitted for it, which is what `viewFor` animates.
 *
 * There is no fizzle case: a modifier lands on a player, and a player is always there.
 */
export function addPlayerModifier(args: {
  /** Whose player state it goes on, relative to the controller. Default "self". */
  player?: PlayerSpec;
  mod: DistributiveOmit<PlayerModifier, "id">;
}): Effect {
  return {
    kind: "addPlayerModifier",
    apply(ctx): void {
      // `EffectContext` satisfies `EngineSink` (`state`, `events`, `rng`), so the subsystem
      // function takes the context directly and no state write moves into this file.
      addModifier(ctx, playerOf(ctx, args.player ?? "self"), args.mod);
    },
  };
}
