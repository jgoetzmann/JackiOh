// The event feed (SPEC §10.10, BUILD M5-T1): `view.events` as readable lines.
//
// A plain list, deliberately: the animation runner owns motion (M5-T4) and nothing here
// animates. Every line is built from the event payload plus public board data, and card
// identities that are only in the view by accident are not printed — `drawn`, `addedToHand` and
// `shuffledIn` carry a `defId` for the animation layer, so this log says "drew a card" rather
// than naming it, and a redaction slip upstream cannot turn into a leak on screen.

import { useContext, type ReactElement } from "react";

import type { GameEvent, PlayerId, PlayerView } from "@jackioh/shared";

import { CatalogContext } from "./catalog.ts";
import { sideOf, testid } from "./contract.ts";

export type LogProps = { view: PlayerView };

/** R97: the id an event carries in place of a card this seat may not read (`view.ts`). */
const HIDDEN_CARD = "hidden";

type Naming = {
  /** A card's printed name, or its def id when no catalog is loaded (see catalog.ts). */
  def: (defId: string) => string;
  /** A board instance by name where it is public, else the raw id. Heroes read as a seat. */
  instance: (instanceId: string) => string;
  seat: (player: PlayerId) => string;
};

function seatLabel(view: PlayerView, player: PlayerId): string {
  return sideOf(view, player) === "you" ? "You" : "Opponent";
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

function describe(event: GameEvent, view: PlayerView, name: Naming): string {
  switch (event.type) {
    case "cardPlayed":
      return `${name.seat(event.player)} played ${name.def(event.defId)} for ${event.costPaid}`;
    case "summoned":
      return `${name.def(event.defId)} summoned to ${name.seat(event.player)} ${event.row} lane ${event.lane}`;
    case "damage":
      return `${name.instance(event.targetId)} took ${event.amount} damage${event.combat ? " in combat" : ""}`;
    case "healthLost":
      return `${name.seat(event.player)} lost ${event.amount} health`;
    case "healed":
      return `${name.instance(event.targetId)} healed ${event.amount}`;
    case "divineShieldLost":
      return `${name.instance(event.instanceId)} lost its Divine Shield`;
    case "destroyed":
      return `${name.def(event.defId)} was destroyed`;
    case "cardResolved":
      return `${name.def(event.defId)} finished resolving`;
    case "enteredGraveyard":
      return `${name.def(event.defId)} went to ${name.seat(event.owner)} graveyard`;
    case "exiled":
      return `${name.def(event.defId)} was exiled`;
    case "bounced":
      return `${name.def(event.defId)} returned to ${name.seat(event.owner)} hand`;
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
        : `${name.instance(event.instanceId)} gained +${event.attack}/+${event.health}`;
    case "keywordGranted":
      // R46: the same event reports the Taunt an Indestructible unit's knock-down takes.
      return `${name.instance(event.instanceId)} ${event.lost === true ? "lost" : "gained"} ${event.keyword.kind}`;
    case "counterChanged":
      return `${name.instance(event.instanceId)} ${event.counter} counters: ${event.value}`;
    case "costChanged":
      // R177: a card this seat may not read arrives with its cost redacted to a negative sentinel.
      return event.cost < 0
        ? `${name.instance(event.instanceId)} changed cost`
        : `${name.instance(event.instanceId)} now costs ${event.cost}`;
    case "modifierChanged":
      return `${name.seat(event.player)} ${event.added ? "gained" : "lost"} ${event.modifierId}`;
    case "radiantSet":
      return `${name.def(event.defId)} became Radiant`;
    case "transformed":
      return `${name.def(event.fromDefId)} became ${name.def(event.toDefId)}`;
    case "fused":
      return `${event.instanceIds.length} cards fused into ${name.def(event.defId)}`;
    case "positionSwitched":
      return `${name.instance(event.instanceId)} switched to ${event.position}`;
    case "controlChanged":
      return `${name.instance(event.instanceId)} moved to ${name.seat(event.controller)} ${event.row} lane ${event.lane}`;
    case "rotated":
      return `The board rotated ${event.direction}`;
    case "swapped":
      return `Both players swapped ${event.what}`;
    case "locked":
      return `${name.seat(event.player)} ${event.row} lane ${event.lane} was locked`;
    case "trapFired":
      return `${name.def(event.defId)} fired for ${name.seat(event.controller)}`;
    case "attackDeclared":
      return `${name.instance(event.attackerId)} attacked ${name.instance(event.targetId)}${event.forced ? " (forced)" : ""}`;
    case "attackCancelled":
      return `${name.instance(event.attackerId)}'s attack was cancelled`;
    case "manaChanged":
      return `${name.seat(event.player)} mana ${event.current}/${event.max}`;
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
    case "gameOver":
      return event.winner === "draw"
        ? `Draw (${event.reason})`
        : `${seatLabel(view, event.winner)} won (${event.reason})`;
  }
}

export default function Log({ view }: LogProps): ReactElement {
  const lookup = useContext(CatalogContext);

  const name: Naming = {
    def: (defId) => lookup?.(defId, false)?.name ?? defId,
    instance: (instanceId) => {
      if (instanceId === `hero-${view.you.player}`) return `${seatLabel(view, view.you.player)} hero`;
      if (instanceId === `hero-${view.opponent.player}`) return `${seatLabel(view, view.opponent.player)} hero`;
      const defId = defIdOfInstance(view, instanceId);
      return defId === undefined ? instanceId : (lookup?.(defId, false)?.name ?? defId);
    },
    seat: (player) => seatLabel(view, player),
  };

  return (
    <ol className="log" data-testid={testid.log} aria-label="Game log">
      {view.events.map((event, index) => (
        <li key={`${index}-${event.type}`} className="log-line" data-event={event.type}>
          {describe(event, view, name)}
        </li>
      ))}
    </ol>
  );
}
