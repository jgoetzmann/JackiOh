// #83 Transmogulate (SPEC §8.4 row 83): Spell, cost 2, Legendary.
//   Base:    "Replace every card in your library, board, GY and exile with a random Legendary"
//   Radiant: "Random Radiant Legendaries" — the cell restates only what the replacements are, so it
//            is the same four zones with `radiant: true` on every replacement (§8 Conventions).
//
// FOUR ZONES, AND YOUR HAND IS NOT ONE OF THEM. §8 and R35 both name "library, board, GY and exile"
// (the source note: "Replace your deck, board, GY, and exile"), so a card in hand is untouched.
//
// R35 IS THE WHOLE CARD:
//   "Board cards: same-type replacement in place, Field Trap counts as Trap, Immutable cards stay
//    (R23). Other zones: any card from the pool, same counts. Replaced cards cease to exist.
//    Pool: the §8 Legendary-rarity cards except #83, which is #52, #85, #87, #92, #93, #95".
// Clause by clause:
//   - "the pool" is `catalog.pool("83", { rarity: "Legendary" })` — §5.1's one query function with
//     this card's own index excluded, which `test/query.test.ts` pins to exactly those six. This
//     file never lists the six by hand: two sources of one pool is the bug that file prevents.
//   - "same-type replacement in place" is one `transform` per board card, narrowed to the
//     Legendaries of that card's type: a Unit becomes #52 or #92, a Field Spell becomes #93, and a
//     Trap becomes #85. "Field Trap counts as Trap" is `TRAP_TYPES` (both types in one query), so a
//     Field Trap also becomes #85 Unlicensed Experimentation — BUILD M4-T4's own example. The pool
//     holds no Legendary Field Trap, which is why the type match has to be read this way rather
//     than as an exact `type` equality.
//   - "in place" and "replaced cards cease to exist" are `effects/transform.ts`: `replaceOnField`
//     keeps the zone, the position and the Stack pile beneath, `replaceOffField` keeps the pile
//     index (so a library keeps its order), and both leave the old card in no pile at all. That is
//     also why the counts per zone are preserved without this card counting anything: every
//     replacement is one card for one card.
//   - "Immutable cards stay (R23), since this is a Transform" needs no check here either:
//     `transform` refuses an Immutable target and does nothing, so that card keeps its place and
//     the zone count still holds.
//
// R13 "Stack dormancy": cards under a Stack are not on the field, so "your board" is the top of
// each unit pile plus the backrow, which is what `cardAt` returns per zone (§3.2). Transforming a
// dormant card would also be wrong mechanically — `placeOnField(…, { stack: true })` puts the
// replacement on TOP of the pile, which would promote it past the card that is actually acting.
//
// R11: a unit token cannot sit in a graveyard or an exile pile. The pool holds no tokens, so no
// replacement can vanish on arrival and thin a zone (`replaceOffField` guards it anyway).
//
// RANDOMNESS (CLAUDE.md rule 4, §9.3). Every pick is `ctx.rng`, never `Math.random`, and the picks
// happen while the effect list is being built — the pool is a definition list, and `transform` takes
// one `defId`, so there is no "transform into a random X" effect to defer them into. That is
// deterministic here because this hook runs exactly once: the card opens no prompt, so nothing can
// re-enter it and `applyResumable` never replays part of the list (`prompts.ts`).
//
// THE OFF-FIELD READ. `zones.ts` exposes `slotsOf`/`cardAt` for the field but owns no reader for
// the off-field piles, so enumerating "every card in your library, GY and exile" used to mean
// naming the fields of `PlayerState` — which BUILD M3-T1's acceptance greps for, and which made
// this card one of fifteen files that would have to be edited if that shape ever changed. The
// engine's read-only board surface now answers it:
//     zoneCards(state, player, zone): readonly CardInstance[]     // engine/src/query.ts
// one pile as a copy, which is also what this card needs mechanically — see `pileCards` below.
// Reading is not mutation either way (CLAUDE.md rule 5 bans writing, and nothing here writes).

