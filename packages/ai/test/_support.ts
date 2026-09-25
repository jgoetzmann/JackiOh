// Helpers shared by the packages/ai tests (docs/polish/3-ai.md §Tests). Not a test file itself.
//
// Every state an AI test builds comes from the real engine and the real 110-card catalog:
// `scenario()` from the cards harness (which calls `registerAll()` on import) for hand-built
// boards, and `createGame`/`beginGame` plus §10.7's random policy for real mid-game states.
//
// Scenario ids start at `c1` and follow the setup literal. `redact` also hides a card in the
// seat's OWN library whose id was minted for the opponent's opening deck (R73), and `createGame`
// mints p1's deck first, so a scenario seen from p2 would have its own low-numbered library cards
// read as p1's. Every scenario-based AI test therefore puts the AI in p1's seat and keeps the
// scenario under 20 instances; states for p2's seat come from real `createGame` games.

import type { Action, ActionBody, PlayerId } from "@jackioh/shared";
import { PLAYER_IDS, opponentOf } from "@jackioh/shared";
import {
  DECK_SIZE,
  beginGame,
  createGame,
  createRng,
  legalActions,
  query,
  reduce,
  subsystems,
  type CardInstance,
  type GameState,
  seatToAct,
} from "@jackioh/engine";
import { registerAll } from "@jackioh/cards";
import { scenario, type ScenarioOptions } from "../../cards/test/_harness";
import { AI_BUDGET, actionKey, playAiTurn, type AiTurnResult, type SearchBudget } from "../src/index";

registerAll();

export { scenario };
export type { ScenarioOptions };

/** The AI's seat in every scenario-built test (see the header). */
export const AI: PlayerId = "p1";
/** The human's seat in every scenario-built test. */
export const HUMAN: PlayerId = "p2";

// ---------------------------------------------------------------------------------------------
// Card lookups
// ---------------------------------------------------------------------------------------------

/** Every non-token Core id, sorted: the pool AI decks and determinizations draw from. */
export function corePool(): string[] {
  return query({ set: "Core" })
    .map((def) => def.id)
    .sort();
}

/** Every Trap and Field Trap id in Core: the only defs a face-down sample may take. */
export function trapPool(): string[] {
  return query({ set: "Core", type: ["Trap", "Field Trap"] })
    .map((def) => def.id)
    .sort();
}

/** Every instance in every zone of both players, Stack piles included. */
export function everyCard(state: GameState): CardInstance[] {
  return PLAYER_IDS.flatMap((player) => {
    const side = state.players[player];
    return [
      ...side.hand,
      ...side.library,
      ...side.graveyard,
      ...side.exile,
      ...side.resolving,
      ...side.units.flatMap((pile) => pile ?? []),
      ...side.backrow.flatMap((card) => (card === null ? [] : [card])),
    ];
  });
}

export function cardById(state: GameState, id: string): CardInstance | undefined {
  return everyCard(state).find((card) => card.id === id);
}

/** Whether `player`'s unit zones hold a card of this def (a Stack pile included). */
export function onField(state: GameState, player: PlayerId, defId: string): boolean {
  return state.players[player].units.some((pile) => (pile ?? []).some((card) => card.defId === defId));
}

