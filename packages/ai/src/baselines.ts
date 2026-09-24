// The two baselines the quality gates measure the AI against (docs/polish/3-ai.md, after the
// Hearthstone-AI Competition's random and greedy agents): SPEC §10.7's random policy, and a one-ply
// greedy player that sees exactly what the AI sees (R185) and looks one action ahead.

import type { ActionBody, PlayerId } from "@jackioh/shared";
import { subsystems, type GameState, type Rng } from "@jackioh/engine";
import { candidateActions } from "./candidates";
import { AI_SEARCH, GREEDY_EVAL, GREEDY_MULLIGAN } from "./config";
import { determinize } from "./determinize";
import { evaluate } from "./evaluate";
import { mulliganKeep } from "./mulligan";
import { aiToAct, redact, unansweredDrawOffer } from "./observe";
import { createNodeCounter, simulate } from "./simulate";

/** §10.7's random policy for `seat` (subsystems.chooseAction with AI_SKIPPED_ACTIONS). */
export function randomAction(state: GameState, seat: PlayerId, rng: Rng): ActionBody | null {
  return subsystems.chooseAction(state, seat, rng, { skip: subsystems.AI_SKIPPED_ACTIONS });
}

/**
 * One-ply greedy on one determinization of redact(state, seat): mulligan → mulliganKeep; draw offer
 * → decline; else the candidate (not endTurn) with the highest `evaluate` (with its own frozen
 * GREEDY_EVAL weights) after `simulate`, or endTurn when none beats standing still (prompts: the
 * best answer). null if !aiToAct.
 */
export function greedyAction(state: GameState, seat: PlayerId, rng: Rng): ActionBody | null {
  if (!aiToAct(state, seat)) return null;

  const pub = redact(state, seat);
  if (unansweredDrawOffer(pub, seat)) return { type: "answerDraw", accept: false };
  if (pub.pending !== null && pub.pending.playerId === seat && pub.pending.kind === "mulligan") {
    return { type: "mulligan", keep: mulliganKeep(pub, seat, GREEDY_MULLIGAN.keepMaxCost) };
  }

  // The only draws greedy takes from its rng: one determinization per decision.
  const det = determinize(pub, seat, rng);
  const candidates = candidateActions(det, seat);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;

  const answering = det.pending !== null && det.pending.playerId === seat;
  // Every candidate gets its one simulation, auto-answers of the other seat's prompts included.
  const counter = createNodeCounter(candidates.length * (1 + AI_SEARCH.maxAutoAnswers));

  let best: ActionBody | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const action of candidates) {
    if (action.type === "endTurn") continue;
    const step = simulate(det, seat, action, counter);
    if (step === null || !step.ok) continue;
    const score = evaluate(step.state, seat, "enemy", GREEDY_EVAL);
    // Strictly greater, so a tie keeps the earlier candidate in move order.
    if (score > bestScore) {
      best = action;
      bestScore = score;
    }
  }

  if (answering) return best ?? candidates[0] ?? null;

  const endTurn = candidates.find((action) => action.type === "endTurn");
  if (endTurn === undefined) return best ?? candidates[0] ?? null;
  if (best !== null && bestScore > evaluate(det, seat, "enemy", GREEDY_EVAL)) return best;
  return endTurn;
}
