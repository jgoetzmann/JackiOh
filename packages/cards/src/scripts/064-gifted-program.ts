// #64 Gifted Program (SPEC §8.3, §10.1, §10.5 step 3, §5.2, R56, R70, R74, R213, R214).
//
// Base: "The first card costing 1 or less you play each turn becomes Radiant as it is played".
// Radiant: "2 or less" — §8's Conventions make that a change to the threshold only.
//
// §8.3's Engine cell puts it before resolution with "cost = cost paid", and §10.5 step 3 is that
// moment in the play sequence: after the cost is paid (step 2) and before the card is moved or
// resolved (steps 4 and 5). The card is a static flag carrying its threshold, which the
// engine reads at step 3 (`playSteps.giftedProgramStep`, through `playChoices.giftedMakesRadiant`),
// the way #38 Quickstriker's flag is read at step 5. Three things decide it, all the engine's:
//   - "you play": only the permanents on the playing player's side count, since the card's text is
//     its controller's (§8 Conventions) — a stolen Gifted Program works for its thief;
//   - R56: the cost compared is the one ACTUALLY PAID after every modifier — a 2-cost card
//     discounted to 1 qualifies under the base face, and a cast pays 0 and so always qualifies (R70);
//   - "the first ... each turn": R213 counts the player's plays this turn off the turn log, not a
//     flag on this instance, so a Gifted Program that changes hands, or leaves and comes back, can
//     neither use up another player's first cheap card nor hand its own player a second one.
//
// A flag rather than a hook because step 1 must know the face a play will resolve with before it
// reads the play's targets and modes (R214): a hook only runs at step 3, while a flag can be read
// by `legalActions` and by the refusal alike. Gifted Program cannot catch its own play: step 3 runs
// before step 4 puts it on the board (R119).

import type { Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-064");

/** The printed thresholds: "1 or less", and "2 or less" on the radiant face. */
const BASE_THRESHOLD = 1;
const RADIANT_THRESHOLD = 2;

export const base: Script = { staticFlags: { giftedProgram: BASE_THRESHOLD } };

export const radiant: Script = { staticFlags: { giftedProgram: RADIANT_THRESHOLD } };
