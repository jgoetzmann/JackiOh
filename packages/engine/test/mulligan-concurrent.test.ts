// The concurrent mulligan and the draw offer's lifetime (SPEC §2.1, §2.5, §10.1, §10.8, R265–R269).
//
//  - R265: both seats' mulligans open at once, either may answer first, and the second answer
//    resolves both in seat order — so the game is the same whichever seat answered first, and a
//    state waiting on one answer survives JSON and replays exactly.
//  - R266: an answer is sealed: the other seat learns only that it is in.
//  - R267: a sealed answer is read at resolution, against the hand as it stands then.
//  - R268: a timed-out mulligan keeps the whole hand, and only the timing-out seat's.
//  - R269: a draw offer stands until it is answered or its offerer's turn ends, both seats see it,
//    and one that lapses blocks nothing.

import type { Action, ActionInput, CardDef, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { AI_DIFFICULTY, DECK_SIZE, type Handicap } from "../src/config";
import { addToHand, discardRandom } from "../src/effects";
import { beginGame, legalActions, reduce, seatToAct } from "../src/reduce";
import { fold, hashState } from "../src/replay";
import { createRng, type Rng } from "../src/rng";
import { registerScripts, registeredScripts } from "../src/scripts";
import { mulliganOwed, mulliganPromptFor } from "../src/setup";
import { cloneState, createGame, newInstance, type GameState } from "../src/state";
import { viewFor } from "../src/viewFor";
import { vanillaDeck } from "./fixtures/catalog";
import { newGame, setupCatalog } from "./fixtures/harness";
import { cnVirus, hinder } from "./fixtures/scripts";

const SEATS = ["p1", "p2"] as const;

let counter = 0;
function act(state: GameState, body: ActionInput): GameState {
  counter += 1;
  const result = reduce(state, { ...body, nonce: `mc-${counter}` } as Action);
  if (result.error !== undefined) throw new Error(`${body.type} for ${body.playerId}: ${result.error}`);
  return result.state;
}

/** A random subset of the seat's offered cards, drawn from the test's own stream. */
function someKeep(state: GameState, player: PlayerId, pick: Rng): string[] {
  const prompt = mulliganPromptFor(state, player);
  if (prompt === null) throw new Error(`${player} owes no mulligan`);
  return prompt.options.map((option) => option.key).filter(() => pick.chance(0.5));
}

type Answered = { state: GameState; log: Action[] };

/** Both seats answer, in `order`, each with its keep list; the log is what a table would record. */
function answerIn(begun: GameState, order: readonly PlayerId[], keep: Record<PlayerId, string[]>): Answered {
  let state = begun;
  const log: Action[] = [];
  for (const player of order) {
    const action = { type: "mulligan", keep: keep[player], playerId: player, nonce: `m-${player}` } as Action;
    const result = reduce(state, action);
    if (result.error !== undefined) throw new Error(`${player}: ${result.error}`);
    state = result.state;
    log.push(action);
  }
  return { state, log };
}

describe("R265 the mulligans are open at once", () => {
  it("R265 either seat answers first, and the game dealt is the same whichever did", () => {
    for (let n = 0; n < 60; n += 1) {
      const seed = `r265-${n}`;
      const decks: [string[], string[]] = [vanillaDeck(DECK_SIZE, 1), vanillaDeck(DECK_SIZE, 21)];
      const begun = beginGame(newGame(seed, decks)).state;
      expect(begun.pending).toBeNull();
      expect(mulliganOwed(begun)).toEqual(["p1", "p2"]);

      const pick = createRng(`r265-pick-${n}`);
      const keep = { p1: someKeep(begun, "p1", pick), p2: someKeep(begun, "p2", pick) };
      const first = answerIn(begun, ["p1", "p2"], keep);
      const second = answerIn(begun, ["p2", "p1"], keep);

      // The same game, whichever answered first: the state after setup hashes the same.
      expect(hashState(second.state), seed).toBe(hashState(first.state));
      expect(first.state.turn).toBe(1);
      expect(first.state.phase).toBe("main");
      expect(first.state.mulligan).toBeUndefined();
      expect(first.state.mulliganed).toEqual(["p1", "p2"]);

      // Each order's log folds back to that game (§9.3).
      for (const answered of [first, second]) {
        const replayed = fold({ seed, decks, log: answered.log });
        expect(replayed.errors).toEqual([]);
        expect(hashState(replayed.state)).toBe(hashState(first.state));
      }
    }
  });

  it("R265 the order does not matter with cast-on-draw replacements and a handicapped seat either", () => {
    setupCatalog();
    // Hinder and CN-Virus are cast when drawn, so replacement draws cast, draw the match rng and
    // touch both seats (§2.4, R70); a Hard seat mulligans four cards as p1 (R182). CN-Virus is a
    // token, so it joins each library after the decks are checked.
    const hard = AI_DIFFICULTY.hard;
    const handicaps: Partial<Record<PlayerId, Handicap>> = { p1: hard };
    let casts = 0;
    for (let n = 0; n < 40; n += 1) {
      const seed = `r265-cast-${n}`;
      const decks: [string[], string[]] = [[hinder.id, ...vanillaDeck(hard.deckSize - 1, 1)], vanillaDeck(DECK_SIZE, 21)];
      const game = createGame({ seed, decks, handicaps });
      for (const seat of SEATS) {
        game.players[seat].library.push(newInstance(game, cnVirus.id, seat, { z: "library", player: seat }));
      }
      const begun = beginGame(game).state;
      // Every opening card goes back, so each seat draws as many replacements as it can.
      const keep = { p1: [], p2: [] };
      const first = answerIn(begun, ["p1", "p2"], keep);
      const second = answerIn(begun, ["p2", "p1"], keep);
      expect(hashState(second.state), seed).toBe(hashState(first.state));
      const played = SEATS.flatMap((seat) => first.state.players[seat].graveyard);
      if (played.some((card) => card.defId === hinder.id || card.defId === cnVirus.id)) casts += 1;
    }
    // Not vacuous: some of these setups cast a replacement.
    expect(casts).toBeGreaterThan(0);
  });

  it("R265 a state waiting on one answer survives a JSON round trip and goes on exactly as the live one", () => {
    const begun = beginGame(newGame("r265-json")).state;
    const waiting = act(begun, { type: "mulligan", keep: [], playerId: "p2" });
    const copy = JSON.parse(JSON.stringify(waiting)) as GameState;
    expect(copy).toEqual(waiting);
    expect(legalActions(copy, "p1")).toEqual(legalActions(waiting, "p1"));
    expect(legalActions(copy, "p2")).toEqual([{ type: "concede" }]);
    expect(seatToAct(copy)).toBe("p1");

    const keep = copy.players.p1.hand.slice(1).map((card) => card.id);
    const live = reduce(waiting, { type: "mulligan", keep, playerId: "p1", nonce: "json-p1" });
    const thawed = reduce(copy, { type: "mulligan", keep, playerId: "p1", nonce: "json-p1" });
    expect(hashState(thawed.state)).toBe(hashState(live.state));
    expect(thawed.events).toEqual(live.events);
  });
});

describe("R265 a game that ends while the mulligans are open", () => {
  it("R265 closes both mulligans with the game, so no view offers one no one can answer (R216)", () => {
    const begun = beginGame(newGame("r265-concede")).state;
    const waiting = act(begun, { type: "mulligan", keep: [], playerId: "p1" });
    for (const [state, who] of [
      [begun, "p1"],
      [waiting, "p2"],
      [waiting, "p1"],
    ] as const) {
      const over = act(state, { type: "concede", playerId: who });
      expect(over.result?.reason).toBe("concede");
      expect(over.mulligan).toBeUndefined();
      expect(mulliganOwed(over)).toEqual([]);
      for (const seat of SEATS) {
        expect(viewFor(over, seat).pending).toBeNull();
        expect(viewFor(over, seat).mulligan).toBeUndefined();
        expect(legalActions(over, seat)).toEqual([]);
      }
    }
    // A disconnect or the ceiling ends it the same way.
    const dropped = act(begun, { type: "disconnectExpired", player: "p2", playerId: "p2" });
    expect(dropped.mulligan).toBeUndefined();
  });
});

describe("R266 an answer is sealed until both are in", () => {
  it("R266 the other seat sees that a seat is ready and nothing of what it kept", () => {
    const begun = beginGame(newGame("r266")).state;
    const hand = begun.players.p1.hand.map((card) => card.id);
    const keptAll = act(begun, { type: "mulligan", keep: hand, playerId: "p1" });
    const keptNone = act(begun, { type: "mulligan", keep: [], playerId: "p1" });

    // Nothing moves until p2 answers: p1's hand is as it was dealt.
    expect(keptNone.players.p1.hand.map((card) => card.id)).toEqual(hand);

    // p2's view is the same whatever p1 chose (§9.1, rule 7): p1 is ready, and that is all.
    const seen = viewFor(keptAll, "p2");
    expect(viewFor(keptNone, "p2")).toEqual(seen);
    expect(seen.mulligan).toEqual({ youReady: false, opponentReady: true });
    expect(seen.pending).toMatchObject({ forYou: true, kind: "mulligan" });
    expect(JSON.stringify(seen)).not.toContain('"kept"');

    // p1 sees its own answer and waits on p2's, whose options it is never shown.
    const own = viewFor(keptNone, "p1");
    expect(own.mulligan).toEqual({ youReady: true, opponentReady: false, kept: [] });
    expect(own.pending).toEqual({ forYou: false, pendingFor: "p2" });
    expect(viewFor(keptAll, "p1").mulligan?.kept).toEqual(hand);

    // An answer is a set (R221): two spellings of one answer are one state.
    const twoCards = hand.slice(0, 2);
    const forwards = act(begun, { type: "mulligan", keep: twoCards, playerId: "p1" });
    const backwards = act(begun, { type: "mulligan", keep: [...twoCards].reverse(), playerId: "p1" });
    expect(hashState(backwards)).toBe(hashState(forwards));
    expect(viewFor(backwards, "p1").mulligan?.kept).toEqual(twoCards);

    // Before anyone answers, each seat sees its own prompt; after, the window is gone from the view.
    expect(viewFor(begun, "p1").mulligan).toEqual({ youReady: false, opponentReady: false });
    const done = act(keptNone, { type: "mulligan", keep: [], playerId: "p2" });
    for (const seat of SEATS) expect(viewFor(done, seat).mulligan).toBeUndefined();
  });
});

describe("R267 a sealed answer is read against the hand at resolution", () => {
  it("R267 returns only the offered cards it did not keep that are still in the hand; a card that arrived since stays", () => {
    setupCatalog();
    // A cast-on-draw card that reaches into the other seat's hand: it discards one of its cards at
    // random and gives it a new one. p1's replacement draw casts it before p2's answer resolves.
    const meddler: CardDef = {
      id: "fx-r267-meddler",
      index: "R267",
      name: "Meddler (fixture)",
      set: "Core",
      type: "Spell",
      tags: [],
      rarity: "Common",
      token: false,
      cost: 0,
      base: { keywords: [], text: "" },
      radiant: { keywords: [], text: "" },
    };
    const gift = vanillaDeck(1, 39)[0] as string;
    registerCatalog({ ...registeredCatalog(), [meddler.id]: meddler });
    const script = {
      staticFlags: { castOnDraw: true },
      cry: () => [discardRandom({ player: "enemy" }), addToHand({ defId: gift, player: "enemy" })],
    };
    registerScripts({ ...registeredScripts(), [meddler.id]: { base: script, radiant: script } });

    const game = createGame({ seed: "r267", decks: [vanillaDeck(DECK_SIZE, 1), vanillaDeck(DECK_SIZE, 21)] });
    let state = beginGame(game).state;
    state.players.p1.library.unshift(newInstance(state, meddler.id, "p1", { z: "library", player: "p1" }));

    const offered = state.players.p2.hand.map((card) => card.id);
    const kept = offered[0] as string;
    state = act(state, { type: "mulligan", keep: [kept], playerId: "p2" });
    // p1 returns one card; its replacement is the meddler, cast as it is drawn (§2.4, R70).
    state = act(state, { type: "mulligan", keep: state.players.p1.hand.slice(1).map((card) => card.id), playerId: "p1" });

    const side = state.players.p2;
    const discarded = side.graveyard.filter((card) => offered.includes(card.id)).map((card) => card.id);
    expect(discarded).toHaveLength(1);
    const arrived = side.hand.find((card) => card.defId === gift && !offered.includes(card.id));
    expect(arrived, "the card the meddler gave p2 is still in its hand").toBeDefined();
    expect(side.hand.map((card) => card.id)).toContain(kept);
    // Returned: the offered cards p2 did not keep, less the one the meddler discarded.
    const returned = offered.filter((id) => id !== kept && !discarded.includes(id));
    for (const id of returned) {
      expect(side.hand.some((card) => card.id === id)).toBe(false);
      expect(side.library.some((card) => card.id === id)).toBe(true);
    }
    // The kept card, the new one, a replacement for each returned card, and The Coin if dealt.
    const coins = side.hand.filter((card) => card.defId === "t-coin").length;
    expect(side.hand).toHaveLength(2 + returned.length + coins);
  });
});

describe("R268 a mulligan whose clock runs out", () => {
  it("R268 keeps the timing-out seat's whole hand, draws nothing from the rng, and never answers the other seat's", () => {
    const begun = beginGame(newGame("r268")).state;
    const hand = begun.players.p2.hand.map((card) => card.id);

    const timed = reduce(begun, { type: "timeout", playerId: "p2", nonce: "r268-p2" });
    expect(timed.error).toBeUndefined();
    expect(mulliganOwed(timed.state)).toEqual(["p1"]);
    expect(timed.state.mulligan?.p2.keep).toEqual(hand);
    expect(timed.state.rngCursor).toBe(begun.rngCursor);
    expect(timed.state.turn).toBe(0);

    // A second expiry for a seat that has answered does nothing at all.
    const again = reduce(timed.state, { type: "timeout", playerId: "p2", nonce: "r268-p2-again" });
    expect(again.error).toBeUndefined();
    expect(again.state.mulligan).toEqual(timed.state.mulligan);
    expect(again.state.rngCursor).toBe(timed.state.rngCursor);

    // The other seat's expiry answers its own the same way, and the game begins with both hands.
    const p1Hand = begun.players.p1.hand.map((card) => card.id);
    const started = reduce(again.state, { type: "timeout", playerId: "p1", nonce: "r268-p1" });
    expect(started.error).toBeUndefined();
    expect(started.events.some((event) => event.type === "shuffledIn")).toBe(false);
    expect(started.state.turn).toBe(1);
    expect(started.state.active).toBe("p1");
    expect(started.state.players.p1.hand.slice(0, p1Hand.length).map((card) => card.id)).toEqual(p1Hand);
    expect(started.state.players.p2.hand.slice(0, hand.length).map((card) => card.id)).toEqual(hand);
  });
});

describe("R269 a draw offer's lifetime", () => {
  function playing(seed: string): GameState {
    let state = beginGame(newGame(seed)).state;
    for (const player of SEATS) {
      state = act(state, { type: "mulligan", keep: state.players[player].hand.map((card) => card.id), playerId: player });
    }
    return state;
  }

  it("R269 stands on both views until answered or until its offerer's turn ends, and a lapsed offer blocks nothing", () => {
    let state = playing("r269");
    for (const seat of SEATS) expect(viewFor(state, seat).drawOffer).toBeUndefined();

    state = act(state, { type: "offerDraw", playerId: "p1" });
    for (const seat of SEATS) expect(viewFor(state, seat).drawOffer).toEqual({ by: "p1" });
    expect(legalActions(state, "p2")).toContainEqual({ type: "answerDraw", accept: true });
    expect(legalActions(state, "p1").some((action) => action.type === "offerDraw")).toBe(false);

    // p1 plays on and ends the turn without an answer: the offer lapses.
    state = act(state, { type: "endTurn", playerId: "p1" });
    for (const seat of SEATS) expect(viewFor(state, seat).drawOffer).toBeUndefined();
    const late = reduce(state, { type: "answerDraw", accept: true, playerId: "p2", nonce: "r269-late" });
    expect(late.error).toMatch(/no draw offer/);
    expect(state.players.p1.drawOffer.blockedUntil).toBeUndefined();

    // A lapsed offer is not a declined one: p1 may offer again on its next turn (R36 blocks a decline).
    state = act(state, { type: "endTurn", playerId: "p2" });
    expect(state.active).toBe("p1");
    expect(legalActions(state, "p1")).toContainEqual({ type: "offerDraw" });

    // An answered offer is gone at once, from both views.
    state = act(state, { type: "offerDraw", playerId: "p1" });
    state = act(state, { type: "answerDraw", accept: false, playerId: "p2" });
    for (const seat of SEATS) expect(viewFor(state, seat).drawOffer).toBeUndefined();
    expect(legalActions(state, "p1").some((action) => action.type === "offerDraw")).toBe(false);
  });

  it("R269 is gone once the game is over, however it ended (R216)", () => {
    const offered = act(playing("r269-over"), { type: "offerDraw", playerId: "p1" });
    for (const [who, body] of [
      ["p2", { type: "concede" }],
      ["p1", { type: "concede" }],
      ["p1", { type: "ceilingReached" }],
    ] as const) {
      const over = act(offered, { ...body, playerId: who } as ActionInput);
      expect(over.result).not.toBeNull();
      for (const seat of SEATS) expect(viewFor(over, seat).drawOffer).toBeUndefined();
    }
  });

  it("R269 does not survive into a copy of the state as anything but the same offer", () => {
    const state = act(playing("r269-json"), { type: "offerDraw", playerId: "p1" });
    const copy = cloneState(state);
    expect(viewFor(copy, "p2").drawOffer).toEqual({ by: "p1" });
    const accepted = act(copy, { type: "answerDraw", accept: true, playerId: "p2" });
    expect(accepted.result).toEqual({ winner: "draw", reason: "draw-accepted" });
  });
});
