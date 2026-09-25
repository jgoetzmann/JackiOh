// What a card face shows, computed once from a catalog def and the live view (docs/polish/6-cards.md,
// Surface B). Pure: no React, no DOM, no settings. Every component that draws a card — the board's
// Card.tsx, the inspect overlays, the deck builder — builds a FaceModel here and hands it down.
//
// Two kinds of face come out of it (SPEC §10.10). A face with no `inPlay` is the card as printed:
// the collection's, both faces of it in the catalog's words. A face with `inPlay` is the card as the
// view says it stands in a game (R243): the cost the view gives it, the stats of a Unit in its
// owner's hand with what it gained there (#89 Corpse Eater), the numbers and keywords of a unit on
// the field, the Vanilla marker, and inPlay.ts's words where play and print part ways — a #98
// Heroic Power's rolled power, "???" for Call to Chaos. A match-made definition (a Fuse's, R77) is
// just the `def` the caller found in the view's `defs`, and prints its own name, text and stats.
//
// Nothing here is a rule (CLAUDE.md rule 7). The tones compare two numbers the view and the catalog
// already carry — the live cost against the printed price, the live stats against the printed
// stats — so a buffed unit reads green and a damaged one red, the way Hearthstone colours them.
//
// Three marks ride on the text (SPEC §10.10). A Radiant face prints its whole catalog text with the
// stretches its base face does not have marked (`text.marks`, radiantDiff.ts, R277); the names its
// `refs` link are references (refs.ts, R279), which the renderer finds in the text; and in play the
// numbers the view's `preview` carries are printed after their formulas (`values`, R280).

import {
  keywordKey,
  type CardDef,
  type CardFace as PrintedFace,
  type CardType,
  type Keyword,
  type Rarity,
  type PreviewValue,
  type SetName,
  type Tag,
} from "@jackioh/shared";

import {
  CONCEALED_TEXT,
  HEROIC_POWER_ID,
  VANILLA_TEXT,
  concealedInPlay,
  powerText,
  type RolledPower,
} from "./inPlay.ts";
import { radiantMarks, type TextRange } from "./radiantDiff.ts";

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
export type FaceStats = {
  attack: number;
  health: number;
  maxHealth: number;
  attackTone: StatTone;
  healthTone: StatTone;
  /**
   * R277: on a printed Radiant face (no live numbers), which stats the Radiant face raised over the
   * base face's, so the face can mark them as it marks its text. Absent elsewhere.
   */
  grew?: { attack: boolean; health: boolean };
};
/**
 * What the rules box prints: the whole text, and on a Radiant face the stretches of it the base
 * face's text does not have (R277). `marks` is empty on a base face and wherever play prints
 * something else (a Vanilla unit, "???", a Heroic Power's power on its base face).
 */
export type FaceText = { full: string; marks: readonly TextRange[] };
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
   * What the rules box prints: the face's catalog text whole, with a Radiant face's changes marked
   * (R277). A fused definition's text is its ingredients' texts line by line (R102), each Radiant
   * line marked against its own base line. In play it is what the card in play says (inPlay.ts),
   * which may differ from the printed text.
   */
  text: FaceText;
  /**
   * R279: the cards and tokens this card's text names (`CardDef.refs`), which the renderer links
   * where their names stand in `text.full`. Empty where the text in play names none ("???", Vanilla).
   */
  refs: readonly string[];
  /**
   * R280: in play, what the card's formula comes to now (`CardView.preview`), each value printed in
   * braces after its label. Always empty in the collection, and wherever play prints other words.
   */
  values: readonly PreviewValue[];
  /** Live keywords when `live` was given, else the printed face's keywords. */
  keywords: readonly Keyword[];
  /** A face in a game (`FaceSource.inPlay` given) rather than the collection's. */
  inPlay: boolean;
  /** R243, §6.3 Vanilla: the unit's text is gone, and the rules box says so. */
  vanilla: boolean;
  /**
   * Keywords the card has now that its printed face does not print (a Plastic Surgery's, an aura's,
   * Defense Position's Taunt, every keyword a Vanilla unit still has): the face prints them after
   * its text, since the text no longer says them. Empty outside play.
   */
  gained: readonly Keyword[];
  /**
   * The collection's text for this face, when the face in play prints something else — a Heroic
   * Power's rolled power, a Vanilla unit — so the inspect overlays can show both. Null when the two
   * agree, outside play, and for a card whose text play keeps a mystery ("???").
   */
  printed: FaceText | null;
};
/**
 * What a game adds to a face (R243, SPEC §10.10); its presence is what makes a face one in play.
 * `live` (a unit on the field) and `liveCost` stay where they were, beside it.
 */
export type InPlay = {
  /** R243: a Unit card's stats in its owner's hand, as they stand (`CardView.attack`, `.health`). */
  handStats?: { attack: number; health: number };
  /** R243: the unit's text is gone (`UnitView.vanilla`). */
  vanilla?: boolean;
  /** R43, R243: the power a #98 Heroic Power rolled, with its X. */
  power?: RolledPower;
  /** R280: what the card's formula comes to now (`CardView.preview`). */
  preview?: readonly PreviewValue[];
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
  /** Set on every face drawn in a game, absent in the collection (see the header). */
  inPlay?: InPlay;
};

/** The gem of a card nobody can name: no catalog, no live cost. */
const UNKNOWN_COST = "?";

/** A card with no def is drawn as a Unit, exactly as `unknownCard` in game/catalog.ts reports it. */
const UNKNOWN_TYPE: CardType = "Unit";

