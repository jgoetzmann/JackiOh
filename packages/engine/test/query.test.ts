// `src/query.ts`: the read-only board surface a card script asks its questions with
// (BUILD M3-T1's "scripts never touch state", SPEC §10.9's "a hook may read state to compute an
// effect's arguments; it never writes").
//
// Each accessor is checked against a fact the ENGINE put in the state — a draw, a damage instance,
// a move to the graveyard, a play through `reduce` — rather than against a field the test itself
// assigned, so a test here fails if the accessor stops answering what the engine did. The copy
// tests are the other half of the surface's promise: a card file holds no reference it can write
// the game through, which is the property the acceptance grep is really protecting.

import type { Action, ActionInput, GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { HERO_HEALTH } from "../src/config";
import { loseHealth } from "../src/damage";
import { drawOne } from "../src/draw";
import {
  cardsPlayedThisTurn,
  heroOf,
  playedEarlier,
  playedIdsThisTurn,
  wasPlayedThisTurn,
  zoneCards,
  zoneCount,
} from "../src/query";
import { beginGame, reduce } from "../src/reduce";
import type { CardInstance, GameState } from "../src/state";
import { startTurn } from "../src/turn";
import { moveToZone } from "../src/zones";
import { inHand, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

/** A state in the main phase with nothing dealt, so every pile below is exactly what a test built. */
function board(seed: string): GameState {
  const state = newGame(seed);
  state.turn = 4;
  state.active = "p1";
  state.phase = "main";
  return state;
}

let nonce = 0;
function act(state: GameState, body: ActionInput): GameState {
  nonce += 1;
  const result = reduce(state, { ...body, nonce: `q${nonce}` } as Action);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

/** Past the mulligans, in the main phase of turn 1, so `play` is a legal action. */
function playing(seed: string): GameState {
  let state = beginGame(newGame(seed)).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" });
  // Turn 1 refreshes 1 mana (§2.3) and these tests play two 1-cost fixtures; §2.3 lets current mana
  // sit above max, which is the same thing #6 Mana Well does.
  state.players.p1.mana.current = 4;
  return state;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function events(): GameEvent[] {
  return [];
}

describe("the card-facing read surface (BUILD M3-T1, SPEC §10.9)", () => {
  // -------------------------------------------------------------------------
  // heroOf — #68 Twisted Sorcerer's threshold, #70 Spiteful Stab's missing health.
  // -------------------------------------------------------------------------

  it("heroOf reads the health the engine just took off, for the player named and no other", () => {
    const state = board("hero-health");
    expect(heroOf(state, "p1").health).toBe(HERO_HEALTH);

    loseHealth(sinkFor(state, events()), "p1", 7);

    expect(heroOf(state, "p1").health).toBe(HERO_HEALTH - 7);
    // The accessor is keyed on the player it is given: p2 took nothing.
    expect(heroOf(state, "p2").health).toBe(HERO_HEALTH);
  });

  it("heroOf reads the stored armor field of §4.4 step 2", () => {
    const state = board("hero-armor");
    expect(heroOf(state, "p1").armor).toBe(0);

    // Only `createPlayerState` writes this field today (#84 is blocked on an engine verb), so the
    // test plays the part of whatever eventually will, and the accessor has to see it.
    state.players.p1.hero.armor = 3;

    expect(heroOf(state, "p1").armor).toBe(3);
    expect(heroOf(state, "p2").armor).toBe(0);
  });

  it("heroOf hands back a copy, so a script cannot write a hero's health through it", () => {
    const state = board("hero-copy");
    const hero = heroOf(state, "p1") as { health: number; armor: number };

    hero.health = 1;
    hero.armor = 99;

    expect(state.players.p1.hero).toEqual({ health: HERO_HEALTH, armor: 0 });
    expect(heroOf(state, "p1").health).toBe(HERO_HEALTH);
  });

  // -------------------------------------------------------------------------
  // zoneCards / zoneCount — #30 Archivist, #51 Private Tutor, #71 Intern Stimmy, #83 Transmogulate.
  // -------------------------------------------------------------------------

  it("zoneCards is one player's pile in zone order, the library top first", () => {
    const state = board("zone-order");
    setLibrary(state, "p1", ["fx-1", "fx-2", "fx-3"]);

    expect(zoneCards(state, "p1", "library").map((card) => card.defId)).toEqual(["fx-1", "fx-2", "fx-3"]);

    // "Top" is whatever `drawOne` takes, which is what #30's top-down scan and #51's reveal mean.
    const top = must(zoneCards(state, "p1", "library")[0], "a library card");
    drawOne(sinkFor(state, events()), "p1");

    expect(zoneCards(state, "p1", "hand").map((card) => card.id)).toEqual([top.id]);
    expect(zoneCards(state, "p1", "library").map((card) => card.defId)).toEqual(["fx-2", "fx-3"]);
  });

  it("zoneCount follows the engine moving a card from one pile to another", () => {
    const state = board("zone-count");
    setLibrary(state, "p1", ["fx-1", "fx-2", "fx-3"]);
    inHand(state, "fx-4", "p1", 2);
    expect(zoneCount(state, "p1", "library")).toBe(3);
    expect(zoneCount(state, "p1", "hand")).toBe(2);
    expect(zoneCount(state, "p1", "graveyard")).toBe(0);
    expect(zoneCount(state, "p1", "exile")).toBe(0);

    drawOne(sinkFor(state, events()), "p1");
    expect(zoneCount(state, "p1", "library")).toBe(2);
    expect(zoneCount(state, "p1", "hand")).toBe(3);

    // All four zone names answer, which is what #83 walks and what #70's exile term counts.
    const unit = put(state, "fx-5", slot("p1", "units", 1));
    moveToZone(state, unit, "graveyard");
    expect(zoneCount(state, "p1", "graveyard")).toBe(1);
    expect(zoneCards(state, "p1", "graveyard").map((card) => card.id)).toEqual([unit.id]);

    moveToZone(state, unit, "exile");
    expect(zoneCount(state, "p1", "graveyard")).toBe(0);
    expect(zoneCount(state, "p1", "exile")).toBe(1);
  });

  it("zoneCount reads the player it is given, not the active one (#71's two libraries)", () => {
    const state = board("zone-sides");
    setLibrary(state, "p1", ["fx-1", "fx-2", "fx-3"]);
    setLibrary(state, "p2", ["fx-4"]);

    expect(zoneCount(state, "p1", "library")).toBe(3);
    expect(zoneCount(state, "p2", "library")).toBe(1);
    expect(zoneCards(state, "p2", "library").map((card) => card.defId)).toEqual(["fx-4"]);
  });

  it("zoneCards hands back a copy, so a script cannot push into or empty a zone through it", () => {
    const state = board("zone-copy");
    const library = setLibrary(state, "p1", ["fx-1", "fx-2"]);
    const stray = must(inHand(state, "fx-3", "p1")[0], "a hand card");

    const cards = zoneCards(state, "p1", "library") as CardInstance[];
    cards.push(stray);
    cards.shift();

    expect(zoneCount(state, "p1", "library")).toBe(2);
    expect(zoneCards(state, "p1", "library").map((card) => card.id)).toEqual(library.map((card) => card.id));
    expect(zoneCount(state, "p1", "hand")).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The turn log — #23, #24, #31's one-shot return; #38's Combo X; #39's replay of the turn.
  // -------------------------------------------------------------------------

  it("cardsPlayedThisTurn and playedIdsThisTurn follow the plays, in play order", () => {
    let state = playing("played-log");
    expect(cardsPlayedThisTurn(state, "p1")).toBe(0);
    expect(playedIdsThisTurn(state, "p1")).toEqual([]);

    const first = must(inHand(state, "fx-1", "p1")[0], "a first card");
    const second = must(inHand(state, "fx-2", "p1")[0], "a second card");
    const unplayed = must(inHand(state, "fx-3", "p1")[0], "a third card");

    state = act(state, { type: "play", instanceId: first.id, zone: { row: "units", lane: 1 }, playerId: "p1" });
    // §10.5 step 4 counts the card as it is played, which is the fact #38 subtracts 1 from.
    expect(cardsPlayedThisTurn(state, "p1")).toBe(1);

    state = act(state, { type: "play", instanceId: second.id, zone: { row: "units", lane: 2 }, playerId: "p1" });
    expect(cardsPlayedThisTurn(state, "p1")).toBe(2);
    expect(playedIdsThisTurn(state, "p1")).toEqual([first.id, second.id]);

    expect(wasPlayedThisTurn(state, "p1", first)).toBe(true);
    expect(wasPlayedThisTurn(state, "p1", second.id)).toBe(true);
    expect(wasPlayedThisTurn(state, "p1", unplayed)).toBe(false);

    // The log is per player: p1's plays are not in p2's log, and p2 has played nothing.
    expect(wasPlayedThisTurn(state, "p2", first)).toBe(false);
    expect(cardsPlayedThisTurn(state, "p2")).toBe(0);
    expect(playedIdsThisTurn(state, "p2")).toEqual([]);
  });

  it("startTurn clears the log, so a played-this-turn gate fires once (§5.1, R68)", () => {
    let state = playing("played-cleared");
    const card = must(inHand(state, "fx-1", "p1")[0], "a card");
    state = act(state, { type: "play", instanceId: card.id, zone: { row: "units", lane: 1 }, playerId: "p1" });
    expect(wasPlayedThisTurn(state, "p1", card)).toBe(true);

    startTurn(sinkFor(state, events()), "p1");

    expect(cardsPlayedThisTurn(state, "p1")).toBe(0);
    expect(playedIdsThisTurn(state, "p1")).toEqual([]);
    expect(wasPlayedThisTurn(state, "p1", card)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // playedEarlier — §6.2's Combo X "at play time" (#10, and §10.5 step 5's #38 and #78).
  // -------------------------------------------------------------------------

  it("playedEarlier counts a played card's own place in the log, and every play so far for a card in hand", () => {
    let state = playing("played-earlier");
    const first = must(inHand(state, "fx-1", "p1")[0], "a first card");
    const second = must(inHand(state, "fx-2", "p1")[0], "a second card");
    const held = must(inHand(state, "fx-3", "p1")[0], "a card kept in hand");

    // Nothing played yet: a card in hand would be the first play.
    expect(playedEarlier(state, "p1", held)).toBe(0);

    state = act(state, { type: "play", instanceId: first.id, zone: { row: "units", lane: 1 }, playerId: "p1" });
    state = act(state, { type: "play", instanceId: second.id, zone: { row: "units", lane: 2 }, playerId: "p1" });

    // Its place in the log, by instance or by id: nothing before the first play, one before the second.
    expect(playedEarlier(state, "p1", first.id)).toBe(0);
    expect(playedEarlier(state, "p1", must(state.players.p1.units[1]?.[0], "the second card on the field"))).toBe(1);
    // A card still in hand has not been played: both plays so far are earlier than its would be.
    expect(playedEarlier(state, "p1", held.id)).toBe(2);
    // An id the log does not hold is read the same way.
    expect(playedEarlier(state, "p1", "no-such-card")).toBe(2);
    // The log is per player: p1's plays are not earlier than anything of p2's.
    expect(playedEarlier(state, "p2", first.id)).toBe(0);
  });

  it("playedEarlier counts a card played twice this turn from its latest play", () => {
    let state = playing("played-earlier-twice");
    const twice = must(inHand(state, "fx-1", "p1")[0], "the card played twice");
    const other = must(inHand(state, "fx-2", "p1")[0], "another card");

    state = act(state, { type: "play", instanceId: twice.id, zone: { row: "units", lane: 1 }, playerId: "p1" });
    state = act(state, { type: "play", instanceId: other.id, zone: { row: "units", lane: 2 }, playerId: "p1" });
    // Back to the hand (a bounce), and played again: the log holds it twice.
    moveToZone(state, must(state.players.p1.units[0]?.[0], "the first card on the field"), "hand");
    expect(playedEarlier(state, "p1", twice.id)).toBe(2);
    state = act(state, { type: "play", instanceId: twice.id, zone: { row: "units", lane: 3 }, playerId: "p1" });

    expect(playedIdsThisTurn(state, "p1")).toEqual([twice.id, other.id, twice.id]);
    expect(playedEarlier(state, "p1", twice.id)).toBe(2);
  });

  it("playedEarlier does not count a card cast while the play resolved, which is played after it (R70)", () => {
    let state = playing("played-earlier-cast");
    // Stockpile draws 2, and the top of p1's library is Hinder, which casts on draw (§2.4).
    setLibrary(state, "p1", ["fx-hinder", "fx-5", "fx-6"]);
    const stockpile = must(inHand(state, "fx-stockpile", "p1")[0], "Stockpile");

    state = act(state, { type: "play", instanceId: stockpile.id, playerId: "p1" });

    // The cast counts as a play (R70), logged after the play whose draw made it.
    const log = playedIdsThisTurn(state, "p1");
    expect(log[0]).toBe(stockpile.id);
    expect(log).toHaveLength(2);
    expect(cardsPlayedThisTurn(state, "p1")).toBe(2);
    // So the play that cast it still has nothing before it, and the cast has the play before it.
    expect(playedEarlier(state, "p1", stockpile.id)).toBe(0);
    expect(playedEarlier(state, "p1", must(log[1], "the cast"))).toBe(1);
  });

  it("playedEarlier with no card takes the latest play as the running script's own (R127)", () => {
    let state = playing("played-earlier-null");
    expect(playedEarlier(state, "p1", null)).toBe(0);
    const first = must(inHand(state, "fx-1", "p1")[0], "a first card");
    const second = must(inHand(state, "fx-2", "p1")[0], "a second card");
    state = act(state, { type: "play", instanceId: first.id, zone: { row: "units", lane: 1 }, playerId: "p1" });
    expect(playedEarlier(state, "p1", null)).toBe(0);
    state = act(state, { type: "play", instanceId: second.id, zone: { row: "units", lane: 2 }, playerId: "p1" });
    expect(playedEarlier(state, "p1", null)).toBe(1);
  });

  it("playedIdsThisTurn hands back a copy, so a script cannot forge a play", () => {
    let state = playing("played-copy");
    const card = must(inHand(state, "fx-1", "p1")[0], "a card");
    const other = must(inHand(state, "fx-2", "p1")[0], "another card");
    state = act(state, { type: "play", instanceId: card.id, zone: { row: "units", lane: 1 }, playerId: "p1" });

    const ids = playedIdsThisTurn(state, "p1") as string[];
    ids.push(other.id);
    ids.length = 0;

    expect(playedIdsThisTurn(state, "p1")).toEqual([card.id]);
    expect(wasPlayedThisTurn(state, "p1", other)).toBe(false);
    expect(cardsPlayedThisTurn(state, "p1")).toBe(1);
  });
});
