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
// THE VERB (§8.5 #99 "Fuse them; the result costs 0 and goes to your hand"): `fuseCards` in the
// effects barrel, which is `subsystems/fuse.ts` wrapped and nothing more. `fuse(sink, { ingredients,
// target?, toHand? })` has the whole rule but takes an `EngineSink` and mutates state, which a card
// file may not do (CLAUDE.md rule 5), and its `ingredients` are `CardInstance`s while a Discover
// hands over catalog ids — so `defIds` is the spelling this card uses, and the effect makes each
// pick an ingredient in no pile at all (R86's `{ z: "gone" }`) before handing the list over. R102
// composes the result member by member; none of it is reimplemented here.

import type { Effect, EffectContext, Hook, Script } from "@jackioh/engine";
import { subsystems } from "@jackioh/engine";
import { chosenOptions, discoverFromCatalog, fuseCards } from "@jackioh/engine/effects";
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
  // No target: nothing of this fusion was ever on a board, so R77 takes the ingredients' shared
  // type ("Unit", both Discovers query it) and hands back a fresh non-Radiant card with
  // `costOverride` 0. "your hand" is the caster's (§8.5).
  return [fuseCards({ defIds: [...picks], toHand: "self" })];
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
