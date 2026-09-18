// SPEC §8.1 #5 Stockpile — Spell, cost 1.
// Base: "Draw 2; heal your hero 2". Radiant: "Draw 5; heal 5" — the cell changes only the numbers
// of the base clause (§8 Conventions), and "heal 5" is still the hero.
//
// Engine cell: the hand cap applies. That is the draw pipeline's job (§2.4, R4: hand size 10, a
// card drawn into a full hand is burned to the graveyard), so this file just asks for the draws.
// A hero has no maximum health (§3), so the heal may take it above 30; `heal` with an `amount` on
// a hero adds health with no cap (effects/heal.ts).
//
// A Spell's on-resolve script hangs off `cry` (§10.5 step 5).

import type { Script } from "@jackioh/engine";
import { draw, heal } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-005");

export const base: Script = {
  cry: () => [draw({ count: 2 }), heal({ target: { of: "selfHero" }, amount: 2 })],
};

export const radiant: Script = {
  cry: () => [draw({ count: 5 }), heal({ target: { of: "selfHero" }, amount: 5 })],
};
