// Positions, exertion, attack validation and combat resolution (SPEC §4.1, §4.2, §4.3; BUILD M2-T1,
// M2-T2, M2-T4). The damage pipeline of §4.4 lives in `damage.ts` and the state check of §4.5 in
// `stateCheck.ts`: this module orders them, it never re-implements them.
//
// Nothing here is random and nothing here asks the player anything, so combat is a plain function of
// the state (CLAUDE.md rule 4): the client's `attack` and `switchPosition` actions come in through
// `reduce`, and every refusal is a string the action layer hands back untouched.

import type { PlayerId } from "@jackioh/shared";
import { hasKeyword, opponentOf } from "@jackioh/shared";
import { LANE_RESTRICTED_ATTACKS } from "./config";
import { dealDamage, type DamageTarget } from "./damage";
import { unitView } from "./layers";
import type { EngineSink } from "./resolve";
import { flagsOf } from "./scripts";
import { stateCheck } from "./stateCheck";
import type { CardInstance, GameState, Position } from "./state";
import { activeUnitsOf, adjacent, cardAt, slotOf } from "./zones";

/**
 * What an attack can be declared on (§4.2 step 2): an enemy unit or the enemy hero. It is the
 * damage pipeline's own target type, so a declared attack hands its target straight to `dealDamage`.
 */
export type AttackTarget = DamageTarget;

/** The two halves of a unit's turn (§4.1). A unit has one of them; Deft Duelist has both (R49). */
export type ExertionKind = "attack" | "switch";

/** Every entry point returns the §4.2 refusal reason, or nothing when it went through. */
export type CombatResult = { error?: string };

export type SwitchPositionOptions = {
  /** False for a switch that is an effect rather than the player's action (R20). */
  spendExertion?: boolean;
  /** Where to put the unit; by default it flips. */
  to?: Position;
};

/**
 * R49: Deft Duelist has two exertions, one attack and one switch, where every other unit has one.
 * The flag lives on the card's script (`staticFlags.deftDuelist`), so the rule is data rather than a
 * card name in the engine, and a granted copy of the text would carry it the same way.
 */
function hasTwoExertions(unit: CardInstance): boolean {
  return flagsOf(unit).deftDuelist === true;
}

/**
 * §4.1: one exertion per turn, so a unit that attacked cannot switch and a unit that switched
 * cannot attack (R6). Deft Duelist spends the two independently (R49).
 */
export function hasExertion(unit: CardInstance, kind: ExertionKind): boolean {
  const spent = unit.exertion;
  if (hasTwoExertions(unit)) return kind === "attack" ? !spent.attacked : !spent.switched;
  return !spent.attacked && !spent.switched;
}

/**
 * §4.1: a unit that entered the field this turn is summoning sick. A unit that enters again, a
 * Reborn body included, entered it on that turn like any other (R83), so this is the one comparison.
 */
export function isSick(state: GameState, unit: CardInstance): boolean {
  return unit.summonedTurn === state.turn;
}

/**
 * §3.2: the card that acts in a zone is the top of its Stack pile. A card dormant underneath one is
 * not on the field for anything: it neither acts nor can be targeted (R13).
 */
export function isActiveOnField(state: GameState, unit: CardInstance): boolean {
  const at = slotOf(state, unit);
  if (at === null) return false;
  return cardAt(state, at)?.id === unit.id;
}

/**
 * Flip a unit between Attack and Defense Position (§4.1). As the player's action it spends the
 * unit's exertion; as an effect (5pek Controller, #48) it spends nothing (R20). Defense Position's
 * Taunt and Armor +1 are layers, not state, so they follow from `position` alone (§10.4).
 */
export function switchPosition(
  sink: EngineSink,
  unit: CardInstance,
  options: SwitchPositionOptions = {},
): CombatResult {
  const spendExertion = options.spendExertion !== false;
  if (!isActiveOnField(sink.state, unit)) return { error: "that unit is not on the field" };

  const from = unit.position ?? "ATK";
  const to = options.to ?? (from === "ATK" ? "DEF" : "ATK");

  // R91: asking for the position the unit already holds "does nothing: no error, no event and no
  // exertion spent". It is read before the exertion because there is no switch to refuse — a unit
  // that has already acted is not told it has, since nothing was going to be spent. #48's "switch
  // every unit" reaches units already in the position it would set.
  if (to === from) return {};

  if (spendExertion && !hasExertion(unit, "switch")) return { error: "that unit has already acted this turn" };
  // §4.1: Spikey Pillow cannot be switched to Defense Position, by an action or by an effect.
  if (to === "DEF" && flagsOf(unit).neverDefense === true) {
    return { error: "that unit cannot be in Defense Position" };
  }

  unit.position = to;
  if (spendExertion) unit.exertion.switched = true;
  sink.events.push({ type: "positionSwitched", instanceId: unit.id, position: to });
  return {};
}

/**
 * §4.2 step 1: "choose an attacker that can attack", in the order the step lists — exertion
 * unspent, Attack Position, not sick unless Rush or Charge, attack above 0, no "Can't attack" —
 * with §3.2's "is it even on the field" first. The order is what decides which reason a unit that
 * fails several ways reports, so R6's spent exertion is read before its position.
 */
