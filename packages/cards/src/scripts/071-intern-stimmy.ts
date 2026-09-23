// #71 Intern Stimmy (SPEC §8.3): "At the end of any turn, if your library has more cards than the
// opponent's: Recruit a Unit costing 1 or less", radiant "2 or less" — a Radiant cell that changes
// only a number changes only that number (§8 Conventions), so the trigger, the condition and the
// Recruit are all kept and only the cost ceiling moves.
//
// Three things this card is NOT responsible for, all of them engine:
//
//  1. WHEN it fires. R62 puts the end-of-turn trap window after the end-of-turn triggers and before
//     the end-of-turn delayed effects, on BOTH players' turns, which is why the trigger watches the
//     plain `turnEnded` event and reads nothing off it. `traps.ts` withholds `turnEnded` from the
//     immediate dispatch (`TRAP_WINDOW_EVENTS`) precisely so this fires once, in the window.
//  2. "NEVER consumed". §5.1 and §3.2 make that the card TYPE's doing: `traps.ts consumeTrap` and
//     `triggers.ts consumeTrap` both return early for a Field Trap, so it stays in the backrow and
//     can fire again next turn. R33's "a Field Trap that has fired is face-up to both" is theirs
//     too (both set `faceUp` when the trap fires).
//  3. WHOSE library, and whose Recruit. R62 and R52 (#18 Bread and Butter's beneficiary) settle it:
//     "your" is the TRAP'S CONTROLLER, not the player who ended the turn. Both firing paths build
//     the context with `controller: trap.controller`, so `ctx.controller` is already that player and
//     `recruit`'s default `player: "self"` is already the right side. The trigger never looks at
//     `event.player`.
//
// The condition is a `when` predicate, which is what `traps.ts` reads. That module is the ONLY one
// that can fire this card: `triggers.ts` passes `turnEnded` over for traps (`offerToTraps` returns
// null for a `TRAP_WINDOW_EVENTS` event) and skips trap holders in the ordinary queue, exactly so
// R62's window fires them once, at its scheduled point. `when` matters because R61 makes `run`
// returning `[]` mean "the trap fired and achieved nothing", which would flip this Field Trap
// face-up (R33) on every turn end it does not answer; a predicate leaves it armed and face-down.
// `run` repeats the check as belt and braces, so the card is still correct under the
// `effects.length === 0` convention `triggers.ts runQueuedTrigger` uses for non-window triggers.
//
// `script.ts`'s `TriggerDef` does not declare `when` (traps.ts reads it structurally and says M3-T2
// must add it), so the trigger is typed as `TrapTrigger`. Reported.
//
// R195, the yellow glow: the card glows in its controller's hand and in their backrow exactly when
// `libraryIsLarger` holds, the same function the trap's `when` and `run` read, so the glow says
// "this would recruit if the turn ended now". It asks nothing the controller cannot see (§9.1: both
// library sizes are public counts), and the opponent never sees the glow on a face-down trap
// because `viewFor` never asks about a card the viewer does not control.

import type { GameState, Script, TrapTrigger } from "@jackioh/engine";
import { zoneCount } from "@jackioh/engine";
import { recruit } from "@jackioh/engine/effects";
import { opponentOf, type PlayerId } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-071");

/**
 * §10.9: a hook may READ state to compute an effect's arguments; it never writes. This is the whole
 * of that read for this card — the two library sizes through the engine's read-only `zoneCount`
 * (engine/src/query.ts, BUILD M3-T1), "yours" being the trap's controller (R62, R52) — and "more
 * cards than" is strictly greater, so an equal count does nothing.
 */
function libraryIsLarger(state: GameState, controller: PlayerId): boolean {
  const mine = zoneCount(state, controller, "library");
  const theirs = zoneCount(state, opponentOf(controller), "library");
  return mine > theirs;
}

/** `maxCost` is the whole of the radiant text: 1 or less on the base face, 2 or less on it. */
function internStimmy(maxCost: number): Script {
  // R65: outside play an X-cost card counts as 0 and an embiggen card as its base price, which is
  // what `recruit`'s filter reads off the library (`queryCost` in effects/summon.ts).
  const recruitUnit = recruit({ filter: { type: "Unit", costRange: { max: maxCost } } });

  const atEndOfAnyTurn: TrapTrigger = {
    id: "intern-stimmy-window",
    on: ["turnEnded"],
    when: (ctx) => libraryIsLarger(ctx.state, ctx.controller),
    run: (ctx) => (libraryIsLarger(ctx.state, ctx.controller) ? [recruitUnit] : []),
  };

  return {
    triggers: [atEndOfAnyTurn],
    // R195: hand and field alike — the condition is the board's, not the play's.
    conditionMet: (ctx) => libraryIsLarger(ctx.state, ctx.controller),
  };
}

export const base: Script = internStimmy(1);

export const radiant: Script = internStimmy(2);
