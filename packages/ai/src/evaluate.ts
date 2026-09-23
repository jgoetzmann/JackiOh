// The AI's static evaluation (SPEC §9.9): hero health (concave, so the last points weigh most),
// hero armor, board stats and keywords through §10.4's layers (a Defense-Position unit's attack at
// a discount), cards in hand, library, the enemy's face damage next turn against our health and the
// reverse, and, late in the game, the turn cap. It reads only what the seat may know or what a
// determinization sampled, and nothing here reads a handicap or a difficulty (R180).

import type { PlayerId } from "@jackioh/shared";
import { hasKeyword, opponentOf } from "@jackioh/shared";
import {
  activeUnitsOf,
  findDef,
  heroArmorOf,
  queryCost,
  subsystems,
  unitView,
  type CardInstance,
  type GameState,
} from "@jackioh/engine";
import { HERO_HEALTH, TURN_CAP_PLAYER_TURNS } from "@jackioh/engine/config";
import { AI_EVAL, type EvalWeights } from "./config";

/** A hero's health, concave: heroHealth × sqrt(h × HERO_HEALTH), so 30 health is worth 30. */
function heroValue(health: number, w: EvalWeights): number {
  if (health <= 0) return -w.win;
  return w.heroHealth * Math.sqrt(health * HERO_HEALTH);
}

/** §10.8, R33: whether `seat` may read this backrow card. A placeholder never is. */
function readableBy(state: GameState, card: CardInstance, seat: PlayerId): boolean {
  const def = findDef(state, card.defId);
  if (def === undefined) return false;
  if (def.type !== "Trap" && def.type !== "Field Trap") return true;
  if (card.faceUp === true) return true;
  return card.controller === seat;
}

/** One unit's worth on the board: its stats through the layers and its keywords (AI_EVAL). */
export function unitWorth(state: GameState, unit: CardInstance, w: EvalWeights = AI_EVAL): number {
  const view = unitView(state, unit);
  const weights = w.keyword as Readonly<Record<string, number>>;
  let value = w.health * view.health + w.armorPoint * view.armor;
  if (!hasKeyword(view.keywords, "Can't attack")) {
    // §4.1: a Defense-Position unit cannot attack until it spends a turn's exertion switching back,
    // though it still strikes back in full, so only part of its attack counts.
    const share = view.position === "DEF" ? w.defenseAttackShare : 1;
    value += w.attack * view.attack * share;
  }
  for (const keyword of view.keywords) {
    const weight = weights[keyword.kind];
    if (weight !== undefined) value += weight;
  }
  // §4.1: Defense Position's Taunt and Armor +1 are the position's, not the unit's. Their worth is
  // the damage they soak, which `faceThreat` and the reply already count, so here they are worth
  // only `positionGrants` of a printed Taunt and a point of printed Armor.
  if (view.position === "DEF" && hasKeyword(view.keywords, "Taunt")) {
    value -= (1 - w.positionGrants) * ((weights["Taunt"] ?? 0) + w.armorPoint);
  }
  return value;
}

function handCardValue(state: GameState, card: CardInstance, w: EvalWeights): number {
  const def = findDef(state, card.defId);
  const cost = def === undefined ? w.opponentHandCost : queryCost(def);
  const radiant = card.radiant ? w.radiantInHand : 0;
  return w.handCard + w.handPerCost * Math.min(cost, w.handCostCap) + radiant;
}

/** A hero's side of the ledger: its concave health and its armor. */
function heroSide(state: GameState, player: PlayerId, w: EvalWeights): number {
  return heroValue(state.players[player].hero.health, w) + w.heroArmor * heroArmorOf(state, player);
}

/** Everything on one side but the hero: the board, the backrow, the hand and the library. */
function material(state: GameState, player: PlayerId, seat: PlayerId, w: EvalWeights): number {
  const side = state.players[player];
  let value = 0;
  for (const unit of activeUnitsOf(state, player)) value += unitWorth(state, unit, w);

  for (const card of side.backrow) {
    if (card === null) continue;
    const def = findDef(state, card.defId);
    if (def !== undefined && readableBy(state, card, seat)) {
      value += w.backrowBase + w.backrowPerCost * queryCost(def);
    } else {
      value += w.enemyFaceDown;
    }
  }

  if (player === seat) {
    for (const card of side.hand) value += handCardValue(state, card, w);
  } else {
    value += side.hand.length * (w.handCard + w.handPerCost * w.opponentHandCost);
  }

  value += w.libraryCard * Math.min(side.library.length, w.libraryComfort);
  return value;
}

