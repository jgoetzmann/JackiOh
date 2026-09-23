// Positions, exertion, attack validation and combat resolution (SPEC §4.1, §4.2, §4.3; BUILD M2-T1,
// M2-T2, M2-T4). The damage pipeline of §4.4 lives in `damage.ts` and the state check of §4.5 in
// `stateCheck.ts`: this module orders them, it never re-implements them.
//
// Nothing here is random and nothing here asks the player *directly*: the client's `attack` and
// `switchPosition` actions come in through `reduce`, and every refusal is a string the action layer
// hands back untouched (CLAUDE.md rule 4).
//
// The one thing that is not a plain function of the state is §4.2 step 4, the trap window between a
// declaration and its damage. A trap that fires there can prompt its controller, and a prompt is
// state rather than a callback (§9.3), so `declareAttack` is a resumable sequence: it puts the
// declaration in `state.declaredAttack`, hands the `attackDeclared` event to `traps.runTrapWindow`,
// and — only if that pauses — owes step 5's combat to `state.work` under `ATTACK_WINDOW_WORK`
// (R113, R117). Everything the resume needs is an id, because the window can replace every instance
// in the state before step 5 runs (R44's AI turn drives `reduce`, which clones).

import type { GameEvent, PlayerId } from "@jackioh/shared";
import { PLAYER_IDS, hasKeyword, opponentOf } from "@jackioh/shared";
import { LANE_RESTRICTED_ATTACKS } from "./config";
import { dealDamage, type DamageTarget } from "./damage";
import { unitView } from "./layers";
import type { EngineSink } from "./resolve";
import { flagsOf } from "./scripts";
import { stateCheck } from "./stateCheck";
import { findInstance, type CardInstance, type DeclaredAttack, type GameState, type Position, type WorkItem } from "./state";
import { runTrapWindow } from "./traps";
import { cardsInTriggerOrder, queueTrigger, triggersOnEvent, type SettleSink } from "./triggers";
import { moveSourcedModifiers } from "./modifiers";
import { leftFieldSince } from "./stays";
import { owe, registerWorkHandler } from "./work";
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
 * Reborn body included, entered it on that turn like any other (R83), and so does a unit whose
 * controller changed this turn (R171, through `enterNewSide` below), so this is the one comparison.
 */
export function isSick(state: GameState, unit: CardInstance): boolean {
  return unit.summonedTurn === state.turn;
}

/**
 * R171: a card whose controller changes has entered its new controller's side on this turn — §4.1's
 * "entered the field" for `isSick`, and a fresh exertion for its new controller. Every path that
 * changes control on the field calls this at the moment it emits `controlChanged`, for every card
 * that changes sides (a card dormant under a Stack and a backrow card included), and for nothing
 * else: a card moving along its own side has not entered anything.
 *
 * `from` is the controller the card had before. A player modifier a permanent installed and still
 * owns (#79 Twinspell's "the next Spell you play gains Echo +1", `sourceId`) is that permanent's
 * lasting effect (§5.1), and §8's conventions read its "you" as the controller, so it follows the
 * card to its new side rather than staying with the player it left.
 */
