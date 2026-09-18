// #7 Jewelosco Scarab (SPEC §8.1): a 1-cost 1/1 → 2/2 Unit, "Cry: Discover a 2-cost card", radiant
// "Cry: Discover a 3-cost card; it costs 1 less". The radiant cell restates the Discover with a new
// number and ADDS a clause (§8 Conventions: "a cell that changes only a number changes only that
// number", and "Also"/"Then" add effects), so the two faces differ in the cost bracket and in the
// permanent discount the radiant face puts on what it finds.
//
// §8.1's Engine cell is `catalog.query({cost, notTags:["Token"], excludeIndex:7})`:
//   - the cost bracket is read per R65, which `catalog.queryCost` already owns: outside play an
//     embiggen card counts at its base price and an X-cost card as 0, so this file passes a plain
//     number and nothing here reads a cost;
//   - `notTags: ["Token"]` is stated because §8 states it, even though §5.1 already keeps tokens
//     out of every pool that does not name them (`catalog.asksForTokens`);
//   - `excludeIndex: 7` is NOT passed here on purpose: `discoverFromCatalog` adds the running
//     card's own §5 index to every query it builds (§5.1, "a random pool never offers the card that
//     generated it"), so repeating it would be duplicated rules, not safety.
//
// The prompt and the continuation (§10.6, R81): the Cry opens a `discover` prompt whose answer is a
// `mode` selection carrying the chosen DEF ID, and the answer re-enters `resume.chosen` with that
// selection in `ctx.targets`, which is what `chosenOptions` reads. An empty pool never opens a
// prompt (the effect fizzles, the unit still enters, §8 Conventions), and then no step runs at all.

import type { Effect, EffectContext, Script } from "@jackioh/engine";
import { addToHand, chosenOptions, discoverFromCatalog } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-007");

/** The cost bracket each face Discovers from (§8.1). */
const BASE_COST = 2;
const RADIANT_COST = 3;
/** "It costs 1 less": a permanent −1 `costMod` on the card the radiant face found (§8.1, R65). */
const RADIANT_DISCOUNT = 1;

function discover(cost: number): Effect[] {
  return [discoverFromCatalog({ step: "chosen", query: { cost, notTags: ["Token"] }, count: 3 })];
}

/** §10.6: a Discover's answer is the def id it picked, or nothing when the prompt never opened. */
function picked(ctx: EffectContext): string | undefined {
  return chosenOptions(ctx)[0];
}

export const base: Script = {
  cry: () => discover(BASE_COST),
  resume: {
    chosen: (ctx) => {
      const defId = picked(ctx);
      return defId === undefined ? [] : [addToHand({ defId })];
    },
  },
};

export const radiant: Script = {
  cry: () => discover(RADIANT_COST),
  resume: {
    chosen: (ctx) => {
      const defId = picked(ctx);
      if (defId === undefined) return [];
      // BLOCKED: `addToHand` (engine/src/effects/addToHand.ts:9) takes `radiant` and
      // `costOverride` but no `costMod`, and the discount cannot be applied in a second effect
      // either: the card the Discover names does not exist until `addToHand` creates it, and
      // `setCostMod`'s only way to name a card is a `TargetSpec` — `{ of: "chosen" }` resolves
      // `ctx.targets[0]`, which on this path is a `mode` selection (a def id), so
      // `effects/targets.resolveTarget` returns null for it (targets.ts:36). §8.1 asks for a
      // permanent `costMod`, not a `costOverride` (R65 starts from the override in place of the
      // printed cost, which would also erase any other discount the card carries), so this waits
      // for the one-line engine addition rather than printing a different rule:
      //     addToHand(args: { defId; player?; radiant?; costOverride?; costMod?: number })
      //       ... if (args.costMod !== undefined) card.costMod += args.costMod;
      return [addToHand({ defId, costMod: -RADIANT_DISCOUNT })];
    },
  },
};
