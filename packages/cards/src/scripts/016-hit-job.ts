// #16 Hit Job (SPEC §8.1): "Destroy target unit", radiant "Destroy target unit and the units
// adjacent to it on its side". Engine cell: "Adjacency 3.1; Indestructible survives".
//
// The radiant cell restates the base clause and adds the neighbours, so the target is destroyed on
// both faces (§8 Conventions) and only the extra kills are radiant-only.
//
// Nothing here knows about Indestructible: §6.3 Destroy only marks the card and §4.5 step 1 collects
// it at the next state check, where R46 lets an Indestructible unit ignore the mark. Both destroys
// are in one effect list, so the whole spell resolves before anything is collected and the target
// and its neighbours die together (R59).
//
// §3.1: "Adjacent means index N-1 and N+1 on the same side and same row", never across the centre
// line, and the target is picked with the play rather than by a prompt (R81), so it arrives in
// `ctx.targets` as `{ of: "chosen" }`.

import type { Script } from "@jackioh/engine";
// BLOCKED (engine, effects/destroy.ts): `destroyAdjacentTo` does not exist yet. The effects library
// has no adjacency-aware verb and `TargetSpec` cannot name an arbitrary instance, so radiant Hit Job
// cannot be written without it and this import is red until M3-T1 adds it. Proposed:
//   export function destroyAdjacentTo(args: { target: TargetSpec }): Effect
// It resolves `args.target` to a unit, reads its zone with `slotOf`, and marks every unit that
// `zones.adjacent(ref)` reports — lane N-1 and N+1 on the TARGET's own side and row (§3.1), never
// across sides. Marking only, exactly like `destroy`, so Indestructible neighbours survive (R46) and
// everything this spell marks dies in the one state check that follows (R59). It must fizzle
// silently when the target is not a unit, is off the field, or has no occupied neighbour.
import { destroy, destroyAdjacentTo } from "@jackioh/engine/effects";
import type { TargetDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-016");

/**
 * R81: "target" with no narrowing is any unit on either side (§8 Conventions), picked as part of the
 * `play` action and never as a prompt. `min: 1` with an empty board is R90's "a declaration the
 * board cannot satisfy asks for what the board has": the play stays legal and the spell fizzles,
 * which is §8's "a spell whose target set is empty fizzles: the spell still counts as played".
 */
const targets: TargetDecl[] = [
  { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit"] } },
];

export const base: Script = {
  targets,
  cry: () => [destroy({ target: { of: "chosen" } })],
};

export const radiant: Script = {
  targets,
  cry: () => [destroy({ target: { of: "chosen" } }), destroyAdjacentTo({ target: { of: "chosen" } })],
};
