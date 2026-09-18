// The card catalog is static data shipped with the client (§9.4), so the engine reads it from a
// registry rather than carrying it in GameState, which stays serializable. Fused and crafted
// definitions live in `state.transientDefs` and win over the registry.

import type { CardDef, CardDefs, CardType, CatalogQuery, Rarity } from "@jackioh/shared";

let registered: CardDefs = {};
let version = "0";

export function registerCatalog(defs: CardDefs, catalogVersion = "test"): void {
  registered = defs;
  version = catalogVersion;
}

export function registeredCatalog(): CardDefs {
  return registered;
}

/** Tokens and cards are also reachable by their §5 index ("43", "51.1", "T-rush"). */
export function defByIndex(index: string): CardDef | undefined {
  return Object.values(registered).find((def) => def.index === index);
}

export function catalogVersion(): string {
  return version;
}

export type TransientHolder = { transientDefs: Readonly<Record<string, CardDef>> };

export function findDef(state: TransientHolder | null, defId: string): CardDef | undefined {
  return state?.transientDefs[defId] ?? registered[defId];
}

/** Throws when a def is missing: a card instance always has a definition. */
export function defOf(state: TransientHolder | null, defId: string): CardDef {
  const def = findDef(state, defId);
  if (def === undefined) throw new Error(`unknown defId "${defId}": register the catalog first`);
  return def;
}

// ---------------------------------------------------------------------------
// §5.1's one query function, and the cost every filter reads (R65).
// ---------------------------------------------------------------------------

/**
 * R65 outside play: "an embiggen card's printed cost is its base price and an X-cost card's is 0".
 * Every pool, filter and comparison that looks at a *definition* rather than at a played instance
 * goes through this, so #7's cost brackets, #30's highest/lowest, #94's odd costs and Recruit all
 * read one number. The in-play calculation is `mana.effectiveCost`, which starts from the instance.
 */
export function queryCost(def: CardDef): number {
  const cost = def.cost;
  if (cost === "X") return 0;
  if (typeof cost === "number") return cost;
  return cost.base;
}

/**
 * §5.1's `catalog.query({type, cost, costRange, tags, notTags, rarity, set, excludeIndex})`, plus
 * the identity fields a card needs to name a pool by hand. Every field is a narrowing filter, and
 * `{}` is the whole non-token catalog.
 */
export type CatalogQueryArgs = CatalogQuery & {
  /** A §5 index, or several: a pool named card by card (mirrors `RecruitFilter`). */
  index?: string | string[];
  /** The inverse of `index`; `excludeIndex` is the §5.1 spelling and both are honoured. */
  notIndex?: string | string[];
  /** A catalog id, or several, for a pool a script builds from ids it already holds. */
  defId?: string | string[];
  /** §5.1: `true` asks for tokens, `false` forbids them (the default already does). */
  token?: boolean;
};

function asList<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value as T];
}

/**
 * §5.1: "Random pools never include Token-tagged cards … unless the card names the pool itself".
 * A query names the token pool by asking for the Token tag or rarity, by setting `token: true`, or
 * by naming its members outright through `index`/`defId`.
 */
function asksForTokens(args: CatalogQueryArgs): boolean {
  if (args.token !== undefined) return args.token;
  if (args.tags?.includes("Token") === true) return true;
  if (asList<Rarity>(args.rarity).includes("Token")) return true;
  return asList(args.index).length > 0 || asList(args.defId).length > 0;
}

function isToken(def: CardDef): boolean {
  return def.token || def.tags.includes("Token");
}

function matchesQuery(def: CardDef, args: CatalogQueryArgs, tokensAllowed: boolean): boolean {
  if (!tokensAllowed && isToken(def)) return false;
  if (args.token !== undefined && isToken(def) !== args.token) return false;

  const types = asList<CardType>(args.type);
  if (types.length > 0 && !types.includes(def.type)) return false;
  const rarities = asList<Rarity>(args.rarity);
  if (rarities.length > 0 && !rarities.includes(def.rarity)) return false;
  if (args.set !== undefined && def.set !== args.set) return false;

  const indexes = asList(args.index);
  if (indexes.length > 0 && !indexes.includes(def.index)) return false;
  const defIds = asList(args.defId);
  if (defIds.length > 0 && !defIds.includes(def.id)) return false;
  // §5.1: a random pool never offers the card that generated it.
  if (asList(args.excludeIndex).includes(def.index)) return false;
  if (asList(args.notIndex).includes(def.index)) return false;

  // `tags` means "has every listed tag"; `notTags` means "has none of them".
  if (args.tags !== undefined && !args.tags.every((tag) => def.tags.includes(tag))) return false;
  if (args.notTags !== undefined && args.notTags.some((tag) => def.tags.includes(tag))) return false;

  // R65: costs are read out of play, so X counts as 0 and an embiggen card as its base price.
  const cost = queryCost(def);
  if (args.cost !== undefined && cost !== args.cost) return false;
  if (args.costRange?.min !== undefined && cost < args.costRange.min) return false;
  if (args.costRange?.max !== undefined && cost > args.costRange.max) return false;
  return true;
}

/** §5's index as a number, so "2" sorts before "10" and a token index ("T-rush") sorts last. */
function indexRank(index: string): number {
  const parsed = Number.parseFloat(index);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * §5.1's single source of random pools and Discover: every definition the filters allow, in §5 index
 * order. The order is a strict total order (index as a number, then the index itself, then the
 * unique catalog id), so it never depends on the order the registry happened to hand the defs over
 * and a seeded `rng.pick`/`rng.shuffle` over the result replays identically (R58, R60, §9.3).
 *
 * Only the registered catalog is searched: fused and crafted definitions live on the instance's
 * `transientDefs` and are not catalog cards, so no pool can generate one.
 */
export function query(args: CatalogQueryArgs = {}): CardDef[] {
  const tokensAllowed = asksForTokens(args);
  return Object.values(registered)
    .filter((def) => matchesQuery(def, args, tokensAllowed))
    .sort((a, b) => {
      // Compared, not subtracted: two token indexes are both +Infinity, and `Infinity - Infinity`
      // is NaN, which `sort` reads as 0 while `NaN !== 0` is true — so subtracting returned early
      // with NaN and skipped both tie-breaks, leaving the tokens in registry insertion order and
      // breaking the total order this function promises (R58, R60, §9.3).
      const rankA = indexRank(a.index);
      const rankB = indexRank(b.index);
      if (rankA !== rankB) return rankA < rankB ? -1 : 1;
      if (a.index !== b.index) return a.index < b.index ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
}
