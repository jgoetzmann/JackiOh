// Simulation through the real reducer (docs/polish/3-ai.md, SPEC §9.9). Every `reduce` call the AI
// makes goes through `simulate` and costs one node of the decision's counter, the opponent's
// auto-answers included, so budgets are counted in engine calls and a decision is deterministic.

import type { Action, ActionBody, PlayerId } from "@jackioh/shared";
import { PLAYER_IDS, opponentOf } from "@jackioh/shared";
import { activeUnitsOf, legalActions, reduce, type GameState } from "@jackioh/engine";
import { AI_EVAL, AI_SEARCH } from "./config";
import { evaluate } from "./evaluate";
import type { NodeCounter, SearchStats } from "./types";

export type LineStatus = "open" | "passed" | "yielded" | "over";

/** A NodeCounter that also tallies failed simulations for `SearchStats.simErrors`. */
export type CountingNodeCounter = NodeCounter & { simErrors: number };

export function createNodeCounter(limit: number, shouldStop?: () => boolean): CountingNodeCounter {
  let used = 0;
  let stoppedBy: SearchStats["stoppedBy"] = "exhausted";
  return {
    simErrors: 0,
    get used(): number {
      return used;
    },
    get limit(): number {
      return limit;
    },
    get stoppedBy(): SearchStats["stoppedBy"] {
      return stoppedBy;
    },
    take(): boolean {
      if (stoppedBy !== "exhausted") return false;
      if (shouldStop !== undefined && shouldStop()) {
        stoppedBy = "clock";
        return false;
      }
      if (used >= limit) {
        stoppedBy = "budget";
        return false;
      }
      used += 1;
      return true;
    },
  };
}

/**
 * A slice of `parent`: at most `limit` more nodes, drawn from the parent. Running out of the slice
 * does not stop the parent, so the lethal solver can hand what it left over to the beam.
 */
export function createSubCounter(parent: NodeCounter, limit: number): CountingNodeCounter {
  const start = parent.used;
  let capped = false;
  const errorsOf = parent as { simErrors?: unknown };
  return {
    get simErrors(): number {
      return typeof errorsOf.simErrors === "number" ? errorsOf.simErrors : 0;
    },
    set simErrors(value: number) {
      if (typeof errorsOf.simErrors === "number") errorsOf.simErrors = value;
    },
    get used(): number {
      return parent.used;
    },
    get limit(): number {
      return Math.min(parent.limit, start + Math.max(0, limit));
    },
    get stoppedBy(): SearchStats["stoppedBy"] {
      if (parent.stoppedBy !== "exhausted") return parent.stoppedBy;
      return capped ? "budget" : "exhausted";
    },
    take(): boolean {
      if (parent.used - start >= limit) {
        capped = true;
        return false;
      }
      return parent.take();
    },
  };
}

function noteSimError(counter: NodeCounter): void {
  const loose = counter as { simErrors?: unknown };
  if (typeof loose.simErrors === "number") loose.simErrors += 1;
}

/**
 * `seat`'s view of a state during a line that started on `rootTurn`: "over" if state.result is set;
 * "passed" if state.turn !== rootTurn; "yielded" if no prompt is open and state.active !== seat;
 * otherwise "open".
 */
export function lineStatus(state: GameState, seat: PlayerId, rootTurn: number): LineStatus {
  if (state.result !== null) return "over";
  if (state.turn !== rootTurn) return "passed";
  if (state.pending === null && state.active !== seat) return "yielded";
  return "open";
}

type SimStep = { ok: true; state: GameState } | { ok: false; error: string };

/**
 * One AI action on a determinized state: reduce (nonce `sim:${counter.used}`), then, while a prompt
 * of the other seat is open, answer it with the first entry of legalActions (each answer one more
 * node, at most AI_SEARCH.maxAutoAnswers). A throw or a refusal is `{ ok: false }`. Returns null
 * without touching anything when the counter refuses a node.
 */
