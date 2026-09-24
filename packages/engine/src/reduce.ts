// reduce(state, action, rng) and legalActions (SPEC §9.3, §10.2, §10.5). The reducer is pure: it
// clones the state, applies the action, and returns the new state with the events it produced.
// Illegal actions come back as an error with the state untouched.
//
// This file is the action layer and nothing else. Every rule it needs belongs to a module that owns
// it, and the two directions of each rule — what `legalActions` offers and what an action is
// refused for — come from the same place, so a client's greyed-out button and the reducer's error
// can never disagree (§9.3):
//
//   play             → `playSteps.runPlaySteps` (§10.5's eight steps), listed by
//                      `playChoices.playActionsFor` (R81, R90). Step 1's validation is
//                      `playSteps.validatePlay`, which asks `playChoices.whyChoicesRefused` for
//                      the zone, X, embiggen, Tribute, target and mode refusals (R90) before it
//                      reads the cost, so the refusal a client's greyed-out button comes from and
//                      the refusal this reducer returns are the same call. Nothing of that rule is
//                      restated here; a second copy is what would let the two disagree.
//   attack           → `combat.declareAttack`, listed by `combat.attackTargets` (§4.2). That call
//                      is §4.2 steps 1 to 5 whole, step 4's trap window included, so an `attack`
//                      can come back with a prompt open and the combat still owed on `state.work`
//                      (R113): the answer action finishes it, exactly as it finishes a Cry.
//   switchPosition   → `combat.switchPosition` (§4.1, R20, R49)
//   activatePower    → `subsystems/heroPower.activatePower`, listed by `whyCannotActivate` (R43)
//   answer           → `prompts.answerPrompt`, or the play pipeline for a prompt it opened itself
//   mulligan, draws, concede, endTurn, the turn cap → `setup.ts` and `turn.ts` (§2.1, §2.2, §2.5)
//
// After the action the resolution loop of §10.3 runs (`triggers.settle`): it dispatches the events
// the action emitted, drains whatever a prompt left owed in `state.work`, runs the state check and
// pops the trigger queue until nothing is left or a prompt stops it.

import type { Action, ActionBody, GameEvent, PlayerId } from "@jackioh/shared";
import { NON_ACTIVE_ACTION_TYPES, PROMPT_OPEN_ACTION_TYPES, opponentOf } from "@jackioh/shared";
import { attackTargets, declareAttack, hasExertion, switchPosition, type AttackTarget } from "./combat";
import { NONCE_HISTORY, TIMEOUT_ANSWER_CAP, TURN_CAP_PLAYER_TURNS } from "./config";
import { endGame } from "./gameOver";
import { answerPlayPrompt, isPlayResume, runPlaySteps } from "./playSteps";
import { playActionsFor } from "./playChoices";
import { answerPrompt, promptAnswers } from "./prompts";
import { createRng, type Rng } from "./rng";
import type { EngineSink } from "./resolve";
import { answerMulligan, beginSetup } from "./setup";
import { flagsOf } from "./scripts";
import { cloneState, findInstance, type CardInstance, type GameState } from "./state";
import { playOutTurn } from "./subsystems/aiPolicy";
import { syncFusedScripts } from "./subsystems/fuse";
import { activatePower, whyCannotActivate } from "./subsystems/heroPower";
import { settle } from "./triggers";
import { answerDraw, canOfferDraw, concede, endTurn, hasStandingDrawOffer, offerDraw } from "./turn";
import { activeUnitsOf } from "./zones";

export type ReduceResult = { state: GameState; events: GameEvent[]; error?: string };

const MAX_MULLIGAN_SUBSETS = 256;

/** §4.2: a target names an enemy unit by instance id, or an enemy hero as `hero-<player>`. */
export function attackTargetId(target: AttackTarget): string {
  return target.kind === "unit" ? target.instance.id : `hero-${target.player}`;
}

/**
 * The attacker an `attack` action names: any card in this player's unit piles, a dormant one
 * included, so that §3.2's "not on the field" is `combat`'s refusal to give rather than a lookup
 * failure here (R13).
 */
function attackerOf(state: GameState, player: PlayerId, instanceId: string): CardInstance | undefined {
  return state.players[player]
    .units.flatMap((pile) => pile ?? [])
    .find((card) => card.id === instanceId);
}

/**
 * The target an `attack` action names, looked up among the enemy's active units and the enemy hero
 * and nothing else, so a friendly target never reaches the validator (§4.2 step 2).
 */
