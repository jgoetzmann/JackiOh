// #79 Twinspell (SPEC §8.3, R30, R70, §2.2, §3.2, §6.2 Echo, §10.5 step 6).
//
// Base: "The next Spell you play gains Echo +1"; the radiant cell is "Echo +2", a cell that changes
// only a number (§8 Conventions). The text has no "Cry:" (compare #73's "… Cry: draw 1"), and R169
// says #79 installs its modifier "without a Cry": it is the Field Spell's lasting effect (§5.1,
// R209), which the permanent has for as long as it stands on the field, however it got there — a
// summon fires no Cry (§6.2), yet a Twinspell #22's Death summons still grants its Echo, and #85
// fusing Twinspell onto another Field Spell hands the text to that permanent's controller.
//
// So the card is one static flag, `echoGrant`, and the engine does the rest
// (`modifiers.installLastingModifiers`): an `echoNextSpell` rider on the player whose side the card
// stands on, owned by the card (`sourceId`), moved with it when control changes and ended when it
// leaves (R209); §10.5 step 4 has the next Spell take it and sends this card to its owner's
// graveyard (R30, R178). It is not turn-scoped: §2.2 says so in as many words ("Twinspell's pending
// Echo is not turn-scoped and survives cleanup"), so the rider is `{ until: "used" }`.
//
// §6.2's Echo row: "Play resolves, then the same instance re-resolves X times with fresh mode/target
// prompts; Twinspell grants Echo +1 to the next spell." §10.5 step 6 is where that happens, and R70
// adds that a CAST spell uses Twinspell's Echo even though it never uses a cost discount.

import type { Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-079");

/**
 * The two faces differ only in how many extra resolutions the next spell gets. The engine reads the
 * amount off the face the card wears when a Spell takes it, so a Twinspell made Radiant on the field
 * (#49 radiant) grants "Echo +2" from then on (§5.2, R209).
 */
function twinspell(amount: number): Script {
  return { staticFlags: { echoGrant: amount } };
}

export const base: Script = twinspell(1);

export const radiant: Script = twinspell(2);
