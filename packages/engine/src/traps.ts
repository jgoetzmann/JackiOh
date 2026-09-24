// Trap matching and immediate resolution (SPEC §5.1, §10.3, §2.2's end-of-turn window; BUILD M3-T2).
//
// §10.3: "Traps are checked before other triggers because they are responses (the end-of-turn trap
// window of §2.2 is the one scheduled exception, R62); a trap that fires during the opponent's turn
// resolves to completion (including forced attacks and prompts for the trap's owner) before the
// opponent's action continues."
//
// This module owns four things and nothing else:
//   1. matching  — which backrow traps watch a given event (`trapsWatching`), in R68 order;
//   2. firing    — emit `trapFired`, run the trigger to completion, run the state check
//                  (`fireTrapsFor`, `runTrapWindow`);
//   3. consuming — a Trap goes to its owner's graveyard, a Field Trap stays and is face-up (R33)
//                  (`consumeTrap`);
//   4. owing     — a window a prompt interrupted parks the traps that have not seen the event yet
//                  on `state.work`, so the answer finishes the window (`TRAP_WINDOW_WORK`, R113),
//                  and a trap whose own list asks parks the rest of its firing — its other
//                  triggers, its consumption and its check — behind that list (`TRAP_FIRING_WORK`).
//
// The *when* is the caller's: `triggers.ts` offers every freshly emitted event to `fireTrapsFor`
// before it queues any ordinary trigger, and `turn.ts` calls `runTrapWindow` at R62's scheduled
// point — after the end-of-turn triggers and before the end-of-turn delayed effects. R17's two
// moments are likewise the play pipeline's (§10.5): Sheepish fires on the `summoned`/`cardPlayed`
// pair emitted at step 4, before the Cry of step 5; Bear Honeypot, Unstable Clone Machine and
// Unlicensed Experimentation fire on `cardResolved`, which step 7 emits once per play or cast after
// the Cry and every Echo repeat, and whose `permanent` flag is R61's "played permanents only".
// `cardResolved` needs no list here — a trigger that names an event type is matched on it — but it
// does need R119: a trap is a played card too, so `trapsWatching` never offers a trap the arrival
// event that names the trap itself. And it travels the immediate path alone: R100 keeps the
// scheduled window's events to the window, and `cardResolved` is not one of them.
//
// A window is a sequence that can span a prompt, so it is resumable through `state.work` and
// through nothing else (§9.3, R113). Neither of the two dispatch paths may ever *drop* an event it
// has not finished delivering: the immediate one owes the rest of its traps as `triggers.ts`'s
// front-of-queue `OWED_TO_TRAPS` entry, and the scheduled window owes its remainder here as a
// `TRAP_WINDOW_WORK` item — the event plus the ids of the traps still to be offered it, all plain
// JSON. A bare `if (state.pending !== null) return;` would be the bug and not the fix: it strands
// the rest of the window with no way back, which is worse than firing late.

import type { GameEvent, GameEventType, PlayerId } from "@jackioh/shared";
import { defOf } from "./catalog";
import { applyResumable } from "./prompts";
import { makeContext, type EngineSink } from "./resolve";
import type { TriggerDef } from "./script";
import { scriptOf } from "./scripts";
import { stateCheck } from "./stateCheck";
import { eventMark, exitMark, leftFieldAfter, type LaterMoves } from "./stays";
import { findInstance, type CardInstance, type DeclaredAttack, type GameState, type Resume, type WorkItem } from "./state";
import { EVENT_KEY, owe, oweUnnumbered, paused as isPaused, registerWorkHandler } from "./work";
import { slotOf } from "./zones";
import { cardAt, moveToZone, slotsOf } from "./zones";

/**
 * A trap trigger, and the two rows that settle what firing means.
 *
 * R99: a trap fires when its trigger's `on` matches the event **and** its `when` predicate admits
 * it. The predicate is kept out of the effect list on purpose, because R61 makes `run` returning
 * `[]` mean "fired, consumed, did nothing" — so a trap whose condition simply was not met cannot
 * say so through `run` and would be spent by an event it should ignore. A condition that must leave
 * the trap armed (Bear Honeypot's "costing 1 or less", My Pawn's "would be lethal", Sheepish's
 * own-side summon, Unlicensed Experimentation's "whose type matches one you control") therefore
 * belongs in `when`, never in `run`. A trigger that declares no predicate answers every event it
 * names, whichever side caused it (R99), and with the predicate satisfied an empty effect list
 * still spends the trap (R61).
 *
 * `when` is declared on `script.ts`'s `TriggerDef` now, so this alias adds nothing to it: reading
 * the predicate below is the declared contract, not a structural workaround. The name stays because
 * the card files annotate their trap triggers with it (#18, #41, #60, #71, #85, #96).
 */