export function enterNewSide(sink: EngineSink, card: CardInstance, from: PlayerId): void {
  card.summonedTurn = sink.state.turn;
  card.exertion = { attacked: false, switched: false };
  moveSourcedModifiers(sink, card.id, from, card.controller);
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

/** §4.2 step 2's two possibilities as one id: an enemy unit's instance id, or `hero-<player>`. */
const HERO_TARGET_PREFIX = "hero-";

function targetIdOf(target: AttackTarget): string {
  return target.kind === "unit" ? target.instance.id : `${HERO_TARGET_PREFIX}${target.player}`;
}

/**
 * The inverse of `targetIdOf`: the target an `attackDeclared` event or an open `declaredAttack`
 * names. Exported because the ids are all a paused attack and a trap trigger have to go on — #96
 * My Pawn reads the event, and §4.2 step 5 reads the state back after the window — and because the
 * `hero-<player>` spelling is this module's, so nobody else should be parsing it.
 */
export function attackTargetOf(state: GameState, targetId: string): AttackTarget | null {
  if (targetId.startsWith(HERO_TARGET_PREFIX)) {
    const named = targetId.slice(HERO_TARGET_PREFIX.length);
    const player = PLAYER_IDS.find((id) => id === named);
    return player === undefined ? null : { kind: "hero", player };
  }
  const unit = findInstance(state, targetId);
  return unit === undefined ? null : { kind: "unit", instance: unit };
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

// ---------------------------------------------------------------------------
// §4.2 step 4: the trap window between the declaration and the damage (R44, R100, R113, R117)
// ---------------------------------------------------------------------------

/**
 * R113: the `resume.hook` of the one work item this module parks — the rest of an attack whose
 * step 4 window a prompt interrupted. It is an engine sequence and not a card's, so the name is one
 * no `Script` can hold, and `runOwedAttack` below is registered for it at module scope, the way
 * `traps.ts` registers its window and `turn.ts` its two boundaries. `work.runWorkItem` raises on a
 * hook nothing knows, and an attack that cannot be resumed is exactly the lost sequence that rule
 * exists to prevent: a declaration that spent an exertion and never became damage.
 */
export const ATTACK_WINDOW_WORK = "@attackWindow";

/** The window owes one step: §4.2 step 5, the combat the declaration has not resolved yet. */
const ATTACK_COMBAT_STEP = "combat";

/**
 * R100: "an event the window is scheduled to deliver is not also offered to the immediate trap
 * check". The window below delivers `attackDeclared` itself, so §10.3's frontier must not deliver
 * it a second time — a trap that declined a non-lethal swing would otherwise be offered the same
 * declaration again *after* the damage, against a hero the attack has already hit, and a Field Trap
 * would answer one declaration twice.
 *
 * `triggers.ts` copies events out of `sink.events` into `state.dispatch` starting at
 * `sink.dispatched`, so advancing that cursor past this event is precisely "the frontier has taken
 * it" — it has, into this window. R100's own mechanism (`traps.TRAP_WINDOW_EVENTS`) cannot serve
 * here: it withholds an event *type*, and a forced attack's `attackDeclared` opens no window (R121)
 * and must keep reaching the immediate check like any other event a card's effect list emits.
 *
 * The cursor is at the event on every path that opens a window: `reduce` hands an `attack` action a
 * sink whose event list it has not touched, and `reduce` is the only production caller. A sink a
 * test has already run a combat on is the one other shape; there the cursor is behind, and moving
 * it would silently drop the events in between, so the event is left on the frontier instead.
 */
function withholdFromFrontier(sink: SettleSink, at: number): void {
  if ((sink.dispatched ?? 0) !== at) return;
  sink.dispatched = at + 1;
}

/**
 * The ordinary (non-trap) triggers on the declaration, queued in R68's order. This is the second
 * half of `triggers.dispatchEvent`; its first half is the immediate trap check, which §4.2 step 4
 * replaces with the window, so calling `dispatchEvent` itself would offer the event to the traps a
 * second time. Queueing only reads the board, so it cannot pause, and the entries pop in the
 * caller's own resolution loop — after the combat, exactly where they popped before step 4 existed.
 */
function queueDeclarationTriggers(sink: EngineSink, event: GameEvent): void {
  for (const holder of cardsInTriggerOrder(sink.state)) {
    if (holder.isTrap) continue;
    for (const def of triggersOnEvent(holder, event.type)) queueTrigger(sink, holder, def, event);
  }
}

/**
 * Park the rest of the attack (R113). `work.ts` owns `state.work`, so this only ever calls `owe`:
 * the item lands at `state.workCursor`, which `traps.runTrapWindow` has just advanced past the
 * traps *it* still owes, so the window finishes before the combat it precedes. Nothing is held but
 * the declaration's id, which is plain JSON, so the paused attack survives a round trip.
 *
 * R117: this is called at the moment the window pauses and never in advance. While `declareAttack`
 * is on the stack the combat is `declareAttack`'s alone, so a resolution loop running *inside* the
 * window — My Pawn's AI playout drives `reduce`, which settles — can neither take nor re-run it.
 * Pre-parking a sequence's continuation is what made a played card's Cry fire twice (R1, R117).
 */
function oweDeclaredAttack(sink: EngineSink, id: string): void {
  owe(sink, {
    defId: "",
    hook: ATTACK_WINDOW_WORK,
    step: ATTACK_COMBAT_STEP,
    radiant: false,
    data: { declaredAttack: id },
  });
}

/** Close the window, if this declaration is still the one that holds it open. */
function closeWindow(state: GameState, id: string): DeclaredAttack | null {
  const open = state.declaredAttack;
  if (open === null || open.id !== id) return null;
  state.declaredAttack = null;
  return open;
}

/**
 * §4.2 step 5, once step 4's window has closed: resolve the combat the declaration still owes, then
 * run the state check.
 *
 * The attacker and the target are read back out of `state.declaredAttack` by id rather than from
 * the caller's own variables, because the window can have replaced every instance in the state:
 * R44's AI turn drives `reduce`, which clones, and `subsystems/aiPolicy.adoptState` copies the
 * clone back field by field. Ids survive that; object references do not.
 *
 * R94 is untouched. "Both units' attack is read at the start of the combat" — that read is
 * `resolveCombat`'s, and the combat starts here, after the window. Nothing reads either attack
 * before it, so a trap that buffed or shrank a unit inside the window is read once, in the right
 * order, and a First Strike survivor is still struck back with the attack the defender had when the
 * combat began.
 */
function resolveDeclaredAttack(sink: EngineSink, id: string): void {
  const state = sink.state;
  // A window opened inside this one owns the field now, and this declaration is over either way.
  // The only Core shape is My Pawn handing the turn to the AI policy, which cancels first (R44).
  const open = closeWindow(state, id);
  if (open === null || open.cancelled) return;
  if (state.result !== null) return;

  const attacker = findInstance(state, open.attackerId);
  if (attacker === undefined) return;
  const target = attackTargetOf(state, open.targetId);
  if (target === null) return;

  resolveCombat(sink, attacker, target);
  stateCheck(sink);
}

/** `work.ts`'s handler for a parked attack: the same attack, continued where it stopped (R113). */
function runOwedAttack(sink: EngineSink, item: WorkItem): void {
  const id: unknown = item.resume.data.declaredAttack;
  if (typeof id !== "string") return;
  resolveDeclaredAttack(sink, id);
}

registerWorkHandler(ATTACK_WINDOW_WORK, runOwedAttack);

/**
 * The player's attack: §4.2 steps 1 to 5. Validation first, then step 4 — the exertion, then the
 * trap window — and only then step 5's combat and state check.
 *
 * Step 4 in full: "Declaring the attack has now spent the attacker's exertion, before any damage.
 * Trap window: My Pawn checks whether the hit would be lethal and, if so, cancels the attack; the
 * exertion is not given back, so the attack is gone either way (R44)." So the declaration goes into
 * `state.declaredAttack` before any trap sees it — that record is what `effects/combat.cancelAttack`
 * marks (§6.3 "Cancel an attack") — and the traps are offered the event through
 * `traps.runTrapWindow`, the same scheduled-window entry point §2.2's end-of-turn window uses. That
 * is not an analogy: it is the one implementation, so the ordering, the R68 side order and, above
 * all, R113's parking of the traps a prompt stopped the window from reaching are shared rather than
 * re-derived here.
 *
 * A trap in the window can prompt its controller, so the rest of the attack is a resumable sequence
 * like the two turn boundaries: at the moment the window pauses, and never before it (R117), the
 * combat is owed to `state.work` and `runOwedAttack` above picks it up when the answer drains the
 * queue. `state.work` is drained ahead of the trigger queue, and the traps the window still owes
 * are parked on `state.work` too, in front of the combat — which is why the window uses
 * `runTrapWindow` rather than `triggers.dispatchEvent`, whose remainder would wait *behind* the
 * combat in the trigger queue and so fire after the damage it exists to pre-empt.
 */
export function declareAttack(sink: EngineSink, attacker: CardInstance, target: AttackTarget): CombatResult {
  const state = sink.state;
  const refusal = whyCannotAttack(state, attacker, target);
  if (refusal !== null) return { error: refusal };

  // Step 4's first sentence. R44 never gives this back, so a cancelled attack is gone either way.
  attacker.exertion.attacked = true;

  const targetId = targetIdOf(target);
  const declared: DeclaredAttack = {
    id: `d${state.nextSeq}`,
    attackerId: attacker.id,
    targetId,
    cancelled: false,
  };
  state.nextSeq += 1;
  state.declaredAttack = declared;

  const event: GameEvent = { type: "attackDeclared", attackerId: attacker.id, targetId, forced: false };
  const at = sink.events.length;
  sink.events.push(event);
  withholdFromFrontier(sink, at);

  // Step 4's second sentence: the traps answer the declaration, before any damage.
  runTrapWindow(sink, event);
  queueDeclarationTriggers(sink, event);

  if (state.result !== null) {
    // The window ended the game; there is no step 5 and nothing to resume into.
    closeWindow(state, declared.id);
    return {};
  }
  if (state.pending !== null) {
    oweDeclaredAttack(sink, declared.id);
    return {};
  }

  resolveDeclaredAttack(sink, declared.id);
  return {};
}

/**
 * A forced attack (Moths to the Flame, Bear Honeypot): §4.2's last paragraph and R53. It skips
 * steps 1 to 3, so position, sickness and the Taunt rule do not apply, and it spends no exertion, so
 * the unit may still take its own attack on its own turn. The target still strikes back, and the
 * combat is followed by its own state check.
 *
 * R121 — AND IT OPENS NO TRAP WINDOW. Step 4 is one sentence about spending the attacker's exertion
 * and one about the window that answers the declaration, and a forced attack has neither half: R121
 * says in as many words that it "is declared by the effect, not the player … so it is not 'the
 * opponent declaring an attack'", and §6.3's Cancel-an-attack row is "call off an attack already
 * declared", which is the player's declaration and not a compulsion. So `state.declaredAttack` stays
 * null here and nothing can cancel a forced attack — which is also what #96 already says, since its
 * `when` refuses every event carrying `forced`.
 *
 * The engineering reading agrees with the rules one. A window here would open inside a card's
 * effect list, where a trap's prompt would split the list §10.3 calls one unit of work, and where
 * `forceAttacksOn`'s run would have to become a second resumable sequence — for a window no Core
 * card can fire in. Nothing is lost by leaving it out: the `attackDeclared` event a forced attack
 * emits still reaches the traps through §10.3's immediate check, exactly as it does today, because
 * the withholding above is per declaration rather than per event type.
 */
export function forceAttack(sink: EngineSink, attacker: CardInstance, target: AttackTarget): void {
  const state = sink.state;
  if (state.result !== null) return;
  if (!isActiveOnField(state, attacker)) return;
  if (target.kind === "unit" && !isActiveOnField(state, target.instance)) return;
  // R173: the compulsion waives position, sickness and Taunt (R53), never whose side the target is
  // on. A target that is not this attacker's enemy — it changed sides mid-run, or had crossed to
  // the attacker's side before the run began — is not attacked, and the attacker is passed over in
  // silence, as R96 passes over one that is gone.
  if (!isEnemyOf(attacker, target)) return;

  sink.events.push({
    type: "attackDeclared",
    attackerId: attacker.id,
    targetId: targetIdOf(target),
    forced: true,
  });

  resolveCombat(sink, attacker, target);
  stateCheck(sink);
}

/** §4.2 step 2: an attack is made on an enemy unit or the enemy hero, forced or not (R173). */
function isEnemyOf(attacker: CardInstance, target: AttackTarget): boolean {
  const enemy = opponentOf(attacker.controller);
  return target.kind === "hero" ? target.player === enemy : target.instance.controller === enemy;
}

/**
 * R53: the named units attack the named target one at a time, in the order given (lane order, as
 * `activeUnitsOf` reports it), each its own combat with its own state check, and the sequence stops
 * as soon as the target is no longer on the field — and R174 has a target that left and came back
 * (a Reborn body) count as gone, since what is standing there now is a new arrival (R83).
 */
export function forceAttacksOn(sink: EngineSink, attackers: readonly CardInstance[], target: AttackTarget): void {
  const from = sink.events.length;
  for (const attacker of attackers) {
    if (sink.state.result !== null) return;
    if (target.kind === "unit") {
      if (!isActiveOnField(sink.state, target.instance)) return;
      if (leftFieldSince(sink.events, from, target.instance.id)) return;
    }
    forceAttack(sink, attacker, target);
  }
}
