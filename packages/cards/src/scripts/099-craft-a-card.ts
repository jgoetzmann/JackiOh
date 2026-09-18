// #99 Craft a Card (SPEC §8.5, §6.3 Fuse and Discover, §10.6, R77). Spell, cost 3, Mythic.
//   Base:    "Discover a Unit, then Discover another; Fuse them; the result costs 0 and goes to
//             your hand"
//   Radiant: "Three Discovers" — the cell restates only how many Discovers there are, so "Fuse
//             them; the result costs 0 and goes to your hand" is kept (§8 Conventions), and R77
//             agrees: "Craft a Card fuses two or three cards".
//   Engine:  "Fuse per 6.3 creates a transient definition stored in match state".
//
// THE CHAIN (§10.6). Each Discover is one `PendingChoice` whose `resume` names the next step, and
// `prompts.hookFor` looks the step up in the card's own `resume` table, so the chain is a table of
// named continuations and nothing else — no callback, no closure in state (§9.3). The picks are
// carried forward in `data`, the only place a chained effect may keep anything: `resumeSelf` merges
// the running step's `data` into the next step's, so each step appends the id it just received and
// hands the whole list on. `chosenOptions` is how a Discover's pick is read (a `mode` selection
// carrying a catalog id), never `ctx.targets` by hand.
//
// WHAT FUSE DOES WITH THEM (R77, `subsystems/fuse.ts`). "Fuse creates a transient definition. Its
// base form sums the ingredients' base attack and health, unions their base keywords and tags, and
// concatenates their base scripts; its radiant form does the same with their radiant forms. Its
// cost is min(sum of the printed costs per R65, 4). Its type is the target's, or the ingredients'
// shared type when there is no target on the field … Craft a Card fuses two or three cards with no
// target on the field, and its result is a fresh, non-Radiant hand card with `costOverride` 0."
// So: no `target`, `toHand` the caster; the def lands in `state.transientDefs` with BOTH faces
// fused, which is what makes "make the hand card Radiant later" switch to the fused radiant form;
// and the fused cost (min(sum, 4)) is overridden to 0 on the instance, not on the definition —
// `CRAFTED_CARD_COST`. Every one of those decisions is the subsystem's; this card only says which
// definitions go in and whose hand the result goes to.
//
// The ingredients are Discovered DEFINITIONS that were never cards on a board, so nothing ceases to
// exist that a player could see, and the fused type is the ingredients' shared type — always "Unit",
// because both (or all three) Discovers query `type: "Unit"`.
//
// TOKENS AND REPEATS. `catalog.query({ type: "Unit" })` drops tokens (§5.1's `asksForTokens` is
// false for a plain type filter), so no Rush Token or Chaos Golem can be crafted. The second and
// third Discovers are independent draws over the same pool, so the same Unit can be offered — and
// picked — twice; §8.5 and R77 neither forbid it nor de-duplicate, and R60 has generated cards
// repeating elsewhere, so nothing here narrows the later pools.
//
// BLOCKED (§8.5 #99 "Fuse them; the result costs 0 and goes to your hand"):
// `subsystems/fuse.ts` has the whole rule — `fuse(sink, { ingredients, target?, toHand? })` — but it
// is a subsystem function over an `EngineSink`, not an `Effect`, so a card file cannot call it
// (CLAUDE.md rule 5), and `FuseArgs.ingredients` is `readonly CardInstance[]` while a Discover hands
// over catalog ids. Nothing in the effects barrel creates an instance from a definition without
// also putting it in a zone (`addToHand` would emit `addedToHand` and could be burned by the hand
// cap; `summon` needs a field zone), so there is no way to build the ingredient list either.
// Reported. What is needed:
//
//   // packages/engine/src/effects/fuse.ts (new), re-exported from effects/index.ts
//
//   /** §6.3 Fuse as an effect (R77). Exactly the subsystem, wrapped: for each `defIds` entry it
//    *  creates `newInstance(state, defId, player, { z: "gone", player })` — an ingredient in no
//    *  pile, so no zone event fires and nothing can reach it — resolves each `instanceIds` entry
//    *  with `findInstance`, then calls `fuse(sink, { ingredients, target?, toHand? })` and leaves
//    *  the `fused` event and `state.transientDefs` to it. */
//   export function fuseCards(args: {
//     /** Ingredients that are definitions only: #99's Discover picks. */
//     defIds?: readonly string[];
//     /** Ingredients that already exist as cards: #85 Unlicensed Experimentation's pair. */
//     instanceIds?: readonly string[];
//     /** R77's kept instance: the on-field ingredient the result becomes. #99 never passes one. */
//     targetInstanceId?: string;
//     /** R77's Craft a Card path: whose hand the fresh `costOverride` 0 result goes to. */
//     toHand?: PlayerSpec;
//   }): Effect;
//
// (The alternative the engine team may prefer is widening `FuseArgs.ingredients` to
// `readonly (CardInstance | string)[]`, a defId standing for an ingredient that was never a card,
// and exporting a thin `Effect` around `fuse`. Either way this file stays a list of effects.)
//
// The last step returns `[]` until the verb lands, and imports nothing that does not exist: one
// unresolvable import in `src/scripts/` takes down `_generated.ts` and with it all 109 cards.
// Everything before it — the two (or three) chained Discovers and the picks they carry — is
// complete and compiles today.