export type TrapTrigger = TriggerDef;

/** One trap and the triggers of its own script that this event woke. */
export type TrapMatch = {
  trap: CardInstance;
  triggers: TrapTrigger[];
};

/** What a dispatch did: the traps that fired, and whether a prompt paused the rest (§10.3). */
export type TrapDispatch = {
  /** Instance ids, in the order they resolved. */
  fired: string[];
  /** A prompt (or the end of the game) stopped the dispatch before it finished. */
  paused: boolean;
};

/**
 * A dispatch as the module reads it internally: `owed` names the traps the pause stopped it from
 * offering the event to at all, which is what a resume needs and what neither caller may guess by
 * subtracting `fired` — a trap whose `when` declined has seen the event and is not owed it again.
 */
type TrapRun = TrapDispatch & { owed: string[] };

/**
 * R212: the player each trap a dispatch offers the event to answers it for — the one who controlled
 * it when the event happened, read as the dispatch begins and kept, like the owed list, across any
 * pause. A trap an earlier effect stole between the event and its dispatch — a cast's events wait
 * for the list that cast it (R70), and the end-of-turn window offers `turnEnded` to one trap after
 * another (R62) — still answers for the player who held it then, and its tokens are theirs (R52).
 */
export type TrapControllers = Record<string, PlayerId>;

/**
 * An immediate dispatch, as `triggers.ts` parks and resumes it: the traps still owed the event, in
 * the order the dispatch offered it (R68, fixed as it began), who each answers for, and the stays
 * it began with (R174).
 */
export type ImmediateDispatch = TrapDispatch & { owed: string[]; controllers: TrapControllers; mark: number };

/**
 * R113: the `resume.hook` of the one work item this module parks — the rest of an end-of-turn trap
 * window. It is an engine sequence, not a card's, so the name is one no `Script` can hold, and
 * `runOwedWindow` below is registered for it: `work.runWorkItem` throws on a hook nothing knows,
 * and a window that cannot be resumed is exactly the lost sequence that rule exists to prevent.
 */
export const TRAP_WINDOW_WORK = "@trapWindow";

/** The window has one step, named so a reader of `state.work` can see what is owed. */
const TRAP_WINDOW_STEP = "window";

/** What a parked window carries: the event it is delivering, and who has not seen it yet. */
export type OwedWindow = {
  event: GameEvent;
  /** Instance ids of the traps the window still has to offer the event to, in R68 order. */
  owed: string[];
  /** R212: who each of them answers for — its controller when the window opened. */
  controllers?: TrapControllers;
  /** R174: the field's departures when the window opened (`stays.exitMark`). */
  mark?: number;
};

/**
 * R100: the events the *scheduled* end-of-turn window owns. An event the window is scheduled to
 * deliver is not also offered to the immediate check, so Bread and Butter and Intern Stimmy fire
 * once per turn end, in the window, on both sides — and not a second time as ordinary responses.
 * This list is the whole of that withholding, and R62's end-of-turn order depends on it.
 */
export const TRAP_WINDOW_EVENTS: readonly GameEventType[] = ["turnEnded"];

export function isTrapWindowEvent(event: GameEvent): boolean {
  return TRAP_WINDOW_EVENTS.includes(event.type);
}

/** §5.1: a Field Trap is a Trap that stays after firing, so both are "a Trap" (R61). */
export function isTrapType(state: GameState, instance: CardInstance): boolean {
  const type = defOf(state, instance.defId).type;
  return type === "Trap" || type === "Field Trap";
}

export function isFieldTrap(state: GameState, instance: CardInstance): boolean {
  return defOf(state, instance.defId).type === "Field Trap";
}

function isOnField(instance: CardInstance): boolean {
  return instance.zone.z === "field";
}

/**
 * Every trap on the field, in R68 order: the active player's cards first, then the opponent's, each
 * side's backrow by lane 1–5. Traps only ever occupy backrow zones (§5.1), so the unit lanes of
 * R68's order hold none.
 */
export function trapsInOrder(state: GameState): CardInstance[] {
  const sides: PlayerId[] = state.active === "p1" ? ["p1", "p2"] : ["p2", "p1"];
  return sides.flatMap((player) =>
    slotsOf(player, "backrow").flatMap((ref) => {
      const card = cardAt(state, ref);
      return card !== null && isTrapType(state, card) ? [card] : [];
    }),
  );
}

function trapTriggersOf(trap: CardInstance): TrapTrigger[] {
  return scriptOf(trap).triggers ?? [];
}

