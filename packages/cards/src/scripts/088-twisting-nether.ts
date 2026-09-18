// #88 Twisting Nether (SPEC §8.5, §3.1, §4.5, R13, R46, R59, R68, R69, R81).
//
// Base: "Destroy all permanents". Radiant: "Choose: all enemy permanents, or all".
// Engine cell: "Indestructibles survive; backrow included."
//
// §8's Conventions: the radiant cell restates the whole clause as a modal one, so the radiant face
// is the same board-wide destroy with a side chosen at play time.
//
// The mode is a DECLARED play choice, not a prompt. R81's card list names #88, and §10.6 is
// explicit: a card's own declared modes "travel in the `play` action" and are "not prompts";
// `playChoices.ts` enumerates them for `legalActions` and refuses a play that answers none. So the
// declaration below and `chosenOptions(ctx)` are the whole of the radiant choice — and they work
// today, which is why they are written out rather than left for later.
//
// `destroyAll({ side, rows })` is the board-wide destroy (`effects/destroy.ts`), written in the
// shared `BoardScope` of `effects/targets.ts`. It MARKS and never moves — `markedDestroyed` on
// every card the scope matches, walked in R68's order — so §4.5 step 1 collects the whole board at
// once and R59's single state check does the rest. Only cards ON the field are matched, so a card
// dormant under a Stack pile is not (R13).
//
// INDESTRUCTIBLE IS NOT THIS CARD'S BUSINESS, and the scope does NOT pre-exclude it. §4.5's
// `resolveIndestructibleMarks` drops the mark on an Indestructible unit, switches it to Attack
// Position and suppresses its Taunt for the turn (R46) — effects that only happen if the mark was
// actually applied. An Indestructible unit whose max health is already 0 or less dies anyway,
// because no destroy effect is involved (R69). So "Indestructibles survive" falls out of the state
// check, and asking the scope to skip them would quietly lose R46.

import type { Effect, Script } from "@jackioh/engine";
import { chosenOptions, destroyAll } from "@jackioh/engine/effects";
import type { ModeDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-088");

/** The radiant face's choice, in the order §8's cell lists it: enemy only, or everything. */
const MODE_ENEMY = "enemy";
const MODE_ALL = "all";
const modes: ModeDecl[] = [{ kind: "mode", options: [MODE_ENEMY, MODE_ALL] }];

/**
 * Which side the destroy reaches. The base face has no choice to read and always hits both sides;
 * the radiant face hits what the play named, and a play carrying no mode fizzles rather than
 * guessing — the spell still counts as played (§6.3, §8 Conventions).
 */
function sideFor(modeName: string | undefined, modal: boolean): "any" | "enemy" | null {
  if (!modal) return "any";
  if (modeName === MODE_ENEMY) return "enemy";
  if (modeName === MODE_ALL) return "any";
  return null;
}

/** `modal` is the whole of the radiant text. */
function nether(modal: boolean): Script {
  return {
    ...(modal ? { modes } : {}),
    cry: (ctx): Effect[] => {
      const side = sideFor(chosenOptions(ctx)[0], modal);
      if (side === null) return [];
      // §6.3: a permanent is a Unit, Field Spell, Trap or Field Trap, so both rows.
      return [destroyAll({ side, rows: ["units", "backrow"] })];
    },
  };
}

export const base: Script = nether(false);

export const radiant: Script = nether(true);
