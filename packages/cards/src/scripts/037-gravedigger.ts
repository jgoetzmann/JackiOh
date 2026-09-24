// #37 Gravedigger (SPEC §8.2): 4/5 → 8/10, "Start of turn: add a random card from your GY to your
// hand", radiant "Discover one from your GY; it costs 1 less". The radiant cell restates the whole
// clause — the random add becomes a Discover — and adds the discount, so the radiant face is a
// prompt where the base face is a seeded pick (§8 Conventions).
//
// Base is one verb: `addRandomFromGraveyard` already draws from `ctx.rng` (CLAUDE.md rule 4) and
// returns without doing anything when the graveyard is empty (§8.2 Engine: "Empty GY → nothing").
// `startTurn` (engine/src/turn.ts) runs the start-of-turn hooks BEFORE `draw(sink, player, 1)`, so
// "before the draw" is the turn loop's order and not a clause here.
//
// Radiant is a genuine RESOLUTION prompt, not a play-time choice: the card is already on the field
// and the Discover happens at the start of a later turn, so R81's "travels in the play action" does
// not apply and it opens a `PendingChoice` through `discoverFromGraveyard` (R50: the options come
// from the actual graveyard, so spell tokens there are eligible). An empty graveyard opens no
// prompt at all, which is the same "nothing" the base face does.
//
// The answer re-enters this script through the continuation `prompts.ts` documents: `resumeSelf`
// records `hook: "resume"` (`RESUME_HOOK`) and `step: "picked"`, and `runResume` looks up
// `script.resume.picked`. So the resume step is a TABLE on the `Script` and NOT the `startOfTurn`
// hook that opened the prompt — which is exactly what makes a start-of-turn Discover land in the
// right place even though a `Resume` cannot say which hook asked for it.
//
// The pick arrives in `ctx.targets` as `{ pick: "instance", instanceId }` (that is what
// `discoverFromGraveyard` offers, R50), so `{ of: "chosen" }` names it. Two verbs finish the job:
//   - `bounce` moves the named card to its owner's hand. §6.3 Bounce is "return to owner's hand"
//     with no zone restriction, the hand cap burns it when the hand is full (§2.4, R4), and #72
//     Reminisce's Engine cell prints this same move as "chosen card moves GY → hand"; #23
//     Reoccurring Dream already uses it to come back out of the graveyard. There is no
//     `moveToHand` verb and there should not be: §6.3's Add to hand row is one verb that "Creates
//     OR MOVES the card", so `addToHand({ instance })` moves the chosen instance while
//     `addToHand({ defId })` creates a fresh one. #72 Reminisce uses the `instance` form.
//   - `setCostMod({ amount: -1 })` is R65's "costs 1 less": it adds to the instance's `costMod`,
//     which R78 keeps in every zone, so the discount survives the card's next trip to the
//     graveyard. `cost.ts` names this card as the reason that verb exists.
// The order is bounce-then-discount so the discount is the price of a card that reached the hand:
// `inHandOnly` skips it for a pick a full hand burned straight back to the graveyard (§2.4, R4),
// which would otherwise keep a discount for a return it never made (R78). The `costChanged` event
// then reports the card as it now stands, in hand.

import type { Script } from "@jackioh/engine";
import {
  addRandomFromGraveyard,
  bounce,
  discoverFromGraveyard,
  setCostMod,
} from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-037");

/** The step name the Discover's continuation carries (`prompts.ts`: `script.resume[step]`). */
const PICKED = "picked";

/** R65: "costs 1 less" is a −1 `costMod` on the chosen instance, permanent and zone-proof (R78). */
const DISCOUNT = -1;

export const base: Script = {
  startOfTurn: () => [addRandomFromGraveyard({ player: "self" })],
};

export const radiant: Script = {
  startOfTurn: () => [discoverFromGraveyard({ step: PICKED, prompt: "Discover a card from your graveyard" })],
  resume: {
    [PICKED]: () => [
      bounce({ target: { of: "chosen" } }),
      // R4: "it costs 1 less" is its price in the hand, so a pick a full hand burns keeps its cost.
      setCostMod({ target: { of: "chosen" }, amount: DISCOUNT, inHandOnly: true }),
    ],
  },
};
