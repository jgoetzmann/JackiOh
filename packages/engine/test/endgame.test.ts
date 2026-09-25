import type { Action, ActionInput } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { DECK_SIZE, DRAW_OFFER_BLOCK_TURNS, TURN_CAP_PLAYER_TURNS } from "../src/config";
import { beginGame, legalActions, reduce } from "../src/reduce";
import { mulliganOwed } from "../src/setup";
import { newInstance, type GameState } from "../src/state";
import { vanillaDeck } from "./fixtures/catalog";
import { eventsOfType, newGame } from "./fixtures/harness";
import { doubleEdge } from "./fixtures/scripts";

let seq = 0;
function act(state: GameState, body: ActionInput): { state: GameState; events: Action[] } {
  seq += 1;
  const result = reduce(state, { ...body, nonce: `e${seq}` } as Action);
  if (result.error !== undefined) throw new Error(result.error);
  return { state: result.state, events: [] as Action[] };
}

function playing(seed: string, decks?: [string[], string[]]): GameState {
  let state = beginGame(newGame(seed, decks)).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" }).state;
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" }).state;
  return state;
}

describe("ending the game (M1-T8)", () => {
  it("a hero at 0 loses", () => {
    const state = playing("hero-death");
    const bolt = newInstance(state, doubleEdge.id, "p1", { z: "hand", player: "p1" });
    state.players.p1.hand.push(bolt);

    const result = reduce(state, { type: "play", instanceId: bolt.id, playerId: "p1", nonce: "hd" });
    expect(result.error).toBeUndefined();
    expect(result.state.result).toEqual({ winner: "p1", reason: "hero-death" });
    expect(result.state.phase).toBe("over");
    expect(eventsOfType(result.events, "gameOver")[0]?.winner).toBe("p1");
  });

  it("R59: one effect that leaves both heroes at 0 is a draw", () => {
    const state = playing("simultaneous");
    const card = newInstance(state, doubleEdge.id, "p1", { z: "hand", player: "p1" });
    state.players.p1.hand.push(card);
    // p1 will fatigue for 5 on the draw the same effect takes, from 5 health.
    state.players.p1.library = [];
    state.players.p1.fatigueCount = 4;
    state.players.p1.hero.health = 5;

    const result = reduce(state, { type: "play", instanceId: card.id, playerId: "p1", nonce: "sim" });
    expect(result.error).toBeUndefined();
    expect(result.state.players.p1.hero.health).toBeLessThanOrEqual(0);
    expect(result.state.players.p2.hero.health).toBeLessThanOrEqual(0);
    expect(result.state.result).toEqual({ winner: "draw", reason: "both-heroes-dead" });
  });

  it("the same two hits as separate actions end the game at the first one", () => {
    const state = playing("sequential");
    const card = newInstance(state, doubleEdge.id, "p1", { z: "hand", player: "p1" });
    state.players.p1.hand.push(card);
    state.players.p1.hero.health = 5;
    state.players.p1.fatigueCount = 4;
    state.players.p1.library = [newInstance(state, "fx-2", "p1", { z: "library", player: "p1" })];

    const result = reduce(state, { type: "play", instanceId: card.id, playerId: "p1", nonce: "seq" });
    expect(result.state.result).toEqual({ winner: "p1", reason: "hero-death" });
  });

  it("a conceding player loses", () => {
    const result = reduce(playing("concede"), { type: "concede", playerId: "p2", nonce: "c1" });
    expect(result.state.result).toEqual({ winner: "p1", reason: "concede" });
  });

  it("ends in a draw after the 30th player-turn, not the 29th (R2)", () => {
    let state = playing("cap");
    for (let i = 0; i < TURN_CAP_PLAYER_TURNS - 1; i += 1) {
      state = act(state, { type: "endTurn", playerId: state.active }).state;
    }
    expect(state.turn).toBe(TURN_CAP_PLAYER_TURNS);
    expect(state.result).toBeNull();

    state = act(state, { type: "endTurn", playerId: state.active }).state;
    expect(state.result).toEqual({ winner: "draw", reason: "turn-cap" });
  });

  it("an accepted draw offer ends the game as a draw", () => {
    let state = playing("offer-accept");
    state = act(state, { type: "offerDraw", playerId: "p1" }).state;
    state = act(state, { type: "answerDraw", accept: true, playerId: "p2" }).state;
    expect(state.result).toEqual({ winner: "draw", reason: "draw-accepted" });
  });

  it("a declined offer blocks the offering player for three of their turns, not the opponent (R36)", () => {
    let state = playing("offer-decline");
    state = act(state, { type: "offerDraw", playerId: "p1" }).state;
    state = act(state, { type: "answerDraw", accept: false, playerId: "p2" }).state;
    expect(state.players.p1.drawOffer.blockedUntil).toBe(1 + DRAW_OFFER_BLOCK_TURNS + 1);

    state = act(state, { type: "endTurn", playerId: "p1" }).state;
    // The opponent may still offer on their own turn.
    expect(legalActions(state, "p2").some((a) => a.type === "offerDraw")).toBe(true);

    const advanceToP1Turn = (from: GameState, target: number): GameState => {
      let next = from;
      while (!(next.active === "p1" && next.players.p1.turnsStarted === target)) {
        next = act(next, { type: "endTurn", playerId: next.active }).state;
      }
      return next;
    };

    // Their next three turns are blocked, and the fourth is free again.
    for (const turn of [2, 3, 4]) {
      state = advanceToP1Turn(state, turn);
      expect(legalActions(state, "p1").some((a) => a.type === "offerDraw")).toBe(false);
    }
    state = advanceToP1Turn(state, 5);
    expect(legalActions(state, "p1").some((a) => a.type === "offerDraw")).toBe(true);
  });

  it("auto-ends a turn when nothing but ending it is left", () => {
    const empty: string[] = vanillaDeck(DECK_SIZE, 1);
    let state = playing("auto-end", [empty, vanillaDeck(DECK_SIZE, 21)]);
    state.players.p1.hand = [];
    state.players.p1.library = [];
    state.players.p1.hero.health = 40; // survive the fatigue draws

    // p1 ends; p2 plays their turn; p1's next turn has nothing to do, so it ends itself.
    state = act(state, { type: "endTurn", playerId: "p1" }).state;
    const result = reduce(state, { type: "endTurn", playerId: "p2", nonce: "auto" });
    expect(result.error).toBeUndefined();
    const auto = eventsOfType(result.events, "turnAutoEnded");
    expect(auto.length).toBeGreaterThanOrEqual(1);
    expect(auto[0]?.player).toBe("p1");
  });

  it("the match ceiling ends the game in a draw (R79)", () => {
    const result = reduce(playing("ceiling"), { type: "ceilingReached", playerId: "p1", nonce: "ceil" });
    expect(result.state.result).toEqual({ winner: "draw", reason: "match-ceiling" });
  });

  it("a timeout answers the open prompt and only ends the turn of the player who ran out (R79)", () => {
    const withPrompt = beginGame(newGame("timeout")).state;
    expect(mulliganOwed(withPrompt)).toEqual(["p1", "p2"]);

    const answered = reduce(withPrompt, { type: "timeout", playerId: "p1", nonce: "to1" });
    expect(answered.error).toBeUndefined();
    // p1's mulligan is answered (R268), so p2's is all that is left rather than the turn ending.
    expect(mulliganOwed(answered.state)).toEqual(["p2"]);
    expect(answered.state.turn).toBe(0);

    const mainPhase = playing("timeout-main");
    const ended = reduce(mainPhase, { type: "timeout", playerId: "p1", nonce: "to2" });
    expect(ended.error).toBeUndefined();
    expect(ended.state.active).toBe("p2");
  });

  it("lets a prompt-blocked game still be conceded or timed out (BUILD M1-T3)", () => {
    const withPrompt = beginGame(newGame("blocked")).state;
    expect(reduce(withPrompt, { type: "concede", playerId: "p2", nonce: "b1" }).error).toBeUndefined();
    expect(reduce(withPrompt, { type: "timeout", playerId: "p2", nonce: "b3" }).error).toBeUndefined();
    expect(
      reduce(withPrompt, { type: "play", instanceId: "c1", playerId: "p1", nonce: "b2" }).error,
    ).toMatch(/the mulligan is open/);
  });

  it("disconnect expiry is a loss (R79)", () => {
    const result = reduce(playing("disconnect"), {
      type: "disconnectExpired",
      player: "p2",
      playerId: "p2",
      nonce: "dc",
    });
    expect(result.state.result).toEqual({ winner: "p1", reason: "disconnect" });
  });
});
