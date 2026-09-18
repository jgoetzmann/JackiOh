import { describe, expect, it } from "vitest";
import { DECK_SIZE, OPENING_DRAW } from "../src/config";
import { beginGame, reduce } from "../src/reduce";
import type { GameState } from "../src/state";
import { vanillaDeck } from "./fixtures/catalog";
import { newGame } from "./fixtures/harness";
import { goingLong, heroicPower, HERO_POWERS } from "./fixtures/scripts";

function started(seed = "setup", decks?: [string[], string[]]): GameState {
  return beginGame(newGame(seed, decks)).state;
}

describe("setup (M1-T5)", () => {
  it("deals 3 and 4 from shuffled libraries and opens the first mulligan", () => {
    const state = started();
    expect(state.players.p1.hand).toHaveLength(OPENING_DRAW[0] as number);
    expect(state.players.p2.hand).toHaveLength(OPENING_DRAW[1] as number);
    expect(state.players.p1.library).toHaveLength(DECK_SIZE - 3);
    expect(state.players.p2.library).toHaveLength(DECK_SIZE - 4);
    expect(state.phase).toBe("mulligan");
    expect(state.pending?.kind).toBe("mulligan");
    expect(state.pending?.playerId).toBe("p1");
  });

  it("shuffles: the opening hand is not the top of the deck list on every seed", () => {
    const orders = new Set(
      ["a", "b", "c", "d", "e"].map((seed) =>
        started(seed).players.p1.hand.map((c) => c.defId).join(","),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  it("puts every Quickdraw card in the opening hand and draws that many fewer (§6.2)", () => {
    const deck = [goingLong.id, heroicPower.id, ...vanillaDeck(DECK_SIZE - 2, 1)];
    const state = started("quickdraw", [deck, vanillaDeck(DECK_SIZE, 21)]);
    const hand = state.players.p1.hand.map((c) => c.defId);

    expect(hand).toContain(goingLong.id);
    expect(hand).toContain(heroicPower.id);
    expect(hand).toHaveLength(OPENING_DRAW[0] as number);
    expect(state.players.p1.library).toHaveLength(DECK_SIZE - (OPENING_DRAW[0] as number));
    // Two Quickdraw cards and an opening draw of 3 leaves exactly one random draw.
    expect(hand.filter((defId) => defId !== goingLong.id && defId !== heroicPower.id)).toHaveLength(1);
  });

  it("draws no random cards when Quickdraw already fills the opening hand", () => {
    const quickdrawDeck = [goingLong.id, heroicPower.id, ...vanillaDeck(DECK_SIZE - 2, 1)];
    const state = started("qd-full", [vanillaDeck(DECK_SIZE, 21), quickdrawDeck]);
    expect(state.players.p2.hand).toHaveLength(OPENING_DRAW[1] as number);
  });

  it("R9: replacements are drawn before the returned cards are shuffled back", () => {
    for (let i = 0; i < 100; i += 1) {
      const state = started(`mull-${i}`);
      const hand = state.players.p1.hand;
      const keep = [hand[0]?.id as string];
      const returned = hand.slice(1).map((c) => c.id);

      const after = reduce(state, { type: "mulligan", keep, playerId: "p1", nonce: `n${i}` });
      expect(after.error).toBeUndefined();

      const newHand = after.state.players.p1.hand.map((c) => c.id);
      expect(newHand).toHaveLength(hand.length);
      expect(newHand).toContain(keep[0]);
      for (const id of returned) expect(newHand).not.toContain(id);
      for (const id of returned) {
        expect(after.state.players.p1.library.some((c) => c.id === id)).toBe(true);
      }
    }
  });

  it("moves on to the opponent's mulligan, then starts turn 1 with a draw (R10)", () => {
    const state = started("flow");
    const first = reduce(state, {
      type: "mulligan",
      keep: state.players.p1.hand.map((c) => c.id),
      playerId: "p1",
      nonce: "m1",
    }).state;
    expect(first.pending?.playerId).toBe("p2");

    const second = reduce(first, {
      type: "mulligan",
      keep: first.players.p2.hand.map((c) => c.id),
      playerId: "p2",
      nonce: "m2",
    }).state;

    expect(second.pending).toBeNull();
    expect(second.phase).toBe("main");
    expect(second.turn).toBe(1);
    expect(second.active).toBe("p1");
    expect(second.players.p1.hand).toHaveLength((OPENING_DRAW[0] as number) + 1);
    expect(second.players.p1.mana).toMatchObject({ current: 1, max: 1 });
  });

  it("R43: Heroic Power rolls its power during setup, deterministically from the seed", () => {
    const deck = [heroicPower.id, ...vanillaDeck(DECK_SIZE - 1, 1)];
    const decks: [string[], string[]] = [deck, vanillaDeck(DECK_SIZE, 21)];

    const power = (seed: string): unknown => {
      let state = started(seed, decks);
      state = reduce(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1", nonce: "a" }).state;
      state = reduce(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2", nonce: "b" }).state;
      const card = state.players.p1.hand.find((c) => c.defId === heroicPower.id);
      return card?.memory.power;
    };

    const first = power("power-seed");
    expect(HERO_POWERS).toContain(first);
    expect(power("power-seed")).toBe(first);
  });

  it("R43 rolls a power for a Heroic Power the mulligan returned to the library", () => {
    const deck = [heroicPower.id, ...vanillaDeck(DECK_SIZE - 1, 1)];
    let state = started("mulliganed-power", [deck, vanillaDeck(DECK_SIZE, 21)]);

    // Quickdraw put it in the opening hand; return it, so it is in the library at start of game.
    const keep = state.players.p1.hand.filter((c) => c.defId !== heroicPower.id).map((c) => c.id);
    expect(keep).toHaveLength(state.players.p1.hand.length - 1);
    state = reduce(state, { type: "mulligan", keep, playerId: "p1", nonce: "mp1" }).state;
    state = reduce(state, {
      type: "mulligan",
      keep: state.players.p2.hand.map((c) => c.id),
      playerId: "p2",
      nonce: "mp2",
    }).state;

    const side = state.players.p1;
    const card = [...side.library, ...side.hand].find((c) => c.defId === heroicPower.id);
    expect(card, "the returned Heroic Power is in the library or back in hand").toBeDefined();
    expect(HERO_POWERS).toContain(card?.memory.power);
  });
});