function attackTargetOf(state: GameState, player: PlayerId, targetId: string): AttackTarget | null {
  const enemy = opponentOf(player);
  if (targetId === `hero-${enemy}`) return { kind: "hero", player: enemy };
  const unit = activeUnitsOf(state, enemy).find((card) => card.id === targetId);
  return unit === undefined ? null : { kind: "unit", instance: unit };
}

function attack(sink: EngineSink, player: PlayerId, action: Extract<ActionBody, { type: "attack" }>): string | null {
  const attacker = attackerOf(sink.state, player, action.attackerId);
  if (attacker === undefined) return `no unit ${action.attackerId} you control`;

  const target = attackTargetOf(sink.state, player, action.targetId);
  if (target === null) return `no target ${action.targetId}`;

  return declareAttack(sink, attacker, target).error ?? null;
}

/** §4.1: the player's own switch, which spends the unit's exertion (R20 is the effect's version). */
function switchAction(sink: EngineSink, player: PlayerId, instanceId: string): string | null {
  const unit = attackerOf(sink.state, player, instanceId);
  if (unit === undefined) return `no unit ${instanceId} you control`;
  return switchPosition(sink, unit).error ?? null;
}

/** §4.1 and R49: whether this unit's own switch is on offer at all. */
function canSwitch(unit: CardInstance): boolean {
  if (!hasExertion(unit, "switch")) return false;
  // §4.1: Spikey Pillow can never be in Defense Position, so a unit in Attack has nowhere to go.
  return (unit.position ?? "ATK") === "DEF" || flagsOf(unit).neverDefense !== true;
}

function applyAction(sink: EngineSink, action: Action): string | null {
  const state = sink.state;

  switch (action.type) {
    case "mulligan": {
      if (state.pending === null || state.pending.kind !== "mulligan") return "no mulligan is open";
      if (state.pending.playerId !== action.playerId) return "that mulligan is not yours";
      const hand = new Set(state.players[action.playerId].hand.map((c) => c.id));
      for (const id of action.keep) if (!hand.has(id)) return `${id} is not in your hand`;
      answerMulligan(sink, action.playerId, action.keep);
      return null;
    }
    case "play":
      return runPlaySteps(sink, action.playerId, action);
    case "switchPosition":
      return switchAction(sink, action.playerId, action.instanceId);
    case "attack":
      return attack(sink, action.playerId, action);
    case "activatePower":
      // R43: the power lives on the instance and `heroPower.ts` owns every part of using it —
      // the cost is the power's X, and using it is that turn's use.
      return activatePower(sink, action.playerId, action);
    case "answer": {
      // §10.6: a card's continuation is re-entered through its script; a prompt an engine sequence
      // opened for itself (an Echo repeat's fresh pick, §10.5 step 6) is answered by that sequence.
      const pending = state.pending;
      if (pending !== null && isPlayResume(pending.resume)) return answerPlayPrompt(sink, action);
      return answerPrompt(sink, action);
    }
    case "offerDraw": {
      if (!canOfferDraw(state, action.playerId)) return "you cannot offer a draw right now";
      offerDraw(sink, action.playerId);
      return null;
    }
    case "answerDraw": {
      if (!hasStandingDrawOffer(state, action.playerId)) return "there is no draw offer to answer";
      answerDraw(sink, action.playerId, action.accept);
      return null;
    }
    case "concede":
      concede(sink, action.playerId);
      return null;
    case "endTurn":
      endTurn(sink);
      return null;
    case "timeout":
      return timeout(sink, action);
    case "disconnectExpired": {
      endGame(sink, opponentOf(action.player), "disconnect");
      return null;
    }
    case "ceilingReached": {
      // R79: past the hard wall-clock ceiling the match is a draw.
      endGame(sink, "draw", "match-ceiling");
      return null;
    }
    default:
      return "unknown action";
  }
}

/**
 * R79 and §2.5: `timeout` "answers only the prompts of the player whose clock ran out, using the AI
 * policy, and ends the turn only when that is the active player". The AI policy answers, so a
 * timeout is as deterministic as any action.
 *
 * - The non-active player's clock is a prompt clock: on expiry it answers that one prompt of theirs,
 *   and with none of theirs open it does nothing — it never touches the active player's prompt or
 *   turn.
 * - The active player's clock is the turn clock: every prompt of theirs that is open, or that an
 *   answer opens in turn (a chain like KY's Private Tutor's), is answered, and then the turn ends.
 *   A prompt the other player holds stops it there, since that one has a clock of its own, and it
 *   stops once the turn has passed, so nothing on the next turn is answered for anybody.
 */
