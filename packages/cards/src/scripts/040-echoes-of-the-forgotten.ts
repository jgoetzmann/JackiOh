// #40 Echoes of the Forgotten (SPEC §8.2): 2-cost Field Spell, "Start of your turn: deal damage to
// the enemy hero equal to the cards in your exile; then exile the bottom card of your library",
// radiant "+3 damage". The radiant cell changes only that number, so everything else is kept
// (§8 Conventions) — the same count, the same target, the same library exile.
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
// instance at all (R63), so an empty exile pile does nothing on the base face while the radiant
// face still deals its +3.
//
// !! BLOCKED — MISSING VERB (reported; the wave's agreed name, also requested by #65 Masochism
// Mask, whose "exile the bottom card of your library" mode is the same clause) !!
//     exileBottomOfLibrary({ player?: "self" | "enemy" }): Effect
// `exile` takes only a `TargetSpec`, and `TargetSpec` is `{of:"self"} | {of:"selfHero"} |
// {of:"enemyHero"} | {of:"chosen", index?}` — none of which can name a library card, and
// `{ of: "chosen" }` reads `ctx.targets`, which is empty in a start-of-turn hook (R81: declared
// picks travel with a `play`, and this clause is not a choice at all). No other verb in
// `effects/index.ts` moves a library card to exile, so there is no faithful composition to fall
// back on; the call below is written against the agreed verb rather than faked. Implementation is
// three lines over what already exists: take `players[player].library.at(-1)` — the top is index 0,
// so the bottom is the last element — and hand it to the same `moveToZone(state, card, "exile")`
// plus `counters.exiled += 1` and `exiled` event that `effects/move.ts` already does.
// (`exile({ instanceId })`, the escape hatch `steal`, `transform` and `setRadiant` all carry and
// that #34 Collateral Damage asks for, would do just as well; either one unblocks all three cards.)

import type { Script } from "@jackioh/engine";
import { zoneCount } from "@jackioh/engine";
import { damage, exileBottomOfLibrary } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-040");

/** Radiant: "+3 damage" — the one number the radiant cell changes. */
const RADIANT_BONUS = 3;

/** The two faces differ only by the bonus added to the exile count. */
function echoesOfTheForgotten(bonus: number): Script {
  return {
    startOfTurn: (ctx) => [
      // R72: your own exile pile, read before anything new enters it, through the engine's
      // read-only `zoneCount` (engine/src/query.ts) rather than off `PlayerState` (BUILD M3-T1).
      damage({
        to: { of: "enemyHero" },
        amount: zoneCount(ctx.state, ctx.controller, "exile") + bonus,
      }),
      // "then exile the bottom card of your library" — after the count, so it pays out next turn.
      exileBottomOfLibrary({ player: "self" }),
    ],
  };
}

export const base: Script = echoesOfTheForgotten(0);

export const radiant: Script = echoesOfTheForgotten(RADIANT_BONUS);
