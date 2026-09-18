// #9 Moths to the Flame (SPEC §8.1): a 2-cost 1/14 → 2/28 Unit, "Start of turn: every enemy unit
// attacks this". The radiant cell is "Armor 1; same": Armor 1 is printed on the radiant face in
// `catalog.json` and applied by §10.4's keyword layer, and "same" says the text is unchanged
// (§8 Conventions), so the two faces run the identical hook.
//
// §8.1's Engine cell is "Forced attacks in enemy lane order (§4.2); stops when Moths dies", which
// is R53 in full: the forced attacks skip §4.2 steps 1-3 (no validator, so position, summoning
// sickness and Taunt are all irrelevant), spend no exertion, the target still strikes back, each
// forced attack is its own combat followed by its own state check, and the next forced attacker
// attacks only while the target is still on the field. `combat.forceAttacksOn` implements exactly
// that, and `startTurn` fires this hook for the controller alone, before their draw (§2.2, R68).
//
// Armor is not this card's business either: §4.4 step 2 subtracts the defender's armor from each
// incoming hit, so the radiant face's printed Armor 1 reduces every forced attack by 1 on its own.

import type { Script } from "@jackioh/engine";
// BLOCKED: `forcedAttacksOn` does not exist in `packages/engine/src/effects/index.ts`.
//
// Forced attack is deliberately NOT on the card-script surface today: the effects barrel says so in
// its header ("Verbs that §6.3 lists but this directory does not implement … Forced attack, Cancel
// attack and Switch position as a player action (`../combat`)"), and the engine functions that do
// the work — `forceAttack` and `forceAttacksOn` (engine/src/combat.ts:323, :345) — take an
// `EngineSink`, not an `Effect`. A card file may not call them: it returns `Effect[]` and never
// touches state (CLAUDE.md rule 5).
//
// So this card needs one new verb, and #60 Bear Honeypot needs the same one:
//
//     // effects/combat.ts, re-exported from effects/index.ts
//     export function forcedAttacksOn(args: { target?: TargetSpec; attackers?: PlayerSpec }): Effect {
//       return {
//         kind: "forcedAttacksOn",
//         apply(ctx): void {
//           const target = resolveTarget(ctx, args.target ?? { of: "self" });
//           if (target === null) return;
//           // §4.2: "in lane order, as `activeUnitsOf` reports it" (R53).
//           forceAttacksOn(ctx, activeUnitsOf(ctx.state, playerOf(ctx, args.attackers ?? "enemy")), target);
//         },
//       };
//     }
//
// `EffectContext` already satisfies `EngineSink` structurally (state, events, rng), so the wrapper
// is the whole of it: lane order, the per-attack state check and the "stop when the target is gone"
// loop are all `forceAttacksOn`'s, and R53 stays in one place.
import { forcedAttacksOn } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-009");

/** Both faces: every enemy unit, in enemy lane order, is forced to attack this card (R53). */
function moths(): Script {
  return {
    startOfTurn: () => [forcedAttacksOn({ target: { of: "self" }, attackers: "enemy" })],
  };
}

export const base: Script = moths();

export const radiant: Script = moths();
