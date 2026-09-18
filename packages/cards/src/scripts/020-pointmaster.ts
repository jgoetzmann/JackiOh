// #20 Pointmaster (SPEC §8.1): 7/2 → 14/4 Unit, Human, "First Strike", radiant "First Strike,
// Divine Shield". Engine cell: "Keywords only".
//
// The radiant cell lists keywords without "Plus", so `[First Strike, Divine Shield]` is the radiant
// form's complete list (§8 Conventions) — which is also what the base list plus Divine Shield comes
// to, so the two readings agree.
//
// Both faces are keywords only and both keyword lists are PRINTED in the catalog
// (`core-020.base.keywords = [First Strike]`, `core-020.radiant.keywords = [First Strike, Divine
// Shield]`), so §10.4's layer system already supplies them: `combat.ts`'s `resolveCombat` gives the
// First Striker step 1 of §4.3 alone and `damage.ts` spends the Divine Shield on the first hit.
// There is nothing left for a script to do, and an empty Script is the whole of this card — a hook
// that re-granted a printed keyword would be a second source of it (§10.4 layer 4).

import type { Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-020");

export const base: Script = {};

export const radiant: Script = {};
