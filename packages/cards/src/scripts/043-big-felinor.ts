// #43 Big Felinor (SPEC §8.2). Unit 3/10 → 6/20, Felinor, cost 3, Rare.
//   Base:    "Cry: destroy all non-Felinor units on both sides"
//   Radiant: "Enemy non-Felinor units only" — §8 Conventions: a restated clause replaces the base
//            version, so the radiant Cry is the same destroy narrowed to one side.
//   Engine:  "Simultaneous destroy, one state check."
//
// R59 IS WHY THIS IS ONE EFFECT. "The state check never runs between the damage instances of a
// single effect", and §10.3 adds that "Apply effect means a whole script's effect list", so the
// check comes after the Cry's list either way. `destroy` only MARKS a card (`markedDestroyed`) and
// §4.5 step 1 "collects" every mark "at once", so nothing here can die early and take a Death
// trigger's side effects with it while the rest of the board is still being marked.
//
// MISSING VERB. `destroy({ target })` takes a `TargetSpec`, which is only `self | selfHero |
// enemyHero | chosen` — it cannot name a computed instance, and nothing chose these units, so a
// board-wide destroy is not expressible today. The call below is the verb the engine must add:
//
//   destroyAll({ side: "any" | "self" | "enemy", notTags?, tags?, excludeSelf? })
//       One effect that marks every unit the filter matches, so the single state check after the
//       whole effect collects them together (R59, §4.5). `side` is relative to `ctx.controller`;
//       `tags`/`notTags` read the def's §5 tags (tags are printed data, not a layer); only active
//       units are matched, so a card dormant under a Stack is neither marked nor hit (R13);
//       Indestructible is §4.5's business, not the filter's (R46, R69).
//
// See the agent report for the alternative the engine team may prefer instead: adding
// `{ of: "instance"; instanceId: string }` to `TargetSpec`, which unblocks every board-wide card at
// once. Either way the card file stays a list of effects.
//
// "AND ITSELF": Big Felinor is Felinor-tagged in `catalog.json`, so `notTags: ["Felinor"]` already
// spares it and `excludeSelf` would be a second, redundant reason. `test/043-big-felinor.test.ts`
// proves that rather than asserting it here.

import type { Script } from "@jackioh/engine";
import { destroyAll } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-043");

/** The faces differ only in which sides the destroy reaches. */
function bigFelinor(side: "any" | "enemy"): Script {
  return {
    cry: () => [destroyAll({ side, notTags: ["Felinor"] })],
  };
}

export const base: Script = bigFelinor("any");

export const radiant: Script = bigFelinor("enemy");
