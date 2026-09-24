// Destroy and Sacrifice (SPEC §6.3, §4.5). Destroy only marks the card: the next state check moves
// it, which is where Indestructible, Reborn and the Death order live. Sacrifice is immediate.
//
// `destroyAll` and `destroyAdjacentTo` are the same mark over a scope (§3.1, §3.2), so a sweep and
// a single destroy are collected by the one state check that follows the whole effect (R59).

import type { Effect } from "../script";
import type { CardInstance } from "../state";
import { sacrificeNow } from "../stateCheck";
import { adjacentTo, cardsInScope, instanceOf, type BoardScope, type TargetSpec } from "./targets";

/**
 * The mark every destroy leaves (§6.3, §4.5 step 1). A destroy is not a damage instance, so no
 * unit's hit can be the lethal one any more: R42's "a death whose lethal damage instance came from
 * this unit" and R89's `killerId` read `lastDamagedBy`, and a hit that landed earlier and did not
 * kill must not be credited with a death this effect caused. Poisonous marks inside the damage
 * instance itself (`damage.ts` step 7) and so keeps its source.
 */
function markDestroyed(card: CardInstance): void {
  card.markedDestroyed = true;
  delete card.lastDamagedBy;
}

/**
 * §6.3 Destroy: mark the card and stop. §4.5 step 1 collects it at the next state check, moves it
 * to its owner's graveyard (R12), fires its Death trigger and lets Indestructible ignore the mark
 * (R46). Nothing here moves a card, so several destroys in one effect die together (R59).
 */
export function destroy(args: { target: TargetSpec }): Effect {
  return {
    kind: "destroy",
    apply(ctx): void {
      const card = instanceOf(ctx, args.target);
      if (card === null || card.zone.z !== "field") return;
      markDestroyed(card);
    },
  };
}

/**
 * §6.3 Destroy, board-wide: mark every card the scope names and stop (#2 Bigot, #17 Flood,
 * #43 Big Felinor, #88 Twisting Nether). Marking and only marking is the whole point — §4.5 step 1
 * then collects the entire board in ONE state check, which is what R59 requires of a sweep: no
 * Death trigger of the first victim fires while the rest are still standing.
 *
 * Indestructible is deliberately NOT filtered out of the scope. "Indestructibles survive" is a
 * consequence of §4.5's mark resolution, not of this walk: that step drops the mark, switches the
 * unit to Attack Position and suppresses its Taunt for the turn (R46). A scope that skipped
 * Indestructible units would quietly lose all three, leaving a warded blocker in Defense Position
 * after a Twisting Nether that R46 says should have been knocked flat.
 *
 * `rows` defaults to `["units"]`; a sweep over permanents passes `["units", "backrow"]` (§6.3).
 */
export function destroyAll(args: BoardScope = {}): Effect {
  return {
    kind: "destroyAll",
    apply(ctx): void {
      for (const card of cardsInScope(ctx, args)) markDestroyed(card);
    },
  };
}

/**
 * §3.1 Adjacent destroy: mark lanes N-1 and N+1 on the target's own side and row, never the target
 * itself and never across sides (#16 Hit Job radiant). The card pairs this with a plain
 * `destroy({ target: { of: "chosen" } })` in the same effect list, so the target and its
 * neighbours are all marked before the state check and die together under R59.
 *
 * A target off the field, or one with no neighbours, fizzles silently and the card still resolves.
 */
export function destroyAdjacentTo(args: { target: TargetSpec } & BoardScope): Effect {
  return {
    kind: "destroyAdjacentTo",
    apply(ctx): void {
      const { target, ...scope } = args;
      for (const card of adjacentTo(ctx, target, scope)) markDestroyed(card);
    },
  };
}

/**
 * §6.3 Sacrifice: your own card goes from the field to the graveyard at once, bypassing
 * Indestructible, and it counts as a death — the destroyed counter (R55), the `destroyed` event,
 * the Death trigger, which reads the card as it was just before it left (R78), and §6.1's Reborn,
 * which brings a sacrificed Reborn unit back to its zone at 1 health as it would any other first
 * death. That is §4.5's pass for one card, so it is `stateCheck.sacrificeNow` rather than a copy of
 * it. A unit token vanishes instead of entering a graveyard (R11). Tribute may aim it at an enemy
 * unit (#55), which `allowEnemy` says.
 */
export function sacrifice(args: { target: TargetSpec; allowEnemy?: boolean }): Effect {
  return {
    kind: "sacrifice",
    apply(ctx): void {
      const card = instanceOf(ctx, args.target);
      if (card === null || card.zone.z !== "field") return;
      if (card.controller !== ctx.controller && args.allowEnemy !== true) return;
      sacrificeNow(ctx, card);
    },
  };
}
