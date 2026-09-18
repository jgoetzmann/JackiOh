// #66 The Rock (SPEC §8.3, §6.3 Tribute, §3.2, R23, R46, R69, R81, R90).
//
// Base cell: "Tribute 1, Indestructible". Radiant cell: "Plus Immutable" — §8's Conventions read
// "Plus X" as the base keyword list plus X, and both lists are printed on the catalog faces
// (`def.base.keywords = [Indestructible]`, `def.radiant.keywords = [Indestructible, Immutable]`),
// which §10.4 layer 1 reads straight off the def. So this file grants no keyword: granting
// Indestructible here would be a second source of truth and granting Armor-style keywords twice is
// what #25's header warns about.
//
// The one thing the script carries is the Tribute cost. §6.3 calls Tribute "an additional cost of
// playing a card" and puts it in the play validator, and `playChoices.ts` is that validator:
//   * `tributeCostOf(card)` reads a `tribute` TargetDecl's `amount` first and falls back to
//     `staticFlags.tribute`, so the flag alone is enough and the card declares no `targets`;
//   * `tributeValueOf` gives the Sheep Token 2 and every other unit 1 (§3.2, §6.3), so one Sheep
//     pays this cost of 1 on its own and `isMinimalTribute` still accepts it;
//   * `legalTributeUnits` offers only the chooser's own units, because `mayTributeEnemyUnits` reads
//     a `tributeEnemies` flag that only #55 Lava Golem sets and §6.3 reads Tribute as "sacrifice X
//     of *your* units";
//   * `refuseTributes` refuses the play outright when the board cannot pay — the "play refused
//     without a tribute" row of BUILD M4-T4.
// The units chosen travel in the `play` action's own `tributes` list rather than in `targets`
// (R81, R90), so there is nothing for a hook to read and no hook here at all.
//
// Where the two keywords' behaviour lives, all of it engine-side:
//   Indestructible — §4.4 step 4: takes no damage at all. §4.5 step 1 and R46: a destroy mark is
//                    ignored, and the marked unit switches to Attack Position and loses Taunt for
//                    that turn (`stateCheck.ts`'s `resolveIndestructibleMarks`, which stamps
//                    `tauntSuppressedTurn`). R69: it dies anyway once its max health falls to 0 or
//                    less (#46 Suppressive Aura), because no destroy effect is involved. §6.1:
//                    Sacrifice and Exile still remove it — a Tribute of a The Rock included.
//   Immutable      — R23: blocks Vanilla, Transform (Transmogulate on the board included) and
//                    Fuse-onto on this card. Radiant is still allowed, #41 Sheepish still fires and
//                    is consumed for nothing (R17), and #61's Vanilla copy of an Immutable unit is
//                    legal because the Vanilla lands on the copy.

import type { Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-066");

/** §6.3 "Tribute 1": one of your units, or one Sheep Token, which is worth 2 of it (§3.2). */
const TRIBUTE_COST = 1;

export const base: Script = { staticFlags: { tribute: TRIBUTE_COST } };

/**
 * The radiant cell adds a keyword and nothing else, and §8's Conventions keep every base clause a
 * radiant cell does not restate — so the Tribute cost is kept and the script is the same object.
 */
export const radiant: Script = base;
