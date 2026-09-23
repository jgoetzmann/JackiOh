// Every number the AI states (CLAUDE.md rule 9, in the package's own config). The weights are tuning
// defaults: tests pin rankings and puzzle outcomes, never these values.

import type { SearchBudget } from "./types";

/** The practice AI's budget (SPEC §9.9): the same at every difficulty (R180). */
export const AI_BUDGET: SearchBudget = {
  nodes: 600,
  lethalNodes: 150,
  determinizations: 3,
  beamWidth: 4,
  rootBranching: 20,
  branching: 6,
  maxDepth: 8,
  finalists: 3,
};

/**
 * The quality gates' budget, and the shadow-ban sweep's: the browser's own, so that the gates
 * (docs/polish/3-ai.md B28–B31) and the sweep (R186) measure the AI that ships. A decision seldom
 * spends it all (the beam's shape, not the node count, bounds most turns), so a gate game costs
 * seconds, not minutes. Kept as its own name so that the gates can be given less, with the same
 * algorithm, if CI ever needs them faster.
 */
export const AI_GATE_BUDGET: SearchBudget = AI_BUDGET;

export const AI_SEARCH = {
  /** Plays identical but for `zone` keep the leftmost and rightmost lane only. */
  zoneVariants: 2,
  /** Opponent prompts auto-answered inside one simulated step before it counts as an error. */
  maxAutoAnswers: 8,
  /** Deepest line the lethal solver explores. */
  lethalMaxDepth: 10,
  /** Lines per first action scored after the opponent's reply on determinization 0. */
  linesPerAction: 2,
  /** Seed of the throwaway determinization that lists candidates for the forced check. */
  probeSeed: "ai:probe",
} as const;

export const AI_EVAL = {
  /** won: +win − state.turn; lost: −win + state.turn. */
  win: 1_000_000,
  /** result "draw". */
  drawn: 0,
  /** heroValue(h) = h <= 0 ? −win : heroHealth × sqrt(h × HERO_HEALTH). */
  heroHealth: 1,
  /**
   * Per point of the enemy hero's health, on top of its concave value: damage to the enemy hero
   * shortens the race by the same amount whatever its health, and a draw at the turn cap is no win.
   */
  enemyHealth: 1,
  /** Share of a printed Taunt and a point of Armor that Defense Position's grants are worth (§4.1). */
  positionGrants: 0,
  /** Per point of heroArmorOf. */
  heroArmor: 0.6,
  /** Per point of unitView.attack. */
  attack: 1.2,
  /**
   * The share of a Defense-Position unit's attack that counts (§4.1: it cannot attack until a
   * switch spends its exertion, but it still strikes back in full).
   */
  defenseAttackShare: 0.5,
  /** Per point of unitView.health (current). */
  health: 1,
  /** Per point of unitView.armor. */
  armorPoint: 0.8,
  /** Per keyword in unitView.keywords (spent Divine Shield and Reborn are already gone). */
  keyword: {
    Taunt: 1.5,
    "Divine Shield": 2,
    Lifesteal: 1,
    Poisonous: 2,
    Reborn: 2,
    Charge: 0.5,
    Rush: 0.3,
    "First Strike": 1,
    Trample: 0.5,
    Cleave: 1,
    Indestructible: 4,
    Immutable: 0.3,
    Stack: 0,
    Lucky: 0.2,
  },
  /** Own hand card: handCard + handPerCost × min(queryCost(def), handCostCap). */
  handCard: 1,
  handPerCost: 0.3,
  handCostCap: 6,
  /** Added per own Radiant hand card. */
  radiantInHand: 0.5,
  /** An unseen hand card is valued as if it cost this. */
  opponentHandCost: 2,
  /** A readable backrow card: backrowBase + backrowPerCost × queryCost(def). */
  backrowBase: 1.5,
  backrowPerCost: 0.8,
  /** A backrow card the seat cannot read (on the enemy's side of the ledger). */
  enemyFaceDown: 2,
  /** Per library card up to libraryComfort. */
  libraryCard: 0.1,
  libraryComfort: 10,
  /** Per crystal left at the end of the seat's own turn (terminal only). */
  unspentMana: 0.8,
  /** Per point of faceThreat(enemy) against the seat. */
  threatPerDamage: 0.4,
  /** When faceThreat(enemy) >= the seat's hero health. */
  lethalThreat: 150,
  pressurePerDamage: 0.5,
  lethalPressure: 20,
  /** The share of the threat terms that counts when `seat` swings first (evaluate's "seat" frame). */
  answerableThreat: 0.3,
  /** Lethal pressure when `seat` swings first: the enemy has no turn left to answer it. */
  lethalOnBoard: 20,
  /** From this turn on, damage on the enemy hero gains value, rising linearly to the turn cap. */
  closingFrom: 10,
  /** The extra value per point of enemy hero damage once the turn cap is reached (a draw scores 0). */
  closingWeight: 3,
} as const;

