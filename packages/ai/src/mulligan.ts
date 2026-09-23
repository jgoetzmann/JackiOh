// The AI's mulligan (SPEC §2.1, §9.9): keep the cheap cards, send back everything costing more than
// AI_MULLIGAN.keepMaxCost. The answer is R9-shaped — the ids kept — so `reduce` draws the
// replacements before the returned cards are shuffled back in, exactly as for a human.

import type { PlayerId } from "@jackioh/shared";
import { findDef, queryCost, type GameState } from "@jackioh/engine";
import { AI_MULLIGAN } from "./config";

/**
 * R9-shaped: the instance ids to keep; returns every hand card with queryCost > keepMaxCost
 * (AI_MULLIGAN's by default; the greedy baseline passes its own frozen GREEDY_MULLIGAN).
 */
export function mulliganKeep(state: GameState, seat: PlayerId, keepMaxCost: number = AI_MULLIGAN.keepMaxCost): string[] {
  const keep: string[] = [];
  for (const card of state.players[seat].hand) {
    const def = findDef(state, card.defId);
    if (def === undefined) continue;
    if (queryCost(def) <= keepMaxCost) keep.push(card.id);
  }
  return keep;
}
