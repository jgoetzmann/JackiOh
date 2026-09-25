// The deck builder's browse semantics: which pool cards a filter keeps, the order a sort puts them
// in, the mana curve of a deck and the order its list tiles are drawn in.
//
// PURE, AND THE ONLY PLACE THESE LIVE. The components render what this module returns and decide
// nothing themselves, so a filter or a sort is proved here without mounting anything
// (docs/polish/6-cards.md, Surface D).
//
// NO RULE LIVES HERE EITHER. Ownership comes from `poolFrom` (which already drops Tokens, since L3
// bans them from a deck), and whether a deck is legal is `@jackioh/validator`'s alone. A filter only
// hides cards from view; it never refuses one. Filter and sort state is deliberately not persisted:
// a filter that survived a reload could hide cards and confuse a player (and spec 09).

import type { CardCost, CardDef, CardType, KeywordKind, Rarity, Tag } from "@jackioh/shared";
import type { CatalogSnapshot, Collection } from "@jackioh/validator";

import { poolFrom } from "./loadout.ts";

/** Cost filter chips and mana-curve buckets. Core tops out at 6, plus the 100-cost Ceaseless Void. */
export type CostBucket = "0" | "1" | "2" | "3" | "4" | "5" | "6+" | "X";

export const COST_BUCKETS: readonly CostBucket[] = ["0", "1", "2", "3", "4", "5", "6+", "X"];

/** The "6+" boundary: every numeric cost at or above it shares one bucket. */
export const CURVE_TOP = 6;

export const FILTER_TYPES: readonly CardType[] = ["Unit", "Spell", "Field Spell", "Trap", "Field Trap"];

/** Every tag a deckable card can carry. "Token" is left out: the pool never offers a Token. */
export const FILTER_TAGS: readonly Tag[] = [
  "Human",
  "Felinor",
  "KY",
  "CN",
  "Fruit",
  "Call to Chaos",
  "Quickdraw",
  // R278: #13 and #14's.
  "Jlockeed",
];

export const FILTER_RARITIES: readonly Rarity[] = ["Common", "Rare", "Epic", "Legendary", "Mythic"];

export type PoolFilter = {
  costs: ReadonlySet<CostBucket>;
  types: ReadonlySet<CardType>;
  tags: ReadonlySet<Tag>;
  rarities: ReadonlySet<Rarity>;
  search: string;
  ownedOnly: boolean;
};

/** Every group empty (no constraint), no search, and only the cards the profile owns. */
export const DEFAULT_FILTER: PoolFilter = {
  costs: new Set<CostBucket>(),
  types: new Set<CardType>(),
  tags: new Set<Tag>(),
  rarities: new Set<Rarity>(),
  search: "",
  ownedOnly: true,
};

export type SortKey = "cost" | "name" | "rarity" | "attack" | "health" | "type";

export const SORT_KEYS: readonly SortKey[] = ["cost", "name", "rarity", "attack", "health", "type"];

export type PoolSort = { key: SortKey; dir: "asc" | "desc" };

export const DEFAULT_SORT: PoolSort = { key: "cost", dir: "asc" };

/** Common < Rare < Epic < Legendary < Mythic. Token sorts after them (the pool never shows one). */
const RARITY_ORDER: readonly Rarity[] = ["Common", "Rare", "Epic", "Legendary", "Mythic", "Token"];

const TYPE_ORDER: readonly CardType[] = ["Unit", "Spell", "Field Spell", "Trap", "Field Trap"];

/** The printed price a card is filed under: an embiggen card under its base price. */
function printedPrice(cost: CardCost): number | "X" {
  if (typeof cost === "number") return cost;
  if (cost === "X") return "X";
  return cost.base;
}

/** n ≥ 6 → "6+" (so 100 is "6+"); an embiggen card → its base price's bucket; "X" → "X". */
export function costBucket(cost: CardCost): CostBucket {
  const price = printedPrice(cost);
  if (price === "X") return "X";
  if (price >= CURVE_TOP) return "6+";
  // COST_BUCKETS opens with "0".."5", so a price below CURVE_TOP is its own position.
  return COST_BUCKETS[Math.floor(price)] ?? "0";
}

/** The number a cost sorts by: n; an embiggen card's base; X after every number. */
export function costOrder(cost: CardCost): number {
  const price = printedPrice(cost);
  return price === "X" ? Number.POSITIVE_INFINITY : price;
}

/** Keyword kinds printed on either face, as searchable words. */
function keywordKindsOf(def: CardDef): KeywordKind[] {
  return [...def.base.keywords, ...def.radiant.keywords].map((keyword) => keyword.kind);
}

/** Everything a search term may match, lower-cased. Fields are newline-separated, and a term never
 *  holds whitespace, so no term can match across two fields. */
function haystackOf(def: CardDef): string {
  return [
    def.name,
    def.type,
    ...def.tags,
    def.rarity,
    def.base.text,
    def.radiant.text,
    ...keywordKindsOf(def),
  ]
    .join("\n")
    .toLowerCase();
}

/**
 * The query is trimmed and split on whitespace; every term has to occur, case-insensitively, in the
 * card's name, type, tags, rarity, base or radiant text, or the keyword kinds printed on either face.
 * An empty query keeps everything.
 */
export function searchMatches(def: CardDef, query: string): boolean {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return true;
  const haystack = haystackOf(def);
  return terms.every((term) => haystack.includes(term));
}

