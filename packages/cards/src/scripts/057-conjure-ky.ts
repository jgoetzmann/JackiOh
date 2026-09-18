// #57 Conjure KY (SPEC §8.3): Spell, cost 2, tag KY. "Add 3 random KY cards to your hand" /
// radiant "2 random plus 2 random Radiant KY cards". Engine cell: "KY pool = #31, #51, #82 (no
// tokens, not #57); repeats allowed".
//
// The pool is §5.1's one query and nothing else: `{ tags: ["KY"] }` already leaves out the Token-
// tagged KY card (#51.1 KY's Empty Notebook), because "random pools never include Token-tagged
// cards", and `excludeIndex: "57"` is §5.1's other half — "never include the generating card's own
// definition". That leaves #31 KY's Math Equation, #51 KY's Private Tutor and #82 KY's Trial, which
// is the Engine cell verbatim and BUILD M4-T4's must-pass row.
//
// R60: "Cards generated from the catalog may repeat unless the card says 'different'". This card
// does not say different, so three picks may land on one def — that is `count`, not a shuffle.
// R4: the hand caps at 10 and extra adds are burned to the graveyard; the add-to-hand pipeline owns
// that (engine/src/draw.ts), so neither face counts hand space here.
// R74/§5.2: a card generated "Radiant" is Radiant — an instance flag on the created card, not a
// separate def, which is why the radiant face is two calls rather than one with a ratio.
//
// BLOCKED (reported, not worked around): `addRandomFromCatalog` is not in the effects barrel
// (engine/src/effects/index.ts). A hook may not roll dice itself — `ctx.rng.*` advances `rngCursor`,
// which is state — so the pick has to happen inside an effect, and `addToHand` only takes a fixed
// `defId`. The verb this file is written against:
//
//   addRandomFromCatalog({ query: CatalogQueryArgs, count: number, player?: "self" | "enemy",
//                          radiant?: boolean, costOverride?: number }): Effect
//
// picking `count` defs from `query(...)` with `ctx.rng`, repeats allowed (R60), and creating each in
// `player`'s hand through the same pipeline `addToHand` uses (§2.4, R4). Shared with #54 Straaza
// and #59 Unbiased Immigration.

import type { CatalogQueryArgs, Script } from "@jackioh/engine";
import { addRandomFromCatalog } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-057");

/**
 * §5.1's KY pool: the KY tag minus tokens (automatic) minus this card (`excludeIndex`). Passed
 * explicitly because the verb cannot be trusted to know the caller's index yet — see the report:
 * `addRandomFromCatalog` should exclude the generating card by default, as `discoverFromCatalog`
 * already does (engine/src/effects/choose.ts).
 */
const KY_POOL: CatalogQueryArgs = { tags: ["KY"], excludeIndex: "57" };

/** A spell's script is its `cry` hook (§10.9; `runHook` in engine/src/resolve.ts). */
export const base: Script = {
  cry: () => [addRandomFromCatalog({ query: KY_POOL, count: 3 })],
};

/**
 * "2 random plus 2 random Radiant KY cards": a restated clause replaces the base one (§8
 * Conventions), so the radiant face adds 4 cards, not 3 + 4. The plain pair is rolled first so the
 * radiant flag lands on exactly the last two adds.
 */
export const radiant: Script = {
  cry: () => [
    addRandomFromCatalog({ query: KY_POOL, count: 2 }),
    addRandomFromCatalog({ query: KY_POOL, count: 2, radiant: true }),
  ],
};
