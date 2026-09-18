// #70 Spiteful Stab (SPEC §8.3, §3, §4.4, §10.9, R72, R81, R90).
//
// Base cell: "Deal 2 damage to a target, +1 per full 5 health your hero is below 30, +1 per card in
// your exile". Radiant cell: "4 base, per full 3 health" — the cell restates the base amount and the
// health step and nothing else, so the target, the 30 baseline and the exile term are all kept
// (§8 Conventions).
//
// R72 is the whole of the arithmetic: "'Cards in exile' means your own exile pile; missing health
// counts from 30 even when the hero has more". So
//     missing = max(0, HERO_HEALTH - health)                 // floors at 0 above 30
//     amount  = base + floor(missing / step) + exileCount    // floor division, "per FULL n"
// with `base`/`step` of 2/5 on the base face and 4/3 on the radiant one. HERO_HEALTH is the §2
// starting health in `config.ts`, which is the 30 both R72 and the card text mean; the engine never
// hard-codes a rules constant (BUILD §2).
//
// §3's zone table puts it plainly: the exile count "feeds Echoes of the Forgotten and Spiteful
// Stab". It is the controller's own pile — the opponent's exile is not counted, and neither is the
// game-wide `counters.exiled`, which counts exiles by both players (R55's counter, for #100).
//
// §8's Conventions: "'target' means the player picks at play time from all legal units and heroes on
// either side unless narrowed", and a bare `target` declaration means a unit only (`pickKindsFor` in
// `playChoices.ts`, R90), so the heroes are named. R81: the pick travels in the `play` action, so
// the hook reads `{ of: "chosen" }` and nothing pauses. The amount is computed in the hook, at
// resolution, which §10.9 allows: a hook may READ state to build an effect's arguments, never write.
//
// §4.4: one damage instance through the pipeline, however large it grew — Armor, Divine Shield, the
// anti-oneshot cap and Indestructible all still apply, and R63's zero rule applies if it is reduced
// to nothing.

import type { Effect, EffectContext, Script } from "@jackioh/engine";
import { heroOf, zoneCount } from "@jackioh/engine";
import { HERO_HEALTH } from "@jackioh/engine/config";
import { damage } from "@jackioh/engine/effects";
import type { TargetDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-070");

/** §8 Conventions: every legal unit and hero on either side (R90: a bare `target` is units only). */
const targets: TargetDecl[] = [
  { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit", "hero"] } },
];

/**
 * §10.9: a hook may read state to compute an effect's arguments; it never writes. Both reads go
 * through the engine's read-only board surface (`heroOf`, `zoneCount` in engine/src/query.ts), so
 * this file names the two facts R72 needs rather than the fields they live in (BUILD M3-T1).
 */
function heroHealthOf(ctx: EffectContext): number {
  return heroOf(ctx.state, ctx.controller).health;
}

/** R72: the controller's OWN exile pile, never the opponent's and never the game-wide counter. */
function exileCountOf(ctx: EffectContext): number {
  return zoneCount(ctx.state, ctx.controller, "exile");
}

/** R72: missing health is measured from 30 even when the hero is above it, so it floors at 0. */
function missingHealth(ctx: EffectContext): number {
  return Math.max(0, HERO_HEALTH - heroHealthOf(ctx));
}

/** `base` + one per FULL `step` of missing health + one per card in your own exile (R72). */
function stabAmount(ctx: EffectContext, base: number, step: number): number {
  return base + Math.floor(missingHealth(ctx) / step) + exileCountOf(ctx);
}

/** The radiant cell moves exactly these two numbers: 2 → 4 and a 5-health step → a 3-health one. */
function spitefulStab(base: number, step: number): Script {
  return {
    targets,
    cry: (ctx): Effect[] => [damage({ to: { of: "chosen" }, amount: stabAmount(ctx, base, step) })],
  };
}

export const base: Script = spitefulStab(2, 5);

export const radiant: Script = spitefulStab(4, 3);
