// What a card face shows, computed once from a catalog def and the live view (docs/polish/6-cards.md,
// Surface B). Pure: no React, no DOM, no settings. Every component that draws a card — the board's
// Card.tsx, the inspect overlays, the deck builder — builds a FaceModel here and hands it down.
//
// Nothing here is a rule (CLAUDE.md rule 7). The tones compare two numbers the view and the catalog
// already carry — the live cost against the printed price, the live stats against the printed
// stats — so a buffed unit reads green and a damaged one red, the way Hearthstone colours them.

import type { CardDef, CardFace as PrintedFace, CardType, Keyword, Rarity, SetName, Tag } from "@jackioh/shared";

import { radiantText } from "./radiantText.ts";

export type FaceLayout = "full" | "compact" | "minion";
export type StatTone = "base" | "buffed" | "reduced" | "damaged";
export type FaceCost = {
  /**
   * What the gem shows: the view's live number whenever there is one (SPEC §10.10: the client
   * renders `viewFor`), "X" for an X card, else the printed price (an embiggen card's base).
   */
  text: string;
  /** `data-cost`: the live number when there is one (CardView.cost), else `text`. */
  value: string;
  tone: "base" | "down" | "up";
  /**
   * The embiggen price, shown small beside the gem while the gem shows the base price; null
   * otherwise, including once the live cost has moved off the base price (a discount, or a card
   * on the field that was paid its embiggen price).
   */
  alt: string | null;
};
export type FaceStats = { attack: number; health: number; maxHealth: number; attackTone: StatTone; healthTone: StatTone };
export type FaceModel = {
  defId: string;
  /** False when no catalog def was available (the `unknownCard` fallback). */
  known: boolean;
  name: string;
  type: CardType;
  tags: readonly Tag[];
  rarity: Rarity | null;
  index: string | null;
  set: SetName | null;
  radiant: boolean;
  cost: FaceCost;
  /** Units only: live when `live` was given, else the printed face; null for non-units and unknown stats. */
  stats: FaceStats | null;
  /**
   * What the rules box prints. On a base face, `base` is the base text and `radiant` is null. On a
   * radiant face they are radiantText.ts's reading of the two cells by SPEC §8's rule: `base` is
   * the radiant form's keyword line and the base clauses it keeps, `radiant` what the cell adds or
   * restates (printed under a gold rule), or null when it changes nothing else.
   */
  text: { base: string; radiant: string | null };
  /** Live keywords when `live` was given, else the printed face's keywords. */
  keywords: readonly Keyword[];
};
export type FaceSource = {
  defId: string;
  def?: CardDef;
  /** Fallbacks when `def` is absent (CardInfo.name, BackrowView.type). */
  name?: string;
  type?: CardType;
  radiant: boolean;
  /** CardView.cost. */
  liveCost?: number;
  /** UnitView's current numbers. */
  live?: { attack: number; health: number; maxHealth: number; keywords: readonly Keyword[] };
};

/** The gem of a card nobody can name: no catalog, no live cost. */
const UNKNOWN_COST = "?";

/** A card with no def is drawn as a Unit, exactly as `unknownCard` in game/catalog.ts reports it. */
const UNKNOWN_TYPE: CardType = "Unit";

export function faceModel(source: FaceSource): FaceModel {
  const def = source.def;
  const printed = def === undefined ? undefined : source.radiant ? def.radiant : def.base;
  const type: CardType = def?.type ?? source.type ?? UNKNOWN_TYPE;

  return {
    defId: source.defId,
    known: def !== undefined,
    name: def?.name ?? source.name ?? source.defId,
    type,
    tags: def?.tags ?? [],
    rarity: def?.rarity ?? null,
    index: def?.index ?? null,
    set: def?.set ?? null,
    radiant: source.radiant,
    cost: costOf(def, source.liveCost),
    stats: statsOf(type, def !== undefined, printed, source.live),
    text: textOf(def, source.radiant),
    keywords: source.live?.keywords ?? printed?.keywords ?? [],
  };
}

/**
 * `data-foil` on `.cf`: Mythic cards and radiant faces carry foil, animated while the player's
 * `animatedFoil` setting is on and still while it is off. The CSS never animates it under
 * `prefers-reduced-motion: reduce` whatever this says.
 */
export function foilFor(face: FaceModel, animatedFoil: boolean): "animated" | "static" | "none" {
  if (face.rarity !== "Mythic" && !face.radiant) return "none";
  return animatedFoil ? "animated" : "static";
}

function costTone(live: number | undefined, printed: number): FaceCost["tone"] {
  if (live === undefined) return "base";
  if (live < printed) return "down";
  if (live > printed) return "up";
  return "base";
}

function costOf(def: CardDef | undefined, liveCost: number | undefined): FaceCost {
  const live = liveCost === undefined ? undefined : String(liveCost);

  if (def === undefined) {
    const text = live ?? UNKNOWN_COST;
    return { text, value: text, tone: "base", alt: null };
  }

  const printed = def.cost;
  if (printed === "X") {
    // An X card costs exactly X (R65): the gem says X, and `data-cost` carries whatever the view says.
    return { text: "X", value: live ?? "X", tone: "base", alt: null };
  }
  if (typeof printed === "number") {
    const text = live ?? String(printed);
    return { text, value: text, tone: costTone(liveCost, printed), alt: null };
  }
  // "A embiggen B". With no live number, or the live number at A, the gem shows A with the bigger
  // price B beside it. Otherwise it shows the view's number and drops B, which it can no longer
  // vouch for (the client never works out a discounted embiggen price, CLAUDE.md rule 7). A card
  // whose live cost is B was paid B, on the field: that is its printed price, so the tone is base.
  const base = String(printed.base);
  if (liveCost === undefined || liveCost === printed.base) {
    return { text: base, value: live ?? base, tone: "base", alt: String(printed.embiggen) };
  }
  const text = String(liveCost);
  const tone = liveCost === printed.embiggen ? "base" : costTone(liveCost, printed.base);
  return { text, value: text, tone, alt: null };
}

function statTone(value: number, printed: number | undefined): StatTone {
  if (printed === undefined) return "base";
  if (value > printed) return "buffed";
  if (value < printed) return "reduced";
  return "base";
}

function statsOf(
  type: CardType,
  known: boolean,
  printed: PrintedFace | undefined,
  live: FaceSource["live"],
): FaceStats | null {
  if (live !== undefined) {
    // A unit nobody can name has no printed face to compare against, so nothing is coloured.
    if (!known) {
      return { attack: live.attack, health: live.health, maxHealth: live.maxHealth, attackTone: "base", healthTone: "base" };
    }
    return {
      attack: live.attack,
      health: live.health,
      maxHealth: live.maxHealth,
      attackTone: statTone(live.attack, printed?.attack),
      healthTone: live.health < live.maxHealth ? "damaged" : statTone(live.maxHealth, printed?.health),
    };
  }

  if (type !== "Unit") return null;
  const attack = printed?.attack;
  const health = printed?.health;
  if (attack === undefined || health === undefined) return null;
  return { attack, health, maxHealth: health, attackTone: "base", healthTone: "base" };
}

/**
 * A base face prints its text. A radiant face prints radiantText.ts's reading of the two cells:
 * the radiant keyword line and the base clauses the cell keeps, then what the cell adds or restates.
 */
function textOf(def: CardDef | undefined, radiant: boolean): FaceModel["text"] {
  if (def === undefined) return { base: "", radiant: null };
  if (!radiant) return { base: def.base.text, radiant: null };
  const read = radiantText(def.base.text, def.radiant.text, def.radiant.keywords);
  return { base: read.kept, radiant: read.changed };
}