/**
 * R119: the events that say a card arrived. A card does not answer the play that put it onto the
 * field. Not because it was absent when the play began — §10.5 step 4 places it and only then emits
 * `cardPlayed`, so it is already a registered watcher by the time its own arrival is dispatched.
 * The exclusion is deliberate, and for traps it lives here: a trap is never offered the
 * `cardPlayed`, `summoned` or `cardResolved` event that names the trap itself. R17's two moments are
 * both in this list, which is why the rule belongs here and not in each card's predicate: Sheepish
 * answers step 4's `summoned`/`cardPlayed` pair, and Bear Honeypot, Unstable Clone Machine and
 * Unlicensed Experimentation answer step 7's `cardResolved` — and a Trap or Field Trap is itself a
 * card someone plays, so without this a trap watching either moment answers its own arrival.
 */
const ARRIVAL_EVENTS: readonly GameEventType[] = ["cardPlayed", "summoned", "cardResolved"];

function isOwnArrival(trap: CardInstance, event: GameEvent): boolean {
  if (!ARRIVAL_EVENTS.includes(event.type)) return false;
  const about: unknown = (event as { instanceId?: unknown }).instanceId;
  if (about === trap.id) return true;
  // R119: nor the play the trap arrived on the field during, whatever put it there — #95 summoning a
  // Bear Honeypot face-down does not have that Honeypot answer #95's own `cardResolved`, and a
  // Sheepish a tributed Cube's Death copied at step 2 does not answer the `cardPlayed` of the play
  // that paid the Tribute.
  return arrivedDuringPlay(event).includes(trap.id);
}

/** R119: the arrivals a play's `cardPlayed`, `summoned` or `cardResolved` names, which it does not answer. */
export function arrivedDuringPlay(event: GameEvent): readonly string[] {
  if (event.type === "cardPlayed" || event.type === "summoned" || event.type === "cardResolved") {
    return event.arrivedDuring ?? [];
  }
  return [];
}

/**
 * The traps this event woke, matched by the event type each trigger names. This is matching only:
 * a `when` predicate needs an `EffectContext`, so it is evaluated when the trap fires.
 *
 * Any event type a trigger names is matched, `cardResolved` included — R17's "after the card
 * resolves", which §10.5 step 7 emits once per play or cast. It reaches the traps through the
 * immediate path (`fireTrapsFor`), never the scheduled one: R100 keeps the two disjoint, and only
 * `TRAP_WINDOW_EVENTS` belongs to the window.
 */
export function trapsWatching(state: GameState, event: GameEvent): TrapMatch[] {
  return trapsInOrder(state).flatMap((trap) => {
    if (isOwnArrival(trap, event)) return [];
    if (isSpent(state, trap)) return [];
    const triggers = trapTriggersOf(trap).filter((trigger) => trigger.on.includes(event.type));
    return triggers.length === 0 ? [] : [{ trap, triggers }];
  });
}

/**
 * §5.1: a Trap "fires …, then goes to the graveyard"; only a Field Trap "stays after firing and can
 * fire again". A Trap is face-down until it fires (R33), so a face-up one that is still in the
 * backrow is one whose firing has not finished — #96 My Pawn's effects are a whole AI turn — and it
 * answers nothing more: it has fired, and firing is once. `fireTrap` turns it face-up before its
 * effects run for exactly this reason.
 */
export function isSpent(state: GameState, trap: CardInstance): boolean {
  return trap.faceUp === true && !isFieldTrap(state, trap);
}

/**
 * §3.2: "backrow cards go to the owner's graveyard when their effect ends (traps after firing
 * unless Field Trap)". R33: a Field Trap that has fired is face-up to both players from then on.
 * R61 makes this unconditional: a trap that fired is consumed whether or not its effects achieved
 * anything, so the caller never asks what the effect list managed to do.
 */
export function consumeTrap(sink: EngineSink, instance: CardInstance): void {
  instance.faceUp = true;
  if (isFieldTrap(sink.state, instance)) return;

  const moved = moveToZone(sink.state, instance, "graveyard");
  if (moved !== "moved") return;
  sink.events.push({
    type: "enteredGraveyard",
    instanceId: instance.id,
    defId: instance.defId,
    owner: instance.owner,
  });
}

/**
 * R152, §3.2, §5.1: #96 My Pawn's effect is the rest of the turn it handed to the AI, so that
 * effect ends at the cleanup of that turn (`turn.ts` calls this there) — and a Trap "goes to the
 * graveyard" when its effect ends. The trap is still face-up in its backrow (`isSpent`), because
 * `fireTrap` is still on the stack underneath the AI's playout, and the next turn begins inside that
 * same playout: consuming it only once the playout returns left it in the backrow through the
 * opponent's start of turn, where #37 Gravedigger could not find it in the graveyard. A trap its own
 * AI turn moved off the field (exiled, destroyed) is no longer in a backrow and is not touched.
 */
