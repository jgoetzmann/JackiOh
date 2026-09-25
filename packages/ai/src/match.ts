// Whole games and whole AI turns, for the gates, the sweep and the puzzles (docs/polish/3-ai.md).
//
// Both runners are deterministic: the game rng lives in the state (reduce is called without one, so
// it resumes from `(seed, rngCursor)` exactly as `fold` does), every controller draws from its own
// stream seeded from the match seed and its seat, and every nonce is derived from the log. So a
// config is a game, and `fold({ seed, decks, handicaps, log })` of a record reproduces its hash.

import type { Action, ActionBody, PlayerId } from "@jackioh/shared";
import {
  beginGame,
  createGame,
  createRng,
  hashState,
  legalActions,
  reduce,
  subsystems,
  zoneCards,
  type GameState,
  type Handicap,
  type Rng,
  seatToAct,
} from "@jackioh/engine";
import { greedyAction, randomAction } from "./baselines";
import { AI_BUDGET } from "./config";
import { decide } from "./decide";
import { aiToAct } from "./observe";
import type { AiOptions, Decision, SearchBudget } from "./types";

const AI_MATCH = { maxActions: 3000 } as const;

/** playAiTurn's ceiling on actions in one turn. */
const AI_TURN_MAX_ACTIONS = 60;

export type SeatController =
  | { kind: "ai"; budget?: SearchBudget }
  | { kind: "greedy" }
  | { kind: "random" };

export type MatchConfig = {
  seed: string;
  decks: [string[], string[]];
  handicaps?: Partial<Record<PlayerId, Handicap>>;
  controllers: Record<PlayerId, SeatController>;
  maxActions?: number;
};

export type MatchHooks = {
  /** Called with the true state before and after every accepted action. */
  afterAction?: (before: GameState, after: GameState, seat: PlayerId, action: ActionBody) => void;
  /** Wraps each controller call for timing (the sweep); default none. */
  timeDecision?: <T>(seat: PlayerId, run: () => T) => T;
};

export type MatchRecord = {
  /** null when maxActions was hit or a controller threw. */
  result: GameState["result"];
  log: Action[];
  /** hashState of the final state. */
  hash: string;
  turns: number;
  rejected: { seat: PlayerId; action: ActionBody; error: string }[];
  thrown: { seat: PlayerId; message: string }[];
  /** AI decisions with reason "fallback", plus controller nulls replaced by randomAction. */
  fallbacks: number;
  decisions: number;
  nodes: number;
  /** defIds each seat played, in order. */
  played: Record<PlayerId, string[]>;
};

export type AiTurnResult = { state: GameState; actions: Action[]; decisions: Decision[] };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What one controller call produced: the action, and the AI's decision when it was an AI. */
type ControllerChoice = { action: ActionBody | null; decision: Decision | null };

function chooseFor(controller: SeatController, state: GameState, seat: PlayerId, rng: Rng): ControllerChoice {
  if (controller.kind === "ai") {
    const decision = decide(state, seat, { rng, budget: controller.budget ?? AI_BUDGET });
    return { action: decision === null ? null : decision.action, decision };
  }
  if (controller.kind === "greedy") return { action: greedyAction(state, seat, rng), decision: null };
  return { action: randomAction(state, seat, rng), decision: null };
}

/**
 * What stands in for a refused action: endTurn when it is legal, else the first legal answer (or
 * mulligan), else any other legal action the random policy would take. Tried in this order.
 */
function replacementsFor(state: GameState, seat: PlayerId): ActionBody[] {
  const legal = legalActions(state, seat).filter((action) => !subsystems.AI_SKIPPED_ACTIONS.includes(action.type));
  const isAnswer = (action: ActionBody): boolean => action.type === "answer" || action.type === "mulligan";
  return [
    ...legal.filter((action) => action.type === "endTurn"),
    ...legal.filter(isAnswer),
    ...legal.filter((action) => action.type !== "endTurn" && !isAnswer(action)),
  ];
}

/** The defId of the hand card a `play` names, read before the play moves it. */
function playedDefId(state: GameState, seat: PlayerId, action: ActionBody): string | null {
  if (action.type !== "play") return null;
  const card = zoneCards(state, seat, "hand").find((instance) => instance.id === action.instanceId);
  return card === undefined ? null : card.defId;
}

