// The printed face of a card the view names by its definition: the opponent's play the showcase
// holds up, the card a log line is about, the cards in a graveyard or an exile pile.
//
// No rule lives here (CLAUDE.md rule 7). The definition comes from the public catalog (§5.1,
// `CatalogContext`), else from the match-made definitions the view carries beside the cards it
// names (R243), else from nothing: the card is drawn by its id, as `Card.tsx` draws one before the
// catalog has loaded. The R97 sentinel names no card, so it has no face, and the callers draw a
// back instead.

import type { CardView, PlayerView } from "@jackioh/shared";

import { faceModel, type FaceModel } from "../cards/index.ts";
import { lookupFromDefs, unknownCard, type CardInfo, type CardLookup } from "./catalog.ts";

/** R97: the id and definition an event or a prompt carries in place of a card the viewer may not read. */
export const HIDDEN_CARD = "hidden";

function infoFor(lookup: CardLookup | null, view: PlayerView, defId: string, radiant: boolean): CardInfo {
  const fromCatalog = lookup?.(defId, radiant);
  if (fromCatalog !== undefined) return fromCatalog;
  const defs = view.defs;
  const fromView = defs !== undefined && defs[defId] !== undefined ? lookupFromDefs(defs)(defId, radiant) : undefined;
  return fromView ?? unknownCard(defId);
}

/**
 * The face a definition prints, or null for the sentinel. `liveCost` is the view's own number for
 * a card it lists (`CardView.cost`); a card named only by an event has none and shows its price.
 */
export function printedFace(
  lookup: CardLookup | null,
  view: PlayerView,
  defId: string,
  radiant: boolean,
  liveCost?: number,
): FaceModel | null {
  if (defId === HIDDEN_CARD || defId === "") return null;
  const info = infoFor(lookup, view, defId, radiant);
  return faceModel({ defId, def: info.def, name: info.name, type: info.type, radiant, liveCost });
}

/** A card the view lists (a pile, the resolving strip): its face as it stands, cost included. */
export function listedFace(lookup: CardLookup | null, view: PlayerView, card: CardView): FaceModel | null {
  return printedFace(lookup, view, card.defId, card.radiant, card.cost);
}

/**
 * The `CardView` for an instance anywhere the view shows cards face up: the field, a face-up
 * backrow card, both piles, the resolving strip, and the viewer's own hand. Null when the view
 * shows it nowhere, which is also what a hidden card gives.
 */
export function cardInView(view: PlayerView, instanceId: string): CardView | null {
  if (instanceId === HIDDEN_CARD) return null;
  for (const seat of [view.you, view.opponent]) {
    for (const unit of seat.units) {
      if (unit !== null && unit.instanceId === instanceId) return unit;
    }
    for (const entry of seat.backrow) {
      if (entry !== null && !entry.faceDown && entry.instanceId === instanceId) return entry;
    }
    for (const card of [...seat.graveyard, ...seat.exile, ...(seat.resolving ?? [])]) {
      if (card.instanceId === instanceId) return card;
    }
    if (Array.isArray(seat.hand)) {
      for (const card of seat.hand) {
        if (card.instanceId === instanceId) return card;
      }
    }
  }
  return null;
}
