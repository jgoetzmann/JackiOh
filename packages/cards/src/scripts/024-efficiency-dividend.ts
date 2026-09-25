// #24 Efficiency Dividend (SPEC §8.2, R65, R81, R68, §5.1).
//
// Base: "Choose one: deal X damage to a target; heal a target 2X; gain floor(X/2) mana next turn.
// End of turn: returns to hand". Radiant (R275: an X-cost card's X is scaled): "Choose one: deal 2X
// damage to a target; heal a target 4X; gain X mana next turn. End of turn: returns to hand" — the
// §8 cell's "Uses 2X". So the radiant face is the base arithmetic run on 2X instead of X: 2X damage,
// 2·2X = 4X healing and floor(2X/2) = X mana, exactly the printed numbers, and the modes, the target
// and the return to hand are all kept (§8 Conventions). What the player pays is still X (R65).
//
// R81: X, the mode and the target all travel in the `play` action and never pause resolution, so
// the hook reads `ctx.x`, `ctx.modes` (through `chosenOptions`, which also reads a mode selection)
// and `{ of: "chosen" }`. R65: an X-cost card being played costs exactly X — `costMod` and
// discounts do not change it — and the play validator bounds X by current mana, so nothing here
// re-checks the price.
//
// "Gain floor(X/2) mana next turn" is a positive `mana.nextTurnMod` (§2.3), the same one-shot
// modifier Hinder makes negative: `refreshMana` spends it at the next refresh and clears it.
//
// §5.1 and R68: the spell is flagged `returnToHandAtEndOfTurn` when played and comes back from the
// graveyard at the end of that turn, as a graveyard trigger. No verb sets that flag yet (reported),
// so the hook gates on the flag OR this turn's play log — see #23 for the same note.

import type { Effect, EffectContext, Script } from "@jackioh/engine";
import { wasPlayedThisTurn } from "@jackioh/engine";
import {
  bounce,
  chosenOptions,
  damage,
  heal,
  nextTurnMana,
} from "@jackioh/engine/effects";
import type { ModeDecl, TargetDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-024");

// The three §8.2 modes, in the order the cell lists them. A card file exports only
// `{ def, base, radiant }` (§10.9), so the mode names live in the declaration below and the test
// reads them back off `base.modes`.
const MODE_DAMAGE = "damage";
const MODE_HEAL = "heal";
const MODE_MANA = "mana";

const modes: ModeDecl[] = [{ kind: "mode", options: [MODE_DAMAGE, MODE_HEAL, MODE_MANA] }];

/**
 * R81: the target travels with the play. It is the damage and heal modes' target alone
 * (`forModes`): §8's Conventions have "a target" picked from every legal unit and hero, and only an
 * EMPTY set lets the effect fizzle — a hero always stands, so those two modes always name one, while
 * the mana mode names none at all (R90). With `min: 0` for every mode, a damage or heal play could
 * name nobody and pay its X for nothing.
 */
const targets: TargetDecl[] = [
  {
    kind: "target",
    min: 1,
    max: 1,
    filter: { side: "any", of: ["unit", "hero"] },
    forModes: [MODE_DAMAGE, MODE_HEAL],
  },
];

/** "Heal a target 2X". */
const HEAL_PER_X = 2;

/** "Gain floor(X/2) mana next turn": one mana for every two X. */
const X_PER_MANA = 2;

/** The base face uses X as it was paid; the radiant face uses 2X ("Uses 2X", R275). */
const BASE_USES = 1;
const RADIANT_USES = 2;

/** The X the modes read: the X paid (never below 0), times the face's multiple. */
function amountX(ctx: EffectContext, uses: number): number {
  return Math.max(0, Math.trunc(ctx.x)) * uses;
}

/** `uses` is the whole of the radiant difference: every mode reads 2X instead of X. */
function dividend(uses: number): Script {
  return {
    modes,
    targets,
    cry: (ctx): Effect[] => {
      const x = amountX(ctx, uses);
      const mode = chosenOptions(ctx)[0];
      if (mode === MODE_DAMAGE) return [damage({ to: { of: "chosen" }, amount: x })];
      if (mode === MODE_HEAL) return [heal({ target: { of: "chosen" }, amount: HEAL_PER_X * x })];
      if (mode === MODE_MANA) {
        return [nextTurnMana({ amount: Math.floor(x / X_PER_MANA), player: "self" })];
      }
      // No mode named: nothing to resolve, and the spell still counts as played (§8 Conventions).
      return [];
    },
    endOfTurn: (ctx): Effect[] => {
      const self = ctx.self;
      if (self === null) return [];
      const played = wasPlayedThisTurn(ctx.state, self.controller, self);
      if (self.returnToHandAtEndOfTurn !== true && !played) return [];
      return [bounce({ target: { of: "self" } })];
    },
  };
}

export const base: Script = dividend(BASE_USES);

export const radiant: Script = dividend(RADIANT_USES);