function whyCannotDeclare(state: GameState, attacker: CardInstance): string | null {
  if (!isActiveOnField(state, attacker)) return "that unit is not on the field";
  if (!hasExertion(attacker, "attack")) return "that unit has already acted this turn";

  const view = unitView(state, attacker);
  if (view.position !== "ATK") return "only Attack-Position units may attack";
  if (
    isSick(state, attacker) &&
    !hasKeyword(view.keywords, "Rush") &&
    !hasKeyword(view.keywords, "Charge")
  ) {
    return "that unit is summoning sick";
  }
  // R7: a 0-attack unit cannot declare an attack, printed (Big D-fender) or dragged there (§10.4).
  if (view.attack <= 0) return "a unit with 0 attack cannot attack";
  if (hasKeyword(view.keywords, "Can't attack")) return "that unit cannot attack";
  return null;
}

/** Every enemy unit whose Taunt forces the target, printed, granted or from Defense (§4.2 step 3). */
function tauntWall(state: GameState, enemy: PlayerId): CardInstance[] {
  return activeUnitsOf(state, enemy).filter((unit) => hasKeyword(unitView(state, unit).keywords, "Taunt"));
}

/**
 * Steps 1 to 3 of §4.2, as the reason the attack is refused or null when it is legal. The action
 * layer surfaces this string as the error of an `attack` action, and `attackTargets` filters with it,
 * so the two can never disagree.
 */
export function whyCannotAttack(state: GameState, attacker: CardInstance, target: AttackTarget): string | null {
  const refusal = whyCannotDeclare(state, attacker);
  if (refusal !== null) return refusal;

  // Step 2: an enemy unit, or the enemy hero.
  const enemy = opponentOf(attacker.controller);
  if (target.kind === "hero") {
    if (target.player !== enemy) return "that target is not an enemy";
  } else {
    if (target.instance.controller !== enemy) return "that target is not an enemy";
    if (!isActiveOnField(state, target.instance)) return "that unit is not on the field";
    // R5 decided attacks are not lane-restricted; flipping the constant restricts a unit to the
    // lane it stands in, which is the only reading §3.1's lanes give an attack.
    if (LANE_RESTRICTED_ATTACKS) {
      const from = slotOf(state, attacker);
      const to = slotOf(state, target.instance);
      if (from !== null && to !== null && from.lane !== to.lane) return "that target is not in this unit's lane";
    }
  }

  // §6.1: Rush lifts sickness for unit targets only, Charge for units and the hero. Step 1 has
  // already established that a sick attacker has one of the two.
  if (target.kind === "hero" && isSick(state, attacker)) {
    if (!hasKeyword(unitView(state, attacker).keywords, "Charge")) {
      return "Rush cannot hit the hero on its summon turn";
    }
  }

  // Step 3: while any enemy unit has Taunt, the target must be one of them.
  const wall = tauntWall(state, enemy);
  if (wall.length > 0 && !(target.kind === "unit" && wall.some((unit) => unit.id === target.instance.id))) {
    return "a Taunt unit must be attacked first";
  }

  return null;
}

export function canAttack(state: GameState, attacker: CardInstance, target: AttackTarget): boolean {
  return whyCannotAttack(state, attacker, target) === null;
}

/**
 * Every target this attacker may legally declare on, enemy units in lane order and then the enemy
 * hero (§4.2). Empty when the attacker cannot attack at all, which is what the action layer and the
 * AI policy read instead of enumerating attacks themselves.
 */
export function attackTargets(state: GameState, attacker: CardInstance): AttackTarget[] {
  const enemy = opponentOf(attacker.controller);
  const candidates: AttackTarget[] = [
    ...activeUnitsOf(state, enemy).map((instance) => ({ kind: "unit" as const, instance })),
    { kind: "hero" as const, player: enemy },
  ];
  return candidates.filter((target) => canAttack(state, attacker, target));
}

function targetIdOf(target: AttackTarget): string {
  return target.kind === "unit" ? target.instance.id : `hero-${target.player}`;
}

/**
 * §4.3's "if D is destroyed here it deals nothing". The state check has not run yet, so this asks
 * the question §4.5 step 1 will: 0 or less health or a destroy mark, while an Indestructible unit
 * falls only to max health 0 or less (R69).
 */
function hasFallen(state: GameState, unit: CardInstance): boolean {
  if (!isActiveOnField(state, unit)) return true;
  const view = unitView(state, unit);
  if (hasKeyword(view.keywords, "Indestructible")) return view.maxHealth <= 0;
  return view.health <= 0 || unit.markedDestroyed === true;
}

/**
 * §4.4 step 10: Cleave deals the attacker's attack to each unit adjacent to the target as separate
 * instances. It belongs to the attack rather than to the hit, so it lands even when Divine Shield,
 * Indestructible or the zero rule stopped the hit on the defender (R63); adjacency never crosses
 * sides (§3.1), so the attacker's own neighbours are never cleaved.
 */
