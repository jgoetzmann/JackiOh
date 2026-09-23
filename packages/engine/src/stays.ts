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
// No instance field records a stay: the design keeps `CardInstance` as it is (docs/polish), and
// the event stream already carries the answer.

import type { GameEvent, PlayerId } from "@jackioh/shared";
import { opponentOf } from "@jackioh/shared";

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
      case "transformed":
        if (event.instanceId === instanceId) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

/** What a run of events did to the cards it names (R212). */
export type LaterMoves = {
  /** Every card the events moved between zones, or brought into existence, or replaced. */
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
    case "transformed":
      return [event.instanceId, event.newInstanceId];
    case "fused":
      return event.instanceIds.filter((id) => id !== event.resultInstanceId);
    default:
      return [];
  }
}

/** R212: read the events that followed an event, oldest first. */
export function movesIn(events: Iterable<GameEvent>): LaterMoves {
  const moved = new Set<string>();
  const controllerBefore = new Map<string, PlayerId>();
  for (const event of events) {
    for (const id of movedBy(event)) moved.add(id);
    if (event.type === "controlChanged" && !controllerBefore.has(event.instanceId)) {
      controllerBefore.set(event.instanceId, opponentOf(event.controller));
    }
  }
  return { moved, controllerBefore };
}
