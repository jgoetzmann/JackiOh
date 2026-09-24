// Swap (SPEC §6.3's Swap row, R73): Pocket Chaos (#87) exchanges one thing between the two players
// — the two heroes' health, the board contents lane by lane, or the libraries.
//
// What travels and what stays (R73):
//
// - Health: the two values change places and armor stays with its hero. This is not damage, not a
//   heal and not "lose health" (R18), so there is no pipeline and no armor step: the only event is
//   `swapped` (§10.3).
// - Board: zone contents change sides lane by lane, in both rows of §3.1. A swapped card never
//   leaves the field, so R78's reset never runs and its damage, buffs, counters and position all
//   come along, exactly as a rotated card's do (R14). `controller` changes because every
//   destination is on the other side of the centre line, and that is an entry (R171): every card
//   that lands, a dormant Stack card and a backrow card included, takes this turn as its
//   `summonedTurn` and a fresh exertion, so the units a player receives are summoning sick for the
//   rest of the turn. `owner` does not change (R12), so the card still goes to its owner's hand,
//   library, graveyard or exile when it later leaves the field. Locks are zone flags, so they stay
//   with their zones and never travel with a card (R73, §3.2). A face-down trap stays face-down and
//   is readable by its new controller only: `viewFor` keys that on `controller`, so `faceUp` is
//   deliberately untouched here (R33).
// - Library: the two piles change places whole and keep their order, so the card on top of a
//   library is still the next draw. Every swapped card's owner becomes the player whose library now
//   holds it — the one exception in R12 (R73). Fatigue is player state, not library state (§2.4),
//   so `fatigueCount` stays where it was.

import type { PlayerId, Row } from "@jackioh/shared";
import { opponentOf } from "@jackioh/shared";
import { enterNewSide } from "../combat";
import { addToHand } from "../draw";
import type { Effect, EffectContext } from "../script";
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
  slotsOf,
  type ZoneSlot,
} from "../zones";
import { chosenOptions } from "./choose";

/** The three things #87 can swap; the values are the `swapped` event's `what` (§10.3). */
export type SwapWhat = "health" | "board" | "library";

const SWAP_WHATS: readonly SwapWhat[] = ["health", "board", "library"];

/** §3.1: the board is two rows, and a board swap moves both. */
export const SWAP_ROWS: readonly Row[] = ["units", "backrow"];

/** One zone's worth of cards and where they are headed. A Stack pile travels whole (§3.2). */
type SwapEntry = { from: ZoneSlot; to: ZoneSlot; cards: CardInstance[] };

/**
 * Everything in a zone, top card first. A unit zone may hold a Stack pile, and the dormant cards
 * under the top are in the zone too, so they swap with it (§3.2).
 */
function contentsOf(state: GameState, ref: ZoneSlot): CardInstance[] {
  if (ref.row === "units") return [...(pileAt(state, ref) ?? [])];
  const card = cardAt(state, ref);
  return card === null ? [] : [card];
}

/** R73: "lane-preserving" — the same row and lane on the other side of the centre line. */
function mirrorOf(ref: ZoneSlot): ZoneSlot {
  return { player: opponentOf(ref.player), row: ref.row, lane: ref.lane };
}

/**
 * Whether a destination can take a swapped card.
 *
 * R73 says locks stay with their zones but not what happens to a card whose destination is Locked,
 * or reserved for a dying Reborn unit (R64). A Locked zone "accepts no summons until the game ends"
 * (§3.2) and a reserved zone "counts as occupied for every other card that would enter it" (§3.2,
 * R64). R88 settles it, following R14, which answers the same question for the other whole-board
 * move: the card bounces to its owner's hand.
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
    // Every swapped zone was emptied before anything was placed and the destination accepts cards,
    // so a refusal here is a broken invariant, not a game rule; `rotation.ts` says so the same way.
    if (!placeOnField(state, card, to, { stack: placed > 0 })) {
      throw new Error(`swap could not place ${card.id} in ${to.player} ${to.row} ${to.lane}`);
    }
    placed += 1;
  }
}

/**
 * The bounce of the decision above: the card goes to its owner's hand (R12). The hand cap applies,
 * so a full hand burns it (§2.4, R4), and a unit token ceases to exist on the way and never reaches
 * a hand (R11).
 */
function bounceHome(ctx: EffectContext, card: CardInstance): void {
  const token = isUnitToken(ctx.state, card);
  const event = {
    type: "bounced" as const,
    instanceId: card.id,
    defId: card.defId,
    owner: card.owner,
  };

  if (token) {
    moveToZone(ctx.state, card, "hand");
    ctx.events.push(event);
    return;
  }

  ctx.events.push(event);
  addToHand(ctx, card);
}

/** R73 health: the two values change places; armor stays with its hero. */
function swapHealthNow(ctx: EffectContext): void {
  const mine = ctx.state.players[ctx.controller].hero;
  const theirs = ctx.state.players[opponentOf(ctx.controller)].hero;
  const keep = mine.health;
  mine.health = theirs.health;
  theirs.health = keep;
  ctx.events.push({ type: "swapped", what: "health" });
}