export function endHandedOverTurn(sink: EngineSink): void {
  for (const trap of trapsInOrder(sink.state)) {
    if (isSpent(sink.state, trap)) consumeTrap(sink, trap);
  }
}

/**
 * Fire one trap: emit `trapFired`, run every trigger of its that this event woke, run the state
 * check so the trap has resolved to completion, then consume it. The trap is consumed whatever its
 * effects achieved — an Immutable Sheepish target or a Fuse with no legal target still spends it
 * (R17, R61). Returns false when no trigger's `when` admitted the event, which leaves the trap
 * armed and face-down (R99) — the one outcome that is not a firing.
 */
export function fireTrap(
  sink: EngineSink,
  match: TrapMatch,
  event: GameEvent,
  controller: PlayerId = match.trap.controller,
): boolean {
  const trap = match.trap;
  const ctx = makeContext(sink, trap, { controller });
  const armed = match.triggers.filter(
    (trigger) => trigger.when === undefined || trigger.when({ ...ctx, event }),
  );
  if (armed.length === 0) return false;

  // R154: the zone is read before the trap resolves, because firing it can move the card — a Trap
  // reaches its owner's graveyard on consumption and would then have no slot to report.
  const at = slotOf(sink.state, trap);
  // `controller` names the seat that reads the trap's identity (R154), and a trap stolen since the
  // event is face-down on its new controller's side: the flip is announced to the seat it sits on.
  sink.events.push({
    type: "trapFired",
    instanceId: trap.id,
    defId: trap.defId,
    controller: trap.controller,
    row: at?.row ?? "backrow",
    lane: at?.lane ?? 0,
  });

  // §5.1: it has fired, and it is face-up from this moment (R33) — which also keeps it out of every
  // dispatch its own effects start, since a Trap fires once (`isSpent`).
  trap.faceUp = true;
  runArmedTriggers(sink, {
    trapId: trap.id,
    // R212, R52: everything the trap does is the player's it answered for.
    controller,
    triggers: armed.map((trigger) => trigger.id),
    at: 0,
    event,
  });
  return true;
}

/**
 * What is left of one trap's firing: its armed triggers from `at` on, then its end — consumed, and
 * the state check that makes it "resolve to completion" (§10.3). All JSON, so a firing a prompt
 * interrupted is owed on `state.work` as `TRAP_FIRING_WORK` and survives the answer (R113).
 */
type TrapFiring = {
  trapId: string;
  controller: PlayerId;
  triggers: string[];
  at: number;
  event: GameEvent;
};

/**
 * R113: the `resume.hook` of a trap's firing that a prompt interrupted — the triggers it has not
 * run and its end. §10.3 has a trap "resolve to completion (including … prompts for the trap's
 * owner) before the opponent's action continues", and a trap's list is an effect list like any
 * other, so it runs resumably: the effects after one that asks are parked by
 * `prompts.applyResumable` (re-entered by the trigger's id, `work.scriptStepFor`), and this item
 * behind them owes the rest. Running the list straight through walked on over the open prompt,
 * dropped a second one (`openPrompt` never overwrites) and consumed the trap and ran the check in
 * the middle of its effect.
 */
export const TRAP_FIRING_WORK = "@trapFiring";

/**
 * The armed triggers of one firing, from `firing.at`, each with the trap's controller as "you"
 * (R52), then the trap's end. Stops at a pause and owes the rest (R117: at the pause, never before).
 */
function runArmedTriggers(sink: EngineSink, firing: TrapFiring): void {
  for (let at = firing.at; at < firing.triggers.length; at += 1) {
    if (sink.state.result !== null) return;
    const trap = findInstance(sink.state, firing.trapId);
    const trigger = trap === undefined ? undefined : trapTriggersOf(trap).find((def) => def.id === firing.triggers[at]);
    if (trap === undefined || trigger === undefined) continue;
    const ctx = makeContext(sink, trap, { controller: firing.controller, data: { [EVENT_KEY]: firing.event } });
    const before = sink.state.pending;
    const plan = {
      defId: trap.defId,
      hook: trigger.id,
      step: "",
      radiant: trap.radiant,
      instanceId: trap.id,
      data: { [EVENT_KEY]: firing.event },
      owner: firing.controller,
    };
    const withEvent = { ...ctx, event: firing.event };
    applyResumable(sink, withEvent, plan, trigger.run(withEvent));
    if (sink.state.result !== null) return;
    if (sink.state.pending !== null && sink.state.pending !== before) {
      oweFiring(sink, { ...firing, at: at + 1 });
      return;
    }
  }
  endFiring(sink, firing.trapId);
}