/** Every weight `evaluate` reads, as numbers (AI_EVAL's shape without its literal types). */
type Widened<T> = { readonly [K in keyof T]: T[K] extends number ? number : Widened<T[K]> };
export type EvalWeights = Widened<typeof AI_EVAL>;

/**
 * The greedy baseline's own evaluation (baselines.ts): AI_EVAL exactly as it stood when the quality
 * gates were fixed on the seed series `gate:v2`, frozen here. A baseline the AI is measured against
 * must not move when the AI is tuned, so tuning AI_EVAL changes the AI and never its yardstick.
 */
export const GREEDY_EVAL: EvalWeights = {
  win: 1_000_000,
  drawn: 0,
  heroHealth: 1,
  enemyHealth: 1,
  positionGrants: 0,
  heroArmor: 0.6,
  attack: 1.2,
  defenseAttackShare: 0.5,
  health: 1,
  armorPoint: 0.8,
  keyword: {
    Taunt: 1.5,
    "Divine Shield": 2,
    Lifesteal: 1,
    Poisonous: 2,
    Reborn: 2,
    Charge: 0.5,
    Rush: 0.3,
    "First Strike": 1,
    Trample: 0.5,
    Cleave: 1,
    Indestructible: 4,
    Immutable: 0.3,
    Stack: 0,
    Lucky: 0.2,
  },
  handCard: 1,
  handPerCost: 0.3,
  handCostCap: 6,
  radiantInHand: 0.5,
  opponentHandCost: 2,
  backrowBase: 1.5,
  backrowPerCost: 0.8,
  enemyFaceDown: 2,
  libraryCard: 0.1,
  libraryComfort: 10,
  unspentMana: 0.8,
  threatPerDamage: 0.4,
  lethalThreat: 150,
  pressurePerDamage: 0.5,
  lethalPressure: 20,
  answerableThreat: 0.3,
  lethalOnBoard: 20,
  closingFrom: 10,
  closingWeight: 3,
};

/** The opponent's reply that the best lines are scored after (reply.ts, SPEC §9.9). */
export const AI_REPLY = {
  /** Engine steps one reply may take: plays, attacks, prompt answers and the closing endTurn. */
  maxSteps: 12,
  /** Nodes `decide` reserves per reply when it splits the budget (a typical reply, not the most). */
  reserveSteps: 5,
  /** Plays of cards the line put in the opponent's hand that one reply step tries, in move order. */
  knownPlays: 8,
  /** The opponent's value per point of damage its attack would deal the seat's hero. */
  facePerDamage: 1,
  /** Per point an attack deals a unit it does not kill. */
  chipPerDamage: 0.3,
} as const;

export const AI_MULLIGAN = { keepMaxCost: 3 } as const;

/** The greedy baseline's mulligan, frozen with GREEDY_EVAL for the same reason. */
export const GREEDY_MULLIGAN = { keepMaxCost: 3 } as const;

export const AI_DETERMINIZE = {
  /** §5 indexes never sampled into a hidden slot: #98 keeps its rolled power in memory (R43). */
  excludeIndexes: ["98"],
} as const;
