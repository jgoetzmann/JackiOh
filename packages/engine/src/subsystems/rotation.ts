// Rotation: Silly Silas (#52) turns both rings one step (SPEC §3.1's rotation-topology ruling, R14).
//
// The ten unit zones form one ring and the ten backrow zones a second, independent one: the
// rotating player's lanes 1 to 5, then the opponent's lanes 5 down to 1, and back (§3.1). Both
// rings turn together, one step, in the direction the play declared (R81).
//
// What travels with a card: its instance. A rotation never takes a card off the field, so R78's
// reset never runs and its damage, buffs, counters and position all come along (R14). What
// changes is `controller`, and only when the card's new zone is on the other side of the centre
// line. That crossing is an entry (R171): the card takes this turn as its
// `summonedTurn` and a fresh exertion, so it is summoning sick on its new side for the rest of the
// turn. A card that moves along its own side has entered nothing and keeps both. The owner never
// changes, so the card still goes to its owner's hand, library, graveyard or exile whenever it
// later leaves the field (R12). A face-down trap that crosses is read by its new controller and no
// longer by the old one, which follows from `controller` alone, so `faceUp` is deliberately
// untouched here (R33).

import type { PlayerId, Row } from "@jackioh/shared";
import { enterNewSide } from "../combat";
import { addToHand } from "../draw";
import type { EngineSink } from "../resolve";
import type { CardInstance, GameState } from "../state";
import {
  cardAt,
  isLocked,
  isReserved,
  isUnitToken,
  moveToZone,
  pileAt,
  placeOnField,
  removeFromField,
  ringNeighbor,
  ringOrder,
  type ZoneSlot,
} from "../zones";

/** R14: two rings, rotated together. */
export const ROTATION_ROWS: readonly Row[] = ["units", "backrow"];

export type RotationDirection = "left" | "right";

export type RotationArgs = {
  direction: RotationDirection;
  /** Whose seat "left" and "right" are read from: the rotating player (§3.1, §8 #52). */
  perspective: PlayerId;
  /**
   * #52 radiant: a card that would cross to the opponent of `perspective` bounces to its owner's
   * hand at cost 0 instead; one crossing towards `perspective` still crosses (R14).
   */
  radiant?: boolean;
};

export type RotationResult = {
  /** Cards that reached a new zone, in ring order: the unit ring first, then the backrow ring. */
  moved: string[];
  /**
   * Cards whose controller changed because their new zone is on the other side (R12). Each one has
   * entered its new side on this turn (R171).
   */
  crossed: string[];
  /** Cards sent to their owner's hand: a Locked destination, or the radiant bounce (R14). */
  bounced: string[];
};

/** One zone's worth of cards and where they are headed. A Stack pile travels whole (§3.2). */
type RingEntry = { from: ZoneSlot; to: ZoneSlot; cards: CardInstance[] };

/**
 * Everything in a zone, top card first. A unit zone may hold a Stack pile, and the dormant cards
 * under the top are in the zone too, so they rotate with it (§3.2).
 */
function contentsOf(state: GameState, ref: ZoneSlot): CardInstance[] {
  if (ref.row === "units") return [...(pileAt(state, ref) ?? [])];
  const card = cardAt(state, ref);
  return card === null ? [] : [card];
}

/**
 * Whether a destination can take a rotating card. A Locked zone never accepts one (§3.2, R14) and
 * a zone reserved for a dying Reborn unit counts as occupied for every other card (§3.2, R64).
 */
function canAccept(state: GameState, ref: ZoneSlot): boolean {
  return !isLocked(state, ref) && !isReserved(state, ref);
}

/**
 * Put a zone's cards down in their new zone. A pile is rebuilt from the bottom up so the card that
 * was on top is on top again, which keeps the same card acting for the zone (§3.2).
 */
function placeContents(state: GameState, cards: readonly CardInstance[], to: ZoneSlot): void {
  const bottomFirst = [...cards].reverse();
  let placed = 0;
  for (const card of bottomFirst) {
    // Every ring zone was emptied before anything was placed and the destination accepts cards,
    // so a refusal here is a broken invariant, not a game rule; `zones.ts` says so the same way.
    if (!placeOnField(state, card, to, { stack: placed > 0 })) {
      throw new Error(`rotation could not place ${card.id} in ${to.player} ${to.row} ${to.lane}`);
    }
    placed += 1;
  }
}

