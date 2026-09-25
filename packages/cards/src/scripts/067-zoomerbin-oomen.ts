// #67 Zoomerbin Oomen (SPEC §8.3, §3.1, §3.2, §5.1, R1, R33, R47, R60, R275).
//
// Base: "Cry: summon a random 1-cost Trap face-down into your backrow zone in this lane" (1/2).
// Radiant: "Cry: summon a random Radiant Trap face-down into your backrow zone in this lane" (2/4).
// The radiant cell restates which trap comes — any Trap, and Radiant (R275: "any random Trap" drew
// the very same six, so the face had no effect raise until the trap came Radiant) — so "your
// backrow zone in this lane" and "face-down" are both kept (§8 Conventions).
//
// §3.1: "'This lane' (Zoomerbin Oomen) means the backrow zone in the same column as the unit", so
// the lane is the Cry's own unit's lane, read back with the engine's `slotOf`. `summon` derives the
// row from the def's type (`rowOf`: everything but a Unit and a Spell goes to the backrow), so
// naming the lane is the whole placement.
//
// R47: a lane-targeted summon into an occupied or Locked zone fizzles, and §8's Conventions keep
// the unit on the field regardless — "the unit still enters". `summon`'s `zoneFor`/`canPlace`
// already implements exactly that (Locked, reserved or occupied → no zone → nothing created), so
// this card needs no check of its own and must not grow one.
//
// §3.2 and R33: `summonOnto` leaves anything that is not a Field Spell face-down, and only the
// current controller may read a face-down trap. R1: a summon fires no Cry and pays nothing, so the
// trap arrives unpaid and dormant until its own trigger condition is met.
//
// THE POOL. The Engine cell: "All six Core traps cost 1, so the base pool is #18, #41, #60, #71,
// #85, #96 and the radiant face's is the same six, summoned Radiant; zone occupied or Locked →
// fizzles". `TRAP_TYPES` is `["Trap", "Field Trap"]` because the filters match `def.type` exactly
// while SPEC reads "Field Trap counts as Trap" (§8 #51, R35, R61) — `test/query.test.ts` pins that
// pool to those six indices. The base form still carries `cost: 1`, because that is the printed text
// and the catalog making it a no-op today is a fact about Core, not about the card; the radiant form
// drops the cost, keeps the types and sets the §5.2 flag on the trap it makes. §5.1 keeps tokens out
// of a pool that does not ask for them and orders the result by §5 index, so a seeded pick replays
// identically (§9.3, R60). A Radiant face-down trap is still a face-down trap: only its controller
// may read it, its face included (R33, R97, R177), which `viewFor` owns.
//
// THE VERB. `summonRandom({ query, player, lane, radiant })` (engine/src/effects/summon.ts) resolves
// the pool through `catalog.query`, draws one def with `ctx.rng.pick`, and hands the placement to
// the same code `summon` uses, so R47's fizzle and the face-down trap stay in one place. A card file
// must not pick the def itself: that would put randomness in `packages/cards` instead of the effects
// library (CLAUDE.md rules 4 and 5).

import type { Effect, Script } from "@jackioh/engine";
import { slotOf } from "@jackioh/engine";
import { summonRandom } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";
import { TRAP_TYPES, type CardQuery } from "../query";

export const def = cardDef("core-067");

/** §8.3: the base text names 1-cost traps; §5.1's `cost` reads a def's cost out of play (R65). */
const TRAP_COST = 1;

/** Both pools, as `test/query.test.ts` spells them; today they return the same six defs. */
const ONE_COST_TRAPS: CardQuery = { type: TRAP_TYPES, cost: TRAP_COST };
const ANY_TRAP: CardQuery = { type: TRAP_TYPES };

/**
 * The faces differ in the pool and in whether the trap comes Radiant, so one factory takes both.
 *
 * §10.9 lets a hook read state to compute an effect's arguments; it never writes. The single read
 * here is the engine's own `slotOf`, which turns the Cry's unit into `{ player, row, lane }`.
 */
function oomen(pool: CardQuery, radiant: boolean): Script {
  return {
    cry: (ctx): Effect[] => {
      const self = ctx.self;
      if (self === null) return [];
      const at = slotOf(ctx.state, self);
      // Off the field there is no "this lane" to summon into, so nothing happens (§3.1).
      if (at === null) return [];
      return [summonRandom({ query: pool, player: "self", lane: at.lane, radiant })];
    },
  };
}

export const base: Script = oomen(ONE_COST_TRAPS, false);

export const radiant: Script = oomen(ANY_TRAP, true);
