// #70 Spiteful Stab (SPEC §8.3, §3, §4.4, §10.9, R72, R81, R90).
//
// Base face: "Deal 2 damage to a target, +1 per full 5 health your hero is below 30, +1 per card in
// your exile". Radiant face (R275): "Deal 4 damage to a target, +1 per full 3 health your hero is
// below 30, +2 per card in your exile" — the base amount, the health step and the exile term move;
// the target and the 30 baseline are kept.
//
// R72 is the whole of the arithmetic: "'Cards in exile' means your own exile pile; missing health
// counts from 30 even when the hero has more". So
//     missing = max(0, HERO_HEALTH - health)                           // floors at 0 above 30
//     amount  = base + floor(missing / step) + perExiled * exileCount  // "per FULL n"
// with `base`/`step`/`perExiled` of 2/5/1 on the base face and 4/3/2 on the radiant one. HERO_HEALTH
// is the §2 starting health in `config.ts`, which is the 30 both R72 and the card text mean; the
// engine never hard-codes a rules constant (BUILD §2).
//
// R280: the whole formula is the card's `preview` label — each face's text as printed — and its
// value the damage `stabAmount` comes to now, the same function the Cry deals. It reads the
// controller's hero health and exile count, both public (§10.8).
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

import type { Effect, GameState, Script } from "@jackioh/engine";
import { heroOf, zoneCount } from "@jackioh/engine";
import { HERO_HEALTH } from "@jackioh/engine/config";
import { damage } from "@jackioh/engine/effects";
import type { PlayerId, TargetDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-070");

/** §8 Conventions: every legal unit and hero on either side (R90: a bare `target` is units only). */
const targets: TargetDecl[] = [
  { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit", "hero"] } },
];

/** One face's numbers: the flat damage, the health step, and what each card in your exile adds. */
type Stab = { base: number; step: number; perExiled: number };

/** §8: "Deal 2 …, +1 per full 5 health …, +1 per card …"; radiant "Deal 4 …, per full 3 …, +2 per card …". */
const FACES = {
  base: { base: 2, step: 5, perExiled: 1 },
  radiant: { base: 4, step: 3, perExiled: 2 },
} as const satisfies Record<"base" | "radiant", Stab>;

/**
 * §10.9: a hook may read state to compute an effect's arguments; it never writes. Both reads go
 * through the engine's read-only board surface (`heroOf`, `zoneCount` in engine/src/query.ts), so
 * this file names the two facts R72 needs rather than the fields they live in (BUILD M3-T1).
 * R72: missing health is measured from 30 even when the hero is above it, so it floors at 0, and the
 * exile is the controller's OWN pile, never the opponent's and never the game-wide counter.
 */
function stabAmount(state: GameState, controller: PlayerId, face: Stab): number {
  const missing = Math.max(0, HERO_HEALTH - heroOf(state, controller).health);
  return face.base + Math.floor(missing / face.step) + face.perExiled * zoneCount(state, controller, "exile");
}

function spitefulStab(face: "base" | "radiant"): Script {
  const numbers = FACES[face];
  return {
    targets,
    cry: (ctx): Effect[] => [damage({ to: { of: "chosen" }, amount: stabAmount(ctx.state, ctx.controller, numbers) })],
    // R280: the label is the face's whole text, the formula as printed.
    preview: (ctx) => [{ label: def[face].text, value: stabAmount(ctx.state, ctx.controller, numbers) }],
  };
}

export const base: Script = spitefulStab("base");

export const radiant: Script = spitefulStab("radiant");
