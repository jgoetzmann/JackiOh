// A card's stay in a zone, read off the event stream (SPEC §10.3, R174, R212).
//
// §10.3 has every visible state change emit an event, so the events that follow a moment say
// everything that happened to a card since: whether it left the field, whether it has moved zones
// at all, and whether its controller changed. Two questions are asked of them:
//
//   * R174: has a card left the field since this point? A Reborn body is back under the same id by
//     the time the state check returns (§4.5 step 4), so "is it on the field now" cannot tell it
//     from a card that never left; the `destroyed` it went out with can.
//   * R212: did a card arrive where it is now after an event, or change hands after it? The
//     resolution loop hands an event to the triggers some time after it happened — the state check
//     that follows a combat, an Echo repeat or a whole Cry runs first — so the board it is offered to
//     can hold a Reborn body, a card drawn since, or a unit a Death has stolen since. The events
//     still owed behind it say which.
//
// No instance field records a stay: the design keeps `CardInstance` as it is (docs/polish). The
// event stream answers the first question inside one action, but a sequence a prompt splits resumes
// in a later action, whose event list begins after the pause: #68's damage in a crafted Cube +
// Scarab + Sorcerer resumes after the Scarab's Discover, and the sacrifice before it is in the
// action that asked. So R174's question is also kept in state, as the field's departures counted
// (`GameState.fieldExits`): a sequence takes a mark when it begins (`exitMark`) and carries it
// across any pause, and `leftFieldAfter` answers against it whatever action it resumes in.

import type { GameEvent, PlayerId } from "@jackioh/shared";
import { opponentOf } from "@jackioh/shared";
import type { GameState } from "./state";

/** R174: the field's departures so far, as a mark to ask `leftFieldAfter` against later. */
export function exitMark(state: GameState): number {
  return state.fieldExits?.count ?? 0;
}

/**
 * R174, R212: the stays an event happened on, when it carries them — the play pipeline's step-4
 * `cardPlayed` and `summoned` and step 7's `cardResolved` name the played card, and the loop can hand
 * them to a response well after they happened (a cast's `cardResolved` waits for the list that cast
 * it, R70). A reader that aims at the card an event names judges its stay from here: a card that has
 * left the field since, even one back through Reborn by now, is not the card the event is about
 * (R83). Undefined for an event that carries no mark, which is judged from when it is dispatched.
 */
export function eventMark(event: GameEvent): number | undefined {
  if (event.type === "cardPlayed" || event.type === "summoned" || event.type === "cardResolved") {
    return event.exitsFrom;
  }
  return undefined;
}

/**
 * R174, R212: the cards an event names, and the field's departures when it happened — what a
 * queued trigger answering the event carries (`triggers.queueTrigger`, `EffectContext.eventStay`),
 * so a card the event names is aimed at the stay it had then, while every other card the trigger
 * reads off the board as it resolves is judged from when its run began. All JSON.
 */
export type EventStay = { from: number; ids: readonly string[] };

/** Every card id an event names: the card it is about, the source and target of a hit, and so on. */
export function cardsNamedBy(event: GameEvent): string[] {
  const fields = event as Record<string, unknown>;
  const named = CARD_FIELDS.flatMap((field) => {
    const value = fields[field];
    return typeof value === "string" ? [value] : [];
  });
  return event.type === "fused" ? [...named, ...event.instanceIds] : named;
}

const CARD_FIELDS = [
  "instanceId",
  "newInstanceId",
  "resultInstanceId",
  "sourceId",
  "targetId",
  "killerId",
  "attackerId",
  "byInstanceId",
] as const;

/** The stays an event happened on, for a trigger queued on it now (`EventStay`). */
export function eventStayOf(state: GameState, event: GameEvent): EventStay {
  return { from: eventMark(event) ?? exitMark(state), ids: cardsNamedBy(event) };
}

