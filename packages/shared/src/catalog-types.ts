// Card definitions and the vocabulary every package shares (SPEC §5, §6.1, §10.6).
// Script and Effect types live in engine/src/script.ts: they need GameState, which lives in the engine.

export type PlayerId = "p1" | "p2";
export const PLAYER_IDS = ["p1", "p2"] as const;

export function opponentOf(player: PlayerId): PlayerId {
  return player === "p1" ? "p2" : "p1";
}

/** §5.1 */
export type CardType = "Unit" | "Spell" | "Field Spell" | "Trap" | "Field Trap";

/** §5: tribes and tags. */
export type Tag = "Human" | "Felinor" | "KY" | "CN" | "Fruit" | "Call to Chaos" | "Quickdraw" | "Token";

/** §8: assigned by mechanical complexity; every token carries "Token". */
export type Rarity = "Common" | "Rare" | "Epic" | "Legendary" | "Mythic" | "Token";

/** §5: Core ships; the rest are reserved. */
export type SetName = "Core" | "Classic" | "Boss" | "Boss-X";

/** §5: 0 to 6, 100 (Ceaseless Void), X, or "A embiggen B". */
export type CardCost = number | "X" | { base: number; embiggen: number };

/**
 * A unit keyword (§6.1). Armor and Lucky carry a number; Armor sums across sources (§10.4).
 */
export type Keyword =
  | { kind: "Taunt" }
  | { kind: "Rush" }
  | { kind: "Charge" }
  | { kind: "First Strike" }
  | { kind: "Poisonous" }
  | { kind: "Lifesteal" }
  | { kind: "Reborn" }
  | { kind: "Divine Shield" }
  | { kind: "Trample" }
  | { kind: "Cleave" }
  | { kind: "Indestructible" }
  | { kind: "Immutable" }
  | { kind: "Stack" }
  | { kind: "Can't attack" }
  | { kind: "Armor"; n: number }
  | { kind: "Lucky"; n: number };

export type KeywordKind = Keyword["kind"];

/** Every keyword kind. R21's random pool is the narrower list in engine config. */
export const KEYWORD_KINDS = [
  "Taunt",
  "Rush",
  "Charge",
  "First Strike",
  "Poisonous",
  "Lifesteal",
  "Reborn",
  "Divine Shield",
  "Trample",
  "Cleave",
  "Indestructible",
  "Immutable",
  "Stack",
  "Can't attack",
  "Armor",
  "Lucky",
] as const;

export function keywordKey(keyword: Keyword): string {
  return "n" in keyword ? `${keyword.kind} ${keyword.n}` : keyword.kind;
}

export function hasKeyword(keywords: readonly Keyword[], kind: KeywordKind): boolean {
  return keywords.some((k) => k.kind === kind);
}

/** Total Armor across every source (§10.4). */
export function armorOf(keywords: readonly Keyword[]): number {
  return keywords.reduce((sum, k) => (k.kind === "Armor" ? sum + k.n : sum), 0);
}

/** One side of a card: the base form or the radiant form (§5). Spells have no stats. */
export type CardFace = {
  attack?: number;
  health?: number;
  keywords: Keyword[];
  /** The §8 cell this face implements, for the client and for test readability. */
  text: string;
};

export type CardDef = {
  /** Catalog id, e.g. "core-043"; transient defs (Fuse, Craft a Card) use "t-<n>". */
  id: string;
  /** §5: "43", token "51.1", shared token "T-rush". */
  index: string;
  name: string;
  set: SetName;
  type: CardType;
  tags: Tag[];
  rarity: Rarity;
  token: boolean;
  cost: CardCost;
  base: CardFace;
  radiant: CardFace;
};

export type CardDefs = Readonly<Record<string, CardDef>>;

/** §5.1: the one query every random pool and Discover goes through. */
export type CatalogQuery = {
  type?: CardType | CardType[];
  cost?: number;
  costRange?: { min?: number; max?: number };
  tags?: Tag[];
  notTags?: Tag[];
  rarity?: Rarity | Rarity[];
  set?: SetName;
  excludeIndex?: string | string[];
};

/** §10.6 */
export type PromptKind =
  | "discover"
  | "target"
  | "mode"
  | "mulligan"
  | "hand"
  | "zone"
  | "tribute"
  | "direction"
  | "x"
  | "embiggen";

export type Row = "units" | "backrow";

/** A zone a card can sit in. Field zones name a side, a row and a lane (§3). */
export type Zone =
  | { z: "hand" | "library" | "graveyard" | "exile"; player: PlayerId }
  | { z: "field"; player: PlayerId; row: Row; lane: number }
  | { z: "resolving"; player: PlayerId }
  /** R11: a unit token that left the field, or any card that ceased to exist (R86). */
  | { z: "gone"; player: PlayerId };

export type ZoneRef = { player: PlayerId; row: Row; lane: number };

/** Which cards a declared choice may pick (§10.6, R81). */
export type TargetFilter = {
  side?: "ally" | "enemy" | "any";
  of?: ("unit" | "hero" | "backrow" | "hand" | "zone")[];
  type?: CardType | CardType[];
  tags?: Tag[];
  notTags?: Tag[];
  excludeSelf?: boolean;
};

/** What a card asks for as part of its own play (R81). */
export type TargetDecl = {
  kind: Extract<PromptKind, "target" | "hand" | "zone" | "tribute">;
  min: number;
  max: number;
  filter?: TargetFilter;
  /** For Tribute: how many tributes the play costs (Sheep Tokens count 2, §6.3). */
  amount?: number;
};

export type ModeDecl = {
  kind: Extract<PromptKind, "mode" | "direction">;
  options: string[];
};
