// #80 Zao Gao (SPEC §8.3, §5.2, §7, §10.5, §10.6; R11, R16, R21, R64, R81, R215, R221, R275,
// R276). Spell, cost 2.
//   Base:    "Discard 2 cards of your choice; summon 2 Rush Tokens, each with 2 random keywords"
//   Radiant: "Discard 2 cards of your choice; summon 2 Radiant Rush Tokens, each with 2 random
//            keywords" — §8's cell "The Rush Tokens are Radiant". R276 gave the card this face,
//            and a Radiant Rush Token (§7: 6/6, Rush, Cleave) is R275's raise.
//
// The two faces differ in one flag: the radiant face summons each token on its Radiant face.
// Everything else — the prompt, the discard, the rolls — is one shared body.
//
// The discard is a PROMPT, not a play-time declaration. R16: "Player's choice unless 'random'" and
// §10.6 names this card as the reason the `hand` kind is reachable at all: "`hand` is reachable:
// Zao Gao's chosen discard is a prompt, and an Echo repeat of Glowy Jelly Bean reopens its hand
// pick." That matters — a prompt reopens on every Echo repeat, where a declared target (#26) would
// not. `chooseFromHand` clamps `min = max = min(2, hand.length)`, which is §8's "Fewer than 2 in
// hand → discard what you have"; the resume step's second `discard` then finds no second selection
// and fizzles.
//
// The effect list deliberately spans the prompt. `prompts.applyResumable` parks the tail of a list
// as a `WorkItem` the moment a prompt opens and `answerPrompt` drains it after the resume step, so:
//   * with cards in hand, the two summons are parked, the discard step runs on the answer, and the
//     summons follow;
//   * with an EMPTY hand, `chooseFromHand` opens no prompt at all, nothing is parked, and the two
//     summons run straight through in the same list — Zao Gao still makes its tokens.
// Both paths are one list, which is why there is no empty-hand branch in the hook.
//
// The picks arrive in the resume step's `ctx.targets`, which is what `{ of: "chosen", index }` reads
// (R81), and `effects/move.discard` defaults to exactly that spec for this card's sake. R221 fixes
// their order — the order the prompt offered them, whatever order the answer listed them in — so
// the discards reach the (public) graveyard in that order. A discarded card is the printed card
// again, keeping only its `costMod`, `costOverride` and radiant flag (R215), and a unit-token card
// among the discards ceases to exist instead of reaching the graveyard (R11) — `discard`'s rules.
//
// R21: each token rolls 2 DISTINCT keywords from the eleven-entry pool, and the two tokens roll
// independently. `grantRandomKeywords` is that rule already — it recomputes the pool per draw off
// the unit's §10.4 keywords, so it never repeats inside one grant and never offers a keyword the
// unit already has: a Rush Token (printed Rush, §7) draws its two from the other ten, and a Radiant
// one (printed Rush and Cleave) from the other nine. §8's Engine cell puts the order in words:
// "each token is summoned Radiant and then rolls its 2 keywords" — `summon` sets the flag as it
// creates the card and rolls only once it has landed, so the roll reads the Radiant face.
//
// R64: a summon with no named zone takes the leftmost empty, unlocked, unreserved unit zone and
// fizzles silently when the row has none, so a board with one free zone gets one token.
//
// The keywords are rolled by `summon` itself (`randomKeywords`), since `summon` returns nothing a
// script can reference and `TargetSpec` has no "last summoned" case: rolling inside the summon keeps
// the rng draws adjacent to the summon they belong to (replay parity, §9.3) and has no fizzle
// hazard.

import type { Effect, Script } from "@jackioh/engine";
import { chooseFromHand, discard, summon } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-080");

/** §7: the token this card makes, taken from the catalog rather than restated. */
const RUSH_TOKEN = cardDef("core-t-rush").id;

const DISCARD_COUNT = 2;
const TOKEN_COUNT = 2;
/** R21: two distinct keywords per token, rolled independently for each. */
const KEYWORDS_PER_TOKEN = 2;

/** The `resume` step the `hand` prompt's answer re-enters (§10.6). */
const DISCARD_STEP = "discard";

/** One Rush Token with its two rolled keywords (R21, R64), on its Radiant face for the radiant card. */
function rushToken(radiantTokens: boolean): Effect {
  return summon({ defId: RUSH_TOKEN, radiant: radiantTokens, randomKeywords: KEYWORDS_PER_TOKEN });
}

/** `radiantTokens` is the whole of the radiant difference: the tokens are summoned Radiant. */
function zaoGao(radiantTokens: boolean): Script {
  return {
    cry: () => [
      // R16, §10.6: the player chooses, so this is a `hand` prompt clamped to the hand size.
      chooseFromHand({
        count: DISCARD_COUNT,
        step: DISCARD_STEP,
        prompt: "Discard 2 cards of your choice",
      }),
      // Parked by `applyResumable` while the prompt is open; run straight through on an empty hand.
      ...Array.from({ length: TOKEN_COUNT }, () => rushToken(radiantTokens)),
    ],
    resume: {
      // The answer's selections are in `ctx.targets`; a missing second pick fizzles (§8 Conventions).
      [DISCARD_STEP]: () =>
        Array.from({ length: DISCARD_COUNT }, (_unused, index) =>
          discard({ target: { of: "chosen", index } }),
        ),
    },
  };
}

export const base: Script = zaoGao(false);

/** R276: "summon 2 Radiant Rush Tokens" — the same card with the tokens on their Radiant face. */
export const radiant: Script = zaoGao(true);
