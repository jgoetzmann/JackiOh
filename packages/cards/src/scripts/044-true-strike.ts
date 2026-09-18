// #44 True Strike (SPEC §8.2). Spell, cost 1, Common.
//   Base:    "Deal 4 damage to a target, ignoring Armor; exile this"
//   Radiant: "9" — §8 Conventions: a cell that changes only a number changes only that number, so
//            the radiant face is the same spell for 9, still ignoring Armor and still exiling.
//   Engine:  "Skips pipeline step 2; Divine Shield still applies."
//
// §4.4: one damage instance, in order. `ignoreArmor` skips step 2 (Armor: printed + Defense +1 +
// auras) and NOTHING else, so step 1 still negates the whole hit on a Divine Shield target and
// spends the shield, step 3 still clamps a hero with Anti-oneshot Armor, and step 4 still makes an
// Indestructible target take nothing. R63's zero rule cannot bite here: 4 and 9 are both above 0
// before step 1, so this is always a damage instance.
//
// §8 Conventions: "target" means the player picks at play time from all legal units and heroes on
// either side unless narrowed, and nothing narrows it here — so the declaration below is
// `side: "any"`, `of: ["unit", "hero"]`. It is a DECLARED play-time choice (R81), travelling in the
// `play` action's `targets` and arriving as `ctx.targets[0]`, which `{ of: "chosen" }` reads; it
// never opens a prompt. R90 validates it against this declaration, so a client can neither name a
// card it may not reach nor send two picks for one declaration.
//
// "Exile this" (§5.1, §6.3): the spell is mid-resolution in the `resolving` zone while its script
// runs (§10.1, §10.5 step 4), and `exile` moves it from there, so §10.5 step 7 finds it already in
// exile and must not send it to the graveyard. `exile` also bumps the game exile counter (R55),
// which #40 Echoes of the Forgotten and #100 Ceaseless Void read.
//
// Order: damage first, then the exile. Both are in one list, so the state check runs after the pair
// (R59) — the target dies, if it dies, with the spell already in exile.

import type { Script } from "@jackioh/engine";
import { damage, exile } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-044");

/** The faces differ only in how much damage they deal. */
function trueStrike(amount: number): Script {
  return {
    targets: [{ kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit", "hero"] } }],
    // A Spell's script hangs off `cry`: that is its on-resolve hook (§10.9).
    cry: () => [
      damage({ to: { of: "chosen" }, amount, ignoreArmor: true }),
      exile({ target: { of: "self" } }),
    ],
  };
}

export const base: Script = trueStrike(4);

export const radiant: Script = trueStrike(9);
