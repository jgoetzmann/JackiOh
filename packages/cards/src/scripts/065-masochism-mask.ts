// #65 Masochism Mask (SPEC §8.3, §6.2, §10.6, R18, R62).
//
// Base: "Start of turn: choose one: exile the bottom card of your library, lose 3 health, or summon
// a Spikey Pillow". Radiant: "Choose twice from: nothing, exile bottom, lose 3, summon Spikey
// Pillow" — a restated clause, so it replaces the base's single pick (§8 Conventions) while the
// Quickdraw tag and the start-of-turn timing are kept.
//
// §8.3's Engine cell: "Two sequential pending choices; 'lose' is not damage".
//
// §6.2: the Quickdraw tag is the `quickdraw` static flag, so the card starts in the opening hand
// and replaces one of the opening draws; `setup.ts` reads the flag, nothing here does.
//
// §10.6 and §10.1: a choice made DURING resolution is a `PendingChoice` in state, never a callback,
// and a card that asks twice is "a step that opens the next one" — prompts.ts names this card's two
// picks as exactly that pattern. So each face's `startOfTurn` opens one mode prompt whose answer
// re-enters a named step of the `resume` table, and the radiant face's first step applies its own
// pick and then opens the second prompt. The prompt effect is LAST in every list it appears in, so
// the sequence is correct whether the caller is `applyResumable` (which parks a tail) or
// `resolve.applyEffects` (which does not) — `turn.ts` still runs start-of-turn hooks with the
// latter (reported).
//
// R18: "lose 3 health" is not damage. `loseHealth` skips the §4.4 pipeline, so no Armor is spent,
// no Anti-oneshot cap applies and no on-damage effect sees it.
//
// R62: start-of-turn triggers run before the draw, so "the bottom card of your library" is the
// bottom before this turn's draw — a draw takes the top and never changes which card is last.

import type { Effect, EffectContext, Script } from "@jackioh/engine";
import {
  chooseMode,
  chosenOptions,
  // `exileBottomOfLibrary` does not exist in `effects/index.ts` yet: `exile` takes a `TargetSpec`,
  // which can only name self, a hero or a declared/answered pick, so no existing verb can reach
  // the bottom card of a library. This is the wave's agreed name (#40 needs it too) and the
  // failing import is the report. See the handback.
  exileBottomOfLibrary,
  loseHealth,
  summon,
} from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-065");

/** #65.1, the token this card defines (§7, §8.3). */
const SPIKEY_PILLOW = cardDef("core-065-1").id;

// The option names, worded as §8.3's two cells list them and in that order. These are prompt
// options, not declared modes (R81), so they reach the client through `state.pending.options` and a
// test reads them back from there rather than off the Script.
const EXILE_BOTTOM = "exile bottom";
const LOSE_THREE = "lose 3";
const SUMMON_PILLOW = "summon Spikey Pillow";
const NOTHING = "nothing";

const BASE_OPTIONS = [EXILE_BOTTOM, LOSE_THREE, SUMMON_PILLOW];
const RADIANT_OPTIONS = [NOTHING, EXILE_BOTTOM, LOSE_THREE, SUMMON_PILLOW];

/** The steps of the `resume` table (§10.6); the radiant face uses both. */
const STEP_FIRST = "firstPick";
const STEP_SECOND = "secondPick";

/**
 * What one answered option does. "nothing" and an answer that named no option are both the empty
 * list: the trigger still fired and the card stays on the field.
 */
function effectsFor(option: string | undefined): Effect[] {
  if (option === EXILE_BOTTOM) return [exileBottomOfLibrary({ player: "self" })];
  // R18: lost health, not damage.
  if (option === LOSE_THREE) return [loseHealth({ player: "self", amount: 3 })];
  if (option === SUMMON_PILLOW) return [summon({ defId: SPIKEY_PILLOW })];
  return [];
}

/** The answered pick: §10.6 delivers a mode selection in `ctx.targets`, which is what this reads. */
function pickOf(ctx: EffectContext): string | undefined {
  return chosenOptions(ctx)[0];
}

export const base: Script = {
  staticFlags: { quickdraw: true },
  startOfTurn: (): Effect[] => [
    chooseMode({ options: BASE_OPTIONS, step: STEP_FIRST, prompt: "Masochism Mask: choose one" }),
  ],
  resume: {
    [STEP_FIRST]: (ctx): Effect[] => effectsFor(pickOf(ctx)),
  },
};

export const radiant: Script = {
  staticFlags: { quickdraw: true },
  startOfTurn: (): Effect[] => [
    chooseMode({
      options: RADIANT_OPTIONS,
      step: STEP_FIRST,
      prompt: "Masochism Mask: choose twice (1 of 2)",
    }),
  ],
  resume: {
    // The first pick resolves, then the second prompt opens — the same option may be picked again,
    // because these are two separate prompts and the "picked twice" check in `prompts.ts` is
    // per-prompt.
    [STEP_FIRST]: (ctx): Effect[] => [
      ...effectsFor(pickOf(ctx)),
      chooseMode({
        options: RADIANT_OPTIONS,
        step: STEP_SECOND,
        prompt: "Masochism Mask: choose twice (2 of 2)",
      }),
    ],
    [STEP_SECOND]: (ctx): Effect[] => effectsFor(pickOf(ctx)),
  },
};