import type { CardInstance, Effect, EffectContext, Script } from "@jackioh/engine";
import { cardAt, defOf, slotsOf, unitHas, zoneCards } from "@jackioh/engine";
import { transform } from "@jackioh/engine/effects";
import type { CardDef, CardType } from "@jackioh/shared";
import { cardDef } from "../catalog-data";
import { TRAP_TYPES, catalog } from "../query";

export const def = cardDef("core-083");

/** §5.1: the pool excludes the generating card, which R35 spells out for this one. */
const OWN_INDEX = "83";

/** R35's "other zones", in the order this card walks them; the hand is deliberately absent. */
const OFF_FIELD_ZONES = ["library", "graveyard", "exile"] as const;

/** R35's pool: #52, #85, #87, #92, #93, #95 — proved by `test/query.test.ts`, not listed here. */
function legendaries(type?: CardType | CardType[]): CardDef[] {
  return catalog.pool(OWN_INDEX, { rarity: "Legendary", ...(type === undefined ? {} : { type }) });
}

/** R35 on the board: same type, with Field Trap counting as Trap in both directions. */
function sameTypeLegendaries(type: CardType): CardDef[] {
  return legendaries(type === "Trap" || type === "Field Trap" ? TRAP_TYPES : type);
}

/**
 * §3.2 and R13: "your board" is the card acting in each zone — the top of a pile, not the pile.
 * R35 and R23: an Immutable board card stays, since on the field a Replace is a Transform, so it is
 * left out here rather than handed to `transform` to refuse: R129 has an effect that finds nothing
 * to do draw no random number, and a pick rolled for a card that stays would be exactly that.
 */
function boardCards(ctx: EffectContext): CardInstance[] {
  return (["units", "backrow"] as const).flatMap((row) =>
    slotsOf(ctx.controller, row).flatMap((ref) => {
      const card = cardAt(ctx.state, ref);
      return card === null || unitHas(ctx.state, card, "Immutable") ? [] : [card];
    }),
  );
}

/**
 * One off-field pile of the controller's. `zoneCards` hands back a copy, which matters here: the
 * `transform`s this card builds replace every card in the pile being walked, so iterating the live
 * array would be iterating a list the effects are rewriting.
 */
function pileCards(
  ctx: EffectContext,
  zone: (typeof OFF_FIELD_ZONES)[number],
): readonly CardInstance[] {
  return zoneCards(ctx.state, ctx.controller, zone);
}

/** §6.3 Replace: one card, one random Legendary from its pool, named by instance (R81 does not apply). */
function replace(
  ctx: EffectContext,
  card: CardInstance,
  pool: readonly CardDef[],
  radiantResult: boolean,
): Effect[] {
  const pick = ctx.rng.pick(pool);
  if (pick === undefined) return [];
  return [transform({ instanceId: card.id, defId: pick.id, radiant: radiantResult })];
}

/** The faces differ only in whether the cards that arrive are Radiant (§5.2, R74). */
function transmogulate(radiantResult: boolean): Script {
  return {
    // A Spell's script hangs off `cry`: that is its on-resolve hook (§10.9).
    cry: (ctx): Effect[] => [
      // The board first, each card by its own type (R35); lane order, so the rng draws are fixed.
      ...boardCards(ctx).flatMap((card) =>
        replace(ctx, card, sameTypeLegendaries(defOf(ctx.state, card.defId).type), radiantResult),
      ),
      // Then library (top down), graveyard and exile: "any card from the pool, same counts".
      ...OFF_FIELD_ZONES.flatMap((zone) =>
        pileCards(ctx, zone).flatMap((card) => replace(ctx, card, legendaries(), radiantResult)),
      ),
    ],
  };
}

export const base: Script = transmogulate(false);

/** "Random Radiant Legendaries": the same four zones, every replacement Radiant. */
export const radiant: Script = transmogulate(true);
