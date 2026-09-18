// #72 Reminisce (SPEC §8.3): "Discover a card from your GY; it costs 1 less; exile this", radiant
// "It costs 0" — the radiant cell restates only the cost clause, so the Discover and the self-exile
// are kept and only the discount changes (§8 Conventions).
//
// R50 is the whole of the Discover: the options come from the ACTUAL graveyard, not from a pool, so
// spell tokens sitting there are eligible and are drawn without replacement. `discoverFromGraveyard`
// (effects/choose.ts) is exactly that — it shuffles the real graveyard pile and offers instance
// selections — so this card names the step and nothing else. A pool-based Discover
// (`discoverFromCatalog`) would exclude tokens and would be wrong here.
//
// The two-step shape, per §10.6 and prompts.ts:
//   cry   -> [discoverFromGraveyard({ step: "chosen" }), exile self]
//   resume.chosen -> [chosen card to hand, its cost changed]
//
// `applyResumable` parks the tail of an effect list as a `WorkItem` the moment a prompt opens, and
// `answerPrompt` runs the resume step FIRST and then drains the parked tail. So one array covers
// both branches of "exile this":
//   - graveyard non-empty: the prompt opens, `exile` is parked, and it runs after the pick has
//     reached the hand — the order §8 writes (Discover, cost, exile);
//   - graveyard empty: `discoverFromGraveyard` returns without opening anything (§6.3: an effect
//     with no options fizzles and the card still resolves), no prompt, so `exile` runs straight
//     through in the same pass and `resume.chosen` never runs at all.
// The resume step therefore reads only `{ of: "chosen" }` and never `ctx.self`: a resumed step may
// find its instance gone (§10.6), and a Spell mid-resolution is in no pile for `findInstance` to
// find anyway.
//
// Cost: R65 starts the calculation from `costOverride`, else the printed cost, then adds `costMod`,
// then the player's discounts. So "costs 1 less" is `costMod -1` (it stacks and it travels with the
// card between zones, R78), while "it costs 0" is a `costOverride` of 0 — the same reading R77 gives
// Craft a Card's "0-cost hand card". Reported as a ruling to settle: a `costOverride` of 0 still has
// `costMod` added after it, so a radiant Reminisce on a card KY's Math Equation has bumped to +1
// leaves it at 1 rather than 0.
//
// R4 is the engine's: `addToHand({ instance })` puts the card in the hand through the same pipeline a
// draw uses, so a card picked into a full hand is burned to the graveyard. §6.3's Add to hand row is
// "Creates OR MOVES the card", so moving the Discover's pick is that verb and not one of its own.

import type { Script } from "@jackioh/engine";
import { addToHand, discoverFromGraveyard, exile, setCostMod, setCostOverride } from "@jackioh/engine/effects";
import type { Effect } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-072");

/** The name the prompt's continuation is filed under, in `resume` and in `step` (§10.6). */
const STEP_CHOSEN = "chosen";

/** `price` is the whole of the radiant text: −1 on the base face, a flat 0 on it. */
function reminisce(price: () => Effect): Script {
  return {
    cry: () => [
      discoverFromGraveyard({ step: STEP_CHOSEN, prompt: "Discover a card from your graveyard" }),
      // Parked while the prompt is open; runs straight through on an empty graveyard.
      exile({ target: { of: "self" } }),
    ],
    resume: {
      // The answered selection arrives in `ctx.targets`, which `{ of: "chosen" }` reads (§10.6).
      [STEP_CHOSEN]: () => [addToHand({ instance: { of: "chosen" } }), price()],
    },
  };
}

export const base: Script = reminisce(() => setCostMod({ target: { of: "chosen" }, amount: -1 }));

export const radiant: Script = reminisce(() => setCostOverride({ target: { of: "chosen" }, cost: 0 }));