/**
 * R14: the card goes to its owner's hand (R12). The hand cap applies, so a full hand burns it
 * (§2.4, R4), and a unit token ceases to exist on the way and never reaches a hand (R11).
 * `costOverride` is the radiant variant's "costing 0"; R78 keeps it while the card waits in hand.
 */
function bounceHome(sink: EngineSink, card: CardInstance, costOverride?: number): void {
  const token = isUnitToken(sink.state, card);
  const event = {
    type: "bounced" as const,
    instanceId: card.id,
    defId: card.defId,
    owner: card.owner,
  };

  if (token) {
    moveToZone(sink.state, card, "hand");
    sink.events.push(event);
    return;
  }

  sink.events.push(event);
  addToHand(sink, card);
  // §8 #52 radiant: "bounced to their owner's hand costing 0" is a rider on a card that reaches the
  // hand. A full hand burns it instead (§2.4, R4), and a burned card is an ordinary graveyard card
  // that R78 would otherwise have carry the 0 into every later zone.
  if (costOverride !== undefined && card.zone.z === "hand") card.costOverride = costOverride;
}

/**
 * Rotate both rings one step (§3.1, R14, §8 #52). Silas is on the field when his Cry resolves, so
 * he is in the snapshot and rotates with everything else.
 *
 * The whole board is read before anything is placed, so one rotation is a single atomic step: no
 * card can land on a zone whose occupant has not moved yet, and a full ring keeps every card.
 *
 * Events (§10.3): `rotated` once for the rotation, then `controlChanged` per card that crossed and
 * `bounced` per card that was bounced, in ring order.
 */
export function rotateRings(sink: EngineSink, args: RotationArgs): RotationResult {
  const state = sink.state;
  const radiant = args.radiant === true;

  const entries: RingEntry[] = ROTATION_ROWS.flatMap((row) =>
    ringOrder(row, args.perspective).map((from) => ({
      from,
      to: ringNeighbor(from, args.direction, args.perspective),
      cards: contentsOf(state, from),
    })),
  ).filter((entry) => entry.cards.length > 0);

  sink.events.push({ type: "rotated", direction: args.direction });

  // Read first, then place: every card comes off the field before any card lands.
  for (const entry of entries) {
    for (const card of entry.cards) removeFromField(state, card);
  }

  const result: RotationResult = { moved: [], crossed: [], bounced: [] };

  for (const entry of entries) {
    const crosses = entry.to.player !== entry.from.player;

    // #52 radiant: "cards that would move to the opponent are bounced to their owner's hand
    // costing 0 instead" — the cards the rotating player would lose, which are the ones leaving
    // their side. "The opponent" is the rotating player's (§8 Conventions: "your" is the
    // controller), so a card crossing the other way, onto the rotating player's side, is not one of
    // them: the base clause the radiant cell does not restate still holds for it, and it crosses and
    // changes control like any other (R14, R171). The bounce goes to the card's owner's hand (R12).
    // A Locked destination would have bounced an outbound card anyway, so this also covers that case.
    if (radiant && crosses && entry.from.player === args.perspective) {
      for (const card of entry.cards) {
        bounceHome(sink, card, 0);
        result.bounced.push(card.id);
      }
      continue;
    }

    // R14: a card whose destination is Locked is bounced to its owner's hand instead.
    if (!canAccept(state, entry.to)) {
      for (const card of entry.cards) {
        bounceHome(sink, card);
        result.bounced.push(card.id);
      }
      continue;
    }

    const before = entry.cards.map((card) => card.controller);
    placeContents(state, entry.cards, entry.to);

    entry.cards.forEach((card, at) => {
      result.moved.push(card.id);
      const previous = before[at];
      if (previous === undefined || card.controller === previous) return;
      enterNewSide(sink, card, previous);
      result.crossed.push(card.id);
      sink.events.push({
        type: "controlChanged",
        instanceId: card.id,
        controller: card.controller,
        row: entry.to.row,
        lane: entry.to.lane,
      });
    });
  }

  return result;
}
