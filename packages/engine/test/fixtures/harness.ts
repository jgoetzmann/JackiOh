// Small helpers shared by the engine tests: a registered fixture catalog, a sink and placement.

import type { Action, ActionBody, GameEvent, PlayerId, Row } from "@jackioh/shared";
import { registerCatalog } from "../../src/catalog";
import { AI_END_TURN_PROBABILITY, DECK_SIZE } from "../../src/config";
import { beginGame, legalActions, reduce } from "../../src/reduce";
import { createRng } from "../../src/rng";
import type { EngineSink } from "../../src/resolve";
import { registerScripts } from "../../src/scripts";
import { createGame, newInstance, type CardInstance, type GameState } from "../../src/state";
import { placeOnField, type ZoneSlot } from "../../src/zones";
import { vanillaCatalog, vanillaDeck } from "./catalog";
import { COMBAT_SCRIPTS, combatCatalog } from "./combat";
import { FIXTURE_SCRIPTS, fixtureCatalog } from "./scripts";

export function setupCatalog(): void {
  registerCatalog(combatCatalog(fixtureCatalog(vanillaCatalog())));
  registerScripts({ ...FIXTURE_SCRIPTS, ...COMBAT_SCRIPTS });
}

export function newGame(seed = "engine-test", decks?: [string[], string[]]): GameState {
  setupCatalog();
  return createGame({
    seed,
    decks: decks ?? [vanillaDeck(DECK_SIZE, 1), vanillaDeck(DECK_SIZE, 21)],
  });
}

/** A sink whose rng starts at the state's cursor, as reduce does. */
export function sinkFor(state: GameState, events: GameEvent[] = []): EngineSink {
  return { state, events, rng: createRng(state.seed, state.rngCursor) };
}

export function slot(player: PlayerId, row: Row, lane: number): ZoneSlot {
  return { player, row, lane };
}

export function put(state: GameState, defId: string, ref: ZoneSlot, options: { radiant?: boolean } = {}): CardInstance {
  const card = newInstance(state, defId, ref.player, { z: "hand", player: ref.player });
  if (options.radiant === true) card.radiant = true;
  if (!placeOnField(state, card, ref)) throw new Error(`could not place ${defId} in ${ref.row} ${ref.lane}`);
  return card;
}

export function inHand(state: GameState, defId: string, player: PlayerId, count = 1): CardInstance[] {
  return Array.from({ length: count }, () => {
    const card = newInstance(state, defId, player, { z: "hand", player });
    state.players[player].hand.push(card);
    return card;
  });
}

export function setLibrary(state: GameState, player: PlayerId, defIds: string[]): CardInstance[] {
  const cards = defIds.map((defId) => newInstance(state, defId, player, { z: "library", player }));
  state.players[player].library = cards;
  return cards;
}

export function eventsOfType<T extends GameEvent["type"]>(
  events: readonly GameEvent[],
  type: T,
): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}

/**
 * A full game played by the random policy of §10.7: uniform over the legal actions, ending the
 * turn when it is the only option or with AI_END_TURN_PROBABILITY. Concedes and draw offers are
 * left out, so a game ends by hero death or the turn cap (M1 gate).
 */
export function playRandomGame(seed: string, deckPair?: [string[], string[]]): {
  state: GameState;
  log: Action[];
  decks: [string[], string[]];
} {
  const decks = deckPair ?? [vanillaDeck(DECK_SIZE, 1), vanillaDeck(DECK_SIZE, 21)];
  let state = beginGame(newGame(seed, decks)).state;
  const policy = createRng(`policy-${seed}`);
  const log: Action[] = [];

  for (let step = 0; state.result === null; step += 1) {
    if (step > 4000) throw new Error(`game ${seed} did not finish`);
    const player = state.pending?.playerId ?? state.active;
    const actions = legalActions(state, player).filter(
      (action) => action.type !== "concede" && action.type !== "offerDraw" && action.type !== "answerDraw",
    );
    if (actions.length === 0) throw new Error(`no legal action for ${player} in game ${seed}`);

    const others = actions.filter((action) => action.type !== "endTurn");
    const endTurn = actions.find((action) => action.type === "endTurn");
    const chosen =
      others.length === 0 || (endTurn !== undefined && policy.chance(AI_END_TURN_PROBABILITY))
        ? (endTurn ?? (others[policy.int(others.length)] as ActionBody))
        : (others[policy.int(others.length)] as ActionBody);

    const action = { ...chosen, playerId: player, nonce: `a${log.length}` } as Action;
    const result = reduce(state, action);
    if (result.error !== undefined) throw new Error(`${action.type} rejected in ${seed}: ${result.error}`);
    log.push(action);
    state = result.state;
  }

  return { state, log, decks };
}