function timeout(sink: EngineSink, action: Extract<Action, { type: "timeout" }>): string | null {
  const who = action.playerId;
  const turn = sink.state.turn;
  const turnClock = who === sink.state.active;

  for (let step = 0; step < TIMEOUT_ANSWER_CAP; step += 1) {
    const state = sink.state;
    if (state.result !== null || state.turn !== turn) return null;

    const pending = state.pending;
    if (pending !== null) {
      if (pending.playerId !== who) return null;
      // R79: the AI policy answers, and it never concedes (R84), so the draw is over the prompt's
      // own answers — the concede R211 also offers is not one of them.
      const answers = legalActions(state, who).filter((body) => body.type !== "concede");
      const pick = answers[sink.rng.int(answers.length)];
      if (pick === undefined) return null;
      const error = applyAction(sink, { ...pick, playerId: who, nonce: action.nonce } as Action);
      if (error !== null) return error;
      if (!turnClock) return null;
      // The answer's own resolution loop, so a prompt it leads to is open before the next look.
      settle(sink);
      continue;
    }

    if (!turnClock || state.active !== who || state.phase !== "main") return null;
    endTurn(sink);
    settle(sink);
  }
  return null;
}

/**
 * R44, §8 #96: "an AI plays the rest of their turn with random legal actions", and while it does,
 * that player is locked out — their client does not act while `aiTurn` is set (R152). A question of
 * theirs can still open outside the AI's own playout: a Death hook of their unit that the other
 * player's trap destroys inside the other player's answer, or the Cry of a card the AI played once
 * the other player has answered the trap that asked about it. That question is the AI's to answer,
 * as every prompt of that turn is (§10.7), and the answer goes on to finish the turn the AI owes
 * (`aiPolicy.AI_TURN_WORK`). Left open, the turn stalled until the turn clock, which R79 then ended.
 */
function answerForLockedOut(sink: EngineSink): void {
  for (let guard = 0; guard <= TURN_CAP_PLAYER_TURNS; guard += 1) {
    const state = sink.state;
    const pending = state.pending;
    if (state.result !== null || pending === null) return;
    if (!state.players[pending.playerId].aiTurn || pending.kind === "mulligan") return;
    if (playOutTurn(sink, pending.playerId).actions.length === 0) return;
  }
}

/** §2.5: when nothing but ending the turn is left, the turn ends by itself. */
function maybeAutoEndTurn(sink: EngineSink): void {
  for (let guard = 0; guard <= TURN_CAP_PLAYER_TURNS; guard += 1) {
    const state = sink.state;
    if (state.result !== null || state.pending !== null || state.phase !== "main") return;
    const player = state.active;
    const actions = legalActions(state, player);
    const meaningful = actions.filter(
      (action) => action.type !== "endTurn" && action.type !== "concede" && action.type !== "offerDraw",
    );
    if (meaningful.length > 0) return;
    sink.events.push({ type: "turnAutoEnded", player, turn: state.turn });
    endTurn(sink);
    settle(sink);
  }
}

function rememberNonce(state: GameState, nonce: string, events: GameEvent[]): void {
  state.applied.push({ nonce, events });
  if (state.applied.length > NONCE_HISTORY) {
    state.applied.splice(0, state.applied.length - NONCE_HISTORY);
  }
}

