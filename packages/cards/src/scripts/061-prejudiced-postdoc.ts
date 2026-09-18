// #61 Prejudiced Postdoc (SPEC §8.3, R23, R57, R64, R81, R90).
//
// Base: "Cry: choose a Human unit on the field; summon a Vanilla copy". The radiant cell is "Any
// unit", which per §8's Conventions restates only which units the pick may name — the Cry, the
// Vanilla copy and the side it lands on are all kept.
//
// §8.3's Engine cell: "Copy per R57 with `vanilla` set and no granted keywords: the target's form,
// radiant flag and buffs, no damage; auras apply to it afresh; an Immutable target is legal (R23)."
// So the copy is R57's copy — defId, radiant flag, permanent buffs and `statsOverride` carried,
// damage, exertion and counters reset — with two deviations R57 does not make on its own and that
// only #61 asks for: the copy's Vanilla flag is on, and the copy carries NO granted keywords
// (BUILD M4-T4 #8: "copy is stats only"). Both are arguments to `summonCopy`, never work this file
// does: a card file composes effects and never touches state (CLAUDE.md rule 5).
//
// R23: Immutable blocks the Vanilla and Transform verbs on the Immutable card ITSELF. Here the
// Vanilla applies to a brand-new card, so an Immutable target is a legal pick and the copy comes
// out textless — the ruling names #61 for exactly this.
//
// Auras are layer 5 of §10.4 and are computed on read, never stored, so "auras apply to it afresh"
// needs no code: the copy is a new instance under whatever auras its own side has.
//
// R81/R90: the pick travels in the `play` action as a declared target, so resolution never pauses.
// The Postdoc is still in hand when the play's choices are validated (§10.5 step 1) and only
// reaches the field at step 4, so it can never be its own target and needs no `excludeSelf`.
// A declaration the board cannot satisfy does not refuse the play: the Cry fizzles and the unit
// still enters (§8 Conventions, R90).

import type { Effect, Script } from "@jackioh/engine";
// `summonCopy` does not exist in `effects/index.ts` yet; it is the wave's agreed name for R57's
// copy verb (#12, #22 and #61 all need it) and this import is the report. See the handback.
import { summonCopy } from "@jackioh/engine/effects";
import type { TargetDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-061");

/** The one difference between the faces: base narrows the pick to Humans, radiant does not. */
function postdoc(humansOnly: boolean): Script {
  const targets: TargetDecl[] = [
    {
      kind: "target",
      min: 1,
      max: 1,
      filter: {
        // "on the field" and §8's Conventions: either side unless the cell narrows it.
        side: "any",
        of: ["unit"],
        ...(humansOnly ? { tags: ["Human" as const] } : {}),
      },
    },
  ];

  return {
    targets,
    cry: (): Effect[] => [
      summonCopy({
        of: { of: "chosen" },
        // §8.3: the copy has no text and no granted keywords of its own.
        vanilla: true,
        grantedKeywords: false,
      }),
    ],
  };
}

export const base: Script = postdoc(true);

export const radiant: Script = postdoc(false);
