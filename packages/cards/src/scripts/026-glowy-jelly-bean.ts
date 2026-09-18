// #26 Glowy Jelly Bean (SPEC §8.2): "Choose a card in your hand; it becomes Radiant", radiant
// "Choose 2" — a Radiant cell that changes only a number changes only that number (§8 Conventions),
// so the radiant face is the same effect, taken twice.
//
// The pick is a DECLARED `hand` choice, so it travels in the play action's `targets` and never
// pauses resolution (R81). `legalActions` builds the picker from the declaration below without
// running this script, and R90 does the rest: a hand declaration offers only the chooser's own hand
// (§9.1) and never the Glowy Jelly Bean that is itself leaving the hand, and one declaration may
// not name the same card twice — so the radiant face cannot spend both picks on one card.
//
// "Radiant takes both cards it can when the hand holds only one other" (§8.2 Engine): the radiant
// declaration asks for 2, and R90 makes a play legal with the answers that exist rather than
// refusing it, so a hand holding one other card sends one selection and the second `setRadiant`
// finds no chosen card and fizzles (§8 Conventions: an empty target set fizzles, the spell still
// counts as played).
//
// Nothing else is this card's business. R74 makes the radiant flag the whole model, so the chosen
// card's stats and text swap on the next read while it sits in hand (§5.2), and a card that is
// already Radiant is untouched (§6.3 Make Radiant).

import type { Script } from "@jackioh/engine";
import { setRadiant } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-026");

/** The two faces differ only in how many cards the play picks. */
function glowyJellyBean(picks: number): Script {
  return {
    targets: [{ kind: "hand", min: picks, max: picks, filter: { of: ["hand"] } }],
    cry: () =>
      Array.from({ length: picks }, (_unused, index) =>
        setRadiant({ target: { of: "chosen", index } }),
      ),
  };
}

export const base: Script = glowyJellyBean(1);

export const radiant: Script = glowyJellyBean(2);
