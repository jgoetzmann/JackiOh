// #96 My Pawn (SPEC §8.5, §4.2 step 4, §6.3 "Cancel an attack", §10.7's AI bullet, R44, R84).
// Trap, cost 1, Mythic.
//   Base:    "When the opponent declares an attack that would be lethal to your hero: cancel it,
//             and an AI plays the rest of their turn with random legal actions"
//   Radiant: "No radiant form" — the catalog's radiant face text is the base text word for word,
//            so the two Scripts are the same object (§8 Conventions).
//
// WHAT FIRES IT. §4.2 step 4: "Declaring the attack has now spent the attacker's exertion, before
// any damage. Trap window: My Pawn checks whether the hit would be lethal and, if so, cancels the
// attack; the exertion is not given back, so the attack is gone either way (R44)". The event that
// opens that window is `attackDeclared`, which `combat.declareAttack` emits after spending the
// exertion and before `resolveCombat`, so this trigger watches exactly that one event.
//
// ARMING (R61, `traps.ts`). "`run` returning `[]` is a trap that fired for nothing — it can never
// mean 'this event was not mine'", so every condition that must leave My Pawn face-down and armed
// lives in the `when` predicate: the opponent's declaration, aimed at a hero that is mine, for
// enough damage to end the game. A non-lethal swing therefore leaves the trap set, which is the
// whole point of the card. Consuming it is not this file's business either — `fireTrap` emits
// `trapFired`, runs the trigger, runs the state check and consumes the trap.
//
// LETHAL IS THE SUBSYSTEM'S (R44). "Lethal = projected damage to the hero after Armor and the cap,
// Trample excess from an attack on a unit included, ≥ health". That calculation is
// `subsystems/lethal.ts` (`isLethal`, `projectedDamage`, `projectedHeroDamage`, `defendingHero`),
// and this card only hands it an attacker and an `AttackTarget`. Nothing here re-reads §4.4.
//
// FORCED ATTACKS DO NOT FIRE IT. §4.2's last paragraph: a forced attack (Moths to the Flame, Bear
// Honeypot) "skips steps 1 to 3" and spends no exertion, and R53 gives each one its own combat and
// state check. The card's condition is "when the OPPONENT DECLARES an attack", and a forced attack
// is declared by the effect that compels it — usually the defender's own card, on the defender's
// own turn, where "an AI plays the rest of THEIR turn" names nobody. `forced` is on the event for
// exactly this kind of distinction, so the predicate reads it. See the proposed R91 in the report.
//
// BUILDING THE `AttackTarget`. The event carries ids only (`attackerId`, `targetId`), and
// `combat.targetIdOf`'s `hero-<player>` spelling is private to that module. §4.2 step 2 leaves only
// two possibilities — an enemy unit or the enemy hero — so a `targetId` that is not an instance is
// the attacker's opponent's hero, named from the attacker instead of by parsing the string. See the
// report: the clean fix is `attackTargetOf(state, targetId)` exported from `combat.ts`, or a
// `target: { kind, id }` field on the event.
//
// BLOCKED (§8.5 #96 "cancel it, and an AI plays the rest of their turn with random legal actions"):
// two effects are missing from `packages/engine/src/effects`, and one piece of engine plumbing is
// missing behind them. Reported, not worked around — a card file cannot cancel combat or drive the
// reducer itself (CLAUDE.md rules 4 and 5).
//
//   // packages/engine/src/effects/combat.ts (new), re-exported from effects/index.ts
//
//   /** §6.3 "Cancel an attack", §4.2 step 4, R44: mark the open `declaredAttack` cancelled so no
//    *  combat resolves, and emit `attackCancelled` (already in the event union) in its place. */
//   export function cancelAttack(): Effect;
//
//   /** R44 and R84: set `aiTurn` on that player's PlayerState — which locks their client out
//    *  until end of turn, and which only `turn.ts` currently clears — then hand the rest of the
//    *  turn to `subsystems/aiPolicy.playOutTurn(sink, player)`, whose uniform draw over
//    *  `legalActions` minus `AI_SKIPPED_ACTIONS` is §10.7's policy (R84: never `concede`,
//    *  `offerDraw` or `answerDraw`). */
//   export function aiPlaysOutTurn(args?: { player?: PlayerSpec }): Effect;
//
// The plumbing behind `cancelAttack`: `GameState` has no `declaredAttack` field (§10.1 requires
// one) and `combat.declareAttack` calls `resolveCombat` on the line after it pushes
// `attackDeclared`, so the trap window of §4.2 step 4 does not exist yet — the trap only sees the
// event once the resolution loop dispatches it, which is after the damage. `declareAttack` has to
// open the window (set `state.declaredAttack`, dispatch the event to the traps via
// `traps.fireTrapsFor`, and resolve combat only if it was not cancelled) before any `cancelAttack`
// can do anything. `run` returns `[]` until then — neither verb is imported, because one
// unresolvable import in `src/scripts/` takes down `_generated.ts` and with it all 109 cards.
//
// Everything above `run` is complete and compiles today: the trigger, and the `when` predicate that
// is the whole of "would be lethal to your hero".

import type { CardInstance, GameState, Script, TrapTrigger } from "@jackioh/engine";
import { findInstance, subsystems, type AttackTarget } from "@jackioh/engine";
import { opponentOf } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-096");

/**
 * §4.2 step 2's two possibilities, from the id the event carries. An instance id names the unit
 * that was declared on; anything else is the only other legal target, the attacker's opponent's
 * hero, so the card never depends on how `combat.ts` spells a hero id.
 */
function attackTargetOf(state: GameState, targetId: string, attacker: CardInstance): AttackTarget {
  const unit = findInstance(state, targetId);
  if (unit !== undefined) return { kind: "unit", instance: unit };
  return { kind: "hero", player: opponentOf(attacker.controller) };
}

/**
 * "When the opponent declares an attack that would be lethal to your hero". Every clause that must
 * leave the trap armed is here (R61): a declaration (not a forced attack), by the opponent, whose
 * projection lands on this trap's controller's hero, for at least that hero's health (R44).
 */
const myPawn: TrapTrigger = {
  id: "my-pawn",
  on: ["attackDeclared"],
  when: (ctx) => {
    const event = ctx.event;
    if (event.type !== "attackDeclared") return false;
    // §4.2's forced attacks are declared by the compelling effect, not by the opponent (R53).
    if (event.forced) return false;

    const attacker = findInstance(ctx.state, event.attackerId);
    if (attacker === undefined) return false;
    // "the opponent declares": a trap never answers its own controller's attack.
    if (attacker.controller !== opponentOf(ctx.controller)) return false;

    const target = attackTargetOf(ctx.state, event.targetId, attacker);
    // R44 counts Trample excess from an attack on a unit, so the hero at risk is the projection's,
    // not the declared target: "lethal to YOUR hero" is that hero being this trap's controller.
    if (subsystems.defendingHero(target) !== ctx.controller) return false;

    return subsystems.isLethal(ctx.state, attacker, target);
  },
  // See the BLOCKED note in the header. With both verbs in the effects barrel this is the row's
  // two clauses in its order, `player: "enemy"` being the attacker's side relative to the trap's
  // controller, which the predicate above has already established:
  //   return [cancelAttack(), aiPlaysOutTurn({ player: "enemy" })]
  run: () => [],
};

export const base: Script = { triggers: [myPawn] };

/** §8.5: "No radiant form" — the radiant face's text is the base text, so it is the same script. */
export const radiant: Script = base;
