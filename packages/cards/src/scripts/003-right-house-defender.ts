// SPEC §8.1 #3 Right-house defender — 1/1 → 2/2 Unit, Human, cost 1.
// Base: "Divine Shield, Reborn" — both are printed on both faces in the catalog and the layer
// system applies them (§10.4), so the base script has nothing to do. Never re-grant a printed
// keyword from a script.
//
// Radiant: "Divine Shield, Reborn; Death: summon a base Right-house defender". The radiant cell
// keeps the base keywords and adds the Death clause (§8 Conventions).
//
// Engine cell: Death fires on both deaths of a Reborn unit (§4.5's ruling, R8) — the Reborn death
// and the reborn body's death — and the reborn body keeps the radiant flag (R78), so the radiant
// form summons twice in total. What it summons is a NEW base Right-house defender rather than a
// copy: `summon` without `radiant: true` creates the base face, whose script is `base` above and
// has no Death hook, so the chain ends there. Placement is R64's leftmost free zone, and the dying
// unit's own zone is reserved for its Reborn return, so the summon lands beside it, not in it.

import type { Script } from "@jackioh/engine";
import { summon } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-003");

/** Printed keywords only (§10.4); an empty Script is the whole base card. */
export const base: Script = {};

export const radiant: Script = {
  death: () => [summon({ defId: "core-003", player: "self" })],
};