/**
 * The end of a firing: the trap consumed and the state check run (§3.2, §10.3).
 *
 * R216: once the trap's effect has ended the game (#96's AI turn ran to an end-of-turn hit that
 * killed a hero) nothing happens after it — the trap is not consumed afterwards.
 *
 * R52: everything the trap did belongs to the trap's controller, whoever caused the event. §3.2
 * sends a backrow card to its owner's graveyard when its effect ends, so the trap is consumed where
 * it is NOW — found again by id, because #96 My Pawn's AI turn replaces every instance in the state
 * (`aiPolicy.adoptState`). Only a trap still on the field is consumed: one its own effects moved off
 * it — exiled by the AI's #34 Collateral Damage, destroyed — is where that move put it, and exile is
 * a pile nothing takes a card back out of (§6.3). One whose turn-long effect has already ended was
 * consumed by `turn.cleanup` at the end of that turn (R152) and is in the graveyard by now.
 */
function endFiring(sink: EngineSink, trapId: string): void {
  if (sink.state.result !== null) return;
  const live = findInstance(sink.state, trapId);
  if (live !== undefined && isOnField(live)) consumeTrap(sink, live);
  stateCheck(sink);
}

function oweFiring(sink: EngineSink, firing: TrapFiring): void {
  const resume: Resume = {
    defId: "",
    hook: TRAP_FIRING_WORK,
    step: "firing",
    radiant: false,
    data: { firing: JSON.parse(JSON.stringify(firing)) as TrapFiring },
  };
  owe(sink, resume);
}

/** `work.ts`'s handler for a firing a prompt interrupted: the same trap, where it stopped (R113). */
function runOwedFiring(sink: EngineSink, item: WorkItem): void {
  const raw: unknown = item.resume.data.firing;
  if (raw === null || typeof raw !== "object") return;
  const firing = raw as Partial<TrapFiring>;
  if (typeof firing.trapId !== "string" || typeof firing.at !== "number") return;
  if (!Array.isArray(firing.triggers) || firing.event === undefined) return;
  if (firing.controller !== "p1" && firing.controller !== "p2") return;
  runArmedTriggers(sink, firing as TrapFiring);
}

registerWorkHandler(TRAP_FIRING_WORK, runOwedFiring);

/**
 * R220: whether an open declaration still stands as it was declared — its attacker on the field on
 * the stay that declared it and still its declarer's, and its target still that attacker's enemy on
 * the stay it was declared on. `combat.ts` owns what an attack is and registers the check at module
 * scope, like the cast driver (`resolve.registerCastDriver`): it sits above this module, which it
 * imports, so the layering forbids calling it directly. Unregistered, a declaration stands.
 */
export type DeclarationCheck = (state: GameState, open: DeclaredAttack) => boolean;

let attackStands: DeclarationCheck = () => true;

/** Registered by `combat.ts` at module scope. Returns the check it replaced. */
export function registerDeclarationCheck(check: DeclarationCheck): DeclarationCheck {
  const previous = attackStands;
  attackStands = check;
  return previous;
}

/**
 * §4.2 step 4, §6.3 "Cancel an attack": the window a declaration opens answers that declaration,
 * and only while it stands. Once a trap has cancelled it (R44), or the window has closed — #96's AI
 * turn can end the turn, and every declaration the AI makes opens and closes its own — there is no
 * attack left to answer: a cancelled attack resolves no combat, so it "would be lethal" to nobody,
 * and a second My Pawn stays armed and face-down (R99). The same holds once a trap earlier in the
 * window has destroyed, stolen or moved the attacker or its target (R220): that attack is over, and
 * there is nothing for My Pawn to call off. A forced attack opens no window at all (R121) and is not
 * held back here.
 */
function declarationStands(state: GameState, event: GameEvent): boolean {
  if (event.type !== "attackDeclared" || event.forced) return true;
  const open = state.declaredAttack;
  return (
    open !== null &&
    !open.cancelled &&
    open.attackerId === event.attackerId &&
    open.targetId === event.targetId &&
    attackStands(state, open)
  );
}

/**
 * The match as the board holds it now. A dispatch reads its matches when the window opens, and a
 * trap that fired before this one can have replaced every instance (#96's AI turn, `adoptState`),
 * moved this trap off the field or turned it face-up, so each is found again by id before it is
 * offered the event: a trap no longer on the field, or already spent, never fires (R61, §5.1).
 */
