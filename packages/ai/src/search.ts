// Turn-level beam search (SPEC §9.9): sequences of `legalActions` played through `reduce` on one
// determinization, the best `beamWidth` open lines kept per depth, every line closed at the end of
// the seat's turn (or where it yields or the game ends) and scored there. `decide` scores the best
// of them again after the opponent's reply (reply.ts), and re-scores its finalists on the other
// determinizations with `scoreLine`.

import type { ActionBody, PlayerId } from "@jackioh/shared";
import type { GameState } from "@jackioh/engine";
import { actionKey, candidateActions } from "./candidates";
import { evaluate } from "./evaluate";
import { hiddenCardIds, replyScore } from "./reply";
import { closeLine, lineStatus, searchSignature, simulate, staticScore, type LineStatus } from "./simulate";
import type { NodeCounter, SearchBudget } from "./types";

/**
 * A complete line. `end` is the state it was scored at (after its closing endTurn), which `decide`
 * scores again after the opponent's reply without replaying the line.
 */
export type Line = { actions: ActionBody[]; score: number; status: LineStatus; end: GameState };

type OpenLine = { state: GameState; actions: ActionBody[]; score: number };

/** Best first; equal scores keep their order (Array.prototype.sort is stable). */
function bestFirst<T extends { score: number }>(lines: readonly T[]): T[] {
  return [...lines].sort((a, b) => b.score - a.score);
}

/** The first `width` candidates that are not endTurn, plus endTurn when it is legal. */
function expansion(state: GameState, seat: PlayerId, width: number): ActionBody[] {
  const candidates = candidateActions(state, seat);
  const moves = candidates.filter((action) => action.type !== "endTurn").slice(0, Math.max(0, width));
  const end = candidates.find((action) => action.type === "endTurn");
  return end === undefined ? moves : [...moves, end];
}

/**
 * Beam search on one determinization. The frontier starts at `det`. Each open line expands its first
 * rootBranching (depth 0) or branching (deeper) candidates, plus endTurn. Every child is simulated
 * and scored with `evaluate`; children whose status is not "open" become complete lines scored by
 * terminalScore; the best beamWidth open children (stable) form the next frontier. The loop stops at
 * maxDepth (open lines are closed by terminalScore) or when the counter refuses. Returns complete
 * lines, best first.
 */
export function beamSearch(det: GameState, seat: PlayerId, counter: NodeCounter, budget: SearchBudget): Line[] {
  const rootTurn = det.turn;
  const complete: Line[] = [];
  let frontier: OpenLine[] = [{ state: det, actions: [], score: evaluate(det, seat) }];
  let leftOpen: OpenLine[] = [];
  let stopped = false;

  for (let depth = 0; depth < budget.maxDepth && frontier.length > 0; depth += 1) {
    const children: OpenLine[] = [];
    const seen = new Set<string>();
    const width = depth === 0 ? budget.rootBranching : budget.branching;

    for (const line of frontier) {
      if (stopped) break;
      for (const action of expansion(line.state, seat, width)) {
        const step = simulate(line.state, seat, action, counter);
        if (step === null) {
          stopped = true;
          break;
        }
        if (!step.ok) continue;

        const actions = [...line.actions, action];
        const status = lineStatus(step.state, seat, rootTurn);
        if (status !== "open") {
          complete.push({ actions, score: staticScore(step.state, seat, rootTurn), status, end: step.state });
          continue;
        }
        // Two orders of the same moves reach the same position: keep the first, which ranks higher.
        const signature = searchSignature(step.state, seat);
        if (seen.has(signature)) continue;
        seen.add(signature);
        children.push({ state: step.state, actions, score: evaluate(step.state, seat) });
      }
    }

    if (stopped) {
      leftOpen = [...frontier, ...children];
      frontier = [];
      break;
    }
    frontier = bestFirst(children).slice(0, Math.max(1, budget.beamWidth));
  }

  if (!stopped) leftOpen = frontier;

  // Open lines at maxDepth, or where the counter refused, are closed where they stand.
  for (const line of leftOpen) {
    if (line.actions.length === 0) continue;
    const end = closeLine(line.state, seat, rootTurn, counter);
    const score = end === line.state ? evaluate(end, seat) : staticScore(end, seat, rootTurn);
    complete.push({ actions: line.actions, score, status: lineStatus(end, seat, rootTurn), end });
  }

  return bestFirst(complete);
}

/**
 * Replay `actions` on another determinization. At the first action whose actionKey is not in that
 * state's candidateActions the line is truncated. What is left ends its turn and is scored: after
 * the opponent's reply when `reply` is set (`replyScore`, with `hidden` as there, by default the
 * opponent's unseen cards in `det`), statically otherwise. null if the counter ran out.
 */
export function scoreLine(
  det: GameState,
  seat: PlayerId,
  actions: readonly ActionBody[],
  counter: NodeCounter,
  reply = false,
  hidden?: ReadonlySet<string>,
): number | null {
  const rootTurn = det.turn;
  let state = det;

  for (const action of actions) {
    if (lineStatus(state, seat, rootTurn) !== "open") break;
    const key = actionKey(action);
    if (!candidateActions(state, seat).some((candidate) => actionKey(candidate) === key)) break;
    const step = simulate(state, seat, action, counter);
    if (step === null) return null;
    if (!step.ok) break;
    state = step.state;
  }

  // A line still open at the seat's main phase ends its turn here, so every finalist is scored at
  // the same point; running out of nodes for that step is running out of nodes.
  if (
    lineStatus(state, seat, rootTurn) === "open" &&
    state.pending === null &&
    state.active === seat &&
    state.phase === "main"
  ) {
    const step = simulate(state, seat, { type: "endTurn" }, counter);
    if (step === null) return null;
    if (!step.ok) return evaluate(state, seat);
    state = step.state;
  }

  return reply ? replyScore(state, seat, rootTurn, counter, hidden ?? hiddenCardIds(det, seat)) : staticScore(state, seat, rootTurn);
}
