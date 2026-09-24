// The event feed (SPEC §10.10, BUILD M5-T1): `view.events` as readable lines.
//
// A plain list, deliberately: the animation runner owns motion (M5-T4) and nothing here
// animates. Every line is built from the event payload plus public board data, and card
// identities that are only in the view by accident are not printed — `drawn`, `addedToHand` and
// `shuffledIn` carry a `defId` for the animation layer, so this log says "drew a card" rather
// than naming it, and a redaction slip upstream cannot turn into a leak on screen.
//
// A line never prints an id. A card is named from the board as it stands, else from what the
// window's own public events said it was (`summoned`, `cardPlayed`, a move to the graveyard …),
// else as "a unit" or "a card". The R154 sentinel reads as "a face-down trap", never as "hidden".
// `cardResolved` gets no line: it is bookkeeping, and "… finished resolving" read like a debug
// trace between the lines that matter.

import { useContext, useLayoutEffect, useRef, type ReactElement } from "react";

import type { GameEvent, PlayerId, PlayerView } from "@jackioh/shared";

import { CatalogContext } from "./catalog.ts";
import { sideOf, testid } from "./contract.ts";
import { outcomeFor, resultReason } from "./Result.tsx";

export type LogProps = {
  view: PlayerView;
  /** True once a hidden log (the phone's popover) is opened, so it can scroll to its newest line. */
  revealed?: boolean;
};

/** R97: the id an event carries in place of a card this seat may not read (`view.ts`). */
const HIDDEN_CARD = "hidden";

type Naming = {
  /** A card's printed name, or its def id when no catalog is loaded (see catalog.ts). */
  def: (defId: string) => string;
  /** A card by name where it is public, else "a unit" (or `unknown`). Heroes read as a seat's. */
  instance: (instanceId: string, unknown?: string) => string;
  seat: (player: PlayerId) => string;
  /** "your" or "the opponent's". */
  whose: (player: PlayerId) => string;
};

function seatLabel(view: PlayerView, player: PlayerId): string {
  return sideOf(view, player) === "you" ? "You" : "Opponent";
}

function whoseLabel(view: PlayerView, player: PlayerId): string {
  return sideOf(view, player) === "you" ? "your" : "the opponent's";
}

/** The log's own words ("your hero", "a unit") open a line with a capital; a card's name is as printed. */
const OWN_WORDS = /^(?:a|an|your|the) /;

