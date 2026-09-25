// #87 Pocket Chaos (SPEC §8.5, §10.6, R4, R11, R12, R33, R73, R81, R88).
//
// Base: "Choose one: swap hero health, swap boards (every zone, lane-preserving), or swap libraries
// with the opponent; then add a Pocket Chaos to the opponent's hand; exile this".
// Radiant: "Choose one: …; then you may add a Pocket Chaos to the opponent's hand; draw 1; exile
// this" (§8's cell "You may skip adding it; then draw 1", R275's added draw).
//
// §8's Conventions: the radiant cell restates the "add a Pocket Chaos" clause and adds a draw, so
// the Choose one and the exile are kept unchanged. The radiant differences are two: the gift
// becomes optional, and a draw follows it, before the exile. The draw is the caster's and runs
// after the swap, so after a library swap it takes the top of the library the caster now holds —
// the one that was the opponent's (R73).
//
// BOTH choices are declared play choices, not prompts. R81's card list names #87, and §10.6 is
// explicit: "A card's own play choices (zone, X, embiggen, Tribute, declared targets and modes) are
// not prompts; they travel in the `play` action". `Script.modes` is a LIST of `ModeDecl`, and
// `playChoices.ts` enumerates the cross product of every declaration and refuses a play that does
// not answer each one (`refuseModes`: "Pocket Chaos needs a mode choice for each of its 2"), so the
// radiant face declares a second mode for the gift rather than opening a prompt mid-resolution.
// That is also the only reading that keeps the two faces consistent: making the skip a prompt would
// pause a resolution that the base face never pauses, and §10.6 reserves `PendingChoice` for
// choices made DURING resolution (Discover, chained steps, Echo repeats, casts, triggers).
//
// Reading the answers: `chosenOptions(ctx)` returns the play's `modes` in declaration order. The
// two option sets are disjoint, so this file never indexes into that list — `swap()` picks out the
// one of "health" | "board" | "library" it recognises and the gift clause looks for SKIP by name.
// A play that somehow carries no swap mode fizzles that clause and the rest of the card still
// resolves (§6.3, §8 Conventions).
//
// What each swap does is R73's, and `effects/swap.ts` owns it, so nothing here re-states it:
//   - health: the two values change places, armor stays with its hero; not damage and not "lose
//     health", so no pipeline (R18).
//   - board: zone contents change sides lane by lane in BOTH rows (§3.1), read whole and then
//     placed, so control changes for everything including face-down traps — which stay face-down
//     and become readable by their new controller only (R33) — while ownership does not (R12).
//     Locks are zone flags and stay with their zones, and a card whose destination is Locked or
//     reserved bounces to its owner's hand (R88, R4, R11).
//   - library: the two piles change places whole and in order, and each swapped card's owner
//     becomes the player now holding it — R12's one exception (R73). Fatigue stays with the player.
//
// The gift is a fresh, non-Radiant card: `addToHand` creates a new instance of this definition in
// the opponent's hand, and a full hand burns it (§2.4, R4). Radiant Pocket Chaos gives away a base
// copy — R57's "carries the radiant flag" is about copies of an existing card, and nothing in this
// card's text or the radiant cell says the gift is Radiant.
//
// `def.id` is the definition this file already owns, so the gift needs no id literal and no second
// catalog lookup.

import type { Effect, Script } from "@jackioh/engine";
import { addToHand, chosenOptions, draw, exile, swap } from "@jackioh/engine/effects";
import type { ModeDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-087");

/**
 * The three things #87 swaps. The names are `effects/swap.ts`'s `SwapWhat` values, which is what
 * lets `swap()` with no argument read the play's answer itself (§6.3 Choose one).
 */
const SWAP_MODE: ModeDecl = { kind: "mode", options: ["health", "board", "library"] };

/** The radiant face's second choice: hand the copy over, or keep it out of the opponent's hand. */
const GIFT = "gift";
const SKIP = "skip";
const GIFT_MODE: ModeDecl = { kind: "mode", options: [GIFT, SKIP] };

/** Radiant: "draw 1", after the gift and before the exile. */
const RADIANT_DRAW = 1;

/** `radiantFace` is the whole of the radiant text: an optional gift, then a draw. */
function chaos(radiantFace: boolean): Script {
  return {
    modes: radiantFace ? [SWAP_MODE, GIFT_MODE] : [SWAP_MODE],
    cry: (ctx): Effect[] => {
      // Only an explicit SKIP skips: the base clause is to add it, and the radiant cell makes that
      // optional rather than reversing it, so an unanswered gift mode still hands the copy over.
      const skipped = radiantFace && chosenOptions(ctx).includes(SKIP);
      return [
        swap(),
        ...(skipped ? [] : [addToHand({ defId: def.id, player: "enemy" })]),
        ...(radiantFace ? [draw({ count: RADIANT_DRAW })] : []),
        exile({ target: { of: "self" } }),
      ];
    },
  };
}

export const base: Script = chaos(false);

export const radiant: Script = chaos(true);
