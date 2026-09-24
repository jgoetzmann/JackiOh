// The random-legal-action policy of SPEC §10.7 (BUILD M3-T7, R44): My Pawn's AI turn and every
// "Targets chosen randomly" pick use it. Uniform over `legalActions`, ending the turn when that is
// the only option left or with AI_END_TURN_PROBABILITY otherwise, and answering prompts uniformly.
//
// Every choice comes from the seeded rng (§10.7), so a state and a seed fix the whole action
// sequence: `playOutTurn` draws from the sink's rng, whose cursor `reduce` stores back in the
// state, which is what makes a My Pawn turn replay exactly (R44).

import type { Action, ActionBody, ActionType, PlayerId } from "@jackioh/shared";
import { AI_END_TURN_PROBABILITY } from "../config";
import { legalActions, reduce } from "../reduce";
import type { EngineSink } from "../resolve";
import type { Rng } from "../rng";
import type { GameState, WorkItem } from "../state";
import { markDispatched, settle } from "../triggers";
import { owe, registerWorkHandler } from "../work";

/**
 * A playout covers one turn, so this ceiling is far above any reachable turn; it exists only so a
 * card that keeps refilling the hand cannot spin forever (BUILD M3-T7).
 */
export const AI_PLAYOUT_STEP_CAP = 500;

/**
 * Actions the policy does not take. `legalActions` always offers `concede` to the active player
 * (reduce.ts), so §10.7's "ending the turn when it is the only option" only ever reads on a set
 * with these removed, and R44's AI plays the opponent's turn out rather than resigning it for them.
 * The M1-gate helper `playRandomGame` filters exactly the same three. R84 rules it.
 */
export const AI_SKIPPED_ACTIONS: readonly ActionType[] = ["concede", "offerDraw", "answerDraw"];

export type PolicyOptions = {
  /** Replaces AI_SKIPPED_ACTIONS; pass `[]` for a literal uniform draw over `legalActions`. */
  skip?: readonly ActionType[];
};

/** The set the policy draws from: `legalActions` minus the action types it never takes. */
export function policyActions(state: GameState, player: PlayerId, options: PolicyOptions = {}): ActionBody[] {
  const skip = options.skip ?? AI_SKIPPED_ACTIONS;
  return legalActions(state, player).filter((action) => !skip.includes(action.type));
}

/**
 * One step of the policy (§10.7): end the turn when nothing else is on offer, otherwise end it with
 * AI_END_TURN_PROBABILITY, otherwise pick uniformly. With a prompt open `legalActions` offers its
 * answers and the concede R211 adds, which the skipped set removes, so the same uniform draw is what
 * "prompts are answered uniformly" means (R44).
 * Returns null only when the player has no action at all.
 */
export function chooseAction(
  state: GameState,
  player: PlayerId,
  rng: Rng,
  options: PolicyOptions = {},
): ActionBody | null {
  const actions = policyActions(state, player, options);
  const endTurn = actions.find((action) => action.type === "endTurn");
  const others = actions.filter((action) => action.type !== "endTurn");

  // No draw is taken when there is no choice to make, so the rng cursor tracks decisions only.
  if (others.length === 0) return endTurn ?? null;
  if (endTurn !== undefined && rng.chance(AI_END_TURN_PROBABILITY)) return endTurn;
  return others[rng.int(others.length)] ?? null;
}

/** Why a playout stopped. Everything but `stepCap` and `rejected` is an ordinary finish. */
export type PlayoutStop = "turnEnded" | "promptElsewhere" | "gameOver" | "noAction" | "rejected" | "stepCap";

export type PlayoutResult = {
  /** The actions taken, in order, so a caller can log or animate them. */
  actions: Action[];
  stopped: PlayoutStop;
  /** Set only with `rejected`: `legalActions` offered an action the reducer refused. */
  error?: string;
};

/**
 * A nonce no earlier action used. The reducer dedupes by nonce (§9.3), so a playout's actions are
 * numbered from the state itself rather than from a counter outside it, keeping replay exact.
 */
function nonceFor(state: GameState, player: PlayerId, step: number): string {
  const base = `ai:${player}:t${state.turn}:s${step}`;
  let nonce = base;
  for (let n = 1; state.applied.some((entry) => entry.nonce === nonce); n += 1) nonce = `${base}#${n}`;
  return nonce;
}

/**
 * `reduce` is pure and hands back a fresh state, while a sink carries the caller's live one: copy
 * the result back field by field so the object the caller (and any enclosing `reduce`) holds stays
 * current. Every instance inside is a new object afterwards, so a caller re-reads what it needs
 * from `sink.state` instead of keeping references across a playout.
 *
 * Except `applied`, the history of the actions a player took (§9.3's nonce dedupe, §10.8's event
 * window). The playout's actions are the AI's inside the one action that handed it the turn, and
 * their events reach that action's own entry through the sink (R168), so adopting their entries too
 * put every event of the AI turn in the view twice, the first copy ahead of the declaration that
 * caused it (§10.10: each event is animated once, in the order it happened).
 */