function liveMatch(state: GameState, match: TrapMatch, event: GameEvent): TrapMatch | null {
  const trap = findInstance(state, match.trap.id);
  if (trap === undefined || !isOnField(trap) || !isTrapType(state, trap)) return null;
  if (isSpent(state, trap) || isOwnArrival(trap, event)) return null;
  const triggers = trapTriggersOf(trap).filter((trigger) => trigger.on.includes(event.type));
  return triggers.length === 0 ? null : { trap, triggers };
}

/**
 * R174, R61: the event as a trap later in the same dispatch meets it. `cardResolved`'s `permanent`
 * is step 7's answer to "is the played card still in play", read as the card landed — but the traps
 * that answer the play fire one after another, and an earlier one can take the card off the field
 * before a later one reads the flag: #60 Bear Honeypot's tokens kill it, and it is in its graveyard
 * or back through Reborn by the time the next trap fires. That stay has ended, so the next trap
 * meets a play that is no longer in play: #85 fuses nothing out of a graveyard, and a second #60's
 * tokens do not attack a Reborn body, which is a new arrival (R83). `dispatchMark` is the field's
 * departures when the dispatch began (`stays.exitMark`), which a dispatch a prompt split carries to
 * the traps it still owes (`triggers.runOwedTraps`), so the answer that killed the card counts too —
 * and a play's event carries the mark it happened at (`stays.eventMark`), so what took the card off
 * the field between the event and its dispatch counts as well (R212).
 */
export function standingEvent(sink: EngineSink, event: GameEvent, dispatchMark: number): GameEvent | null {
  // R212: the stay is the one the event happened on. A play's events carry the mark they were
  // emitted at (`stays.eventMark`), which a late dispatch — a cast's `cardResolved` after the rest of
  // the list that cast it, its sweep and the Reborn that put a body back — must not move forward.
  const mark = Math.min(dispatchMark, eventMark(event) ?? dispatchMark);
  if (event.type === "cardPlayed" || event.type === "summoned") {
    // The same for step 4's pair (#41 Sheepish's moment, R17): a trap answering the arrival of a card
    // an earlier trap answering it has already taken off the field meets no card in play, and is not
    // offered the event at all, as #85 is not offered a play that is no longer a permanent in play
    // (R61). Sheepish does not reach into a hand to rewrite the unit the first trap bounced there, or
    // turn the Reborn body of the one it killed into a Sheep: that body is nobody's play (R83).
    return leftFieldAfter(sink.state, mark, event.instanceId) ? null : event;
  }
  if (event.type !== "cardResolved" || !event.permanent) return event;
  const card = findInstance(sink.state, event.instanceId);
  const stays = card !== undefined && isOnField(card) && !leftFieldAfter(sink.state, mark, event.instanceId);
  return stays ? event : { ...event, permanent: false };
}

function dispatch(
  sink: EngineSink,
  event: GameEvent,
  matches: readonly TrapMatch[],
  mark: number,
  controllers: TrapControllers,
): TrapRun {
  const fired: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (match === undefined) continue;
    // §9.3: a prompt is state, so the rest of the dispatch waits for the answer action — and the
    // traps from here on have not seen the event, which is precisely what is owed (R113).
    if (isPaused(sink)) {
      return { fired, paused: true, owed: matches.slice(index).map((rest) => rest.trap.id) };
    }
    // A trap the previous one destroyed, bounced or fused away never fires (R61), and nothing is
    // offered an attack a trap before it has already called off (§6.3).
    if (!declarationStands(sink.state, event)) continue;
    const live = liveMatch(sink.state, match, event);
    if (live === null) continue;
    // R174, R212: a trap that has left the field since the dispatch began and stands there again is
    // a new arrival, on a stay that did not see the event.
    if (leftFieldAfter(sink.state, mark, live.trap.id)) continue;
    const met = standingEvent(sink, event, mark);
    if (met === null) continue;
    if (fireTrap(sink, live, met, controllers[live.trap.id] ?? live.trap.controller)) fired.push(live.trap.id);
  }
  return { fired, paused: isPaused(sink), owed: [] };
}

/** R212: who each trap answers for, read as a dispatch begins — before any of them has fired. */
function controllersOf(matches: readonly TrapMatch[], later?: LaterMoves): TrapControllers {
  const out: TrapControllers = {};
  for (const match of matches) {
    out[match.trap.id] = later?.controllerBefore.get(match.trap.id) ?? match.trap.controller;
  }
  return out;
}

/**
 * §10.3: offer one event to the traps, as the resolution loop dispatches it — some time after it
 * happened, since the loop dispatches an event after whatever ran first. R212 has the traps answer it
 * as the board stood when it happened, which the events owed behind it say (`later`, read only when
 * some trap watches the event): a trap that reached the field since — summoned by the rest of the
 * list whose draw cast the card — is on a stay that did not see it and is not offered it, and one
 * whose controller has changed since answers for the player who held it then. What a prompt stops
 * the dispatch from offering is returned owed, in the order the dispatch had (R68, R113).
 */