/**
 * R73 board: every zone's contents change sides, lane by lane, in both rows.
 *
 * The whole board is read before anything is placed, so one swap is a single atomic step: no card
 * can land on a zone whose occupant has not moved yet, and an uneven board — a full side against an
 * empty one — simply hands its cards over.
 *
 * Events (§10.3): `swapped` once for the swap, then `controlChanged` per card that landed, in the
 * controller's zones first and then the opponent's, units by lane and then backrow (R68's order).
 */
function swapBoardNow(ctx: EffectContext): void {
  const state = ctx.state;
  const sides: PlayerId[] = [ctx.controller, opponentOf(ctx.controller)];

  const entries: SwapEntry[] = sides
    .flatMap((player) =>
      SWAP_ROWS.flatMap((row) =>
        slotsOf(player, row).map((from) => ({
          from,
          to: mirrorOf(from),
          cards: contentsOf(state, from),
        })),
      ),
    )
    .filter((entry) => entry.cards.length > 0);

  ctx.events.push({ type: "swapped", what: "board" });

  // Read first, then place: every card comes off the field before any card lands.
  for (const entry of entries) {
    for (const card of entry.cards) removeFromField(state, card, { withPile: true });
  }

  for (const entry of entries) {
    if (!canAccept(state, entry.to)) {
      for (const card of entry.cards) bounceHome(ctx, card);
      continue;
    }

    const before = entry.cards.map((card) => card.controller);
    placeContents(state, entry.cards, entry.to);

    // Every destination is on the other side, so every card that landed changed controller (R73),
    // dormant Stack cards included: they are in the zone and moved with it (§3.2). Each one has
    // entered its new side (R171).
    entry.cards.forEach((card, at) => {
      enterNewSide(ctx, card, before[at] ?? card.owner);
      ctx.events.push({
        type: "controlChanged",
        instanceId: card.id,
        controller: entry.to.player,
        row: entry.to.row,
        lane: entry.to.lane,
      });
    });
  }
}

/**
 * R12's one exception: a card in the library that was swapped now belongs to the player holding it,
 * so it feeds that player's draws and later reaches that player's graveyard or exile. Off the field
 * control follows ownership (R78), and the zone records the new side.
 */
function claimLibrary(cards: readonly CardInstance[], player: PlayerId): void {
  for (const card of cards) {
    card.owner = player;
    card.controller = player;
    card.zone = { z: "library", player };
  }
}

/**
 * R73 library: the two piles change places whole, in order, and change owners with them.
 *
 * The piles are exchanged directly rather than card by card: `moveToZone` always routes a card to
 * its own owner's pile (R12), which is precisely the rule R73 overrides here, so there is no zone
 * helper for this move. Nothing leaves the library, so R11 never fires on a unit-token card sitting
 * in one (#75): it is still in a library, just the other player's.
 */
function swapLibraryNow(ctx: EffectContext): void {
  const mine = ctx.controller;
  const theirs = opponentOf(mine);
  const mySide = ctx.state.players[mine];
  const theirSide = ctx.state.players[theirs];

  const wasMine = mySide.library;
  mySide.library = theirSide.library;
  theirSide.library = wasMine;

  claimLibrary(mySide.library, mine);
  claimLibrary(theirSide.library, theirs);

  // §2.4: fatigue is a property of the player, not of the library, so `fatigueCount` is untouched.
  ctx.events.push({ type: "swapped", what: "library" });
}

/** §6.3 Choose one: the answered mode arrives in `ctx.targets` or `ctx.modes` (§10.6, R81). */
function chosenWhat(ctx: EffectContext): SwapWhat | null {
  for (const option of chosenOptions(ctx)) {
    const what = SWAP_WHATS.find((candidate) => candidate === option);
    if (what !== undefined) return what;
  }
  return null;
}

/**
 * §6.3 Swap (#87 Pocket Chaos): exchange one thing with the opponent. With no `what` the effect
 * reads the Choose one answer, so the card script stays declarative data (CLAUDE.md rule 5); an
 * answer naming none of the three fizzles and the rest of the card still resolves.
 */
export function swap(args: { what?: SwapWhat } = {}): Effect {
  return {
    kind: "swap",
    apply(ctx): void {
      const what = args.what ?? chosenWhat(ctx);
      if (what === null) return;
      if (what === "health") swapHealthNow(ctx);
      else if (what === "board") swapBoardNow(ctx);
      else swapLibraryNow(ctx);
    },
  };
}

/** R73: the two heroes' health values change places; armor stays with its hero. */
export function swapHealth(): Effect {
  return {
    kind: "swapHealth",
    apply(ctx): void {
      swapHealthNow(ctx);
    },
  };
}

/** R73: zone contents change sides lane by lane in both rows; locks stay, control moves, owners don't. */
export function swapBoard(): Effect {
  return {
    kind: "swapBoard",
    apply(ctx): void {
      swapBoardNow(ctx);
    },
  };
}

/** R73: the libraries change places whole, and each swapped card's owner changes with it (R12). */
export function swapLibrary(): Effect {
  return {
    kind: "swapLibrary",
    apply(ctx): void {
      swapLibraryNow(ctx);
    },
  };
}
