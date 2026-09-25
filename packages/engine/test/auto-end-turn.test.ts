// R345: R82's automatic turn end is each player's to turn off (SPEC §2.5, §10.2, §10.8).

import type { Action, ActionInput, ActionType } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { DECK_SIZE } from "../src/config";
import { beginGame, legalActions, reduce } from "../src/reduce";
import { fold, hashState } from "../src/replay";
import type { GameState } from "../src/state";
import { viewFor } from "../src/viewFor";
import { vanillaDeck } from "./fixtures/catalog";
import { eventsOfType, newGame } from "./fixtures/harness";

const SEED = "r345";
const DECKS: [string[], string[]] = [vanillaDeck(DECK_SIZE, 1), vanillaDeck(DECK_SIZE, 21)];

let counter = 0;

function action(body: ActionInput): Action {
  counter += 1;
  return { ...body, nonce: `r345-${counter}` } as Action;
}

function act(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  const result = reduce(state, action(body));
  if (result.error !== undefined) throw new Error(result.error);
  return result;
}

function mulligans(state: GameState): Action[] {
  return (["p1", "p2"] as const).map((player) =>
    action({ type: "mulligan", keep: state.players[player].hand.map((card) => card.id), playerId: player }),
  );
}

/** Past both mulligans, in p1's first main phase. */
function started(): GameState {
  let state = beginGame(newGame(SEED, DECKS)).state;
  for (const answer of mulligans(state)) state = reduce(state, answer).state;
  expect(state).toMatchObject({ phase: "main", active: "p1", pending: null });
  return state;
}

/** p1's first turn with nothing left in it but ending it, conceding and offering a draw (R82). */
function idleTurn(): GameState {
  const state = started();
  state.players.p1.hand = [];
  const left = legalActions(state, "p1").map((body) => body.type);
  expect(left.every((type) => (["endTurn", "concede", "offerDraw"] as ActionType[]).includes(type))).toBe(true);
  return state;
}

describe("R345 the automatic turn end is each player's to turn off", () => {
  it("R345 turned off, a turn with nothing left waits for End turn; turned on again, it ends at once", () => {
    const off = act(idleTurn(), { type: "setAutoEndTurn", enabled: false, playerId: "p1" });
    expect(off.events).toEqual([]);
    expect(off.state.active).toBe("p1");
    expect(off.state.players.p1.autoEndTurn).toBe(false);

    const ended = act(off.state, { type: "endTurn", playerId: "p1" });
    expect(eventsOfType(ended.events, "turnAutoEnded")).toHaveLength(0);
    expect(ended.state.active).toBe("p2");

    const on = act(off.state, { type: "setAutoEndTurn", enabled: true, playerId: "p1" });
    expect(eventsOfType(on.events, "turnAutoEnded")).toEqual([{ type: "turnAutoEnded", player: "p1", turn: 1 }]);
    expect(on.state.active).toBe("p2");
    expect(on.state.players.p1).not.toHaveProperty("autoEndTurn");
  });

  it("R345 the default is R82's, and the preference is the sender's own", () => {
    // p2 turning it off for p2 leaves p1's idle turn to end by itself, as R82 says.
    const result = act(idleTurn(), { type: "setAutoEndTurn", enabled: false, playerId: "p2" });
    expect(eventsOfType(result.events, "turnAutoEnded")).toEqual([{ type: "turnAutoEnded", player: "p1", turn: 1 }]);
    expect(result.state.players.p2.autoEndTurn).toBe(false);
    expect(result.state.players.p1).not.toHaveProperty("autoEndTurn");
  });

  it("R345 either seat may send it while the mulligans are open and on the other seat's turn", () => {
    const setup = beginGame(newGame(SEED, DECKS)).state;
    expect(setup.mulligan).toBeDefined();
    for (const player of ["p1", "p2"] as const) {
      const result = act(setup, { type: "setAutoEndTurn", enabled: false, playerId: player });
      expect(result.events).toEqual([]);
      expect(result.state.players[player].autoEndTurn).toBe(false);
    }
    const onTheirTurn = act(started(), { type: "setAutoEndTurn", enabled: false, playerId: "p2" });
    expect(onTheirTurn.state.players.p2.autoEndTurn).toBe(false);
  });

  it("R345 legalActions never offers it, so no policy ever sends it", () => {
    for (const state of [beginGame(newGame(SEED, DECKS)).state, started(), idleTurn()]) {
      for (const player of ["p1", "p2"] as const) {
        expect(legalActions(state, player).some((body) => body.type === "setAutoEndTurn")).toBe(false);
      }
    }
  });

  it("R345 a view carries the viewer's own preference only, and nothing while it is on", () => {
    const off = act(idleTurn(), { type: "setAutoEndTurn", enabled: false, playerId: "p1" }).state;
    expect(viewFor(off, "p1").autoEndTurn).toBe(false);
    expect(viewFor(off, "p2")).not.toHaveProperty("autoEndTurn");
    expect(viewFor(started(), "p1")).not.toHaveProperty("autoEndTurn");
  });

  it("R345 a log that turns it off and on again folds to the hash of one that never touched it", () => {
    const setup = beginGame(newGame(SEED, DECKS)).state;
    const plain = mulligans(setup);
    const toggled = [
      action({ type: "setAutoEndTurn", enabled: false, playerId: "p1" }),
      action({ type: "setAutoEndTurn", enabled: true, playerId: "p1" }),
      ...mulligans(setup),
    ];
    const a = fold({ seed: SEED, decks: DECKS, log: plain });
    const b = fold({ seed: SEED, decks: DECKS, log: toggled });
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(hashState(b.state)).toBe(hashState(a.state));

    // Left off, it is part of the state, so the fold says so.
    const leftOff = fold({ seed: SEED, decks: DECKS, log: [toggled[0] as Action, ...mulligans(setup)] });
    expect(leftOff.state.players.p1.autoEndTurn).toBe(false);
    expect(hashState(leftOff.state)).not.toBe(hashState(a.state));
  });
});
