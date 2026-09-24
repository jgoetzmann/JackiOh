// Card names and rules text for the board.
//
// FINDING against SPEC §10.8: `CardView` carries `instanceId`, `defId`, `radiant` and `cost` and
// nothing else, so a `PlayerView` alone cannot render a card's name, type, tribe tags or rules
// text — all of which BUILD M5-T1 requires on the face of a card. The catalog is public
// information (§5.1, §9.4 checks a `catalogVersion` on both sides), so the client may hold it;
// but it has to come from somewhere other than the view. Until `packages/cards` ships defs and
// the server sends a catalog with the view, every component falls back to showing the `defId`,
// which keeps the tests honest about what the view does and does not contain.

import { createContext, useContext } from "react";

import type { CardDef, CardDefs, CardType, Rarity, Tag } from "@jackioh/shared";

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

export function useCardInfo(defId: string, radiant: boolean): CardInfo {
  const lookup = useContext(CatalogContext);
  return lookup?.(defId, radiant) ?? unknownCard(defId);
}
