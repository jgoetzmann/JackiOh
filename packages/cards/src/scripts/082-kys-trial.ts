// #82 KY's Trial (SPEC §8.4 row 82): Spell, KY, cost 1, Rare.
//   Base:    "Discover among 3 distinct random numbers 1–100; add the Radiant Core card with that
//             index to your hand"
//   Radiant: "It costs 0"
//
// WHAT "IT" IS. The radiant cell changes one thing (§8 Conventions: a cell that changes only a
// number changes only that number, and every base clause it does not restate is kept), and the
// source design note settles which: "Add the Radiant core card corresponding to that number, it
// costs (0)" (JackiOh_Core_Cards.md #82). So the radiant face is the same Discover, and the card it
// puts in your hand costs 0 — not this spell. BUILD M4-T4's "radiant costs 0" is that card.
//
// THE POOL IS THE ENGINE'S, NOT THIS CARD'S (§5.1: one query function, R54).
// "Rolls 1–100 only, rerolls its own index, never a token index" (R54) is three filters, and
// `discoverFromCatalog` plus `catalog.query` already are all three:
//   - "never a token index": §5.1's default. `query` drops every Token-tagged, Token-rarity and
//     `token: true` def unless the caller names the token pool, which this one does not. The nine
//     token indices are exactly the nine non-integer indices in the catalog (51.1, 65.1, 90.1,
//     93.1, 95.1, T-rush, T-sheep, T-felinor, T-bread), so "no tokens" and "an integer 1–100" are
//     the same set of 100 cards — there is nothing left for this card to filter by number.
//   - "rerolls its own index": §5.1's "a random pool never offers the card that generated it".
//     `discoverFromCatalog` reads `defOf(state, ctx.self.defId).index` and passes it as
//     `excludeIndex` itself, so #82 can never be offered and the reroll costs nothing.
//   - "1–100": `set: "Core"`, which is §8's own numbering — the Core set is indices 1–100 plus its
//     tokens, and the tokens are already gone.
// So: 3 options out of those 100, drawn without replacement by `rng.shuffle` (§6.3 Discover), which
// is R60's "Discover options are always different" — the "3 distinct numbers" of the row.
//
// PRESENTATION NOTE (not a rule this card can enforce): §8 says you Discover among three *numbers*.
// `openPrompt` labels a Discover option with the definition's name, so the prompt shows three card
// names. The option keys are `mode:<catalog id>` either way and the mechanic is identical; showing
// the index instead of the name is §10.8's/the client's choice of label, not a card-script one.
//
// THE PICK COMES BACK AS A MODE (§10.6, R81). A Discover answer arrives in `ctx.targets` as
// `{ pick: "mode", option: "<catalog id>" }`; `chosenOptions` is the one reader for that, and the
// named `resume` step below is where `prompts.ts` re-enters this script (`RESUME_HOOK` = "resume",
// the step name is `Resume.step`). Nothing is captured in `data`: the answer is the whole state the
// continuation needs.
//
// R74/§5.2: "the Radiant Core card" is the radiant FLAG on a fresh instance, never a second card
// id, and `addToHand` carries it. R65: `costOverride` is where the calculation starts, so a 0
// override is a card that costs 0 in hand and keeps costing 0 in every zone (R78). R4: a full hand
// burns the card that arrives, which is `draw.addToHand`'s job and not this card's.

import type { Script } from "@jackioh/engine";
import { addToHand, chosenOptions, discoverFromCatalog } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-082");

/** §6.3 Discover offers three, and R54's roll is "1–100", which is the non-token Core set. */
const OPTIONS = 3;

/** The `resume` step `prompts.ts` re-enters with the Discover answer (§10.6). */
const PICKED = "picked";

/** The faces differ only in whether the card that arrives carries a `costOverride` of 0 (R65). */
function trial(costsZero: boolean): Script {
  return {
    // A Spell's script hangs off `cry`: that is its on-resolve hook (§10.9).
    cry: () => [
      discoverFromCatalog({
        step: PICKED,
        count: OPTIONS,
        // §5.1's one pool source. Tokens and #82 itself are excluded for us — see the header.
        query: { set: "Core" },
        prompt: "KY's Trial: Discover a number from 1 to 100",
      }),
    ],
    resume: {
      [PICKED]: (ctx) => {
        const [defId] = chosenOptions(ctx);
        // §8 Conventions: an empty pick fizzles and the spell still counts as played.
        if (defId === undefined) return [];
        return [
          addToHand({ defId, radiant: true, ...(costsZero ? { costOverride: 0 } : {}) }),
        ];
      },
    },
  };
}

export const base: Script = trial(false);

/** "It costs 0": the card the Discover adds, per the source note and BUILD M4-T4. */
export const radiant: Script = trial(true);