function capitalised(text: string): string {
  return OWN_WORDS.test(text) ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

function zoneLabel(row: string, lane: number): string {
  return row === "units" ? `lane ${String(lane)}` : `backrow lane ${String(lane)}`;
}

/**
 * Instance → definition, from the window's events about public zones (a card played, summoned,
 * destroyed or sent to a pile), so a unit that has since left the board is still named. The
 * hand's own events (`drawn`, `addedToHand`, `shuffledIn`) are not read, as above, and neither is
 * the sentinel.
 */
function publicNames(events: readonly GameEvent[]): Map<string, string> {
  const names = new Map<string, string>();
  const note = (instanceId: string, defId: string): void => {
    if (instanceId !== HIDDEN_CARD && defId !== HIDDEN_CARD) names.set(instanceId, defId);
  };
  for (const event of events) {
    switch (event.type) {
      case "cardPlayed":
      case "summoned":
      case "destroyed":
      case "enteredGraveyard":
      case "exiled":
      case "bounced":
      case "burned":
      case "discarded":
      case "radiantSet":
      case "trapFired":
        note(event.instanceId, event.defId);
        break;
      case "fused":
        note(event.resultInstanceId, event.defId);
        break;
      case "transformed":
        note(event.instanceId, event.toDefId);
        break;
      default:
        break;
    }
  }
  return names;
}

function defIdOfInstance(view: PlayerView, instanceId: string): string | undefined {
  for (const seat of [view.you, view.opponent]) {
    for (const unit of seat.units) {
      if (unit !== null && unit.instanceId === instanceId) return unit.defId;
    }
    for (const entry of seat.backrow) {
      if (entry !== null && !entry.faceDown && entry.instanceId === instanceId) return entry.defId;
    }
    for (const card of [...seat.graveyard, ...seat.exile]) {
      if (card.instanceId === instanceId) return card.defId;
    }
    if (Array.isArray(seat.hand)) {
      for (const card of seat.hand) {
        if (card.instanceId === instanceId) return card.defId;
      }
    }
  }
  return undefined;
}

function describe(event: GameEvent, view: PlayerView, name: Naming): string | null {
  switch (event.type) {
    case "cardPlayed":
      return `${name.seat(event.player)} played ${name.def(event.defId)} for ${event.costPaid}`;
    case "summoned":
      return `${name.def(event.defId)} entered ${name.whose(event.player)} ${zoneLabel(event.row, event.lane)}`;
    case "damage":
      return `${capitalised(name.instance(event.targetId))} took ${event.amount} damage${event.combat ? " in combat" : ""}`;
    case "healthLost":
      return `${name.seat(event.player)} lost ${event.amount} health`;
    case "healed":
      return `${capitalised(name.instance(event.targetId))} healed ${event.amount}`;
    case "divineShieldLost":
      return `${capitalised(name.instance(event.instanceId))} lost its Divine Shield`;
    case "destroyed":
      return `${name.def(event.defId)} was destroyed`;
    case "cardResolved":
      return null;
    case "enteredGraveyard":
      return `${name.def(event.defId)} went to ${name.whose(event.owner)} graveyard`;
    case "exiled":
      return `${name.def(event.defId)} was exiled`;
    case "bounced":
      return `${name.def(event.defId)} returned to ${name.whose(event.owner)} hand`;
    case "burned":
      return `${name.def(event.defId)} burned`;
    case "discarded":
      return `${name.seat(event.owner)} discarded ${name.def(event.defId)}`;
    case "drawn":
      return `${name.seat(event.player)} drew a card`;
    case "addedToHand":
      return `${name.seat(event.player)} added a card to hand`;
    case "shuffledIn":
      return `${name.seat(event.player)} shuffled a card into the library`;
    case "buffed":
      // R177: a buff on a card this seat may not read arrives as the sentinel with 0/0, which says
      // nothing of its size, so the line does not claim one.
      return event.instanceId === HIDDEN_CARD
        ? "A hidden card was buffed"
        : `${capitalised(name.instance(event.instanceId))} gained +${event.attack}/+${event.health}`;
    case "keywordGranted":
      return `${capitalised(name.instance(event.instanceId))} gained ${event.keyword.kind}`;
    case "counterChanged":
      return `${capitalised(name.instance(event.instanceId))} ${event.counter} counters: ${event.value}`;
    case "costChanged":
      // R177: a card this seat may not read arrives with its cost redacted to a negative sentinel.
      return event.cost < 0
        ? `${capitalised(name.instance(event.instanceId, "a card"))} changed cost`
        : `${capitalised(name.instance(event.instanceId, "a card"))} now costs ${event.cost}`;
    case "modifierChanged": {
      // The id is the engine's handle ("m123"); the label, while the view still lists it, is the words.
      const label = [...view.you.modifiers, ...view.opponent.modifiers].find((mod) => mod.id === event.modifierId)?.label;
      const what = label === undefined ? "an effect" : `"${label}"`;
      return `${name.seat(event.player)} ${event.added ? "gained" : "lost"} ${what}`;
    }
    case "radiantSet":
      return `${name.def(event.defId)} became Radiant`;
    case "transformed":
      return `${name.def(event.fromDefId)} became ${name.def(event.toDefId)}`;
    case "fused":
      return `${event.instanceIds.length} cards fused into ${name.def(event.defId)}`;
    case "positionSwitched":
      return `${capitalised(name.instance(event.instanceId))} switched to ${event.position}`;
    case "controlChanged":
      return `${capitalised(name.instance(event.instanceId))} moved to ${name.whose(event.controller)} ${zoneLabel(event.row, event.lane)}`;
    case "rotated":
      return `The board rotated ${event.direction}`;
    case "swapped":
      return `Both players swapped ${event.what}`;
    case "locked":
      return `${capitalised(name.whose(event.player))} ${zoneLabel(event.row, event.lane)} was locked`;
    case "trapFired":
      // R154: the other seat reads the sentinel, and a sentinel is not a name.
      return event.defId === HIDDEN_CARD
        ? `${capitalised(name.whose(event.controller))} face-down trap fired`
        : `${capitalised(name.whose(event.controller))} trap ${name.def(event.defId)} fired`;
    case "attackDeclared":
      return `${capitalised(name.instance(event.attackerId))} attacked ${name.instance(event.targetId)}${event.forced ? " (forced)" : ""}`;
    case "attackCancelled":
      return `${capitalised(name.instance(event.attackerId))}'s attack was cancelled`;
    case "manaChanged":
      return `${name.seat(event.player)} ${name.seat(event.player) === "You" ? "have" : "has"} ${event.current}/${event.max} mana`;
    case "turnStarted":
      return `Turn ${event.turn}: ${name.seat(event.player)}`;
    case "turnEnded":
      return `${name.seat(event.player)} ended turn ${event.turn} with ${event.unspentMana} mana unspent`;
    case "turnAutoEnded":
      return `${name.seat(event.player)} had no moves left — turn ${event.turn} ended`;
    case "promptOpened":
      return `${name.seat(event.player)} must choose (${event.kind})`;
    case "promptAnswered":
      return `${name.seat(event.player)} chose`;
    case "drawOffered":
      return `${name.seat(event.player)} offered a draw`;
    case "drawAnswered":
      return `${name.seat(event.player)} ${event.accept ? "accepted" : "declined"} the draw`;
    case "gameOver": {
      const why = resultReason(outcomeFor({ winner: event.winner, reason: event.reason }, view.viewer), event.reason);
      return event.winner === "draw" ? `Draw. ${why}` : `${seatLabel(view, event.winner)} won. ${why}`;
    }
  }
}

export default function Log({ view, revealed = false }: LogProps): ReactElement {
  const lookup = useContext(CatalogContext);
  const remembered = publicNames(view.events);

  const name: Naming = {
    def: (defId) => (defId === HIDDEN_CARD ? "a hidden card" : (lookup?.(defId, false)?.name ?? defId)),
    instance: (instanceId, unknown = "a unit") => {
      if (instanceId === `hero-${view.you.player}`) return "your hero";
      if (instanceId === `hero-${view.opponent.player}`) return "the opponent's hero";
      const defId = defIdOfInstance(view, instanceId) ?? remembered.get(instanceId);
      return defId === undefined ? unknown : (lookup?.(defId, false)?.name ?? defId);
    },
    seat: (player) => seatLabel(view, player),
    whose: (player) => whoseLabel(view, player),
  };

  // The newest line is the one worth reading, so a log taller than its box keeps its end in view
  // (polish task 7: on a desktop the log is a fixed box beside your seat and hand). A log that was
  // hidden (the phone's popover) has no height to scroll, so it scrolls again as it opens.
  const listRef = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [view.events, revealed]);

  const lines = view.events.flatMap((event, index) => {
    const text = describe(event, view, name);
    return text === null ? [] : [{ key: `${String(index)}-${event.type}`, type: event.type, text }];
  });

  return (
    <ol ref={listRef} className="log" data-testid={testid.log} aria-label="Game log">
      {lines.map((line) => (
        <li key={line.key} className="log-line" data-event={line.type}>
          {line.text}
        </li>
      ))}
    </ol>
  );
}
