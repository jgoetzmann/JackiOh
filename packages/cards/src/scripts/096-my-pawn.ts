// #96 My Pawn (SPEC §8.5, §4.2 step 4, §6.3 "Cancel an attack", §10.7's AI bullet, R44, R84,
// R276, R283). Trap, cost 1, Mythic.
//   Base:    "When the opponent declares an attack that would be lethal to your hero: cancel it,
//             and an AI plays the rest of their turn with random legal actions"
//   Radiant: "When the opponent declares an attack that would be lethal to your hero: cancel it,
//             destroy the attacker, and an AI plays the rest of their turn with random legal
//             actions" (§8's cell "Also destroy the attacker"; R276 gave the card its Radiant face).
//
// WHAT FIRES IT. §4.2 step 4: "Declaring the attack has now spent the attacker's exertion, before
// any damage. Trap window: My Pawn checks whether the hit would be lethal and, if so, cancels the
// attack; the exertion is not given back, so the attack is gone either way (R44)". The event that
// opens that window is `attackDeclared`, which `combat.declareAttack` emits after spending the
// exertion and hands to `traps.runTrapWindow` before it resolves any combat, so this trigger
// watches exactly that one event. R100 keeps the window's delivery to the window: the declaration
// is not offered to §10.3's immediate check as well, so this trap answers one swing once.
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
// exactly this kind of distinction, so the predicate reads it (R121). `combat.forceAttack` opens no
// window at all for the same reason, so there is nothing for this trap to cancel there either.
//
// BUILDING THE `AttackTarget`. The event carries ids only (`attackerId`, `targetId`), and the
// `hero-<player>` spelling is `combat.ts`'s. So the reverse of it is `combat.attackTargetOf`, which
// that module now exports for exactly this: §4.2 step 5 reads a paused declaration back through it
// too, so the card and the engine agree on what an id means by sharing one reader rather than by
// each parsing the string.
//
// THE BODY (§8.5 #96 "cancel it, and an AI plays the rest of their turn with random legal actions")
// is the two verbs of `packages/engine/src/effects/combat.ts`, in the row's order. Neither is
// implemented here: a card file cannot cancel combat or drive the reducer itself (CLAUDE.md rules 4
// and 5). `cancelAttack` marks the open `state.declaredAttack` cancelled, so §4.2 step 5 resolves
// no combat and `attackCancelled` is emitted in its place; `aiPlaysOutTurn` sets the `aiTurn`
// lockout on the attacking player and hands the rest of their turn to §10.7's policy through
// `subsystems/aiPolicy.playOutTurn` (R84: never `concede`, `offerDraw` or `answerDraw`; R152: the
// lockout ends at the cleanup of the turn it took).
//
// ORDER MATTERS, and it is the row's own. `cancelAttack` first, because `aiPlaysOutTurn` drives
// `reduce`, which clones the state, and the AI's own actions can open and close declarations of
// their own — the attack this trap answers has to be cancelled while it is still the open one.
// `aiPlaysOutTurn` last for a second reason `effects/combat.ts` spells out: the playout replaces
// every instance in the state, so no effect after it may hold a `CardInstance` read before it.
//
// THE RADIANT FACE (R283) puts one effect between the two: "destroy the attacker", after the cancel
// and before the AI turn. It is an ordinary §6.3 destroy — a mark the state check collects — so an
// Indestructible attacker is knocked down instead (R46) and a Reborn one comes back, and the attack
// is cancelled either way (R44). The attacker is named by the id the declaration carries, so the
// destroy is aimed at the stay it attacked from (R174) and fizzles if it has somehow left since.
// R283 has the state check collect it before the AI takes the turn: the destroy is in its place in
// the list, and `aiPlaysOutTurn`'s `settleFirst` runs the check before the playout's first action,
// so the AI acts from a board the attacker has already left. The base face has nothing to settle
// and keeps the playout exactly as it was.

import type { Effect, Script, TrapTrigger } from "@jackioh/engine";
import { attackTargetOf, findInstance, subsystems } from "@jackioh/engine";
import { aiPlaysOutTurn, cancelAttack, destroy } from "@jackioh/engine/effects";
import { opponentOf, type GameEvent } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-096");

/**
 * "When the opponent declares an attack that would be lethal to your hero". Every clause that must
 * leave the trap armed is here (R61): a declaration (not a forced attack), by the opponent, whose
 * projection lands on this trap's controller's hero, for at least that hero's health (R44). The
 * condition is the same on both faces.
 */
const wouldBeLethal: NonNullable<TrapTrigger["when"]> = (ctx) => {
  const event = ctx.event;
  if (event.type !== "attackDeclared") return false;
  // §4.2's forced attacks are declared by the compelling effect, not by the opponent (R53).
  if (event.forced) return false;

  const attacker = findInstance(ctx.state, event.attackerId);
  if (attacker === undefined) return false;
  // "the opponent declares": a trap never answers its own controller's attack.
  if (attacker.controller !== opponentOf(ctx.controller)) return false;

  const target = attackTargetOf(ctx.state, event.targetId);
  if (target === null) return false;
  // R44 counts Trample excess from an attack on a unit, so the hero at risk is the projection's,
  // not the declared target: "lethal to YOUR hero" is that hero being this trap's controller.
  if (subsystems.defendingHero(target) !== ctx.controller) return false;

  return subsystems.isLethal(ctx.state, attacker, target);
};

/** R283: the radiant face's "destroy the attacker", aimed at the declaration's attacker by id. */
function destroyTheAttacker(event: GameEvent): Effect[] {
  if (event.type !== "attackDeclared") return [];
  return [destroy({ target: { of: "instance", instanceId: event.attackerId } })];
}

/** `destroysAttacker` is the whole of the radiant text (R283). */
function myPawn(destroysAttacker: boolean): TrapTrigger {
  return {
    id: "my-pawn",
    on: ["attackDeclared"],
    when: wouldBeLethal,
    // §8.5's clauses in its order. `player: "enemy"` is the attacker's side relative to the trap's
    // controller, which the predicate above has already established.
    run: (ctx) => [
      cancelAttack(),
      ...(destroysAttacker ? destroyTheAttacker(ctx.event) : []),
      aiPlaysOutTurn({ player: "enemy", ...(destroysAttacker ? { settleFirst: true } : {}) }),
    ],
  };
}

export const base: Script = { triggers: [myPawn(false)] };

export const radiant: Script = { triggers: [myPawn(true)] };
