// #12 Duplicating Felinors (SPEC §8.1): 3/4 → 6/9 Unit, Felinor, cost 2, Rare. Base "Cry: summon a
// copy of this unit"; the radiant cell says "Same", so the radiant face runs the very same text
// (§8 Conventions) on the 6/9 body — and its copy is a Radiant 6/9 too, so the effect doubles with
// the stats (R275). §8's Engine cell: "Copy per R57, placed per R64; the copy's Cry does not fire
// (§6.2)".
//
// R57 (copy semantics): "A copy of a unit on the field keeps its radiant flag, buffs, granted
// keywords, Vanilla state and `statsOverride` and resets damage, exertion and counters." The copy is
// a new instance, so it also takes the current turn as its `summonedTurn` (§4.1 summoning sickness)
// and carries no memory of its own.
//
// R64 (placement): with no zone named the copy takes the leftmost empty, unlocked, unreserved unit
// zone, and the summon fizzles silently when the row has none — which is the row's "board full → no
// copy" with no check of its own.
//
// R1 / §6.2 (Cry): "Only when played from hand or cast by an effect. Copies, Recruit, Reborn, tokens,
// Transform never fire it" — the cited reason being this very card, which "would fill the board for
// 2 mana otherwise". A summon fires no Cry (engine/src/effects/summon.ts), so the chain ends after
// one copy on its own.
//
// The clone is the engine's `summonCopy` (engine/src/effects/summon.ts), which resolves `of` to a
// unit, clones it per R57 and places it per R64 through the same path as `summon`. A card file may
// not read the buffs, keywords and Vanilla state off the instance and rebuild them (CLAUDE.md
// rule 5), which is why the copy is a verb and not a `summon({ defId, radiant })`.

import type { Script } from "@jackioh/engine";
import { summonCopy } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-012");

/**
 * "A copy of this unit": the Cry's own instance is the source, so `{ of: "self" }` names it without
 * the card ever touching state. Both faces run this — the radiant cell is "Same".
 */
const cry: Script["cry"] = () => [summonCopy({ of: { of: "self" }, player: "self" })];

export const base: Script = { cry };

export const radiant: Script = { cry };
