import { describe, expect, it } from "vitest";
import { PLAYER_IDS } from "@jackioh/shared";
import { BACKROW_ZONES, DECK_SIZE, HERO_HEALTH, UNIT_ZONES } from "../src/config";
import { createGame } from "../src/state";
import { tokenDef, vanillaCatalog, vanillaDeck } from "./fixtures/catalog";

const catalog = vanillaCatalog();
const deckA = vanillaDeck(DECK_SIZE, 1);
const deckB = vanillaDeck(DECK_SIZE, 21);

function game(): ReturnType<typeof createGame> {
  return createGame({ seed: "state-test", decks: [deckA, deckB], catalog });
}

describe("createGame (M1-T1)", () => {
  it("starts two players at full health with empty zones, turn 0 and no prompt", () => {
    const state = game();

    expect(Object.keys(state.players)).toEqual([...PLAYER_IDS]);
    expect(state.turn).toBe(0);
    expect(state.phase).toBe("setup");
    expect(state.pending).toBeNull();
    expect(state.result).toBeNull();
    expect(state.rngCursor).toBe(0);
    expect(state.counters).toEqual({ drawn: 0, played: 0, destroyed: 0, exiled: 0 });

    for (const player of PLAYER_IDS) {
      const side = state.players[player];
      expect(side.hero.health).toBe(HERO_HEALTH);
      expect(side.hand).toEqual([]);
      expect(side.graveyard).toEqual([]);
      expect(side.exile).toEqual([]);
      expect(side.library).toHaveLength(DECK_SIZE);
      expect(side.units).toHaveLength(UNIT_ZONES);
      expect(side.backrow).toHaveLength(BACKROW_ZONES);
      expect(side.units.every((zone) => zone === null)).toBe(true);
      expect(side.backrow.every((zone) => zone === null)).toBe(true);
      expect(side.locks.units).toEqual(Array(UNIT_ZONES).fill(false));
      expect(side.turnsStarted).toBe(0);
    }
  });

  it("gives every card a unique instance owned by its player, in deck order", () => {
    const state = game();
    const ids = PLAYER_IDS.flatMap((p) => state.players[p].library.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(state.players.p1.library.map((c) => c.defId)).toEqual(deckA);
    expect(state.players.p1.library.every((c) => c.owner === "p1" && c.controller === "p1")).toBe(true);
    expect(state.players.p2.library.every((c) => c.owner === "p2")).toBe(true);
    expect(state.players.p1.library[0]?.zone).toEqual({ z: "library", player: "p1" });
  });

  it("is deterministic and serializable", () => {
    expect(JSON.parse(JSON.stringify(game()))).toEqual(game());
  });

  it("rejects a deck that is not exactly 20 cards, naming the rule", () => {
    expect(() => createGame({ seed: "s", decks: [vanillaDeck(19, 1), deckB], catalog })).toThrow(/exactly 20 cards \(§2.6 L2\)/);
    expect(() => createGame({ seed: "s", decks: [deckA, vanillaDeck(21, 21)], catalog })).toThrow(/p2: deck must hold exactly 20/);
  });

  it("rejects duplicate card ids, naming the rule", () => {
    const withDuplicate = [...vanillaDeck(19, 1), "fx-1"];
    expect(() => createGame({ seed: "s", decks: [withDuplicate, deckB], catalog })).toThrow(/appears twice.*§2.6 L3/);
  });

  it("rejects a Token-tagged card, naming the rule", () => {
    const token = tokenDef("rush");
    const withToken = [...vanillaDeck(19, 1), token.id];
    expect(() => createGame({ seed: "s", decks: [withToken, deckB], catalog })).toThrow(/is a Token card.*§2.6 L3/);
  });

  it("rejects a card that is not in the catalog, naming the rule", () => {
    const withGhost = [...vanillaDeck(19, 1), "fx-does-not-exist"];
    expect(() => createGame({ seed: "s", decks: [withGhost, deckB], catalog })).toThrow(/not in the catalog \(§9.4 L6\)/);
  });
});