function adoptState(sink: EngineSink, next: GameState): void {
  if (next === sink.state) return;
  const applied = sink.state.applied;
  const target = sink.state as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
  sink.state.applied = applied;
}

/**
 * Play this player's turn out with the policy (R44: "it plays out the turn while the opponent is
 * locked out"). Stops when the turn it started on is over — passed to the other player, or back to
 * this player as a later turn of their own (R152) — when the open prompt is somebody else's, when
 * the game is over, or at AI_PLAYOUT_STEP_CAP.
 */
export function playOutTurn(sink: EngineSink, player: PlayerId, options: PolicyOptions = {}): PlayoutResult {
  const actions: Action[] = [];
  // R44, R152: the AI plays out the rest of THIS turn. The turn it ends can come straight back to
  // the same player inside that one reduction — R82 auto-ends an opponent who has nothing to do — and
  // that later turn is the player's own, so the playout stops at the first turn it did not start on.
  const turn = sink.state.turn;

  for (let step = 0; step < AI_PLAYOUT_STEP_CAP; step += 1) {
    const state = sink.state;
    if (state.result !== null) return { actions, stopped: "gameOver" };
    if (state.turn !== turn) return { actions, stopped: "turnEnded" };
    if (state.pending !== null) {
      // Someone else's prompt blocks every action of ours (§9.3), so the playout waits — and a
      // turn handed to the AI is owed, so the answer brings it back (R113): the rest of that turn is
      // still the AI's (R44).
      if (state.pending.playerId !== player) {
        if (state.players[player].aiTurn) oweAiTurn(sink, player, turn);
        return { actions, stopped: "promptElsewhere" };
      }
    } else if (state.active !== player || state.phase !== "main") {
      return { actions, stopped: "turnEnded" };
    }

    const chosen = chooseAction(state, player, sink.rng, options);
    if (chosen === null) return { actions, stopped: "noAction" };

    const action = { ...chosen, playerId: player, nonce: nonceFor(state, player, step) } as Action;
    const result = reduce(state, action, sink.rng);
    if (result.error !== undefined) return { actions, stopped: "rejected", error: result.error };

    adoptState(sink, result.state);
    // §10.3: `reduce` has already run these through its own resolution loop, so they are reported
    // (R168's window) but never offered to the traps and the trigger queue a second time.
    sink.events.push(...result.events);
    markDispatched(result.events);
    actions.push(action);
  }

  return { actions, stopped: "stepCap" };
}

/**
 * R113: the `resume.hook` of an AI turn another player's prompt stopped. #96 My Pawn hands the rest
 * of the turn to the policy (R44), and one of the AI's actions can set off a question for the other
 * player — a trap that asks, a Death hook of theirs. The answer is that player's action, and the
 * turn it interrupted is still the AI's: R44's "it plays out the turn while the opponent is locked
 * out" and R152's lockout until the end of that turn. Stopping for good handed the locked-out player
 * a turn the AI was to finish, and left My Pawn to be consumed mid-turn rather than at its cleanup.
 * The item is parked at the moment the playout stops (R117), behind what the AI's own action owes.
 */
export const AI_TURN_WORK = "@aiTurn";

function oweAiTurn(sink: EngineSink, player: PlayerId, turn: number): void {
  owe(sink, { defId: "", hook: AI_TURN_WORK, step: "turn", radiant: false, data: { player, turn } });
}

/**
 * `work.ts`'s handler: the same AI turn, going on once the answer has finished what its action set
 * off. The answer's own events are dispatched and the triggers they wake resolve first (§10.3: the
 * interrupting response resolves to completion before the action it interrupted continues). What is
 * owed after this item is the enclosing sequences' — My Pawn's own firing, the window, the combat it
 * cancelled — and not the playout's to run, so the playout's `reduce`s, which settle, never see it
 * (R117): it waits aside and comes back behind whatever the playout leaves owed.
 */
function runOwedAiTurn(sink: EngineSink, item: WorkItem): void {
  const named: unknown = item.resume.data.player;
  const player = named === "p1" || named === "p2" ? named : null;
  const turn: unknown = item.resume.data.turn;
  const state = sink.state;
  if (player === null || state.result !== null || state.turn !== turn) return;
  if (!state.players[player].aiTurn) return;

  const after = state.work;
  state.work = [];
  state.workCursor = 0;
  try {
    settle(sink);
    if (sink.state.result !== null) return;
    // Another question for the other player waits for its own answer; one for the AI's player is
    // the AI's to answer, which the playout does (R44).
    if (sink.state.pending !== null && sink.state.pending.playerId !== player) {
      oweAiTurn(sink, player, turn);
      return;
    }
    playOutTurn(sink, player);
  } finally {
    sink.state.work = [...sink.state.work, ...after];
  }
}

registerWorkHandler(AI_TURN_WORK, runOwedAiTurn);
