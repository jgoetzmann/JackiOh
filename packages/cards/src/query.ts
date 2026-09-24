// SPEC §5.1's one catalog query, as the `packages/cards` surface every card script writes against.
//
// "The catalog needs one query function, `catalog.query({type, cost, costRange, tags, notTags,
// rarity, set, excludeIndex})`, that every random-generation and Discover effect uses" (§5.1).
// ONE function means one implementation: the filter lives in `packages/engine/src/catalog.ts` (the
// engine needs it for Recruit, Discover and every `generate` effect), and this file is the thin
// typed wrapper card scripts import. Nothing here filters, sorts, excludes tokens or reads a cost —
// re-implementing any of that would make two pools out of §5.1's one, which is the bug this file
// exists to prevent. What it does own is the card-facing contract below.
//
// The contract (proved by `test/query.test.ts`, which is the reference for card agents):
//
//   1. Tokens are out unless you ask. §5.1: "Random pools ('a random card', 'Discover a (2) cost
//      card') never include Token-tagged cards". `query({})` is therefore the 100 non-token cards;
//      tokens arrive only for a query that names the token pool — `tags: ["Token"]`,
//      `rarity: "Token"`, `token: true`, or naming members outright via `index`/`defId`.
//      BUILD M4-T4 row 51.1 ("absent from every random pool") needs no extra argument: KY's Empty
//      Notebook carries the KY tag, and `query({ tags: ["KY"] })` still leaves it out.
//   2. The generating card is out when the card says so. §5.1: pools "never include the generating
//      card's own definition, unless the card names the pool itself". That is `excludeIndex`, and
//      because it is the caller's own §5 index, the caller passes it — see `pool()` below, which
//      makes it impossible to forget. The exception is real: #95 Call to Chaos casts "a random Call
//      to Chaos" from the tag "which includes #95", so #95 uses plain `query({ tags: [...] })`.
//   3. Costs are read out of play (R65): "an embiggen card's printed cost is its base price and an
//      X-cost card's is 0". `cost`, `costRange` and `queryCost` all read that one number, so #7's
//      brackets, #51's brackets, #30's highest/lowest and #94's odd costs agree.
//   4. The result is ordered by SPEC §5 index, ascending, with no dependence on the order the
//      registry handed the defs over. A seeded `rng.pick`/`rng.shuffle` over a pool therefore
//      replays identically (§9.3, R58, R60).
//   5. Only registered catalog cards are reachable. `registerAll()` (src/index.ts) registers
//      CATALOG before a game starts; until then every pool is empty. Fused and crafted definitions
//      live on `state.transientDefs`, so no pool can ever generate one.
//
// Card scripts get this whole surface through `src/index.ts`'s `catalog` re-export, so
// `catalog.query(...)`, `catalog.pool(...)`, `catalog.cost(...)` and `catalog.trapTypes` are always
// in reach even when only `catalog` is imported.

import { query as engineQuery, queryCost, type CatalogQueryArgs } from "@jackioh/engine";
import type { CardDef, CardType } from "@jackioh/shared";

/**
 * §5.1's query arguments: `{ type, cost, costRange, tags, notTags, rarity, set, excludeIndex }`,
 * plus the engine's identity fields (`index`, `notIndex`, `defId`, `token`) for a pool a card names
 * card by card. `tags` means "has every listed tag"; `notTags` means "has none of them"; every
 * field narrows, and `{}` is the whole non-token catalog.
 */
export type CardQuery = CatalogQueryArgs;

/**
 * §5.1's single pool source. Returns the matching definitions in §5 index order.
 *
 * Random effects pick from this with `rng` (never `Math.random`, CLAUDE.md rule 4); Discover passes
 * the result to a `PendingChoice`. A card that generates from a pool almost always wants `pool()`
 * instead, so that its own definition cannot come back out.
 */
export function query(args: CardQuery = {}): CardDef[] {
  return engineQuery(args);
}

/**
 * §5.1's "never include the generating card's own definition": the pool for card `ownIndex`, which
 * is `query` with `ownIndex` added to `excludeIndex` rather than replacing what the caller passed.
 *
 * ```ts
 * pool("57", { tags: ["KY"] })                  // #57 Conjure KY  -> #31, #51, #82
 * pool("83", { rarity: "Legendary" })           // #83 Transmogulate (R35) -> #52, #85, #87, #92, #93, #95
 * pool("67", { type: TRAP_TYPES })              // #67 Zoomerbin Oomen -> #18, #41, #60, #71, #85, #96
 * ```
 */
export function pool(ownIndex: string, args: CardQuery = {}): CardDef[] {
  const already = args.excludeIndex;
  const excludeIndex =
    already === undefined ? [ownIndex] : [...(Array.isArray(already) ? already : [already]), ownIndex];
  return query({ ...args, excludeIndex });
}

/**
 * Both trap types, for a pool or filter that says "Trap". SPEC says "Field Trap counts as Trap" for
 * §8 #51 (KY's Private Tutor's type choice), #85/R61 (Unlicensed Experimentation's type match) and
 * R35 (Transmogulate's same-type replacement), so a `type: "Trap"` query — which matches the
 * `type` field exactly — would silently drop #18 and #71. Ask for both.
 *
 * Typed as a mutable array only because `CatalogQuery["type"]` is `CardType | CardType[]`; treat it
 * as constant, `query` never writes to it.
 */
export const TRAP_TYPES: CardType[] = ["Trap", "Field Trap"];

/**
 * R65's out-of-play cost of a definition: an X-cost card reads 0, an embiggen card reads its base
 * price, everything else its printed cost. This is what `cost` and `costRange` compare against, and
 * what a card script must use whenever it sorts, brackets or counts costs in a library, hand,
 * graveyard or pool. The in-play number is the engine's `mana.effectiveCost`, which starts from an
 * instance and adds `costMod`, discounts and Professor Curvature.
 */
export { queryCost };

/** §5.1's `catalog.query(...)`, as the object 110 card scripts call. */
export const catalog = {
  query,
  pool,
  cost: queryCost,
  trapTypes: TRAP_TYPES,
};

// Never sort, filter or de-duplicate a pool after calling `query`: a second sort here would be the
// duplicated filter §5.1 forbids, and the ordering is the engine comparator's job. (It once
// returned NaN for two non-numeric indexes and left the shared tokens in insertion order; that is
// fixed in the engine and guarded by a regression test in `test/query.test.ts`.)
