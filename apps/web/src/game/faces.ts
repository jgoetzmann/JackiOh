// The face of a card in play: the one the board draws for a card the view lists, and the one the
// showcase, a log line, a pile and a prompt draw for a card the view names (SPEC §10.10).
//
// A face in play is the card as the view says it stands (R243): the cost the view gives it, a Unit
// card's stats in its owner's hand, a unit's numbers, keywords and Vanilla mark on the field, the
// power a Heroic Power rolled, a match-made definition's own name and text, and what the card's
// formula comes to now (`CardView.preview`, R280). Everything is read
// off the view — never worked out — so none of it is a rule (CLAUDE.md rule 7). The collection's
// faces, the card as printed, are the deck builder's own (`faceModel` with no `inPlay`).
//
// The definition comes from the public catalog (§5.1, `CatalogContext`), else from the match-made
// definitions the view carries beside the cards it names (R243), else from nothing: the card is
// drawn by its id, as `Card.tsx` draws one before the catalog has loaded. The R97 sentinel names no
// card, so it has no face, and the callers draw a back instead.

import type { CardType, CardView, PlayerView, UnitView } from "@jackioh/shared";

import { faceModel, type FaceModel, type InPlay, type RolledPower } from "../cards/index.ts";
import { lookupFromDefs, matchCardsOf, unknownCard, type CardInfo, type CardLookup } from "./catalog.ts";

/** R97: the id and definition an event or a prompt carries in place of a card the viewer may not read. */
export const HIDDEN_CARD = "hidden";

function infoFor(lookup: CardLookup | null, view: PlayerView, defId: string, radiant: boolean): CardInfo {
  const fromCatalog = lookup?.(defId, radiant);
  if (fromCatalog !== undefined) return fromCatalog;
  const defs = view.defs;
  const fromView = defs !== undefined && defs[defId] !== undefined ? lookupFromDefs(defs)(defId, radiant) : undefined;
  return fromView ?? unknownCard(defId);
}

/** A unit on the field, as against a card in a pile, a hand or the backrow. */
export function isUnitView(card: CardView): card is UnitView {
  return "maxHealth" in card && "keywords" in card;
}

/** What the view lists about a card beyond its printed face, and the face it makes (R243). */
export type LiveFacts = {
  /** A face-up backrow card's type, straight off `BackrowView`. */
  type?: CardType;
  /** The power a Heroic Power on the field rolled (`HeroView.powers`); a hand card carries its own. */
  fieldPower?: RolledPower;
};

/**
 * The face in play of a card the view lists: its live cost, and whatever else the view says about
 * it — a unit's numbers and keywords, a hand Unit's stats, a Heroic Power's power, the Vanilla mark.
 */
export function liveFace(info: CardInfo, card: CardView, facts: LiveFacts = {}): FaceModel {
  const unit = isUnitView(card) ? card : undefined;
  const inPlay: InPlay = {};
  if (unit === undefined && card.attack !== undefined && card.health !== undefined) {
    inPlay.handStats = { attack: card.attack, health: card.health };
  }
  // R43, R243: in hand the power rides on the card and its X is the card's cost; on the field the
  // hero's power list names it.
  const power = card.power !== undefined ? { name: card.power, x: card.cost } : facts.fieldPower;
  if (power !== undefined) inPlay.power = power;
  if (unit?.vanilla === true) inPlay.vanilla = true;
  // R280: what the card's formula comes to now, where the view says (never in the collection).
  if (card.preview !== undefined && card.preview.length > 0) inPlay.preview = card.preview;
  return faceModel({
    defId: card.defId,
    def: info.def,
    name: info.name,
    ...(facts.type === undefined ? {} : { type: facts.type }),
    radiant: card.radiant,
    liveCost: card.cost,
    ...(unit === undefined
      ? {}
      : { live: { attack: unit.attack, health: unit.health, maxHealth: unit.maxHealth, keywords: unit.keywords } }),
    inPlay,
  });
}

/** The face-up backrow card's type, when `card` is one. */
function backrowType(card: CardView): CardType | undefined {
  return "faceDown" in card && card.faceDown === false && "type" in card ? (card.type as CardType) : undefined;
}

/** A card the view lists (a pile, the resolving strip, the field, a hand): its face in play. */
export function listedFace(lookup: CardLookup | null, view: PlayerView, card: CardView): FaceModel | null {
  if (card.defId === HIDDEN_CARD || card.defId === "") return null;
  const info = infoFor(lookup, view, card.defId, card.radiant);
  const type = backrowType(card);
  const fieldPower = matchCardsOf(view).powers.get(card.instanceId);
  return liveFace(info, card, {
    ...(type === undefined ? {} : { type }),
    ...(fieldPower === undefined ? {} : { fieldPower }),
  });
}

/** A card named by an event or a log line: the definition, the face, and the instance when there is one. */
export type NamedCard = {
  defId: string;
  radiant: boolean;
  /** The instance, so a card the view still lists is drawn as it stands. */
  instanceId?: string;
  /** A cost to show when the view lists the card nowhere (a play's `costPaid`). */
  cost?: number;
};

/**
 * The face in play of a card an event names, or null for the sentinel. A card the view still lists
 * is drawn as it stands there (`listedFace`); one it no longer lists — gone to a pile it cannot
 * name, or ceased to exist — is its definition as the game shows it, at `cost` when one is given.
 */
export function namedFace(lookup: CardLookup | null, view: PlayerView, named: NamedCard): FaceModel | null {
  if (named.defId === HIDDEN_CARD || named.defId === "") return null;
  const listed = named.instanceId === undefined ? null : cardInView(view, named.instanceId);
  if (listed !== null && listed.defId === named.defId) return listedFace(lookup, view, listed);
  const info = infoFor(lookup, view, named.defId, named.radiant);
  return faceModel({
    defId: named.defId,
    def: info.def,
    name: info.name,
    type: info.type,
    radiant: named.radiant,
    ...(named.cost === undefined ? {} : { liveCost: named.cost }),
    inPlay: {},
  });
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
