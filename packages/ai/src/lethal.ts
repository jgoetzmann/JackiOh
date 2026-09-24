// The lethal solver (SPEC §9.9): a bounded search for a line that wins this turn on every
// determinization, through attack orderings, removing Taunt first, buffs before attacks, a spell to
// the face, and prompts answered on the way. Nothing in this package recurses, so both of its walks
// keep their own explicit frontier.
//
// It runs in two stages on one node allowance:
//   1. A depth-first walk in move order (`candidateActions` puts face attacks and winning trades
//      first) for AI_SEARCH.lethalQuickNodes nodes. The usual lethal, a few swings at the face, is
//      the first path it tries. When the walk runs out of moves before it runs out of nodes, the
//      whole tree has been searched and there is no lethal to find.
//   2. Otherwise a best-first walk with what is left: it expands the position closest to lethal
//      (`readyGap`: the enemy hero's health less what the attacks still to come would deal past its
//      Taunts), trying its first AI_SEARCH.lethalWidth moves at once. A depth-first walk spends
//      everything below its first move, so a lethal that starts with a card late in move order (a
//      spell that kills one's own unit for its Death, a tribute of the enemy's Taunts) is out of its
//      reach on a wide board. The best-first walk tries each of the first lethalWidth moves and
//      ranks what they leave by `readyGap`, so such a card is found when it is among those moves. A
//      move past the first lethalWidth of its position is never tried by either walk.
// A line counts only when it wins on every determinization.

import type { ActionBody, PlayerId } from "@jackioh/shared";
import { opponentOf } from "@jackioh/shared";
import {
  activeUnitsOf,
  canAttack,
  hasExertion,
  legalActions,
  subsystems,
  unitView,
  type CardInstance,
  type GameState,
} from "@jackioh/engine";
import { actionKey, candidateActions } from "./candidates";
import { AI_SEARCH } from "./config";
import { damagePastTaunts } from "./evaluate";
import { createSubCounter, lineStatus, searchSignature, simulate } from "./simulate";
import type { NodeCounter } from "./types";

type Frame = { state: GameState; line: ActionBody[]; action: ActionBody };

/** A position the best-first walk may expand: the line that reached it and how far it is from lethal. */
type Open = { state: GameState; line: ActionBody[]; gap: number; order: number };

/** What a walk ended with: a lethal line, a tree searched to the end, or a walk the counter cut short. */
type Walk = { line: ActionBody[] } | "exhausted" | "cut";

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
 * Whether `legalActions` would list an attack for `unit`, which `seat` controls, in a position
 * where `seat` may act in its main phase: some target passes the engine's own test
 * (`combat.canAttack`, the filter `attackTargets` applies). Asked unit by unit, with a unit whose
 * attack is spent ruled out first, because enumerating every legal action (every play, target and
 * mode of a wide hand) cost the best-first walk more than simulating its moves did.
 */
function hasAttack(state: GameState, unit: CardInstance): boolean {
  if (!hasExertion(unit, "attack")) return false;
  const enemy = opponentOf(unit.controller);
  if (canAttack(state, unit, { kind: "hero", player: enemy })) return true;
  return activeUnitsOf(state, enemy).some((instance) => canAttack(state, unit, { kind: "unit", instance }));
}

/**
 * How far the seat stands from lethal this turn: the enemy hero's health less what the units that
 * may still attack (those `legalActions` lists an attack for) would deal it past the enemy's Taunts,
 * counted as `faceThreat` counts it. Zero or less means the attacks left could end the game. It
 * only orders the search; a lethal is always proved by playing it through `reduce`.
 */