export function offerEventToTraps(sink: EngineSink, event: GameEvent, later: () => LaterMoves): ImmediateDispatch {
  const mark = exitMark(sink.state);
  if (isTrapWindowEvent(event)) return { fired: [], paused: false, owed: [], controllers: {}, mark };
  const watching = trapsWatching(sink.state, event);
  if (watching.length === 0) return { fired: [], paused: isPaused(sink), owed: [], controllers: {}, mark };
  const moves = later();
  const matches = watching.filter((match) => !moves.moved.has(match.trap.id));
  const controllers = controllersOf(matches, moves);
  if (isPaused(sink)) {
    return { fired: [], paused: true, owed: matches.map((match) => match.trap.id), controllers, mark };
  }
  return { ...dispatch(sink, event, matches, mark, controllers), controllers, mark };
}

/**
 * Finish an immediate dispatch a prompt interrupted: the traps it still owed, in the order it had
 * (R113 — a fresh scan would put a trap the answer moved onto the active side ahead of one the
 * dispatch had ordered before it), each for the player it answered for (R212), and each meeting the
 * event as the board now stands (`standingEvent`, R174). A trap that met the event before the pause
 * and declined it is not in the list, and is not offered it again (R99).
 */
export function resumeEventToTraps(
  sink: EngineSink,
  event: GameEvent,
  owed: readonly string[],
  mark: number,
  controllers: TrapControllers,
): ImmediateDispatch {
  const matches = owed.flatMap((id) => {
    const trap = findInstance(sink.state, id);
    const live = trap === undefined ? null : liveMatch(sink.state, { trap, triggers: [] }, event);
    return live === null ? [] : [live];
  });
  return { ...dispatch(sink, event, matches, mark, controllers), controllers, mark };
}

/**
 * §10.3: offer one freshly emitted event to the traps, before any ordinary trigger is queued. The
 * whole trap resolves inside this call — forced attacks included (R53) — so the action that emitted
 * the event continues only afterwards. A prompt for the trap's owner stops the dispatch instead:
 * the answer action resumes it, which is what "pauses the opponent's action" means (BUILD M3-T2).
 *
 * R62's window events are withheld: `runTrapWindow` fires those at their scheduled point.
 */
export function fireTrapsFor(sink: EngineSink, event: GameEvent): TrapDispatch {
  if (isTrapWindowEvent(event)) return { fired: [], paused: false };
  if (isPaused(sink)) return { fired: [], paused: true };
  // The remainder of an immediate dispatch is `triggers.ts`'s to park: a trap is a response, so it
  // is owed in front of the trigger queue (`OWED_TO_TRAPS`), not behind the interrupted sequence.
  // Handed an event with nothing owed behind it, the board it meets is the board it happened on.
  const matches = trapsWatching(sink.state, event);
  const run = dispatch(sink, event, matches, exitMark(sink.state), controllersOf(matches));
  return { fired: run.fired, paused: run.paused };
}

// ---------------------------------------------------------------------------
// The end-of-turn window, and the remainder it owes (§2.2, R62, R100, R113)
// ---------------------------------------------------------------------------

/** The event a parked window captured, read back defensively: it came through JSON (§10.1). */
function windowEventOf(data: Record<string, unknown>): GameEvent | null {
  const captured: unknown = data.event;
  if (typeof captured !== "object" || captured === null) return null;
  const type: unknown = (captured as { type?: unknown }).type;
  return typeof type === "string" ? (captured as GameEvent) : null;
}

function owedTrapsOf(data: Record<string, unknown>): string[] {
  const owed: unknown = data.owed;
  return Array.isArray(owed) ? owed.filter((id): id is string => typeof id === "string") : [];
}

/** R212: a parked dispatch's `controllers`, read back defensively (it came through JSON). */
export function trapControllersOf(raw: unknown): TrapControllers {
  if (raw === null || typeof raw !== "object") return {};
  const out: TrapControllers = {};
  for (const [id, player] of Object.entries(raw as Record<string, unknown>)) {
    if (player === "p1" || player === "p2") out[id] = player;
  }
  return out;
}

/** What a `TRAP_WINDOW_WORK` item owes, or null when it is not one: the reader for its payload. */
export function owedWindowOf(resume: Resume): OwedWindow | null {
  if (resume.hook !== TRAP_WINDOW_WORK) return null;
  const event = windowEventOf(resume.data);
  if (event === null) return null;
  const mark = resume.data.mark;
  return {
    event,
    owed: owedTrapsOf(resume.data),
    controllers: trapControllersOf(resume.data.controllers),
    ...(typeof mark === "number" ? { mark } : {}),
  };
}

