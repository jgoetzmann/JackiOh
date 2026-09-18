// #50 Kpop Fanatic (SPEC §8.2): "Cry: choose an enemy permanent; at the start of your next turn,
// steal it", radiant "Divine Shield; same".
//
// Reading the radiant cell (§8 Conventions): "Divine Shield" is a keyword list without "Plus", so
// it is the radiant form's complete keyword list, and "same" says the text is unchanged. The
// keyword is printed in `catalog.json` (`radiant.keywords`) and §10.4 reads it off the face, so the
// radiant face needs no script of its own and the two exports are the same script (R74: the flag is
// the whole model, and a keyword-only difference is nothing a card file implements).
//
// The choice is made at PLAY time, not during resolution, so it is a declared target travelling in
// the play action's `targets` (R81) rather than a `PendingChoice`. "Permanent" is §6.3's word — a
// Unit, Field Spell, Trap or Field Trap — so the declaration offers both enemy rows; R90 validates
// it, lets a face-down trap be named without being seen (§9.1) and offers only the top of a Stack
// pile (R13). An empty enemy board fizzles and the unit still enters (§8 Conventions).
//
// The delay is the §8.2 Engine cell: a `state.delayed` entry keyed to the TARGET's instance id.
// Keyed to the target and not to this unit is the point of R76 — "fires at your next start of turn
// even if Kpop Fanatic has died" — so the continuation carries the id in its own `data` and does not
// reach back through `ctx.self`, which may be null by then. `prompts.runResume` re-enters the step
// this card names in its `resume` table (§10.6: a continuation is "script id + step + captured
// data", never a closure), which is why the id is read back out of `ctx.data` defensively: `data`
// is a `Record<string, unknown>` that survived JSON, so it is narrowed, never cast.
//
// R76's two fizzles are `effects/steal.ts`'s own no-ops, and deliberately not re-checked here: a
// target that has left the field has no slot (`slotOf` is null) and a target already under this
// player's control is refused by `takeControl`. R15 places the one that does land: the same lane on
// this side if free, else the first free zone of that row, and it stays with the opponent when the
// row is full.
//
// R62 fixes when it happens (refresh → start-of-turn delayed effects → start-of-turn triggers →
// draw), R68 the order among several (creation order), and `turn.runDelayed` owns both.
//
// THE VERB AND WHERE ITS CONTINUATION LIVES (R126, R127). `delay` stores a `Resume` naming this
// script, the hook key, the step and the captured data, and `turn.runDelayed` re-enters it through
// the one reader — `prompts.runResume`, which resolves `resume.hook` against either a `Hook` on the
// script or a step table. So the step is registered ONCE, in the `resume` table, and `delay` is
// told so with `hook: RESUME_HOOK` (its default is the `delayed` hook). R126: "A card must never
// have to register one continuation under two keys." R127 is the other half and the reason this
// card carries the target id in `data`: the entry re-enters with `ctx.self === null` when Kpop
// Fanatic has died in between, which is exactly R76's case.

import type { EffectContext, Hook, Script } from "@jackioh/engine";
import { RESUME_HOOK } from "@jackioh/engine";
import { delay, steal } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-050");

/** The step `state.delayed` re-enters at the start of this player's next turn (§10.6, R62). */
const STEAL_STEP = "steal";

/** The one thing the continuation captures: which permanent was chosen (§8.2 Engine cell). */
const TARGET_KEY = "targetId";

/** The play-time pick (R81), read straight off the context — reading state is not mutating it. */
function chosenInstanceId(ctx: EffectContext): string | null {
  const chosen = ctx.targets[0];
  if (chosen === undefined || chosen.pick !== "instance") return null;
  return chosen.instanceId;
}

/** The captured id, narrowed rather than cast: `data` is JSON that crossed a turn boundary. */
function capturedTargetId(ctx: EffectContext): string | null {
  const id = ctx.data[TARGET_KEY];
  return typeof id === "string" ? id : null;
}

/**
 * R62's continuation, registered once in the `resume` table (R126). R76's fizzles are steal's own
 * no-ops: a target gone from the field, or one already yours.
 */
const stealStep: Hook = (ctx) => {
  const targetId = capturedTargetId(ctx);
  if (targetId === null) return [];
  return [steal({ instanceId: targetId })];
};

/** Both faces run this: "Divine Shield; same" changes the keywords, printed in the catalog. */
const kpopFanatic: Script = {
  // §6.3: a permanent is a Unit, Field Spell, Trap or Field Trap, so both enemy rows are offered.
  targets: [{ kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit", "backrow"] } }],
  cry: (ctx) => {
    const targetId = chosenInstanceId(ctx);
    if (targetId === null) return [];
    return [
      delay({
        at: { phase: "start", player: "self" },
        step: STEAL_STEP,
        hook: RESUME_HOOK,
        data: { [TARGET_KEY]: targetId },
      }),
    ];
  },
  resume: { [STEAL_STEP]: stealStep },
};

export const base: Script = kpopFanatic;

export const radiant: Script = kpopFanatic;
