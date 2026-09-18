// #58 Rush Token Farm (SPEC §8.3): Field Spell, cost 2. "Start of turn: summon a Rush Token" /
// radiant "Aura: your Rush Tokens +3/+3; same". Engine cell: "Aura keyed on def T-rush".
//
// §8 Conventions: "'same' says so explicitly", so the radiant cell ADDS the aura and KEEPS the
// base start-of-turn summon — the radiant face summons a token every turn AND pumps them.
//
// R62's turn sequence puts "start-of-turn triggers" after the mana refresh and the start-of-turn
// delayed effects and before the draw, and §6.2 defines "Start of turn" as the CONTROLLER's turn
// start, so this fires on its controller's turns only and never on the opponent's (`runHooksIn
// TriggerOrder(sink, "startOfTurn", player)` in engine/src/triggers.ts owns that).
//
// R64 places the token: with no lane named, the leftmost empty, unlocked, unreserved unit zone.
// A full board summons nothing and the trigger still resolved (§3.2: "a summon into a full row
// fails silently"), which is #15's "Board full -> fewer" rule applied one token at a time.
//
// The aura is §10.4 layer 5: a function of the board, recomputed on every read by `unitView`, so it
// vanishes the instant this Field Spell leaves the backrow and it lowers nothing permanently.
// §7's token rules name this card as the reason `statsOverride` is not the mechanism here: "Rush
// Token Farm radiant gives all your Rush Tokens +3/+3 as an aura", not as a summon-time stat.
// Keyed on the def id per the Engine cell, so it touches only Rush Tokens (`core-t-rush`) that this
// card's controller controls: an opponent's Rush Token is outside it, and so is any other 3/3.

import type { AuraHook, Hook, Script } from "@jackioh/engine";
import { summon } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-058");

/** §7's shared Rush Token, 3/3 with Rush. The aura and the summon must name the same def. */
const RUSH_TOKEN = "core-t-rush";

const startOfTurn: Hook = () => [summon({ defId: RUSH_TOKEN })];

/**
 * §10.4 layer 5. `applies` reads instance data only — `controller` and `defId`, never `unitView` —
 * because the layer stack would recurse otherwise (see `auraMods` in engine/src/layers.ts).
 * `ctx.self.controller` rather than the owner: control is what "your" means on the field (R12).
 */
const rushTokenAura: AuraHook = (ctx) => [
  {
    applies: (unit) => unit.controller === ctx.self.controller && unit.defId === RUSH_TOKEN,
    mod: { attack: 3, maxHealth: 3 },
  },
];

export const base: Script = { startOfTurn };

export const radiant: Script = { startOfTurn, aura: rushTokenAura };
