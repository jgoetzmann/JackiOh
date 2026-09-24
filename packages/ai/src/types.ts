// The AI's shared types (docs/polish/3-ai.md §Surface, SPEC §9.9). Every name here is exact: the
// harness, the web worker and the tests write against these before the code behind them exists.

import type { ActionBody } from "@jackioh/shared";
import type { Rng } from "@jackioh/engine";

/** A decision's budget. "Node" = one engine `reduce` call made by the AI, in any determinization. */
export type SearchBudget = {
  /** reduce() calls the whole decision may make, lethal solver and opponent auto-answers included. */
  nodes: number;
  /** Of `nodes`, the most the lethal solver may spend before the beam starts. */
  lethalNodes: number;
  /** Determinizations sampled per decision (K). */
  determinizations: number;
  /** Open lines kept per depth. */
  beamWidth: number;
  /** Children expanded at the root, after move ordering (endTurn always kept on top of this). */
  rootBranching: number;
  /** Children expanded per open line below the root (endTurn always kept on top of this). */
  branching: number;
  /** Actions in one planned line, endTurn included. */
  maxDepth: number;
  /** Best complete lines on determinization 0 that are re-scored on every other determinization. */
  finalists: number;
};

export type AiOptions = {
  /** The AI's own stream; determinize is its only consumer. */
  rng: Rng;
  /** Default AI_BUDGET. */
  budget?: SearchBudget;
  /** Wall-clock safety cap, polled before every node; true = stop and answer with the best so far. */
  shouldStop?: () => boolean;
};

export type DecisionReason = "forced" | "mulligan" | "draw-offer" | "lethal" | "prompt" | "search" | "fallback";

export type SearchStats = {
  nodes: number;
  determinizations: number;
  /** Complete lines scored on determinization 0. */
  lines: number;
  /** Simulated reduce calls that threw or were refused; never escape `decide`. */
  simErrors: number;
  stoppedBy: "exhausted" | "budget" | "clock";
  /** Mean score of the chosen line across determinizations (0 for forced/mulligan/draw-offer). */
  score: number;
};

export type Decision = {
  action: ActionBody;
  reason: DecisionReason;
  /** The planned line this action starts. Only line[0] is ever played; the AI re-plans after it. */
  line: ActionBody[];
  stats: SearchStats;
};

/** Shared node accounting for one decision. */
export type NodeCounter = {
  readonly used: number;
  readonly limit: number;
  /** Polls shouldStop, then takes one node; false when the budget or the clock is spent. */
  take(): boolean;
  readonly stoppedBy: SearchStats["stoppedBy"];
};
