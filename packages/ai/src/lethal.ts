// The exact lethal solver (SPEC §9.9): attack orderings, removing Taunt first, buffs before attacks,
// a spell to the face, and prompts answered on the way. A depth-first walk with an explicit stack —
// nothing in this package recurses — whose move order (`candidateActions`) puts face attacks and
// winning trades first, so the usual lethal is the first path it tries.

import type { ActionBody, PlayerId } from "@jackioh/shared";
import { legalActions, type GameState } from "@jackioh/engine";
import { actionKey, candidateActions } from "./candidates";
import { AI_SEARCH } from "./config";
import { createSubCounter, lineStatus, searchSignature, simulate } from "./simulate";
import type { NodeCounter } from "./types";

type Frame = { state: GameState; line: ActionBody[]; action: ActionBody };

/** The actions the solver tries from a position: no position switches, and never ending the turn. */
function lethalMoves(state: GameState, seat: PlayerId): ActionBody[] {
  return candidateActions(state, seat).filter(
    (action) => action.type !== "switchPosition" && action.type !== "endTurn",
  );
}

function pushMoves(stack: Frame[], state: GameState, line: ActionBody[], seat: PlayerId): void {
  const moves = lethalMoves(state, seat);
  // Reversed, so the first move in move order is the first one popped.
  for (let i = moves.length - 1; i >= 0; i -= 1) {
    const action = moves[i];
    if (action !== undefined) stack.push({ state, line, action });
  }
}

/**
 * Replays a lethal line on every determinization but the first: each action must be legal there
 * (actionKey equality with legalActions) and the line must end with `seat` the winner. null when the
 * counter ran out.
 */
function holdsEverywhere(
  dets: readonly GameState[],
  seat: PlayerId,
  line: readonly ActionBody[],
  counter: NodeCounter,
): boolean | null {
  for (let i = 1; i < dets.length; i += 1) {
    let state = dets[i];
    if (state === undefined) return false;
    for (const action of line) {
      if (state.result !== null) break;
      const key = actionKey(action);
      if (!legalActions(state, seat).some((legal) => actionKey(legal) === key)) return false;
      const step = simulate(state, seat, action, counter);
      if (step === null) return null;
      if (!step.ok) return false;
      state = step.state;
    }
    if (state.result === null || state.result.winner !== seat) return false;
  }
  return true;
}

/**
 * Depth-first over dets[0] with an explicit stack (no recursion): candidateActions minus
 * switchPosition and endTurn, depth ≤ AI_SEARCH.lethalMaxDepth, visited-set keyed on a cheap
 * signature (enemy hero health + each unit's id/damage/exertion/position + hand ids + mana).
 * A line is lethal when simulate leaves state.result.winner === seat. It is returned only if
 * replaying it (actionKey equality with legalActions at each step) also wins on every other
 * determinization; otherwise the search continues. Spends at most `limit` nodes of `counter`.
 */
export function findLethal(
  dets: readonly GameState[],
  seat: PlayerId,
  counter: NodeCounter,
  limit: number,
): ActionBody[] | null {
  const root = dets[0];
  if (root === undefined || limit <= 0) return null;
  if (lineStatus(root, seat, root.turn) !== "open") return null;

  const slice = createSubCounter(counter, limit);
  const rootTurn = root.turn;
  const visited = new Set<string>([searchSignature(root, seat)]);
  const stack: Frame[] = [];
  pushMoves(stack, root, [], seat);

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;

    const step = simulate(frame.state, seat, frame.action, slice);
    if (step === null) return null;
    if (!step.ok) continue;

    const line = [...frame.line, frame.action];
    const next = step.state;

    if (next.result !== null) {
      if (next.result.winner !== seat) continue;
      const verdict = holdsEverywhere(dets, seat, line, slice);
      if (verdict === null) return null;
      if (verdict) return line;
      continue;
    }

    if (line.length >= AI_SEARCH.lethalMaxDepth) continue;
    if (lineStatus(next, seat, rootTurn) !== "open") continue;

    const signature = searchSignature(next, seat);
    if (visited.has(signature)) continue;
    visited.add(signature);
    pushMoves(stack, next, line, seat);
  }

  return null;
}