export function faceModel(source: FaceSource): FaceModel {
  const def = source.def;
  const printed = def === undefined ? undefined : source.radiant ? def.radiant : def.base;
  const type: CardType = def?.type ?? source.type ?? UNKNOWN_TYPE;
  const inPlay = source.inPlay;
  const vanilla = inPlay?.vanilla === true;
  const printedText = textOf(def, source.radiant);
  const text = inPlay === undefined ? printedText : textInPlay(def, source.radiant, printedText, inPlay);
  const keywords = source.live?.keywords ?? printed?.keywords ?? [];
  // The values belong to the printed words: a formula play does not print has no value to show.
  const printsItsText = text.full === printedText.full;

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
    cost: costOf(def, source.liveCost, inPlay?.power),
    stats: statsOf(type, def !== undefined, printed, source.live ?? handLive(inPlay?.handStats, printed), grewOf(def, source)),
    text,
    // The renderer links only the names that stand in the text, so play's own words link what they name.
    refs: def?.refs ?? [],
    values: printsItsText ? (inPlay?.preview ?? []) : [],
    keywords,
    inPlay: inPlay !== undefined,
    vanilla,
    // A Vanilla unit prints no keyword of its own any more (§6.3), so every one it still has is gained.
    gained:
      inPlay === undefined || source.live === undefined
        ? []
        : gainedKeywords(keywords, vanilla ? [] : (printed?.keywords ?? [])),
    printed: inPlay === undefined || sameText(text, printedText) || concealed(def) ? null : printedText,
  };
}

/** R243: a hand card's stats are its face plus what it gained in hand, with nothing on the field's layers. */
function handLive(stats: InPlay["handStats"], printed: PrintedFace | undefined): FaceSource["live"] {
  if (stats === undefined) return undefined;
  return { attack: stats.attack, health: stats.health, maxHealth: stats.health, keywords: printed?.keywords ?? [] };
}

/** The keywords a card has now that its printed face does not print, each once, in the order it has them. */
function gainedKeywords(live: readonly Keyword[], printed: readonly Keyword[]): Keyword[] {
  const printedKeys = new Set(printed.map(keywordKey));
  const seen = new Set<string>();
  const gained: Keyword[] = [];
  for (const keyword of live) {
    const key = keywordKey(keyword);
    if (printedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    gained.push(keyword);
  }
  return gained;
}

function sameText(a: FaceText, b: FaceText): boolean {
  return a.full === b.full;
}

/** R277: which stats a printed Radiant face raised over its base face's; none in play or on a base face. */
function grewOf(def: CardDef | undefined, source: FaceSource): FaceStats["grew"] {
  if (def === undefined || !source.radiant || source.live !== undefined || source.inPlay?.handStats !== undefined) {
    return undefined;
  }
  return {
    attack: (def.radiant.attack ?? 0) > (def.base.attack ?? 0),
    health: (def.radiant.health ?? 0) > (def.base.health ?? 0),
  };
}

/** inPlay.ts: a card with the Call to Chaos tag keeps its text a mystery in play. */
function concealed(def: CardDef | undefined): boolean {
  return def !== undefined && concealedInPlay(def.tags);
}

/**
 * What the rules box prints in play (inPlay.ts). A Vanilla unit's text is gone; a Call to Chaos is
 * "???"; a #98 Heroic Power is the power it rolled. Anything else prints its printed text.
 */
function textInPlay(def: CardDef | undefined, radiant: boolean, printedText: FaceText, inPlay: InPlay): FaceText {
  if (inPlay.vanilla === true) return { full: VANILLA_TEXT, marks: [] };
  if (def === undefined) return printedText;
  if (concealed(def)) return { full: CONCEALED_TEXT, marks: [] };
  if (inPlay.power !== undefined && def.id === HEROIC_POWER_ID) {
    const face = radiant ? def.radiant : def.base;
    const words = powerText(inPlay.power, radiant, face.keywords.map(keywordKey).join(", "));
    if (words !== null) {
      // R277: a Radiant power is marked against the same power's base words.
      const baseWords = radiant ? powerText(inPlay.power, false, def.base.keywords.map(keywordKey).join(", ")) : null;
      return { full: words, marks: baseWords === null ? [] : radiantMarks(baseWords, words) };
    }
  }
  return printedText;
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

function costOf(def: CardDef | undefined, liveCost: number | undefined, power?: RolledPower): FaceCost {
  const live = liveCost === undefined ? undefined : String(liveCost);

  if (def === undefined) {
    const text = live ?? UNKNOWN_COST;
    return { text, value: text, tone: "base", alt: null };
  }

  const printed = def.cost;
  if (printed === "X") {
    // A #98 Heroic Power's X is its rolled power's (R43), which the view names: in play, that is
    // what the gem says, as its text does.
    if (power !== undefined) {
      const x = String(power.x);
      return { text: x, value: live ?? x, tone: "base", alt: null };
    }
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
  grew: FaceStats["grew"],
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
  return { attack, health, maxHealth: health, attackTone: "base", healthTone: "base", ...(grew === undefined ? {} : { grew }) };
}

/**
 * A base face prints its catalog text. A Radiant face prints its catalog text whole, the Radiant
 * cell written out (R277), with what the base face's text does not have marked; a fused definition's
 * lines are marked line by line against the base lines of the same ingredients (radiantDiff.ts).
 */
function textOf(def: CardDef | undefined, radiant: boolean): FaceText {
  if (def === undefined) return { full: "", marks: [] };
  if (!radiant) return { full: def.base.text, marks: [] };
  return { full: def.radiant.text, marks: radiantMarks(def.base.text, def.radiant.text) };
}