export function readyGap(state: GameState, seat: PlayerId): number {
  if (state.result !== null) {
    return state.result.winner === seat ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  const opp = opponentOf(seat);
  const health = state.players[opp].hero.health;
  // legalActions lists no attack while a prompt is open or outside the seat's own main phase.
  if (state.pending !== null || state.active !== seat || state.phase !== "main") return health;
  // As legalActions does first: a fused card's scripts must be this state's own before its layers are read.
  subsystems.syncFusedScripts(state);
  const attacks: number[] = [];
  for (const unit of activeUnitsOf(state, seat)) {
    const attack = unitView(state, unit).attack;
    if (attack > 0 && hasAttack(state, unit)) attacks.push(attack);
  }
  return health - damagePastTaunts(state, opp, attacks);
}

/**
 * What a new position means for the walk: a proved lethal, a position to search on from, or neither.
 * null when the counter ran out while proving a win on the other determinizations.
 */
function judge(
  dets: readonly GameState[],
  seat: PlayerId,
  line: readonly ActionBody[],
  next: GameState,
  rootTurn: number,
  visited: Set<string>,
  counter: NodeCounter,
): "lethal" | "deeper" | "dead" | null {
  if (next.result !== null) {
    if (next.result.winner !== seat) return "dead";
    const verdict = holdsEverywhere(dets, seat, line, counter);
    if (verdict === null) return null;
    return verdict ? "lethal" : "dead";
  }
  if (line.length >= AI_SEARCH.lethalMaxDepth) return "dead";
  if (lineStatus(next, seat, rootTurn) !== "open") return "dead";
  const signature = searchSignature(next, seat);
  if (visited.has(signature)) return "dead";
  visited.add(signature);
  return "deeper";
}

/** Stage 1: depth-first in move order, with a visited set on `searchSignature`. */
function depthFirst(dets: readonly GameState[], seat: PlayerId, counter: NodeCounter): Walk {
  const root = dets[0] as GameState;
  const visited = new Set<string>([searchSignature(root, seat)]);
  const stack: Frame[] = [];
  pushMoves(stack, root, [], seat);

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const step = simulate(frame.state, seat, frame.action, counter);
    if (step === null) return "cut";
    if (!step.ok) continue;
    const line = [...frame.line, frame.action];
    const verdict = judge(dets, seat, line, step.state, root.turn, visited, counter);
    if (verdict === null) return "cut";
    if (verdict === "lethal") return { line };
    if (verdict === "deeper") pushMoves(stack, step.state, line, seat);
  }
  return "exhausted";
}

/** Index of the open position to expand next: the smallest gap, then the longest line, then the oldest. */
function nextOpen(open: readonly Open[]): number {
  let best = 0;
  for (let i = 1; i < open.length; i += 1) {
    const a = open[i] as Open;
    const b = open[best] as Open;
    const closer = a.gap < b.gap;
    const deeper = a.gap === b.gap && a.line.length > b.line.length;
    const older = a.gap === b.gap && a.line.length === b.line.length && a.order < b.order;
    if (closer || deeper || older) best = i;
  }
  return best;
}

/** Stage 2: best-first by `readyGap`, each expansion simulating its first AI_SEARCH.lethalWidth moves. */
function bestFirst(dets: readonly GameState[], seat: PlayerId, counter: NodeCounter): Walk {
  const root = dets[0] as GameState;
  const visited = new Set<string>([searchSignature(root, seat)]);
  const open: Open[] = [{ state: root, line: [], gap: readyGap(root, seat), order: 0 }];
  let order = 1;

  while (open.length > 0) {
    const node = open.splice(nextOpen(open), 1)[0] as Open;
    for (const action of lethalMoves(node.state, seat).slice(0, AI_SEARCH.lethalWidth)) {
      const step = simulate(node.state, seat, action, counter);
      if (step === null) return "cut";
      if (!step.ok) continue;
      const line = [...node.line, action];
      const verdict = judge(dets, seat, line, step.state, root.turn, visited, counter);
      if (verdict === null) return "cut";
      if (verdict === "lethal") return { line };
      if (verdict === "deeper") {
        open.push({ state: step.state, line, gap: readyGap(step.state, seat), order });
        order += 1;
      }
    }
  }
  return "exhausted";
}

/**
 * The lethal solver on dets[0]: candidateActions minus switchPosition and endTurn, lines at most
 * AI_SEARCH.lethalMaxDepth long, a visited set keyed on `searchSignature`. A depth-first walk in move
 * order gets AI_SEARCH.lethalQuickNodes; if it neither found a lethal nor searched the whole tree, a
 * best-first walk by `readyGap` gets the rest (the header says why). A line is lethal when simulate
 * leaves state.result.winner === seat, and it is returned only if replaying it (actionKey equality
 * with legalActions at each step) also wins on every other determinization; otherwise the search
 * continues. Spends at most `limit` nodes of `counter`.
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

  const start = counter.used;
  const quick = createSubCounter(counter, Math.min(limit, AI_SEARCH.lethalQuickNodes));
  const first = depthFirst(dets, seat, quick);
  if (first !== "exhausted" && first !== "cut") return first.line;
  if (first === "exhausted" || counter.stoppedBy !== "exhausted") return null;

  const left = limit - (counter.used - start);
  if (left <= 0) return null;
  const second = bestFirst(dets, seat, createSubCounter(counter, left));
  return second !== "exhausted" && second !== "cut" ? second.line : null;
}