/**
 * Deterministic: createGame+beginGame, then while no result: actor = seatToAct(state) (R265);
 * controller rng = createRng(`${seed}:ctl:${seat}`); nonce `m${log.length}`. A refused action is
 * recorded in `rejected` and replaced by endTurn (or the first legal answer); a throw is recorded
 * and ends the match.
 */
export function playMatch(config: MatchConfig, hooks: MatchHooks = {}): MatchRecord {
  const maxActions = config.maxActions ?? AI_MATCH.maxActions;
  const created = createGame({ seed: config.seed, decks: config.decks, handicaps: config.handicaps });
  let state = beginGame(created).state;

  const rngs: Record<PlayerId, Rng> = {
    p1: createRng(`${config.seed}:ctl:p1`),
    p2: createRng(`${config.seed}:ctl:p2`),
  };
  const time = hooks.timeDecision ?? (<T>(_seat: PlayerId, run: () => T): T => run());

  const log: Action[] = [];
  const rejected: MatchRecord["rejected"] = [];
  const thrown: MatchRecord["thrown"] = [];
  const played: Record<PlayerId, string[]> = { p1: [], p2: [] };
  let fallbacks = 0;
  let decisions = 0;
  let nodes = 0;

  while (state.result === null && log.length < maxActions) {
    const seat: PlayerId = seatToAct(state);
    const controller = config.controllers[seat];
    const rng = rngs[seat];
    const current = state;

    let choice: ControllerChoice;
    try {
      choice = time(seat, () => chooseFor(controller, current, seat, rng));
    } catch (error) {
      thrown.push({ seat, message: `controller ${controller.kind} threw: ${messageOf(error)}` });
      break;
    }

    if (choice.decision !== null) {
      decisions += 1;
      nodes += choice.decision.stats.nodes;
      if (choice.decision.reason === "fallback") fallbacks += 1;
    }

    let chosen = choice.action;
    if (chosen === null) {
      fallbacks += 1;
      chosen = randomAction(current, seat, rng);
      if (chosen === null) {
        thrown.push({ seat, message: `no action for ${seat} while the game is live (turn ${current.turn})` });
        break;
      }
    }

    const nonce = `m${log.length}`;
    let accepted: { body: ActionBody; action: Action; next: GameState } | null = null;
    try {
      const action = { ...chosen, playerId: seat, nonce } as Action;
      const result = reduce(current, action);
      if (result.error === undefined) {
        accepted = { body: chosen, action, next: result.state };
      } else {
        rejected.push({ seat, action: chosen, error: result.error });
        for (const replacement of replacementsFor(current, seat)) {
          const alternative = { ...replacement, playerId: seat, nonce } as Action;
          const retry = reduce(current, alternative);
          if (retry.error === undefined) {
            accepted = { body: replacement, action: alternative, next: retry.state };
            break;
          }
        }
      }
    } catch (error) {
      thrown.push({ seat, message: `reduce threw on "${chosen.type}": ${messageOf(error)}` });
      break;
    }

    if (accepted === null) {
      thrown.push({ seat, message: `no legal replacement for a refused "${chosen.type}" (turn ${current.turn})` });
      break;
    }

    const defId = playedDefId(current, seat, accepted.body);
    if (defId !== null) played[seat].push(defId);

    log.push(accepted.action);
    state = accepted.next;
    hooks.afterAction?.(current, state, seat, accepted.body);
  }

  return {
    result: state.result,
    log,
    hash: hashState(state),
    turns: state.turn,
    rejected,
    thrown,
    fallbacks,
    decisions,
    nodes,
    played,
  };
}

/** decide → reduce until !aiToAct(state, seat) or AI_TURN_MAX_ACTIONS; nonces `t${n}`. */
export function playAiTurn(state: GameState, seat: PlayerId, options: AiOptions): AiTurnResult {
  const actions: Action[] = [];
  const decisions: Decision[] = [];
  let current = state;

  for (let n = 0; n < AI_TURN_MAX_ACTIONS && aiToAct(current, seat); n += 1) {
    const decision = decide(current, seat, options);
    if (decision === null) break;
    decisions.push(decision);
    const action = { ...decision.action, playerId: seat, nonce: `t${n}` } as Action;
    const result = reduce(current, action);
    // A refusal would be offered again on the unchanged state, so the turn stops here instead.
    if (result.error !== undefined) break;
    actions.push(action);
    current = result.state;
  }

  return { state: current, actions, decisions };
}