function cleave(sink: EngineSink, attacker: CardInstance, target: AttackTarget, amount: number): void {
  if (target.kind !== "unit") return;
  if (!hasKeyword(unitView(sink.state, attacker).keywords, "Cleave")) return;

  const at = slotOf(sink.state, target.instance);
  if (at === null) return;
  for (const ref of adjacent(at)) {
    const neighbour = cardAt(sink.state, ref);
    if (neighbour === null) continue;
    dealDamage(sink, {
      source: attacker,
      target: { kind: "unit", instance: neighbour },
      amount,
      flags: { combat: true },
    });
  }
}

/**
 * The exchange of §4.3, with no validation, no exertion and no state check: the First Strike step,
 * then the simultaneous step. Both attacks are read before either lands, which is what makes the
 * simultaneous step simultaneous; a hero never strikes back, and a defender in Defense Position
 * strikes back with its full attack, the position's Armor +1 applying only to what it takes.
 *
 * The caller runs the state check, so both hits of one combat land before anything dies (R59).
 */
export function resolveCombat(sink: EngineSink, attacker: CardInstance, target: AttackTarget): void {
  const state = sink.state;
  if (!isActiveOnField(state, attacker)) return;
  if (target.kind === "unit" && !isActiveOnField(state, target.instance)) return;

  const attack = unitView(state, attacker).attack;
  const strike = (): void => {
    dealDamage(sink, { source: attacker, target, amount: attack, flags: { combat: true } });
    cleave(sink, attacker, target, attack);
  };

  // §4.3: when the defender is a hero, only the attacker deals damage.
  if (target.kind === "hero") {
    strike();
    return;
  }

  const defender = target.instance;
  // R94: both attacks are read once, here, before either hit lands. That is what makes the
  // simultaneous step simultaneous, and it is why a First Strike survivor is struck back with the
  // attack the defender had before the hit landed rather than with whatever it reads afterwards.
  const strikeBackAttack = unitView(state, defender).attack;
  const strikeBack = (): void => {
    dealDamage(sink, {
      source: defender,
      target: { kind: "unit", instance: attacker },
      amount: strikeBackAttack,
      flags: { combat: true },
    });
  };

  const attackerFirst = hasKeyword(unitView(state, attacker).keywords, "First Strike");
  const defenderFirst = hasKeyword(unitView(state, defender).keywords, "First Strike");

  // Step 1: one First Strike hits alone, and the other side answers in step 2 only if it survives.
  if (attackerFirst && !defenderFirst) {
    strike();
    if (!hasFallen(state, defender)) strikeBack();
    return;
  }
  if (defenderFirst && !attackerFirst) {
    strikeBack();
    if (!hasFallen(state, attacker)) strike();
    return;
  }

  // Two First Strikers strike simultaneously in step 1, two ordinary units in step 2, and either
  // way the first death does not cancel the exchange (R59).
  strike();
  strikeBack();
}

/**
 * The player's attack: §4.2 steps 1 to 5. Validation first, then the exertion, which step 4 spends
 * before any damage, then the combat and the state check.
 *
 * Step 4's trap window rides the `attackDeclared` event emitted here (My Pawn reads the projection
 * in `subsystems/lethal.ts` and cancels with `attackCancelled`, R44). The exertion above is spent
 * before the window, so a cancelled attack is gone either way.
 */
export function declareAttack(sink: EngineSink, attacker: CardInstance, target: AttackTarget): CombatResult {
  const refusal = whyCannotAttack(sink.state, attacker, target);
  if (refusal !== null) return { error: refusal };

  attacker.exertion.attacked = true;
  sink.events.push({
    type: "attackDeclared",
    attackerId: attacker.id,
    targetId: targetIdOf(target),
    forced: false,
  });

  resolveCombat(sink, attacker, target);
  stateCheck(sink);
  return {};
}

/**
 * A forced attack (Moths to the Flame, Bear Honeypot): §4.2's last paragraph and R53. It skips
 * steps 1 to 3, so position, sickness and the Taunt rule do not apply, and it spends no exertion, so
 * the unit may still take its own attack on its own turn. The target still strikes back, and the
 * combat is followed by its own state check.
 */
export function forceAttack(sink: EngineSink, attacker: CardInstance, target: AttackTarget): void {
  const state = sink.state;
  if (state.result !== null) return;
  if (!isActiveOnField(state, attacker)) return;
  if (target.kind === "unit" && !isActiveOnField(state, target.instance)) return;

  sink.events.push({
    type: "attackDeclared",
    attackerId: attacker.id,
    targetId: targetIdOf(target),
    forced: true,
  });

  resolveCombat(sink, attacker, target);
  stateCheck(sink);
}

/**
 * R53: the named units attack the named target one at a time, in the order given (lane order, as
 * `activeUnitsOf` reports it), each its own combat with its own state check, and the sequence stops
 * as soon as the target is no longer on the field.
 */
export function forceAttacksOn(sink: EngineSink, attackers: readonly CardInstance[], target: AttackTarget): void {
  for (const attacker of attackers) {
    if (sink.state.result !== null) return;
    if (target.kind === "unit" && !isActiveOnField(sink.state, target.instance)) return;
    forceAttack(sink, attacker, target);
  }
}