export function inGraveyard(state: GameState, player: PlayerId, defId: string): boolean {
  return state.players[player].graveyard.some((card) => card.defId === defId);
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

/** Whether `action` is one of `legalActions(state, seat)`, compared by `actionKey`. */
export function isLegal(state: GameState, seat: PlayerId, action: ActionBody): boolean {
  const key = actionKey(action);
  return legalActions(state, seat).some((legal) => actionKey(legal) === key);
}

let nonceCounter = 0;

/** One action through `reduce`, throwing the engine's refusal. */
export function act(state: GameState, playerId: PlayerId, body: ActionBody, nonce?: string): GameState {
  nonceCounter += 1;
  const result = reduce(state, { ...body, playerId, nonce: nonce ?? `support-${nonceCounter}` } as Action);
  if (result.error !== undefined) throw new Error(`${body.type} for ${playerId} refused: ${result.error}`);
  return result.state;
}

export function clone(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

// ---------------------------------------------------------------------------------------------
// Puzzles (P1–P14)
// ---------------------------------------------------------------------------------------------

export type PuzzleRun = {
  /** The scenario's state before the AI moved. */
  start: GameState;
  /** `playAiTurn`'s whole result. */
  turn: AiTurnResult;
  /** The state after the AI's turn. */
  end: GameState;
};

/**
 * The puzzle runner: `scenario({ active: "p1", turn: 9, … })` with the AI as p1, then one AI turn
 * through `playAiTurn` at `AI_BUDGET` (the budget the browser plays at).
 */
export function runPuzzle(name: string, setup: ScenarioOptions, budget: SearchBudget = AI_BUDGET): PuzzleRun {
  const s = scenario({ seed: `puzzle-${name}`, active: AI, turn: 9, ...setup });
  const start = s.state;
  const turn = playAiTurn(start, AI, { rng: createRng(`puzzle:${name}`), budget });
  return { start, turn, end: turn.state };
}

/** A readable trace of a turn's decisions, for failure messages. */
export function trace(turn: AiTurnResult): string {
  return turn.decisions.map((d) => `${d.reason}:${JSON.stringify(d.action)}`).join(" | ");
}

/**
 * P8–P10's scripted reply: `attacker` attacks with everything it has. Each step takes an attack on
 * the enemy hero when one is legal, otherwise the first attack `legalActions` lists (a Taunt, when
 * one stands in the way). A prompt, whoever holds it, is answered with its first legal answer. It
 * plays no card and never ends the turn, and stops when the game is over, when it is not the
 * attacker's main phase, when no attack is left, or when the turn it started on is over. That last
 * one matters because R82 auto-ends a turn with nothing left to do: once the attacker's last swing
 * ends its turn, the defender's empty turn can end inside the same action and hand the attacker a
 * fresh main phase, which is a later turn than the one "next turn" means (B18).
 */
export function allOutAttack(start: GameState, attacker: PlayerId): GameState {
  let state = start;
  const heroTarget = `hero-${opponentOf(attacker)}`;
  for (let step = 0; step < 200; step += 1) {
    if (state.result !== null) return state;
    if (state.turn !== start.turn) return state;
    const pending = state.pending;
    if (pending !== null) {
      const answer = legalActions(state, pending.playerId)[0];
      if (answer === undefined) return state;
      state = act(state, pending.playerId, answer, `all-out-${step}`);
      continue;
    }
    if (state.active !== attacker || state.phase !== "main") return state;
    const attacks = legalActions(state, attacker).filter((action) => action.type === "attack");
    const pick =
      attacks.find((action) => action.type === "attack" && action.targetId === heroTarget) ?? attacks[0];
    if (pick === undefined) return state;
    state = act(state, attacker, pick, `all-out-${step}`);
  }
  throw new Error("the scripted all-out attack did not finish in 200 steps");
}

// ---------------------------------------------------------------------------------------------
// Real games
// ---------------------------------------------------------------------------------------------

/** Two distinct-card Core decks from one seeded shuffle (the fuzz suite's construction). */
export function randomDecks(seed: string, sizes: [number, number] = [DECK_SIZE, DECK_SIZE]): [string[], string[]] {
  const shuffled = createRng(`ai-test-decks:${seed}`).shuffle(corePool());
  return [shuffled.slice(0, sizes[0]), shuffled.slice(sizes[0], sizes[0] + sizes[1])];
}

/** A freshly dealt game: `beginGame` done, p1's mulligan open. */
export function dealtGame(seed: string): GameState {
  return beginGame(createGame({ seed, decks: randomDecks(seed) })).state;
}

/**
 * A game played by §10.7's random policy (`subsystems.chooseAction`), returning the state after
 * every `every`-th action (the dealt state first). Stops at the result or at `maxActions`.
 */
export function randomPolicyStates(seed: string, every: number, maxActions = 1500): GameState[] {
  let state = dealtGame(seed);
  const policy = createRng(`ai-test-policy:${seed}`);
  const states: GameState[] = [state];
  for (let n = 0; state.result === null && n < maxActions; n += 1) {
    const player = seatToAct(state);
    const chosen = subsystems.chooseAction(state, player, policy);
    if (chosen === null) break;
    const result = reduce(state, { ...chosen, playerId: player, nonce: `rp-${n}` } as Action);
    if (result.error !== undefined) throw new Error(`${seed}: ${chosen.type} refused: ${result.error}`);
    state = result.state;
    if ((n + 1) % every === 0) states.push(state);
  }
  return states;
}
