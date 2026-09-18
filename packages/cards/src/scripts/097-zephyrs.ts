// #97 Zephyrs (SPEC §8.5, §10.7's scorer bullet, §6.3 Discover and Exile, R29). Spell, cost 0.
//   Base:    "Discover the 'perfect' card from the Core set; exile this"
//   Radiant: "A perfect Radiant card" — the cell restates only which card the Discover hands over,
//            so "exile this" is kept and the pick arrives Radiant (§8 Conventions).
//   Engine:  "Scorer in 10.7 ranks every non-token Core card except #97 for the current state;
//             Discover offers the top 3 (R29)".
//
// THE RANKING IS THE SUBSYSTEM'S. §10.7: "for each candidate, simulate a dry-run score: lethal
// available → max; can clear the enemy board → high; hero below 10 and card heals → high; otherwise
// stats-per-mana plus draw value. Deterministic, ranks all non-token Core cards except Zephyrs
// itself, Discover offers the top 3. The weights are engine constants". That is
// `subsystems/scorer.ts` (`rank`, `topThree`, `SCORER_WEIGHTS`), and this card only asks it for the
// three ids and hands them to the Discover. No weight, no tie-break and no candidate filter is
// restated here, and `{ radiant }` is passed through so the radiant face scores the radiant faces
// (`ScorerOptions`, §5.2).
//
// WHY A `defId` POOL. `discoverFromCatalog` draws its options from `catalog.query`, and `query`
// honours a `defId` list as "a pool a script builds from ids it already holds" (§5.1). So naming
// the scorer's three ids offers exactly those three and nothing else. Tokens cannot slip in through
// `asksForTokens`'s `defId` branch: `scorer.candidateDefs` is `query({ set: "Core",
// excludeIndex: "97" })`, which already drops every token (§5.1), so the list can only hold
// non-token Core cards. `count: 3` is R29's "the top 3" said out loud rather than left to a default.
//
// R29's "EXCEPT #97" COMES FOR FREE TWICE: `candidateDefs` passes `excludeIndex: ZEPHYRS_INDEX`,
// and `discoverFromCatalog` adds `excludeIndex` for the running card's own index on top of it
// (§5.1: "a random pool never offers the card that generated it").
//
// WHY THE EXILE IS THE SECOND EFFECT AND NOT THE FIRST. §8.5's row reads "Discover …; exile this",
// and `prompts.applyResumable` is built for exactly that shape: the effect after the one that
// opened the prompt is parked in `state.work` as a continuation of this same hook and drained once
// the answer comes back, so "exile this" happens whether the prompt pauses the list or not. Putting
// the exile first would also work mechanically — `resolveTarget({ of: "self" })` reads `ctx.self`,
// which the resume still finds in the exile pile — but it would change the order §8.5 prints and
// would exile the card before its own text had finished, so the row's order is the one kept.
//
// §10.5 step 7 sends a resolved Spell to the graveyard "or exile"; this card is the "or exile", and
// `exile` bumps `state.counters.exiled`, which is R55's counter #100 reads.

import type { Script } from "@jackioh/engine";
import { subsystems } from "@jackioh/engine";
import { addToHand, chosenOptions, discoverFromCatalog, exile } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-097");

/** The one resume step: the Discover's answer comes back here (§10.6, `prompts.RESUME_HOOK`). */
const PICKED = "picked";

/** R29: "Discover shows the top 3" — §6.3's Discover is 1 of 3 either way, said explicitly. */
const OFFERED = 3;

/** The two faces differ only in which face the scorer ranks and which face reaches the hand. */
function zephyrs(radiant: boolean): Script {
  return {
    cry: (ctx) => [
      discoverFromCatalog({
        step: PICKED,
        // R29: the scorer's top three, by id, for the state as it stands right now.
        query: { defId: subsystems.topThree(ctx.state, ctx.controller, { radiant }).map((scored) => scored.def.id) },
        count: OFFERED,
        prompt: radiant ? "Discover a perfect Radiant card" : "Discover the perfect card",
      }),
      exile({ target: { of: "self" } }),
    ],
    resume: {
      // A Discover's pick arrives as a `mode` selection carrying a catalog id (§10.6).
      [PICKED]: (ctx) => {
        const picked = chosenOptions(ctx)[0];
        // The prompt only ever offers three real ids, so this is the "no answer at all" case.
        if (picked === undefined) return [];
        return [addToHand({ defId: picked, radiant })];
      },
    },
  };
}

export const base: Script = zephyrs(false);

export const radiant: Script = zephyrs(true);
