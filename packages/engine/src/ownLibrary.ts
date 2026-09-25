// What a player may know of their own library (SPEC §10.8, R310–R312): which cards are left in it,
// never in what order, and only the cards they were shown going in.
//
// A player built their deck, drew and returned their own opening hand, and watched every card that
// went in openly after that: a CN-Virus's copies, an Unstable Clone Machine's, the virus the
// opponent's CN-Viral Injection shuffled in (a play both players saw, whose text names the card). So
// the list is theirs to read, as a list without order: §9.1 hides the order, not the contents.
//
// Three rules, and this module owns them:
//   - R310: the list is a multiset. One entry per definition and face, with a count, sorted by the
//     definition's printed cost (R65's `queryCost`), then its name, then its id, base face first:
//     an order the cards alone decide, so two libraries holding the same cards in any order give the
//     same list. It carries no instance id, no position, no live cost and no rolled power.
//   - R311: each library card carries `knownAs`, what its owner was shown of it as it went in. The
//     list reads that record and never the card itself, so a change made inside a library, where
//     nobody sees it (#28 or #42 making a card Radiant, #95's discount, #98's roll), shows nothing:
//     the card is listed with the face it went in with. Only the openings named below write it.
//   - R312: a card with no record was never shown to its owner, and is counted as unknown. That is
//     every card of a library Pocket Chaos swapped (#87: its new owner never saw it; `hideFromOwner`
//     clears the record the old owner had) and every card Transmogulate put in a library (#83: a new
//     instance, and the `transformed` event names it to nobody, R177). A card stays unknown until it
//     leaves the library, even one a prompt has since revealed (#51's options): the list may show
//     less than its owner could piece together, never more.
//
// The record is written where a card goes in openly: the starting deck (`state.createGame`), a
// mulligan's returns (`setup.finishMulligan`) and a shuffle-in (`draw.shuffleIntoLibrary`, which
// every Core shuffle goes through). A path that forgets to write it shows a card back, never a card.

import type { LibraryEntryView, LibraryView, PlayerId } from "@jackioh/shared";
import { defOf, queryCost } from "./catalog";
import type { CardInstance, GameState } from "./state";

/** R311: the card went into its owner's library openly; record what they were shown of it. */
export function showToOwner(card: CardInstance): void {
  card.knownAs = { defId: card.defId, radiant: card.radiant };
}

/** R312: the card's owner was never shown it (a library that changed hands, #87). */
export function hideFromOwner(card: CardInstance): void {
  delete card.knownAs;
}

/** Plain code-unit order: the same in every runtime, unlike `localeCompare`. */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * R310: the order of the list. Printed cost (R65), name, id, then base before Radiant — read off the
 * definition and the face alone, so it says nothing about where a card lies.
 */
function compareEntries(state: GameState, a: LibraryEntryView, b: LibraryEntryView): number {
  if (a.defId !== b.defId) {
    const left = defOf(state, a.defId);
    const right = defOf(state, b.defId);
    const byCost = queryCost(left) - queryCost(right);
    if (byCost !== 0) return byCost;
    const byName = compareText(left.name, right.name);
    if (byName !== 0) return byName;
    return compareText(a.defId, b.defId);
  }
  return Number(a.radiant) - Number(b.radiant);
}

/** R310–R312: `player`'s own library as they may know it. Pure: reads the state, shares nothing. */
export function ownLibraryView(state: GameState, player: PlayerId): LibraryView {
  const counts = new Map<string, LibraryEntryView>();
  let unknown = 0;
  for (const card of state.players[player].library) {
    const known = card.knownAs;
    if (known === undefined) {
      unknown += 1;
      continue;
    }
    const key = `${known.radiant ? "R" : "B"}:${known.defId}`;
    const entry = counts.get(key);
    if (entry === undefined) counts.set(key, { defId: known.defId, radiant: known.radiant, count: 1 });
    else entry.count += 1;
  }
  const cards = [...counts.values()].sort((a, b) => compareEntries(state, a, b));
  return { cards, unknown };
}
