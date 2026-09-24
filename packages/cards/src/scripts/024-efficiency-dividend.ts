// #24 Efficiency Dividend (SPEC §8.2, R65, R81, R68, §5.1).
//
// Base: "Choose one: deal X damage to a target; heal a target 2X; gain floor(X/2) mana next turn.
// End of turn: returns to hand". Radiant restates the arithmetic only — "Uses X+1" — so the modes,
// the target and the return to hand are all kept (§8 Conventions).
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

function amountX(ctx: EffectContext, bonus: number): number {
  return Math.max(0, Math.trunc(ctx.x)) + bonus;
}

/** `bonus` is the whole of the radiant text: every mode reads X+1 instead of X. */
function dividend(bonus: number): Script {
  return {
    modes,
    targets,
    cry: (ctx): Effect[] => {
      const x = amountX(ctx, bonus);
      const mode = chosenOptions(ctx)[0];
      if (mode === MODE_DAMAGE) return [damage({ to: { of: "chosen" }, amount: x })];
      if (mode === MODE_HEAL) return [heal({ target: { of: "chosen" }, amount: 2 * x })];
      if (mode === MODE_MANA) {
        return [nextTurnMana({ amount: Math.floor(x / 2), player: "self" })];
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

export const base: Script = dividend(0);

export const radiant: Script = dividend(1);