export function reduce(state: GameState, action: Action, rng?: Rng): ReduceResult {
  syncFusedScripts(state);
  const previous = state.applied.find((entry) => entry.nonce === action.nonce);
  if (previous !== undefined) return { state, events: previous.events };

  if (state.result !== null) return { state, events: [], error: "the game is over" };

  // A prompt blocks every action but its own answer and the ones that end a game (§9.3, R79).
  if (state.pending !== null) {
    const allowed = PROMPT_OPEN_ACTION_TYPES.includes(
      action.type as (typeof PROMPT_OPEN_ACTION_TYPES)[number],
    );
    if (!allowed) return { state, events: [], error: "a prompt is open: answer it first" };
    const isAnswer = action.type === "answer" || action.type === "mulligan";
    if (isAnswer && state.pending.playerId !== action.playerId) {
      return { state, events: [], error: "that prompt belongs to the other player" };
    }
  }

  const nonActive = action.playerId !== state.active;
  if (
    nonActive &&
    !NON_ACTIVE_ACTION_TYPES.includes(action.type as (typeof NON_ACTIVE_ACTION_TYPES)[number]) &&
    state.pending?.playerId !== action.playerId
  ) {
    return { state, events: [], error: "it is not your turn" };
  }

  const next = cloneState(state);
  const events: GameEvent[] = [];
  const sink: EngineSink = { state: next, events, rng: rng ?? createRng(next.seed, next.rngCursor) };

  const error = applyAction(sink, action);
  if (error !== null) return { state, events: [], error };

  // §10.3: the resolution loop finishes the action — the events it emitted, the work a prompt left
  // owed, the state check and the trigger queue — and stops where a prompt is waiting.
  settle(sink);
  answerForLockedOut(sink);
  maybeAutoEndTurn(sink);

  next.rngCursor = sink.rng.cursor;
  rememberNonce(next, action.nonce, events);
  return { state: next, events };
}

/** Start the game: shuffle, deal and open the first mulligan (§2.1). */
export function beginGame(state: GameState, rng?: Rng): ReduceResult {
  const next = cloneState(state);
  const events: GameEvent[] = [];
  const sink: EngineSink = { state: next, events, rng: rng ?? createRng(next.seed, next.rngCursor) };
  beginSetup(sink);
  next.rngCursor = sink.rng.cursor;
  return { state: next, events };
}

function mulliganSubsets(ids: string[]): string[][] {
  const total = 2 ** ids.length;
  if (total > MAX_MULLIGAN_SUBSETS) return [ids, []];
  const out: string[][] = [];
  for (let mask = 0; mask < total; mask += 1) {
    out.push(ids.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  return out;
}

/**
 * Every action that would not error, for the client's greying-out and for the AI policy (§10.2).
 *
 * Each kind comes from the module that refuses it, never from a second copy of the rule here: the
 * plays from `playChoices` (R81's five choice kinds crossed and bounded, R90), the attacks from
 * `combat.attackTargets`, the powers from `heroPower.whyCannotActivate` and, while a prompt is
 * open, that prompt's own answers from `prompts.promptAnswers`.
 */
export function legalActions(state: GameState, player: PlayerId): ActionBody[] {
  syncFusedScripts(state);
  if (state.result !== null) return [];

  const pending = state.pending;
  if (pending !== null) {
    // R211: a prompt blocks everything but its own answer and the actions that end a game, and
    // `reduce` accepts a concede from either seat while it is open (§2.5, BUILD M1-T3) — so both
    // seats are offered it, as they are at every other moment of a live game. §10.7's policy never
    // takes it (R84), so what the policy draws from is still that prompt's answers alone.
    const concede: ActionBody = { type: "concede" };
    if (pending.playerId !== player) return [concede];
    if (pending.kind === "mulligan") {
      return [
        ...mulliganSubsets(pending.options.map((option) => option.key)).map((keep) => ({
          type: "mulligan" as const,
          keep,
        })),
        concede,
      ];
    }
    return [...promptAnswers(pending), concede];
  }

  const out: ActionBody[] = [];
  if (hasStandingDrawOffer(state, player)) {
    out.push({ type: "answerDraw", accept: true }, { type: "answerDraw", accept: false });
  }

  if (state.active !== player || state.phase !== "main") {
    out.push({ type: "concede" });
    return out;
  }

  const side = state.players[player];
  for (const card of side.hand) out.push(...playActionsFor(state, player, card));

  for (const unit of activeUnitsOf(state, player)) {
    for (const target of attackTargets(state, unit)) {
      out.push({ type: "attack", attackerId: unit.id, targetId: attackTargetId(target) });
    }
    if (canSwitch(unit)) out.push({ type: "switchPosition", instanceId: unit.id });
  }

  // R43: a power is the instance's, so every permanent the player controls is asked.
  for (const ref of side.backrow) {
    if (ref === null) continue;
    if (whyCannotActivate(state, player, ref.id) === null) {
      out.push({ type: "activatePower", instanceId: ref.id });
    }
  }

  if (canOfferDraw(state, player)) out.push({ type: "offerDraw" });

  out.push({ type: "endTurn" }, { type: "concede" });
  return out;
}

/** Exported for the AI policy and the client: the instance an `attack` action would move (§10.2). */
export function unitForAction(state: GameState, instanceId: string): CardInstance | undefined {
  return findInstance(state, instanceId);
}
