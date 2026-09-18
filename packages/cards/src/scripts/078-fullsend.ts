// #78 /fullsend (SPEC §8.3, R62, R65, §2.2, §2.3, §10.5 step 5, §10.1).
//
// Base: "Gain 4 mana; this turn your cards cost 1 less and gain 'Combo: draw 1'; at end of turn,
// exile your hand". The radiant cell is "Cost 2 less", a cell that changes only a number, so only
// that number changes and the mana, the Combo draw and the end-of-turn exile are all kept
// (§8 Conventions).
//
// §8's Engine cell: "Turn-scoped player modifiers plus an end-of-turn delayed exile." Four effects:
//
//  1. `gainMana({ amount: 4 })` — §2.3's temporary mana, which may take current above MAX_MANA, and
//     is what makes GIGA Glowy Jelly Bean castable at all (§2.3).
//  2. a `costDiscount` with `{ until: "thisTurn", turn }`. The text says "your CARDS", not "your
//     spells", so there is no `onlyType` and no `onlyCurrentCost`: it is the flat discount R65
//     applies before Curvature. R65 also settles the X-cost case with no help from this card: "An
//     X-cost card being played costs exactly X: `costMod` and discounts don't change it", and
//     `mana.effectiveCost` returns early for an X card, so /fullsend never cheapens Adaptive UI.
//  3. a `comboDraw` modifier with the same expiry. §10.5 step 5 resolves "Combo checks, Quickstriker,
//     /fullsend's Combo draw, then the card's own … script", so this is a PLAYER-scoped rider that
//     the play pipeline reads once per card played this turn — it is not a Combo keyword granted to
//     each card, and it does not care whether the card has a Combo clause of its own. See the report:
//     no engine code reads `comboDraw` yet, so the draw itself is still unimplemented.
//  4. a delayed effect at `{ phase: "end", player: controller }` whose hook exiles the hand.
//
// R62 places that last one precisely: "… → end-of-turn triggers → end-of-turn trap window (Bread and
// Butter and Intern Stimmy on both sides, in R68 order) → end-of-turn delayed effects → cleanup".
// `turn.ts` matches for the two neighbours it has (`endOfTurn` hooks, then `runDelayed(sink, "end",
// player)`, then `cleanup`), so the exile lands AFTER the traps have had their window — a Bread and
// Butter token still reaches the hand and is then exiled with it — and BEFORE cleanup, so the
// modifiers above are still live while the exile runs. The trap window itself is not in `endTurn`
// yet (see the report).
//
// The continuation is one entry in this card's `resume` step table, named by the `delay` that
// schedules it (`hook: RESUME_HOOK`). R126: `turn.runDelayed` re-enters a delayed effect through
// `prompts.runResume`, the one reader that resolves either shape — a `Hook` on the script or a step
// table — so a card registers its continuation once and never twice. /fullsend is a Spell, so by
// the time the step runs the instance is in the graveyard; the stored `Resume` names the script and
// the face, and its `radiant` flag persists in every zone (R78), so the radiant face's step is the
// one that runs — and R127 has it run even if there were no instance left to find at all.

import type { Hook, Script } from "@jackioh/engine";
import { RESUME_HOOK } from "@jackioh/engine";
import { addPlayerModifier, delay, exileHand, gainMana } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-078");

/** §2.3: temporary mana, so current may exceed MAX_MANA. */
const MANA_GAIN = 4;
/** "gain 'Combo: draw 1'" — one card per play, unchanged by the radiant cell. */
const COMBO_DRAW = 1;
/** The step name the delayed effect carries; `turn.ts` labels the pause with it. */
const EXILE_STEP = "exileHand";

/**
 * R62: the end-of-turn delayed effect. It runs after the trap window and before cleanup, and it
 * exiles whatever the hand holds then — including cards drawn by the Combo rider this turn.
 */
const exileTheHand: Hook = () => [exileHand({ player: "self" })];

/** The two faces differ only in how much cheaper the turn's cards are. */
function fullsend(discount: number): Script {
  return {
    cry: (ctx) => [
      gainMana({ amount: MANA_GAIN }),
      addPlayerModifier({
        player: "self",
        // "your cards", so no `onlyType`; R65 applies it as a flat discount before Curvature.
        mod: {
          kind: "costDiscount",
          amount: discount,
          expiry: { until: "thisTurn", turn: ctx.state.turn },
        },
      }),
      addPlayerModifier({
        player: "self",
        mod: {
          kind: "comboDraw",
          amount: COMBO_DRAW,
          expiry: { until: "thisTurn", turn: ctx.state.turn },
        },
      }),
      // R62: `delay` takes a PlayerSpec, so "my own end of turn" is "self" (§6.3, §2.2).
      delay({ at: { phase: "end", player: "self" }, step: EXILE_STEP, hook: RESUME_HOOK }),
    ],
    // The one registration (R126): the step table the `delay` above names.
    resume: { [EXILE_STEP]: exileTheHand },
  };
}

export const base: Script = fullsend(1);

export const radiant: Script = fullsend(2);
