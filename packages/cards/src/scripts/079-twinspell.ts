// #79 Twinspell (SPEC §8.3, R30, R70, §2.2, §3.2, §6.2 Echo, §10.5 step 6).
//
// Base: "The next Spell you play gains Echo +1"; the radiant cell is "Echo +2", a cell that changes
// only a number (§8 Conventions). Twinspell is a Field Spell with a Cry, which is ordinary —
// #73 Anti-oneshot Armor does the same — so it enters the backrow face-up (§3.2, R33) and its Cry
// installs the rider, then it sits there waiting.
//
// §6.2's Echo row: "Play resolves, then the same instance re-resolves X times with fresh mode/target
// prompts; Twinspell grants Echo +1 to the next spell." §10.5 step 6 is where that happens, and R70
// adds that a CAST spell uses Twinspell's Echo even though it never uses a cost discount.
//
// R30 is the lifetime: "Stays until a spell is played, then goes to the GY". Two halves:
//   * it is not turn-scoped, so `{ until: "used" }` — §2.2 says so in as many words ("Twinspell's
//     pending Echo is not turn-scoped and survives cleanup") and `modifiers.expireModifiers` keeps
//     everything that is neither `thisTurn` nor a due `nextTurnOf`, so cleanup already leaves it be.
//   * when it applies, THIS card goes to the graveyard. A player modifier is player-scoped and has
//     no idea which card put it there, so the rider carries `sourceId`, the Twinspell instance, for
//     the engine to consume and bury. `state.ts`'s `echoNextSpell` already declares
//     `sourceId?: string`; nothing reads it yet (see the report).
//
// Nothing else is this card's business: which spell picks the rider up, the repeat count, the fresh
// prompts per repeat and the order the repeats resolve in all belong to §10.5 step 6.

import type { Script } from "@jackioh/engine";
import { addPlayerModifier } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-079");

/** The two faces differ only in how many extra resolutions the next spell gets. */
function twinspell(amount: number): Script {
  return {
    cry: (ctx) => {
      const source = ctx.self;
      return [
        addPlayerModifier({
          player: "self",
          mod: {
            kind: "echoNextSpell",
            amount,
            // R30: the engine sends this instance to the GY when the rider is consumed.
            ...(source === null ? {} : { sourceId: source.id }),
            // §2.2: not turn-scoped — it survives cleanup and waits for a spell.
            expiry: { until: "used" },
          },
        }),
      ];
    },
  };
}

export const base: Script = twinspell(1);

export const radiant: Script = twinspell(2);
