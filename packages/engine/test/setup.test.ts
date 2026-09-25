import { describe, expect, it } from "vitest";
import type { CardDef } from "@jackioh/shared";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { COIN_DEF_ID, DECK_SIZE, OPENING_COINS, OPENING_DRAW } from "../src/config";
import { beginGame, reduce } from "../src/reduce";
import { mulliganOwed, mulliganPromptFor } from "../src/setup";
import { createGame, type GameState } from "../src/state";
import { vanillaDeck } from "./fixtures/catalog";
import { newGame, setupCatalog } from "./fixtures/harness";
import { goingLong, heroicPower, HERO_POWERS } from "./fixtures/scripts";

function started(seed = "setup", decks?: [string[], string[]]): GameState {
  return beginGame(newGame(seed, decks)).state;
}

describe("setup (M1-T5)", () => {
  it("deals 3 and 4 from shuffled libraries and opens both mulligans at once (R265)", () => {
    const state = started();
    expect(state.players.p1.hand).toHaveLength(OPENING_DRAW[0] as number);
    expect(state.players.p2.hand).toHaveLength(OPENING_DRAW[1] as number);
    expect(state.players.p1.library).toHaveLength(DECK_SIZE - 3);
    expect(state.players.p2.library).toHaveLength(DECK_SIZE - 4);
    expect(state.phase).toBe("mulligan");
    // §10.1's one prompt stays free: the two mulligans are their own step.
    expect(state.pending).toBeNull();
    expect(mulliganOwed(state)).toEqual(["p1", "p2"]);
    for (const player of ["p1", "p2"] as const) {
      const prompt = mulliganPromptFor(state, player);
      expect(prompt?.kind).toBe("mulligan");
      expect(prompt?.playerId).toBe(player);
      expect(prompt?.options.map((option) => option.key)).toEqual(state.players[player].hand.map((c) => c.id));
    }
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
      // p2's mulligan, so turn 1's draw (p1's) does not touch the hand under test.
      const hand = state.players.p2.hand;
      const keep = [hand[0]?.id as string];
      const returned = hand.slice(1).map((c) => c.id);

      const sealed = reduce(state, { type: "mulligan", keep, playerId: "p2", nonce: `n${i}` });
      expect(sealed.error).toBeUndefined();
      const after = reduce(sealed.state, {
        type: "mulligan",
        keep: state.players.p1.hand.map((c) => c.id),
        playerId: "p1",
        nonce: `k${i}`,
      });
      expect(after.error).toBeUndefined();

      const newHand = after.state.players.p2.hand.map((c) => c.id);
      expect(newHand).toHaveLength(hand.length);
      expect(newHand).toContain(keep[0]);
      for (const id of returned) expect(newHand).not.toContain(id);
      for (const id of returned) {
        expect(after.state.players.p2.library.some((c) => c.id === id)).toBe(true);
      }
      // R9's order, read off the events: every replacement is drawn before the first shuffle-back.
      const own = after.events.filter(
        (event) => (event.type === "drawn" || event.type === "shuffledIn") && event.player === "p2",
      );
      const firstShuffle = own.findIndex((event) => event.type === "shuffledIn");
      expect(own.slice(0, firstShuffle).every((event) => event.type === "drawn")).toBe(true);
      expect(own.slice(firstShuffle).every((event) => event.type === "shuffledIn")).toBe(true);
      expect(firstShuffle).toBe(returned.length);
    }
  });

  it("waits for both mulligans, then starts turn 1 with a draw (R10, R265)", () => {
    const state = started("flow");
    const first = reduce(state, {
      type: "mulligan",
      keep: state.players.p1.hand.map((c) => c.id),
      playerId: "p1",
      nonce: "m1",
    }).state;
    // p1's answer is sealed: nothing moves until p2 has answered too (R266).
    expect(first.pending).toBeNull();
    expect(first.phase).toBe("mulligan");
    expect(mulliganOwed(first)).toEqual(["p2"]);
    expect(first.players.p1.hand).toEqual(state.players.p1.hand);

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

describe("The Coin (R244)", () => {
  /** A stand-in for the catalog's The Coin: the engine deals the id and reads nothing else of it. */
  const coin: CardDef = {
    id: COIN_DEF_ID,
    index: "T-coin",
    name: "Fixture Coin",
    set: "Core",
    type: "Spell",
    tags: ["Token"],
    rarity: "Token",
    token: true,
    cost: 0,
    base: { keywords: [], text: "gain 1 mana" },
    radiant: { keywords: [], text: "gain 2 mana" },
  };

  function keepAll(state: GameState): GameState {
    let next = state;
    for (const player of ["p1", "p2"] as const) {
      next = reduce(next, {
        type: "mulligan",
        keep: next.players[player].hand.map((c) => c.id),
        playerId: player,
        nonce: `coin-${player}`,
      }).state;
    }
    return next;
  }

  it("R244 deals each seat its OPENING_COINS copies once both mulligans are answered, as its last card", () => {
    setupCatalog();
    registerCatalog({ ...registeredCatalog(), [coin.id]: coin });
    const created = createGame({ seed: "coin", decks: [vanillaDeck(DECK_SIZE, 1), vanillaDeck(DECK_SIZE, 21)] });
    const dealt = beginGame(created).state;
    expect(dealt.players.p2.hand.some((c) => c.defId === COIN_DEF_ID), "not during the deal").toBe(false);

    const state = keepAll(dealt);

    expect(state.turn).toBe(1);
    (["p1", "p2"] as const).forEach((player, seat) => {
      const hand = state.players[player].hand;
      expect(hand.filter((c) => c.defId === COIN_DEF_ID)).toHaveLength(OPENING_COINS[seat] ?? 0);
    });
    const p2 = state.players.p2.hand;
    expect(p2).toHaveLength((OPENING_DRAW[1] as number) + 1);
    expect(p2[p2.length - 1]?.defId).toBe(COIN_DEF_ID);
    setupCatalog();
  });

  it("R244 a registered catalog without The Coin deals none, which is how the engine's fixture catalogs run", () => {
    const state = keepAll(started("no-coin"));
    expect(registeredCatalog()[COIN_DEF_ID]).toBeUndefined();
    expect(state.players.p2.hand).toHaveLength(OPENING_DRAW[1] as number);
  });
});