/**
 * The face damage `attacker`'s board could deal the other hero next turn: units with attack > 0,
 * position ATK and no "Can't attack", sorted ascending by attack. Taunt units on the defending side
 * soak up the smallest attackers first; each Taunt costs health + armor, plus one extra attacker if
 * it has Divine Shield. Each remaining attacker's attack goes through `subsystems.projectedHeroDamage`
 * (armor and the Anti-oneshot cap, per hit), and the results are summed.
 */
export function faceThreat(state: GameState, attacker: PlayerId): number {
  const defender = opponentOf(attacker);
  const attacks: number[] = [];
  for (const unit of activeUnitsOf(state, attacker)) {
    const view = unitView(state, unit);
    if (view.attack <= 0 || view.position !== "ATK") continue;
    if (hasKeyword(view.keywords, "Can't attack")) continue;
    attacks.push(view.attack);
  }
  attacks.sort((a, b) => a - b);

  const taunts = activeUnitsOf(state, defender)
    .map((unit) => unitView(state, unit))
    .filter((view) => hasKeyword(view.keywords, "Taunt"))
    .sort((a, b) => a.health + a.armor - (b.health + b.armor));

  let next = 0;
  for (const taunt of taunts) {
    if (hasKeyword(taunt.keywords, "Divine Shield")) {
      if (next >= attacks.length) return 0;
      next += 1;
    }
    const cost = Math.max(0, taunt.health) + taunt.armor;
    let soaked = 0;
    while (soaked < cost) {
      if (next >= attacks.length) return 0;
      soaked += attacks[next] ?? 0;
      next += 1;
    }
  }

  let total = 0;
  for (let i = next; i < attacks.length; i += 1) {
    total += subsystems.projectedHeroDamage(state, defender, attacks[i] ?? 0);
  }
  return total;
}

/**
 * Who swings next, for the threat and pressure terms: "enemy" (the default) reads a state as the end
 * of `seat`'s turn, where the enemy's board attacks before `seat` can answer; "seat" reads it as the
 * start of `seat`'s turn (the opponent's reply has been played out), where `seat` attacks first and
 * the enemy's board is a threat `seat` still has a whole turn to answer.
 */
export type NextSwing = "enemy" | "seat";

/**
 * A score for `seat` (higher is better). Pure, cheap (O(cards)), reads only public-or-sampled state.
 * `w` is the AI's own AI_EVAL unless a caller brings its own weights (the greedy baseline's
 * GREEDY_EVAL, which tuning the AI never moves).
 */
export function evaluate(state: GameState, seat: PlayerId, next: NextSwing = "enemy", w: EvalWeights = AI_EVAL): number {
  const opp = opponentOf(seat);
  const result = state.result;
  if (result !== null) {
    if (result.winner === seat) return w.win - state.turn;
    if (result.winner === opp) return -w.win + state.turn;
    return w.drawn;
  }

  const enemyDamage = faceThreat(state, opp);
  const ourDamage = faceThreat(state, seat);
  const seatFirst = next === "seat";
  const threatShare = seatFirst ? w.answerableThreat : 1;
  const threat =
    threatShare *
    (enemyDamage >= state.players[seat].hero.health ? w.lethalThreat : w.threatPerDamage * enemyDamage);
  const pressure =
    ourDamage >= state.players[opp].hero.health
      ? seatFirst
        ? w.lethalOnBoard
        : w.lethalPressure
      : w.pressurePerDamage * ourDamage;

  // §2.5: the game is a draw at the turn cap, which scores nothing, so late on every point of damage
  // on the enemy hero is worth more than the concave hero value alone says.
  const span = Math.max(1, TURN_CAP_PLAYER_TURNS - w.closingFrom);
  const progress = Math.min(1, Math.max(0, state.turn - w.closingFrom) / span);
  const closing = w.closingWeight * progress * (HERO_HEALTH - state.players[opp].hero.health);

  const race = w.enemyHealth * state.players[opp].hero.health;

  const board = material(state, seat, seat, w) - material(state, opp, seat, w);

  return heroSide(state, seat, w) - heroSide(state, opp, w) + board - threat + pressure + closing - race;
}
