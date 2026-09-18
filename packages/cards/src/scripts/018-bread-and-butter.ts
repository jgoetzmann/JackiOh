// #18 Bread and Butter (SPEC §8.1, §5.1, §7, R37, R52, R62): "When any player ends a turn with
// unspent mana: summon a Bread Token X/X for the trap's controller, X = that player's unspent mana".
// The radiant cell says only "X = 3 × unspent", a cell that changes one number and nothing else
// (§8 Conventions), so the trigger, the beneficiary and the token are the same on both faces.
//
// WHERE IT FIRES. R62's turn sequence ends "… end-of-turn triggers → end-of-turn trap window (Bread
// and Butter and Intern Stimmy on both sides, in R68 order) → end-of-turn delayed effects → cleanup".
// So this is a trap trigger on the `turnEnded` event, which `traps.ts` reserves for exactly that
// window (`TRAP_WINDOW_EVENTS = ["turnEnded"]`, withheld from the immediate dispatch so the trap
// fires once, in the window, on both players' turns). "Any player" needs no condition of its own:
// `turn.ts` emits one `turnEnded` per turn whoever is active, and a backrow trap registers its
// `triggers` on either side (triggers.ts `triggerHoldersOf`).
//
// WHOSE TOKEN. R52: "The token always goes to the trap's controller, whichever player ended the turn
// with unspent mana". `player: "self"` is that and only that — `playerOf(ctx, "self")` is
// `ctx.controller`, which `fireTrap`/`runQueuedTrigger` set to the trap's own controller, never to
// the player who ended the turn.
//
// X. It comes off the event (`turnEnded.unspentMana`), so this card reads no state at all — not the
// ending player's mana pool, not `turnLog.unspentAtEnd`, which `cleanup` only writes afterwards.
//
// THE TOKEN. §7 and R37: the Bread Token is printed 0/0 with no text and is "always summoned as X/X
// through `statsOverride`", which is what `summon`'s `statsOverride` does.
//
// IT STAYS. §5.1 and §3.2: a Field Trap is not consumed when it fires, so it can pay out every turn;
// both `traps.ts` and `triggers.ts` keep it on the field and only turn it face-up (R33).

import type { Script, TrapTrigger } from "@jackioh/engine";
import { summon } from "@jackioh/engine/effects";
import type { GameEvent } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-018");

/** §7: the Bread Token definition; its X/X comes from `statsOverride`, never from the def. */
const BREAD_TOKEN = "core-t-bread";

/**
 * The ending player's unspent mana, straight off the event. Any other event type is not this
 * trigger's (`on` already guarantees `turnEnded`), and a negative pool cannot happen, so both read
 * as "nothing unspent".
 */
function unspentOn(event: GameEvent): number {
  return event.type === "turnEnded" ? Math.max(0, event.unspentMana) : 0;
}

/**
 * One face's trigger: `multiplier` is §8's X (base) or 3X (radiant).
 *
 * The condition is written twice on purpose, because the two dispatch paths read it differently:
 *   - `traps.ts`'s `fireTrap` filters on `when`, and a trap no trigger admitted stays armed and
 *     face-down — which is what "ends a turn WITH unspent mana" means at 0 unspent;
 *   - `triggers.ts`'s `runQueuedTrigger` ignores `when` and instead takes an empty effect list as
 *     "a trigger whose condition was not met … no event, and a trap stays armed".
 * Either way nothing is summoned and nothing is revealed at 0 unspent. `when` is declared on
 * `TrapTrigger` (traps.ts) rather than on `TriggerDef`, which is why that is the annotation here.
 */
function breadTrigger(multiplier: number): TrapTrigger {
  return {
    id: "bread-and-butter",
    on: ["turnEnded"],
    when: (ctx) => unspentOn(ctx.event) > 0,
    run: (ctx) => {
      const x = unspentOn(ctx.event) * multiplier;
      if (x <= 0) return [];
      return [
        summon({
          defId: BREAD_TOKEN,
          // R52: the trap's controller, whoever ended the turn.
          player: "self",
          // §7, R37: X/X on a card printed 0/0.
          statsOverride: { attack: x, health: x },
        }),
      ];
    },
  };
}

export const base: Script = { triggers: [breadTrigger(1)] };

export const radiant: Script = { triggers: [breadTrigger(3)] };
