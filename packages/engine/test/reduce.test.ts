import type { Action, ActionBody } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { DECK_SIZE } from "../src/config";
import { beginGame, legalActions, reduce } from "../src/reduce";
import { createRng } from "../src/rng";
import { cloneState, newInstance, type GameState } from "../src/state";
import { vanillaDeck } from "./fixtures/catalog";
import { newGame } from "./fixtures/harness";

let seq = 0;
function nonce(): string {
  seq += 1;
  return `r${seq}`;
}

function playing(seed = "reduce"): GameState {
  let state = beginGame(newGame(seed)).state;
  state = reduce(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1", nonce: nonce() }).state;
  state = reduce(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2", nonce: nonce() }).state;
  return state;
}

describe("reduce (M1-T3)", () => {
  it("rejects an action from the non-active player and leaves the state untouched", () => {
    const state = playing();
    const before = cloneState(state);

    const result = reduce(state, { type: "endTurn", playerId: "p2", nonce: nonce() });
    expect(result.error).toMatch(/not your turn/);
    expect(result.events).toEqual([]);
    expect(result.state).toEqual(before);
  });

  it("lets the non-active player concede and answer a draw offer", () => {
    const state = playing("non-active");
    expect(reduce(state, { type: "concede", playerId: "p2", nonce: nonce() }).error).toBeUndefined();

    const offered = reduce(state, { type: "offerDraw", playerId: "p1", nonce: nonce() }).state;
    const answered = reduce(offered, { type: "answerDraw", accept: false, playerId: "p2", nonce: nonce() });
    expect(answered.error).toBeUndefined();
  });

  it("refuses anything but an answer while a prompt is open", () => {
    const state = beginGame(newGame("pending")).state;
    expect(state.pending).not.toBeNull();

    const played = reduce(state, {
      type: "play",
      instanceId: state.players.p1.hand[0]?.id as string,
      playerId: "p1",
      nonce: nonce(),
    });
    expect(played.error).toMatch(/a prompt is open/);

    const wrongPlayer = reduce(state, { type: "mulligan", keep: [], playerId: "p2", nonce: nonce() });
    expect(wrongPlayer.error).toMatch(/belongs to the other player/);
  });

  it("dedupes a repeated nonce: same state, no duplicate events", () => {
    const state = playing("dedupe");
    const id = nonce();
    const first = reduce(state, { type: "endTurn", playerId: "p1", nonce: id });
    const second = reduce(first.state, { type: "endTurn", playerId: "p1", nonce: id });

    expect(second.state).toBe(first.state);
    expect(second.events).toEqual(first.events);
    expect(second.error).toBeUndefined();
  });

  it("refuses an action once the game is over", () => {
    const over = reduce(playing("over"), { type: "concede", playerId: "p1", nonce: nonce() }).state;
    expect(reduce(over, { type: "endTurn", playerId: "p2", nonce: nonce() }).error).toMatch(/game is over/);
  });

  it("errors on a card that is not in hand and on a zone that is taken", () => {
    const state = playing("bad-play");
    const ghost = newInstance(state, "fx-1", "p1", { z: "hand", player: "p1" });
    expect(
      reduce(state, { type: "play", instanceId: ghost.id, playerId: "p1", nonce: nonce() }).error,
    ).toMatch(/no card/);

    const card = state.players.p1.hand[0]?.id as string;
    const played = reduce(state, {
      type: "play",
      instanceId: card,
      zone: { row: "units", lane: 1 },
      playerId: "p1",
      nonce: nonce(),
    });
    expect(played.error).toBeUndefined();

    const second = played.state.players.p1.hand[0]?.id as string;
    played.state.players.p1.mana.current = 4; // enough mana, so the zone is what refuses
    const blocked = reduce(played.state, {
      type: "play",
      instanceId: second,
      zone: { row: "units", lane: 1 },
      playerId: "p1",
      nonce: nonce(),
    });
    expect(blocked.error).toMatch(/not open/);
  });

  // An explicit timeout, because the 5 s this inherited from vitest's default was never chosen for
  // it and is the only thing here that measures the machine rather than the engine. Measured on the
  // dev box: the whole file runs in 704 ms, or 1.00 s under coverage instrumentation. It still timed
  // out at 5 s inside a Linux container running the coverage step while three other agents worked —
  // a shared or throttled CI runner is the same environment, and `pnpm test:coverage` instruments
  // every module this walk touches. 30 s keeps roughly a 30x margin over the measured cost while
  // still failing an engine that has genuinely stopped terminating. No assertion below changes:
  // the walk still probes every action legalActions offers at each of the 200 states.
  it("every action legalActions lists succeeds, over 200 random states", () => {
    const rng = createRng("legal-actions-walk");
    let states = 0;
    let probes = 0;

    for (let game = 0; states < 200; game += 1) {
      let state = playing(`walk-${game}`);

      while (state.result === null && states < 200) {
        const player = state.pending?.playerId ?? state.active;
        const actions = legalActions(state, player);
        expect(actions.length).toBeGreaterThan(0);
        states += 1;

        // Every listed action must apply cleanly from this state, concedes and offers included.
        for (const action of actions) {
          const probe = reduce(state, { ...action, playerId: player, nonce: nonce() } as Action);
          expect(probe.error, `${action.type} should be legal: ${probe.error ?? ""}`).toBeUndefined();
          probes += 1;
        }

        // Walk on with something that does not end the game.
        const walkable = actions.filter(
          (action) => action.type !== "concede" && action.type !== "answerDraw",
        );
        const chosen = (walkable[rng.int(walkable.length)] ?? walkable[0]) as ActionBody;
        state = reduce(state, { ...chosen, playerId: player, nonce: nonce() } as Action).state;
      }
    }

    expect(states).toBe(200);
    expect(probes).toBeGreaterThan(200);
  }, 30_000);

  it("lists no actions for a player with an open prompt that is not theirs", () => {
    const state = beginGame(newGame("prompt-actions")).state;
    expect(legalActions(state, "p2")).toEqual([]);
    expect(legalActions(state, "p1").every((a) => a.type === "mulligan")).toBe(true);
  });

  it("offers one play per open zone for a unit", () => {
    const state = playing("zones-listed");
    const unitId = state.players.p1.hand[0]?.id as string;
    const plays = legalActions(state, "p1").filter((a) => a.type === "play" && a.instanceId === unitId);
    expect(plays).toHaveLength(5);
  });

  it("keeps the deck lists out of the state it returns", () => {
    const state = playing("serializable");
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state.players.p1.library.length + state.players.p1.hand.length).toBeLessThanOrEqual(DECK_SIZE);
    expect(vanillaDeck(DECK_SIZE, 1)).toHaveLength(DECK_SIZE);
  });
});
