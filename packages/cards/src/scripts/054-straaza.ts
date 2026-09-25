// #54 Straaza (SPEC §8.3, §5.1, §6.3 Add to hand; R4, R60, R65, R78, R215, R275). Unit, cost 4,
// 8/8 → 16/16.
//   Base:    "Cry: add 2 random Units costing 3 or 4 to your hand; they cost 1"
//   Radiant: "Cry: add 2 random Radiant Units costing 3 or 4 to your hand; they cost 0" — §8's
//            cell "They are Radiant and cost 0" (R275's raise: the cards' face and their price).
//            The cell restates only what the cards are and cost, so the count and the pool are
//            the base clause's, unchanged (§8 Conventions).
//
// The Engine cell is "Non-token pool excluding #54; `costOverride`", which is §5.1's one query and
// nothing else:
//   * no tokens — automatic: "Random pools never include Token-tagged cards", so `{ type: "Unit" }`
//     already leaves out the Sheep, Rush, Felinor and Spikey Pillow token units;
//   * not #54 — `excludeIndex: def.index`, §5.1's "never include the generating card's own
//     definition", passed explicitly rather than trusted to the verb;
//   * costing 3 or 4 — `costRange: { min: 3, max: 4 }`, read out of play per R65, so an X-cost card
//     counts as 0 (never in this bracket) and an embiggen card at its base price (#59, base 2, also
//     out). `queryCost` in engine/src/catalog.ts is the one number every bracket in the game reads.
//
// R60: "Cards generated from the catalog may repeat unless the card says 'different'". This row
// does not say different, so both picks may land on the same def — two draws with replacement, not
// a shuffle of the pool.
// R65/R78: "they cost 1" (radiant: 0) is `costOverride` on each created instance, which is the first
// term of the cost calculation and survives in every zone, so the discount is still there next turn.
// §5.2: "Radiant" on the radiant face is the created instance's flag, set as it is made, so each
// card arrives showing its Radiant face.
// R4: the hand caps at 10 and an extra add is burned to the graveyard; the add-to-hand pipeline
// owns that (engine/src/draw.ts), so this file never counts hand space. R215: the price is the
// card's price in the hand, so the verb sets it only on a card that reaches one, and a card the
// full hand burns reaches the graveyard at its printed price — Radiant still on the radiant face,
// since that flag is set as the card is made (engine/src/effects/addToHand.ts).
//
// The verb is `addRandomFromCatalog` (engine/src/effects/addToHand.ts): a hook may not roll the dice
// itself — `ctx.rng.*` advances `rngCursor`, which is state — so it picks `count` definitions from
// `query(...)` with `ctx.rng` (repeats allowed, R60) and creates each one in the hand through the
// same pipeline `addToHand` uses (§2.4, R4), with `costOverride` and `radiant` set on every card.

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

/** Base: "they cost 1". */
const BASE_COST = 1;

/** Radiant: "they cost 0". */
const RADIANT_COST = 0;

/** The two faces differ in what the generated cards cost and whether they are Radiant. */
function straaza(costOverride: number, radiant: boolean): Script {
  return {
    cry: () => [addRandomFromCatalog({ query: UNIT_POOL, count: COUNT, costOverride, radiant })],
  };
}

export const base: Script = straaza(BASE_COST, false);

export const radiant: Script = straaza(RADIANT_COST, true);
