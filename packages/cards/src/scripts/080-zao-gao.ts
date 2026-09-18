// #80 Zao Gao (SPEC §8.3, R16, R21, R64, R11, §5.2, §7, §10.6, §10.5).
//
// "Discard 2 cards of your choice; summon 2 Rush Tokens, each with 2 random keywords."
//
// No radiant form. SPEC §5.2: "Cards with no listed Radiant form (Quickstriker, Zao Gao, …) are
// unchanged by becoming Radiant; the flag still sets so counting effects behave" (R74). So the two
// exports are the SAME Script object and the radiant face is the base text, verbatim.
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
// (R81), and `effects/move.discard` defaults to exactly that spec for this card's sake. A unit-token
// card among the discards ceases to exist instead of reaching the graveyard (R11) — `discard`'s rule.
//
// R21: each token rolls 2 DISTINCT keywords from the eleven-entry pool, and the two tokens roll
// independently. `grantRandomKeywords` is that rule already — it recomputes the pool per draw, so it
// never repeats inside one grant, and it never offers a keyword the unit already has, which means a
// Rush Token (printed Rush, §7) draws its two from the other ten.
//
// R64: a summon with no named zone takes the leftmost empty, unlocked, unreserved unit zone and
// fizzles silently when the row has none, so a board with one free zone gets one token.
//
// Missing capability (see the report): there is no way for a card to name a token it has just
// summoned. `summon` returns nothing a script can reference and `TargetSpec` has no "last summoned"
// case, so the keywords cannot be granted as a second effect. This file is written against the
// proposed `randomKeywords?: number` argument on `SummonArgs` — the summon rolls them itself, which
// keeps the rng draws adjacent to the summon they belong to (replay parity, §9.3) and has no
// fizzle hazard. The alternative, a `{ of: "lastSummoned" }` TargetSpec, is discussed in the report.

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

/** One Rush Token with its two rolled keywords (R21, R64). */
function rushToken(): Effect {
  return summon({ defId: RUSH_TOKEN, randomKeywords: KEYWORDS_PER_TOKEN });
}

/**
 * One Script for both faces: SPEC §5.2 lists Zao Gao among the cards with no radiant form, so
 * becoming Radiant sets the flag and changes nothing the script does (R74).
 */
const zaoGao: Script = {
  cry: () => [
    // R16, §10.6: the player chooses, so this is a `hand` prompt clamped to the hand size.
    chooseFromHand({
      count: DISCARD_COUNT,
      step: DISCARD_STEP,
      prompt: "Discard 2 cards of your choice",
    }),
    // Parked by `applyResumable` while the prompt is open; run straight through on an empty hand.
    ...Array.from({ length: TOKEN_COUNT }, () => rushToken()),
  ],
  resume: {
    // The answer's selections are in `ctx.targets`; a missing second pick fizzles (§8 Conventions).
    [DISCARD_STEP]: () =>
      Array.from({ length: DISCARD_COUNT }, (_unused, index) =>
        discard({ target: { of: "chosen", index } }),
      ),
  },
};

export const base: Script = zaoGao;

/** §5.2, R74: no radiant form, so the radiant face IS the base face. */
export const radiant: Script = zaoGao;
