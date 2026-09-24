// Card names and rules text for the board.
//
// FINDING against SPEC §10.8: `CardView` carries `instanceId`, `defId`, `radiant` and `cost` and
// nothing else, so a `PlayerView` alone cannot render a card's name, type, tribe tags or rules
// text — all of which BUILD M5-T1 requires on the face of a card. The catalog is public
// information (§5.1, §9.4 checks a `catalogVersion` on both sides), so the client may hold it;
// but it has to come from somewhere other than the view. Until `packages/cards` ships defs and
// the server sends a catalog with the view, every component falls back to showing the `defId`,
// which keeps the tests honest about what the view does and does not contain.
//
// A match makes cards no catalog holds — a Fuse's, a crafted card's (R77, R102, R179) — and the view
// carries their definitions beside the cards it names (`PlayerView.defs`, R243). `MatchCardsContext`
// is where a component that takes a `PlayerView` (Board, Prompt, DragLayer) puts them for the cards
// it draws, together with the power each Heroic Power on the field rolled (`HeroView.powers`), so a
// `Card` that holds only its `CardView` can still read what it is: `useCardInfo` looks in the
// catalog first and in the match's definitions next.

import { createContext, createElement, useContext, useMemo, type ReactElement, type ReactNode } from "react";

import type { CardDef, CardDefs, CardType, PlayerView, Rarity, Tag } from "@jackioh/shared";

import type { RolledPower } from "../cards/index.ts";

export type CardInfo = {
  name: string;
  type: CardType;
  /** The §8 text for the face being shown (base or radiant). */
  text: string;
  tags: readonly Tag[];
  /** Printed attack and health for the face being shown; spells have neither. */
  attack?: number;
  health?: number;
  /** The whole catalog def, for the card faces (apps/web/src/cards, faceModel). */
  def?: CardDef;
  /** The catalog rarity (public, §5.1); the effects layer's Legendary and Mythic entrances read it. */
  rarity?: Rarity;
};

export type CardLookup = (defId: string, radiant: boolean) => CardInfo | undefined;

export const CatalogContext = createContext<CardLookup | null>(null);

export function lookupFromDefs(defs: CardDefs): CardLookup {
  return (defId, radiant) => {
    const def = defs[defId];
    if (def === undefined) return undefined;
    const face = radiant ? def.radiant : def.base;
    return {
      name: def.name,
      type: def.type,
      text: face.text,
      tags: def.tags,
      attack: face.attack,
      health: face.health,
      def,
      rarity: def.rarity,
    };
  };
}

/** What to show when no catalog is loaded: the def id, never a guess at a name. */
export function unknownCard(defId: string): CardInfo {
  return { name: defId, type: "Unit", text: "", tags: [] };
}

/** What a match holds beyond the catalog, as one view says it (R243). */
export type MatchCards = {
  /** `PlayerView.defs`: the match-made definitions the view names. */
  defs: CardDefs;
  /** Each Heroic Power on the field by instance id: the power it rolled and its X (`HeroView.powers`). */
  powers: ReadonlyMap<string, RolledPower>;
};

const NO_MATCH_CARDS: MatchCards = { defs: {}, powers: new Map() };

export const MatchCardsContext = createContext<MatchCards>(NO_MATCH_CARDS);

/** The match's own cards as `view` names them: its definitions, and both seats' field powers. */
export function matchCardsOf(view: PlayerView): MatchCards {
  const powers = new Map<string, RolledPower>();
  for (const seat of [view.you, view.opponent]) {
    for (const power of seat.hero.powers ?? []) powers.set(power.instanceId, { name: power.name, x: power.x });
  }
  return { defs: view.defs ?? {}, powers };
}

/** Puts `view`'s match cards in context for everything under it. */
export function MatchCardsProvider({ view, children }: { view: PlayerView; children?: ReactNode }): ReactElement {
  const value = useMemo(() => matchCardsOf(view), [view]);
  return createElement(MatchCardsContext.Provider, { value }, children);
}

/** A lookup that reads the catalog first and the match's own definitions next (R243). */
export function withMatchDefs(lookup: CardLookup | null, defs: CardDefs | undefined): CardLookup | null {
  if (defs === undefined || Object.keys(defs).length === 0) return lookup;
  const fromMatch = lookupFromDefs(defs);
  return (defId, radiant) => lookup?.(defId, radiant) ?? fromMatch(defId, radiant);
}

export function useCardInfo(defId: string, radiant: boolean): CardInfo {
  const lookup = useContext(CatalogContext);
  const match = useContext(MatchCardsContext);
  return lookup?.(defId, radiant) ?? lookupFromDefs(match.defs)(defId, radiant) ?? unknownCard(defId);
}

/** The power a Heroic Power on the field rolled, when the view names one for this instance. */
export function useFieldPower(instanceId: string | undefined): RolledPower | undefined {
  const match = useContext(MatchCardsContext);
  return instanceId === undefined ? undefined : match.powers.get(instanceId);
}