/**
 * Cost, type, tag, rarity and search. Chips OR within a group and AND across groups, and an empty
 * group is no constraint. Ownership is `visiblePool`'s job, not this function's.
 */
export function matchesFilter(def: CardDef, filter: PoolFilter): boolean {
  if (filter.costs.size > 0 && !filter.costs.has(costBucket(def.cost))) return false;
  if (filter.types.size > 0 && !filter.types.has(def.type)) return false;
  if (filter.tags.size > 0 && !def.tags.some((tag) => filter.tags.has(tag))) return false;
  if (filter.rarities.size > 0 && !filter.rarities.has(def.rarity)) return false;
  return searchMatches(def, filter.search);
}

/** Never subtraction: `Infinity - Infinity` is NaN, and X costs are Infinity. */
function compareNumbers(left: number, right: number): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

/** The ascending comparison of one sort key. */
function comparePrimary(key: "cost" | "name" | "rarity" | "type", left: CardDef, right: CardDef): number {
  switch (key) {
    case "cost":
      return compareNumbers(costOrder(left.cost), costOrder(right.cost));
    case "name":
      return compareNames(left.name, right.name);
    case "rarity":
      return compareNumbers(RARITY_ORDER.indexOf(left.rarity), RARITY_ORDER.indexOf(right.rarity));
    case "type":
      return compareNumbers(TYPE_ORDER.indexOf(left.type), TYPE_ORDER.indexOf(right.type));
  }
}

/** Ties, always ascending whatever `dir` says: cost, then name, then the numeric catalog index. */
function compareTies(left: CardDef, right: CardDef): number {
  const byCost = compareNumbers(costOrder(left.cost), costOrder(right.cost));
  if (byCost !== 0) return byCost;
  const byName = compareNames(left.name, right.name);
  if (byName !== 0) return byName;
  // §5: `index` is "43" or "51.1", so it compares as a number.
  return compareNumbers(Number.parseFloat(left.index), Number.parseFloat(right.index));
}

/** The base face's stat for the attack and health sorts; undefined when the card prints none. */
function statOf(def: CardDef, key: "attack" | "health"): number | undefined {
  return key === "attack" ? def.base.attack : def.base.health;
}

/**
 * Sorts pool ids. `dir` flips only the primary key; ties then break ascending by cost, name and
 * catalog index. For attack and health, a card with no stats goes last in both directions.
 */
export function sortPool(ids: readonly string[], catalog: CatalogSnapshot, sort: PoolSort): string[] {
  const flip = sort.dir === "desc" ? -1 : 1;
  return [...ids].sort((leftId, rightId) => {
    const left = catalog.cards[leftId];
    const right = catalog.cards[rightId];
    // `visiblePool` hands this only ids the catalog knows.
    if (left === undefined || right === undefined) return 0;

    if (sort.key === "attack" || sort.key === "health") {
      const leftStat = statOf(left, sort.key);
      const rightStat = statOf(right, sort.key);
      if (leftStat === undefined && rightStat !== undefined) return 1;
      if (leftStat !== undefined && rightStat === undefined) return -1;
      if (leftStat !== undefined && rightStat !== undefined) {
        const byStat = compareNumbers(leftStat, rightStat) * flip;
        if (byStat !== 0) return byStat;
      }
      return compareTies(left, right);
    }

    const primary = comparePrimary(sort.key, left, right) * flip;
    if (primary !== 0) return primary;
    return compareTies(left, right);
  });
}

/**
 * What the pool grid shows: `poolFrom(catalog, filter.ownedOnly ? collection : null)` (so Tokens
 * never appear, and unchecking "owned" shows every other catalog card), filtered, then sorted.
 */
export function visiblePool(
  catalog: CatalogSnapshot,
  collection: Collection | null,
  filter: PoolFilter,
  sort: PoolSort,
): readonly string[] {
  const shelf = poolFrom(catalog, filter.ownedOnly ? collection : null);
  const kept = shelf.filter((id) => {
    const def = catalog.cards[id];
    return def !== undefined && matchesFilter(def, filter);
  });
  return sortPool(kept, catalog, sort);
}

/** Per-bucket card counts for a deck's mana curve. Ids the catalog does not know are skipped. */
export function manaCurve(
  cardIds: readonly string[],
  catalog: CatalogSnapshot,
): Readonly<Record<CostBucket, number>> {
  const counts: Record<CostBucket, number> = {
    "0": 0,
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    "5": 0,
    "6+": 0,
    X: 0,
  };
  for (const id of cardIds) {
    const def = catalog.cards[id];
    if (def === undefined) continue;
    counts[costBucket(def.cost)] += 1;
  }
  return counts;
}

/**
 * The order a deck's list tiles are drawn in: cost, then name, then id; unknown ids last. Display
 * only. What `save` sends is the draft in the order the player built it, never this.
 */
export function deckListOrder(cardIds: readonly string[], catalog: CatalogSnapshot): string[] {
  return [...cardIds].sort((leftId, rightId) => {
    const left = catalog.cards[leftId];
    const right = catalog.cards[rightId];
    if (left === undefined || right === undefined) {
      if (left !== undefined) return -1;
      if (right !== undefined) return 1;
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    }
    const byCost = compareNumbers(costOrder(left.cost), costOrder(right.cost));
    if (byCost !== 0) return byCost;
    const byName = compareNames(left.name, right.name);
    if (byName !== 0) return byName;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

/** A copy of `set` with `value` added when absent and removed when present. */
export function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