/**
 * R174: a card has just left the field — died, bounced, exiled, returned to a library, or ceased to
 * exist there (replaced by a Transform, fused away). Called from `zones.moveToZone` and
 * `zones.ceaseToExist`, the two funnels every such move goes through, so a reader that names the
 * card by the id an event carried — a trap owed the play of a unit the first Sheepish turned into a
 * Sheep — finds it gone.
 */
export function noteFieldExit(state: GameState, instanceId: string): void {
  const exits = state.fieldExits ?? { count: 0, last: {} };
  exits.count += 1;
  exits.last[instanceId] = exits.count;
  state.fieldExits = exits;
}

/**
 * R174: whether a card has left the field since `mark` — even if it is back on it now, bounced and
 * replayed or returned by Reborn, since what came back is a new arrival (R78, R83). A change of
 * control is not leaving (R171), and neither is a Vanilla (§6.3).
 */
export function leftFieldAfter(state: GameState, mark: number, instanceId: string): boolean {
  return (state.fieldExits?.last[instanceId] ?? 0) > mark;
}

/**
 * R174: whether a card has left the field in the events since `from` — died, was bounced or exiled,
 * or was replaced by a Transform. §10.3 has every visible change emit an event, so this list is the
 * whole of what can take a card off the field.
 */
export function leftFieldSince(events: readonly GameEvent[], from: number, instanceId: string): boolean {
  for (let at = Math.max(0, from); at < events.length; at += 1) {
    const event = events[at];
    if (event === undefined) continue;
    switch (event.type) {
      case "destroyed":
      case "bounced":
      case "exiled":
        if (event.instanceId === instanceId) return true;
        break;
      case "transformed":
        // A Replace puts a new card in the old one's place; a Vanilla (§6.3) names the same card on
        // both sides of the event, and a card whose text went away has not left anything.
        if (event.instanceId === instanceId && event.newInstanceId !== instanceId) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

/**
 * §3.2, R153, R212: a card has just been taken off the field, and `resumed` is the card beneath it in
 * its Stack pile that is the pile's top now, if it was on top of one. A dormant card registers nothing
 * (R153), so the resumed card did not see what happened before it resumed — the death that uncovered
 * it above all — and no event reports a resume, so it is kept here against the card whose leaving
 * caused it, for `uncoveredBy` to read off the events that report that leaving.
 *
 * A note belongs to one removal. It lasts while the report of that removal is still owed to the loop
 * (`noteReported`) and while the card that left has not moved again (`noteMoved`), and goes once
 * both have happened: a later move of the same card — exiled out of the graveyard it died into,
 * discarded, shuffled back — is no removal from a pile's top, so a card that resumed long before is
 * not taken for one that resumed after whatever that move's batch did first. Every removal is such a
 * move, whether or not it uncovers anything.
 */
export function noteUncovered(state: GameState, removedId: string, resumed: string | undefined): void {
  noteMoved(state, removedId);
  if (resumed === undefined) return;
  const exits = state.fieldExits ?? { count: 0, last: {} };
  exits.uncovered = { ...exits.uncovered, [removedId]: { resumed } };
  state.fieldExits = exits;
}

/**
 * R212: a card has moved zones again (`zones.removeFromAnyZone`), so the note of its last removal
 * from a pile's top is done once the loop has dispatched that removal's report; until then the
 * report still reads it, and the note goes with the report (`noteReported`).
 */
export function noteMoved(state: GameState, instanceId: string): void {
  const uncovered = state.fieldExits?.uncovered;
  const note = uncovered?.[instanceId];
  if (uncovered === undefined || note === undefined) return;
  if (note.reported === true) delete uncovered[instanceId];
  else note.movedOn = true;
}

/**
 * R212: the loop has dispatched an event (`triggers.dispatchEvent`). A removal it reports has been
 * answered: its note stays for the rest of that removal's reports (a death's `enteredGraveyard`
 * after its `destroyed`) until the card moves again, or goes now if it already has.
 */
export function noteReported(state: GameState, event: GameEvent): void {
  const uncovered = state.fieldExits?.uncovered;
  if (uncovered === undefined) return;
  for (const id of removalsIn(event)) {
    const note = uncovered[id];
    if (note === undefined) continue;
    if (note.movedOn === true) delete uncovered[id];
    else note.reported = true;
  }
}

/**
 * The cards an event reports leaving the field, or changing hands (a steal takes only a pile's top,
 * R13) — the removals a Stack note can hang on. Arrivals are not read: they name no removal.
 */
function removalsIn(event: GameEvent): readonly string[] {
  switch (event.type) {
    case "destroyed":
    case "enteredGraveyard":
    case "exiled":
    case "bounced":
    case "shuffledIn":
    case "controlChanged":
      return [event.instanceId];
    // R316: an existing card a full library refused left where it was, like a `shuffledIn`; a copy
    // that was never created left nothing.
    case "libraryOverflow":
      return event.outcome === "notCreated" ? [] : [event.instanceId];
    case "fused":
      return event.instanceIds.filter((id) => id !== event.resultInstanceId);
    default:
      return [];
  }
}

/**
 * R212, §3.2: the card the removal an event reports uncovered in its Stack pile — which resumed then,
 * after the event and whatever came before it (`noteUncovered`).
 */
export function uncoveredBy(state: GameState, event: GameEvent): string[] {
  const uncovered = state.fieldExits?.uncovered;
  if (uncovered === undefined) return [];
  return removalsIn(event).flatMap((id) => {
    const note = uncovered[id];
    return note === undefined ? [] : [note.resumed];
  });
}

/** What a run of events did to the cards it names (R212). */
export type LaterMoves = {
  /**
   * Every card the events moved between zones, or brought into existence, or replaced — and, read
   * against a state, every dormant card a removal they report uncovered in its Stack pile (§3.2).
   */
  moved: ReadonlySet<string>;
  /**
   * The controller each card had before the first change of control the events show. A change of
   * control always hands a card to the other player (a steal of your own card does nothing, R76),
   * so the controller before it is the opponent of the one it went to.
   */
  controllerBefore: ReadonlyMap<string, PlayerId>;
};

/**
 * The ids a zone-changing event moves. `transformed` moves both — the old card ceases to exist and
 * its replacement arrives (§6.3 Replace) — while a Fuse keeps the instance of a target on the field
 * (R77), so only the ingredients that ceased to exist are moved by it. A change of control, a
 * rotation and a board swap are not moves: the card stays on the field (R171, R174).
 */
function movedBy(event: GameEvent): readonly string[] {
  switch (event.type) {
    case "cardPlayed":
    case "summoned":
    case "destroyed":
    case "enteredGraveyard":
    case "exiled":
    case "bounced":
    case "burned":
    case "discarded":
    case "drawn":
    case "addedToHand":
    case "shuffledIn":
      return [event.instanceId];
    // R316: as in `removalsIn`, an existing card a full library refused has moved; a copy never
    // created has not.
    case "libraryOverflow":
      return event.outcome === "notCreated" ? [] : [event.instanceId];
    case "transformed":
      return [event.instanceId, event.newInstanceId];
    case "fused":
      return event.instanceIds.filter((id) => id !== event.resultInstanceId);
    default:
      return [];
  }
}

/**
 * R212: read the events that followed an event, oldest first. With `state`, a card that resumed as a
 * Stack pile's top because a card the events report leaving it (`uncoveredBy`) counts as moved too:
 * it was dormant when the event happened, registering nothing (§3.2, R153), and it comes back into
 * play the way a Reborn body does.
 */
export function movesIn(events: Iterable<GameEvent>, state?: GameState): LaterMoves {
  const moved = new Set<string>();
  const controllerBefore = new Map<string, PlayerId>();
  for (const event of events) {
    for (const id of movedBy(event)) moved.add(id);
    if (state !== undefined) for (const id of uncoveredBy(state, event)) moved.add(id);
    if (event.type === "controlChanged" && !controllerBefore.has(event.instanceId)) {
      controllerBefore.set(event.instanceId, opponentOf(event.controller));
    }
  }
  return { moved, controllerBefore };
}