export function simulate(state: GameState, seat: PlayerId, action: ActionBody, counter: NodeCounter): SimStep | null {
  if (!counter.take()) return null;
  try {
    const first = reduce(state, { ...action, playerId: seat, nonce: `sim:${counter.used}` } as Action);
    if (first.error !== undefined) {
      noteSimError(counter);
      return { ok: false, error: first.error };
    }
    let current = first.state;
    let answered = 0;
    while (current.result === null && current.pending !== null && current.pending.playerId !== seat) {
      if (answered >= AI_SEARCH.maxAutoAnswers) {
        noteSimError(counter);
        return { ok: false, error: "too many opponent prompts in one step" };
      }
      const other = current.pending.playerId;
      const reply = legalActions(current, other)[0];
      if (reply === undefined) {
        noteSimError(counter);
        return { ok: false, error: "the opponent's prompt has no answer" };
      }
      if (!counter.take()) return null;
      const next = reduce(current, { ...reply, playerId: other, nonce: `sim:${counter.used}` } as Action);
      if (next.error !== undefined) {
        noteSimError(counter);
        return { ok: false, error: next.error };
      }
      current = next.state;
      answered += 1;
    }
    return { ok: true, state: current };
  } catch (error) {
    noteSimError(counter);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A passed turn's value: the evaluation, less the crystals the seat left unspent. */
function passedScore(state: GameState, seat: PlayerId): number {
  const unspent = state.players[seat].turnLog.unspentAtEnd ?? 0;
  return evaluate(state, seat) - AI_EVAL.unspentMana * unspent;
}

/**
 * Where a line stops: a line still open in the seat's main phase ends its turn here (one node, when
 * one is left). Anything else stops where it stands.
 */
export function closeLine(state: GameState, seat: PlayerId, rootTurn: number, counter: NodeCounter): GameState {
  if (
    lineStatus(state, seat, rootTurn) === "open" &&
    state.pending === null &&
    state.active === seat &&
    state.phase === "main"
  ) {
    const step = simulate(state, seat, { type: "endTurn" }, counter);
    if (step !== null && step.ok) return step.state;
  }
  return state;
}

/** The static value of a line that stopped at `state`: a passed turn pays for its unspent mana. */
export function staticScore(state: GameState, seat: PlayerId, rootTurn: number): number {
  return lineStatus(state, seat, rootTurn) === "passed" ? passedScore(state, seat) : evaluate(state, seat);
}

/**
 * A line's value: "over"/"yielded" → evaluate; "passed" → evaluate − AI_EVAL.unspentMana ×
 * (players[seat].turnLog.unspentAtEnd ?? 0); "open" → simulate endTurn if the seat is in its main
 * phase and a node is left, then score that, else evaluate.
 */
export function terminalScore(state: GameState, seat: PlayerId, rootTurn: number, counter: NodeCounter): number {
  const status = lineStatus(state, seat, rootTurn);
  if (status === "open") {
    const closed = closeLine(state, seat, rootTurn, counter);
    return closed === state ? evaluate(state, seat) : staticScore(closed, seat, rootTurn);
  }
  return staticScore(state, seat, rootTurn);
}

/**
 * A cheap identity for a position inside one turn, for the lethal solver's visited set and the
 * beam's duplicate check: both heroes, every active unit's id, damage, buffs, exertion and position,
 * the seat's hand and mana, the enemy hand size and the open prompt.
 */
export function searchSignature(state: GameState, seat: PlayerId): string {
  const opp = opponentOf(seat);
  const parts: string[] = [
    `h${state.players[opp].hero.health}/${state.players[opp].hero.armor}`,
    `m${state.players[seat].hero.health}/${state.players[seat].hero.armor}`,
    `$${state.players[seat].mana.current}`,
    `n${state.players[opp].hand.length}`,
    `q${state.pending === null ? "-" : state.pending.id}`,
  ];
  for (const player of PLAYER_IDS) {
    for (const unit of activeUnitsOf(state, player)) {
      const exerted = `${unit.exertion.attacked ? 1 : 0}${unit.exertion.switched ? 1 : 0}`;
      parts.push(
        `${unit.id}:${unit.damage}:${unit.buffs.attack}/${unit.buffs.health}:${exerted}:${unit.position ?? "ATK"}`,
      );
    }
    const backrow = state.players[player].backrow.map((card) => (card === null ? "-" : card.id)).join(",");
    parts.push(`b${backrow}`);
  }
  parts.push(`H${state.players[seat].hand.map((card) => card.id).join(",")}`);
  return parts.join("|");
}
