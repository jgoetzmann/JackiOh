// #40 Echoes of the Forgotten (SPEC §8.2): 2-cost Field Spell, "Start of your turn: deal damage to
// the enemy hero equal to the cards in your exile; then exile the bottom card of your library",
// radiant "… equal to twice the cards in your exile; …" (R275; it was "+3 damage"). The Radiant
// face changes only that multiple, so everything else is kept — the same count, the same target, the
// same library exile.
//
// R280: the damage it would deal if its controller's turn started now is its `preview`, labelled
// "the cards in your exile" / "twice the cards in your exile" and computed by the same `damageNow`
// the hook deals. It reads its controller's exile count, which is public (§3).
//
// R72 fixes what is counted: "cards in exile" means YOUR OWN exile pile, so the count is
// `players[controller].exile.length` and never the game-wide `counters.exiled` (which R55 uses for
// Ceaseless Void) and never the opponent's pile.
//
// ORDER is load-bearing: the damage is counted BEFORE the new card enters exile, so the card this
// turn exiles does not pay out until next turn. The count is read in the hook, which is a pure read
// of `ctx.state` (CLAUDE.md rule 5 bans writing it, not reading it), and the number is then frozen
// into the `damage` effect, so it cannot drift while the list runs.
//
// "Start of your turn" is `startOfTurn`, which `turn.ts` runs for the active player alone
// (`triggerOrder(sink, "startOfTurn", player)`), so "your turn" needs no clause here. R62 puts
// those triggers before the draw, and a draw takes the TOP of the library (`drawOne` reads
// `library[0]`), so the bottom card this exiles is the same card either way.
//
// "Empty library → no exile, no fatigue" (§8.2 Engine) needs nothing of its own: this card never
// draws, so §2.4's fatigue (R3) is never in play, and an empty library simply has no bottom card.
// An amount of 0 is emitted as-is: `dealDamage` treats a hit of 0 before step 1 as no damage
// instance at all (R63), so an empty exile pile does nothing on either face (twice 0 is 0).
//
// "Exile the bottom card of your library" is the engine's `exileBottomOfLibrary` (shared with #65
// Masochism Mask's mode of the same words): `exile` takes a `TargetSpec`, which cannot name a
// library card, and the clause is not a choice (R81).

import type { GameState, Script } from "@jackioh/engine";
import { zoneCount } from "@jackioh/engine";
import type { PlayerId } from "@jackioh/shared";
import { damage, exileBottomOfLibrary } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-040");

/** How many damage each card in your exile is worth: "equal to the cards", radiant "twice the cards". */
const PER_EXILED_CARD = { base: 1, radiant: 2 } as const;

/** R280: the formula as each face prints it, which the preview labels its number with. */
const FORMULA = { base: "the cards in your exile", radiant: "twice the cards in your exile" } as const;

/**
 * The damage the hook deals if it runs now. R72: your own exile pile, read before anything new
 * enters it, through the engine's read-only `zoneCount` (engine/src/query.ts) rather than off
 * `PlayerState` (BUILD M3-T1).
 */
function damageNow(state: GameState, controller: PlayerId, perCard: number): number {
  return perCard * zoneCount(state, controller, "exile");
}

/** The two faces differ only by what each card in the exile is worth. */
function echoesOfTheForgotten(face: "base" | "radiant"): Script {
  const perCard = PER_EXILED_CARD[face];
  return {
    startOfTurn: (ctx) => [
      damage({ to: { of: "enemyHero" }, amount: damageNow(ctx.state, ctx.controller, perCard) }),
      // "then exile the bottom card of your library" — after the count, so it pays out next turn.
      exileBottomOfLibrary({ player: "self" }),
    ],
    preview: (ctx) => [{ label: FORMULA[face], value: damageNow(ctx.state, ctx.controller, perCard) }],
  };
}

export const base: Script = echoesOfTheForgotten("base");

export const radiant: Script = echoesOfTheForgotten("radiant");