/**
 * Park the rest of the window (R113). `work.ts` owns `state.work`, so this only ever calls `owe`:
 * the item lands at `state.workCursor`, which puts it behind anything a trap's own effects parked
 * inside it (innermost first) and — when a resumption parks again — in front of everything else
 * still owed. Nothing is held but plain JSON, so the paused window survives a round trip.
 *
 * R117: this is called at the moment the window pauses and never in advance. While `dispatch` is on
 * the stack the traps it has not reached are the dispatch's alone, so a `settle` running inside one
 * of them — a trap's own effects can start one — cannot take the traps the window is standing in.
 */
function oweWindow(
  sink: EngineSink,
  event: GameEvent,
  owed: readonly string[],
  controllers: TrapControllers,
  mark: number,
): void {
  if (owed.length === 0) return;
  const kept: TrapControllers = {};
  for (const id of owed) {
    const player = controllers[id];
    if (player !== undefined) kept[id] = player;
  }
  const resume: Resume = {
    defId: "",
    hook: TRAP_WINDOW_WORK,
    step: TRAP_WINDOW_STEP,
    radiant: false,
    data: { event, owed: [...owed], controllers: kept, mark },
  };
  // R177: the remainder exists only when a trap still owed the event watches it, and whether a
  // face-down one does is its controller's to know (R33), so it takes no number (`oweUnnumbered`).
  oweUnnumbered(sink, resume);
}

/**
 * §2.2 and R62: the end-of-turn trap window. It runs after the end-of-turn triggers and before the
 * end-of-turn delayed effects, and it fires on both sides in R68 order — the ending player's traps
 * first — which is what makes Bread and Butter's token go to the trap's controller whichever player
 * ended the turn with unspent mana (R52).
 *
 * A trap that prompts its controller stops the window where it stands and the rest of it is owed in
 * state, so the answer action delivers the event to the traps that have not seen it — a Field Trap
 * that already fired is not among them, since it fired rather than being passed over (R62, R100).
 * The game ending stops the window for good: there is nothing left to resume into.
 */
export function runTrapWindow(sink: EngineSink, event: GameEvent): TrapDispatch {
  if (sink.state.result !== null) return { fired: [], paused: true };
  const matches = trapsWatching(sink.state, event);
  // R212: the window's event has just happened, so each trap answers for its controller now — and
  // keeps answering for that player when an earlier trap of the window steals it before its turn.
  const controllers = controllersOf(matches);
  const mark = exitMark(sink.state);

  // A prompt already open when the window opens means the window has delivered nothing at all:
  // every matched trap is owed the event. Returning without parking would lose the whole window.
  if (sink.state.pending !== null) {
    oweWindow(sink, event, matches.map((match) => match.trap.id), controllers, mark);
    return { fired: [], paused: true };
  }

  const run = dispatch(sink, event, matches, mark, controllers);
  if (sink.state.result === null) oweWindow(sink, event, run.owed, controllers, mark);
  return { fired: run.fired, paused: run.paused };
}

/**
 * Finish a window a prompt interrupted: offer the event to the traps that were owed it, in the
 * order the window had, and park again if one of those prompts too. The board is re-read only to
 * drop a trap that has left the field since — destroyed, bounced or fused away — which never fires
 * (R61); the owed list is what keeps a trap that already fired from firing twice, which a Field
 * Trap would otherwise do, since firing leaves it on the field (§5.1, R33, R100).
 */
function resumeWindow(sink: EngineSink, parked: OwedWindow): void {
  const { event, owed } = parked;
  const watching = trapsWatching(sink.state, event);
  // The order is the owed list's, not a fresh scan's: R68's sides are read off `state.active`, and
  // the window's order was fixed when it opened (R62 — the ending player's traps, then the
  // opponent's). The board is re-read only to drop what has left the field since (R61).
  const matches = owed.flatMap((id) => {
    const match = watching.find((candidate) => candidate.trap.id === id);
    return match === undefined ? [] : [match];
  });
  const controllers = parked.controllers ?? {};
  const mark = parked.mark ?? exitMark(sink.state);
  const run = dispatch(sink, event, matches, mark, controllers);
  if (sink.state.result === null) oweWindow(sink, event, run.owed, controllers, mark);
}

/** `work.ts`'s handler for a parked window: the same window, continued where it stopped (R113). */
function runOwedWindow(sink: EngineSink, item: WorkItem): void {
  const parked = owedWindowOf(item.resume);
  if (parked === null) return;
  resumeWindow(sink, parked);
}

registerWorkHandler(TRAP_WINDOW_WORK, runOwedWindow);
