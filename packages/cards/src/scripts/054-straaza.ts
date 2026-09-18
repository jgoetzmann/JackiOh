// #54 Straaza (SPEC §8.3, §5.1, §6.3 Add to hand; R4, R60, R65, R78). Unit 8/8 → 16/16, cost 4.
//   Base:    "Cry: add 2 random Units costing 3 or 4 to your hand; they cost 1"
//   Radiant: "They cost 0" — §8 Conventions: the cell restates only the price clause, so the rest
//            of the base clause (2 random Units costing 3 or 4) is kept and only the 1 becomes 0.
//
// The Engine cell is "Non-token pool excluding #54; `costOverride`", which is §5.1's one query and
// nothing else:
//   * no tokens — automatic: "Random pools never include Token-tagged cards", so `{ type: "Unit" }`
//     already leaves out the Sheep, Rush, Felinor and Spikey Pillow token units;
//   * not #54 — `excludeIndex: def.index`, §5.1's "never include the generating card's own
//     definition". It is passed explicitly rather than trusted to the verb; see the report, where
//     `addRandomFromCatalog` is asked to default to it as `discoverFromCatalog` already does;
//   * costing 3 or 4 — `costRange: { min: 3, max: 4 }`, read out of play per R65, so an X-cost card
//     counts as 0 (never in this bracket) and an embiggen card at its base price (#59, base 2, also
//     out). `queryCost` in engine/src/catalog.ts is the one number every bracket in the game reads.
//
// R60: "Cards generated from the catalog may repeat unless the card says 'different'". This row
// does not say different, so both picks may land on the same def — two draws with replacement, not
// a shuffle of the pool.
// R65/R78: "they cost 1" is `costOverride` on each created instance, which is the first term of the
// cost calculation and survives in every zone, so the discount is still there next turn.
// R4: the hand caps at 10 and an extra add is burned to the graveyard; the add-to-hand pipeline
// owns that (engine/src/draw.ts), so this file never counts hand space.
//
// BLOCKED (reported, not worked around): `addRandomFromCatalog` is not in the effects barrel
// (engine/src/effects/index.ts). A hook may not roll the dice itself — `ctx.rng.*` advances
// `rngCursor`, which is state — and `addToHand` only takes a fixed `defId`, so the pick has to
// happen inside the effect. The verb this file is written against, shared with #57 Conjure KY and
// #59 Unbiased Immigration:
//
//   addRandomFromCatalog({ query: CatalogQueryArgs, count: number, player?: "self" | "enemy",
//                          radiant?: boolean, costOverride?: number }): Effect
//
// picking `count` definitions from `query(...)` with `ctx.rng` (repeats allowed, R60) and creating
// each one in `player`'s hand through the same pipeline `addToHand` uses (§2.4, R4), with
// `costOverride` set on every card it creates.

import type { CatalogQueryArgs, Script } from "@jackioh/engine";
import { addRandomFromCatalog } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-054");

/** §8: two cards, both Units in the 3-4 bracket. */
const COUNT = 2;

/**
 * §5.1's pool: Units costing 3 or 4, no tokens (automatic), never Straaza herself. `def.index` is
 * "54" straight from the catalog, so the exclusion cannot drift from the card's own index.
 */
const UNIT_POOL: CatalogQueryArgs = {
  type: "Unit",
  costRange: { min: 3, max: 4 },
  excludeIndex: def.index,
};

/** The two faces differ only in what the generated cards cost (§8 Conventions). */
function straaza(costOverride: number): Script {
  return {
    cry: () => [addRandomFromCatalog({ query: UNIT_POOL, count: COUNT, costOverride })],
  };
}

export const base: Script = straaza(1);

export const radiant: Script = straaza(0);