import type { Effect, EffectContext, Hook, Script } from "@jackioh/engine";
import { subsystems } from "@jackioh/engine";
import { chosenOptions, discoverFromCatalog } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-099");

/** One resume step per Discover, named for the Discover whose answer it receives (§10.6). */
const FIRST = "first";
const SECOND = "second";
const THIRD = "third";

/** The `data` key the picks travel in; `data` is the only place a chained step may keep anything. */
const PICKS = "picks";

/** §6.3 Discover: 1 of 3 Units, drawn without replacement and shown only to the chooser. */
function discoverUnit(step: string, picks: readonly string[]): Effect {
  return discoverFromCatalog({
    step,
    query: { type: "Unit" },
    prompt: "Discover a Unit",
    data: { [PICKS]: [...picks] },
  });
}

/** The ids picked so far, read back out of the captured data. */
function picksOf(ctx: EffectContext): string[] {
  const stored: unknown = ctx.data[PICKS];
  if (!Array.isArray(stored)) return [];
  return stored.filter((entry): entry is string => typeof entry === "string");
}

/** Those ids plus the one this step was answered with. */
function withAnswer(ctx: EffectContext): string[] {
  const picked = chosenOptions(ctx)[0];
  const picks = picksOf(ctx);
  return picked === undefined ? picks : [...picks, picked];
}

/**
 * R77: two or three definitions, no target on the field, and a fresh non-Radiant hand card with
 * `costOverride` 0. Fewer than `FUSE_MIN_INGREDIENTS` is not a fusion — "Fewer is not a fusion" —
 * so a chain that lost an answer fizzles and the spell still counts as played (§8 Conventions).
 */
function craft(picks: readonly string[]): Effect[] {
  if (picks.length < subsystems.FUSE_MIN_INGREDIENTS) return [];
  // See the BLOCKED note in the header. With `fuseCards` in the effects barrel this is:
  //   return [fuseCards({ defIds: [...picks], toHand: "self" })]
  return [];
}

/** `discovers` is the whole of the difference between the two faces (§8.5's radiant cell). */
function craftACard(discovers: 2 | 3): Script {
  /** Each step appends the id it was answered with and hands the list to the next one. */
  const openSecond: Hook = (ctx) => [discoverUnit(SECOND, withAnswer(ctx))];
  const openThird: Hook = (ctx) => [discoverUnit(THIRD, withAnswer(ctx))];
  const fuseThem: Hook = (ctx) => craft(withAnswer(ctx));

  return {
    cry: () => [discoverUnit(FIRST, [])],
    resume: {
      [FIRST]: openSecond,
      // The last Discover's answer fuses; the radiant face has one more before that.
      [SECOND]: discovers === 3 ? openThird : fuseThem,
      ...(discovers === 3 ? { [THIRD]: fuseThem } : {}),
    },
  };
}

export const base: Script = craftACard(2);

export const radiant: Script = craftACard(3);
