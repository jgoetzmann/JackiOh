// #68 Twisted Sorcerer (SPEC §8.3, §4.4, §10.9, R75, R81, R90).
//
// Base cell: "Cry: deal 4 damage to a target, 8 if your hero is below 10". Radiant: "Cry: deal 8
// damage to a target, 16 if your hero is below 10" — the §8 cell "8, or 16", which R275 doubled from
// "6, or 12" to meet the standard. A cell that changes only numbers changes only those numbers (§8
// Conventions), so the target, the threshold and "your hero" are all kept and only the two amounts
// move.
//
// R75 and §5.3: the source list prints this card as "Spell, Unit"; it is a Unit, which is why the
// script hangs off `cry` as a unit's Cry rather than as a spell's on-resolve hook.
//
// §8's Conventions: "'target' means the player picks at play time from all legal units and heroes on
// either side unless narrowed", and "'Your' means the controller". A bare `target` declaration means
// a unit only (`pickKindsFor` in `playChoices.ts`, R90), so the heroes are named explicitly.
// R81: the pick travels in the `play` action and never pauses resolution, so the hook reads it back
// as `{ of: "chosen" }` (`ctx.targets[0]`) and this card opens no prompt.
//
// "Threshold read at resolution" (the Engine cell): the hero's health is read when the Cry runs, not
// when the card is played, which is what makes a hook the right place for the arithmetic. §10.9
// allows a hook to READ state to compute an effect's argument; it never writes.
//
// §4.4: the damage is one instance through the pipeline, so Armor, Divine Shield, the anti-oneshot
// cap and Indestructible all apply to it — `damage` is the only verb involved.
//
// Fizzle: §8's Conventions say a Cry with an empty target set fizzles and the unit still enters, and
// R90 says a declaration the board cannot satisfy does not refuse the play. With the heroes in the
// filter that set is never actually empty (a hero is always there), so the fizzle branch is
// unreachable for this card; `damage` still resolves `{ of: "chosen" }` to null and does nothing if
// it ever is.
//
// R195, the yellow glow: in hand the card glows exactly when its Cry would deal the high number.
// `heroIsLow` is the one predicate both the Cry and `conditionMet` read, so they cannot drift. The
// condition is about the play, so a Sorcerer on the field never glows.

import type { Effect, GameState, Script } from "@jackioh/engine";
import { heroOf } from "@jackioh/engine";
import { damage } from "@jackioh/engine/effects";
import type { PlayerId, TargetDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-068");

/** §8.3: "below 10" is strict — at exactly 10 the small number is dealt. */
const LOW_HERO_HEALTH = 10;

/** §8 Conventions: every legal unit and hero on either side (R90: a bare `target` is units only). */
const targets: TargetDecl[] = [
  { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit", "hero"] } },
];

/**
 * "If your hero is below 10", strictly. §10.9: a hook may read state to compute an effect's
 * arguments; it never writes, and R195's `conditionMet` reads the same thing through this function.
 */
function heroIsLow(state: GameState, controller: PlayerId): boolean {
  return heroOf(state, controller).health < LOW_HERO_HEALTH;
}

/**
 * §10.9: a hook may read state to compute an effect's arguments; it never writes. The read goes
 * through `heroOf` (engine/src/query.ts), the engine's read-only hero block — BUILD M3-T1 wants no
 * card file spelling out the shape of `PlayerState`, so this file names the fact it needs and not
 * the field it lives in.
 *
 * `low` is dealt normally, `high` when the controller's hero is below the threshold at resolution.
 */
function sorcerer(low: number, high: number): Script {
  return {
    targets,
    cry: (ctx): Effect[] => {
      const amount = heroIsLow(ctx.state, ctx.controller) ? high : low;
      return [damage({ to: { of: "chosen" }, amount })];
    },
    // R195: hand only — the glow says playing it now deals `high`.
    conditionMet: (ctx) => ctx.zone === "hand" && heroIsLow(ctx.state, ctx.controller),
  };
}

/** Base: "deal 4 damage …, 8 if your hero is below 10". */
const BASE_DAMAGE = 4;
const BASE_LOW_DAMAGE = 8;

/** Radiant: "deal 8 damage …, 16 if your hero is below 10" (R275). */
const RADIANT_DAMAGE = 8;
const RADIANT_LOW_DAMAGE = 16;

export const base: Script = sorcerer(BASE_DAMAGE, BASE_LOW_DAMAGE);

export const radiant: Script = sorcerer(RADIANT_DAMAGE, RADIANT_LOW_DAMAGE);
