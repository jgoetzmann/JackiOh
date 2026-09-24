// Mana refresh, temporary mana and the cost calculation (SPEC §2.3, §6.3 Cost, R65).

import type { GameEvent } from "@jackioh/shared";
import { MAX_MANA } from "./config";
import { defOf } from "./catalog";
import { scriptOf } from "./scripts";
import type { CardInstance, GameState, PlayerModifier, PlayerState } from "./state";

/**
 * §2.3: "Max mana = min(number of turns you have started, 4), plus persistent modifiers", floored
 * at 0. `nextTurnMod` is not one of those: it is a one-shot rider on a single refresh, which the
 * refresh spends and clears, so it never reaches max mana.
 */
export function maxManaFor(side: PlayerState): number {
  const base = Math.min(side.turnsStarted, MAX_MANA);
  return Math.max(0, base + side.mana.permMod);
}

/**
 * R169: the id the next refresh's rider (`mana.nextTurnMod`, §6.3 Mana: "'next turn' mana is stored
 * as a modifier for the next refresh") travels under — one badge per player, which `modifierChanged`
 * names as it appears, changes and is spent, and which the view lists while the rider is not 0.
 */
export const NEXT_REFRESH_MODIFIER_ID = "nextTurnMana";

/**
 * Start of turn: refresh to max, moved by the one-shot rider (§6.3 Mana: "'next turn' mana is stored
 * as a modifier for the next refresh"), which is then cleared. The rider changes what the refresh
 * gives, not max mana: #24 Efficiency Dividend's next-turn mana is temporary mana on §2.3's list and
 * "adds to current mana and can exceed 4", exactly as #6 Mana Well's gain does, and #21 Hinder
 * "subtracts from the opponent's next refresh". Current mana never goes below 0 (§2.3).
 */
export function refreshMana(side: PlayerState): void {
  const max = maxManaFor(side);
  side.mana.max = max;
  side.mana.current = Math.max(0, max + side.mana.nextTurnMod);
  side.mana.nextTurnMod = 0;
}

/** Temporary mana may take current above max (§2.3). */
export function gainMana(side: PlayerState, amount: number): void {
  side.mana.current = Math.max(0, side.mana.current + amount);
}

export function spendMana(side: PlayerState, amount: number): void {
  side.mana.current = Math.max(0, side.mana.current - amount);
}

export function manaEvent(player: "p1" | "p2", side: PlayerState): GameEvent {
  return { type: "manaChanged", player, current: side.mana.current, max: side.mana.max };
}

/** The printed cost as it stands: X uses the chosen X, an embiggen card the chosen price (R65). */
export function printedCost(state: GameState, instance: CardInstance): number {
  const script = scriptOf(instance);
  if (script.cost !== undefined) return Math.max(0, script.cost({ state, instance }));

  const cost = defOf(state, instance.defId).cost;
  if (cost === "X") return Math.max(0, instance.x ?? 0);
  if (typeof cost === "number") return cost;
  return instance.embiggened === true ? cost.embiggen : cost.base;
}

export function isXCost(state: GameState, instance: CardInstance): boolean {
  return defOf(state, instance.defId).cost === "X";
}

/**
 * R48: a modifier that covers a player's *next* turn does nothing on the turn it was created on,
 * and nothing on the opponent's turn in between either — #77's text is "during **your** next turn",
 * so it is live only once that player is the active one on a later turn. `expireModifiers` ends it
 * at the cleanup of that player's next turn, which is why this is a separate question from expiry.
 */
export function modifierIsLive(state: GameState, mod: PlayerModifier): boolean {
  // §2.2: "this turn" is the turn it names, and no later one — even when it was made after that
  // turn's cleanup had run and so outlives it until the next cleanup (`expireModifiers`).
  if (mod.expiry.until === "thisTurn") return mod.expiry.turn >= state.turn;
  if (mod.expiry.until !== "nextTurnOf") return true;
  return state.turn > mod.expiry.fromTurn && state.active === mod.expiry.player;
}

/**
 * R65: start from costOverride or the printed cost, add the instance's costMod, add the player's
 * discounts, then Professor Curvature if the result is 4, and floor at 0. An X-cost card costs
 * exactly X and ignores modifiers, unless an override makes it free.
 *
 * The player's discounts and Curvature are prices for a play — §6.3's Cost is "what a card costs to
 * play now", #35's is "the next Spell you play", #78's "this turn your cards cost 1 less", and R48
 * reads Curvature "at play time" — so they reach a card in its controller's hand, where a play takes
 * it from (§10.5 step 1), and no other. A card in a library or a graveyard is read at its own cost,
 * its `costOverride` or printed cost with its `costMod`: #30 Archivist's "highest" (R24), #94's
 * 2-cost draw and odd-cost exile (R66), a Recruit's filter — as Hearthstone's hand discounts never
 * reach the deck or the graveyard (R65).
 */
export function effectiveCost(state: GameState, instance: CardInstance): number {
  const side = state.players[instance.controller];
  const override = instance.costOverride;

  // R65: X-cost cards cost exactly X and ignore modifiers, but an override makes one free.
  if (isXCost(state, instance)) {
    return override !== undefined ? 0 : printedCost(state, instance);
  }

  let cost = (override ?? printedCost(state, instance)) + instance.costMod;
  // R65: a player's discounts price a play, and a play takes a card from its hand.
  if (instance.zone.z !== "hand") return Math.max(0, cost);
  const type = defOf(state, instance.defId).type;

  for (const mod of side.mods) {
    if (mod.kind !== "costDiscount") continue;
    if (!modifierIsLive(state, mod)) continue;
    if (mod.onlyType !== undefined && mod.onlyType !== type) continue;
    if (mod.onlyCurrentCost !== undefined) continue; // Curvature is applied below.
    cost -= mod.amount;
  }

  // R65: "apply Professor Curvature if the result is then 4" — the result of the steps above, which
  // every live Curvature reads. Two of them (#39's copy, #33's) each test that one number, so both
  // apply to a card the discounts leave at 4, and the order they were played in changes nothing: a
  // Curvature never reads the cost another Curvature has already lowered (R48).
  const beforeCurvature = cost;
  for (const mod of side.mods) {
    if (mod.kind !== "costDiscount" || mod.onlyCurrentCost === undefined) continue;
    if (!modifierIsLive(state, mod)) continue;
    if (beforeCurvature === mod.onlyCurrentCost) cost -= mod.amount;
  }

  return Math.max(0, cost);
}

export function canAfford(state: GameState, instance: CardInstance): boolean {
  return effectiveCost(state, instance) <= state.players[instance.controller].mana.current;
}
