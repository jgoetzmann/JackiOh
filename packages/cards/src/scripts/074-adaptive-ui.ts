// #74 Adaptive UI (SPEC §8.3): cost X, "Deal X damage to a target, heal your hero X, draw X, summon
// an X/X Rush Token"; radiant "2X damage, heal 3X, draw 2X, a 3X/3X token" — the radiant cell
// changes only the four multipliers, so the clauses, their order and the target are all kept
// (§8 Conventions).
//
// X is a PLAY choice, not a prompt (R81, and §10.6: no Core card opens an `x` prompt). The play
// action carries it, `playCard` bounds it by the player's current mana and stores it on the
// instance, and `makeContext` hands it to the hook as `ctx.x`. R65: an X-cost card being played
// costs exactly X — `costMod` and player discounts do not change it — so nothing here reads a price.
//
// "X = 0 does nothing but counts as played" (§8.3 Engine cell): the hook returns an empty list, so
// no damage instance is created (R63 would drop a 0 hit anyway), no heal event fires, no draw
// happens, and — the part that needs the guard — no 0/0 Rush Token is summoned. "Counts as played"
// is the play pipeline's: `playCard` pushes to `turnLog.playedIds`, bumps `turnLog.cardsPlayed` and
// `counters.played` and emits `cardPlayed` BEFORE the Cry runs, so an empty effect list still counts
// (§10.5 step 4, §8 Conventions: "the spell still counts as played").
//
// The four clauses resolve in the order §8 writes them, which `applyEffects` guarantees (it applies
// the array in order) and which matters: the damage lands before the heal, so a Lifesteal-less
// exchange on your own hero nets correctly, and the draw happens before the summon, so a Rush Token
// drawn into a full hand (R4) is burned before the board grows.
//
// "Heal your hero X" is `{ of: "selfHero" }` — the controller's own hero, never a chosen target
// (R19's "any unit or hero" is #47 Fig of Life's licence, not this card's). §3 gives a hero no
// maximum health, so `healHero` simply adds.
//
// The token is the shipped Rush Token definition plus a §7 `statsOverride` ("Adaptive UI summons a
// Rush Token with X/X (or 3X/3X) instead of 3/3 … Implement as the Rush Token definition plus a
// `statsOverride` on summon"), so it keeps Rush and its printed 1 cost and only its stats move.
// R64 places it in the leftmost empty, unlocked unit zone; a full board fizzles the summon and the
// other three clauses still happen.

import type { Effect, EffectContext, Script } from "@jackioh/engine";
import { damage, draw, heal, summon } from "@jackioh/engine/effects";
import type { TargetDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-074");

/** §7: the token is the catalog's Rush Token, named by id so a missing entry fails at load. */
const RUSH_TOKEN = cardDef("core-t-rush").id;

/**
 * R81: "a target" travels in the play action and never pauses resolution. §8's Conventions make it
 * "all legal units and heroes on either side"; a hero is always on the board, so this declaration
 * can never make a play illegal, and R90 fizzles it rather than refusing the play if it somehow has
 * no answer.
 */
const targets: TargetDecl[] = [
  { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit", "hero"] } },
];

/**
 * §10.9: a hook may READ state to compute an effect's arguments; it never writes. This card's only
 * read is the declared X off the context — negative and fractional values are impossible (the play
 * validator refuses X < 0), and the clamp is belt and braces so no clause can go backwards.
 */
function chosenX(ctx: EffectContext): number {
  return Math.max(0, Math.trunc(ctx.x));
}

/** The four multipliers are the whole of the radiant text. */
function adaptiveUi(per: { damage: number; heal: number; draw: number; stats: number }): Script {
  return {
    targets,
    cry: (ctx): Effect[] => {
      const x = chosenX(ctx);
      // "X = 0 does nothing but counts as played": no hit, no heal, no draw, and no 0/0 token.
      if (x === 0) return [];
      const stats = per.stats * x;
      return [
        damage({ to: { of: "chosen" }, amount: per.damage * x }),
        heal({ target: { of: "selfHero" }, amount: per.heal * x }),
        draw({ count: per.draw * x }),
        summon({ defId: RUSH_TOKEN, statsOverride: { attack: stats, health: stats } }),
      ];
    },
  };
}

export const base: Script = adaptiveUi({ damage: 1, heal: 1, draw: 1, stats: 1 });

export const radiant: Script = adaptiveUi({ damage: 2, heal: 3, draw: 2, stats: 3 });
