import type { CardDef, GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { CAST_ON_DRAW_CHAIN_CAP, HAND_CAP, HERO_HEALTH, LIBRARY_CAP } from "../src/config";
import { draw, drawOne, shuffleIntoLibrary } from "../src/draw";
import { draw as drawEffect } from "../src/effects/draw";
import { registerScripts, registeredScripts } from "../src/scripts";
import { newInstance, type GameState } from "../src/state";
import { eventsOfType, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";
import { antiOneshot, cnVirus, hinder, infiniteReserves } from "./fixtures/scripts";

function drawFrom(state: GameState, library: string[], count = 1): { events: GameEvent[]; state: GameState } {
  setLibrary(state, "p1", library);
  const events: GameEvent[] = [];
  draw(sinkFor(state, events), "p1", count);
  return { events, state };
}

describe("draw (M1-T7)", () => {
  it("takes the top card into the hand and counts the draw", () => {
    const state = newGame();
    const { events } = drawFrom(state, ["fx-1", "fx-2"]);
    expect(state.players.p1.hand.map((c) => c.defId)).toEqual(["fx-1"]);
    expect(state.players.p1.library.map((c) => c.defId)).toEqual(["fx-2"]);
    expect(state.counters.drawn).toBe(1);
    expect(eventsOfType(events, "drawn")).toHaveLength(1);
  });

  it("casts a drawn Hinder, applies the opponent's modifier, and the hand gains the next card", () => {
    const state = newGame();
    const { events } = drawFrom(state, [hinder.id, "fx-2"]);

    expect(state.players.p2.mana.nextTurnMod).toBe(-1);
    expect(state.players.p1.hand.map((c) => c.defId)).toEqual(["fx-2"]);
    expect(state.players.p1.graveyard.map((c) => c.defId)).toEqual([hinder.id]);
    expect(state.players.p1.turnLog.cardsPlayed).toBe(1);
    expect(state.counters.played).toBe(1);
    expect(state.counters.drawn).toBe(2);
    expect(eventsOfType(events, "cardPlayed")[0]?.costPaid).toBe(0);
  });

  it("deals 1, 2 then 3 fatigue damage on three empty draws (R3)", () => {
    const state = newGame();
    const { events } = drawFrom(state, [], 3);
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH - 6);
    expect(state.players.p1.fatigueCount).toBe(3);
    expect(eventsOfType(events, "damage").map((e) => e.amount)).toEqual([1, 2, 3]);
  });

  it("burns the eleventh card to the graveyard while still counting the draw (R4)", () => {
    const state = newGame();
    const { events } = drawFrom(
      state,
      Array.from({ length: HAND_CAP + 1 }, (_, i) => `fx-${i + 1}`),
      HAND_CAP + 1,
    );

    expect(state.players.p1.hand).toHaveLength(HAND_CAP);
    expect(state.players.p1.graveyard.map((c) => c.defId)).toEqual([`fx-${HAND_CAP + 1}`]);
    expect(state.counters.drawn).toBe(HAND_CAP + 1);
    expect(eventsOfType(events, "burned")).toHaveLength(1);
  });

  it("CN-Virus deals 1 through the pipeline, shuffles 2 copies and draws again", () => {
    const state = newGame();
    const { events } = drawFrom(state, [cnVirus.id, "fx-2"]);

    expect(state.players.p1.hero.health).toBe(HERO_HEALTH - 1);
    expect(state.players.p1.library.filter((c) => c.defId === cnVirus.id)).toHaveLength(2);
    expect(state.players.p1.hand.map((c) => c.defId)).toEqual(["fx-2"]);
    expect(eventsOfType(events, "shuffledIn")).toHaveLength(2);
    expect(state.players.p1.graveyard.map((c) => c.defId)).toEqual([cnVirus.id]);
  });

  it("Anti-oneshot Armor caps the hero's damage, and armor can reduce a virus to nothing (R63)", () => {
    const state = newGame();
    put(state, antiOneshot.id, slot("p1", "backrow", 1));
    state.players.p1.hero.armor = 2;
    const { events } = drawFrom(state, [cnVirus.id, "fx-2"]);

    expect(state.players.p1.hero.health).toBe(HERO_HEALTH);
    expect(eventsOfType(events, "damage")).toHaveLength(0);
    expect(state.players.p1.library.filter((c) => c.defId === cnVirus.id)).toHaveLength(2);
  });

  it("stops a cast-on-draw chain at the cap and leaves the next card in hand (R58)", () => {
    const state = newGame();
    state.players.p1.hero.armor = 5; // keep the hero alive; the cap is what ends the chain
    const { events } = drawFrom(state, Array.from({ length: 40 }, () => cnVirus.id));

    expect(eventsOfType(events, "cardPlayed")).toHaveLength(CAST_ON_DRAW_CHAIN_CAP);
    expect(state.players.p1.hand.map((c) => c.defId)).toEqual([cnVirus.id]);
  });

  it("R217 counts the casts of a draw a cast makes into the chain that cast it, so the cap bounds them all", () => {
    // A cast-on-draw Spell whose own text draws 1, the shape /fullsend's Combo draw gives any cast
    // (R70): every draw it makes lands on another one, nested inside the cast that made it.
    const drawer: CardDef = {
      id: "fx-drawing-cast",
      index: "fx-drawing-cast",
      name: "Drawing cast (fixture)",
      set: "Core",
      type: "Spell",
      tags: [],
      rarity: "Common",
      token: false,
      cost: 0,
      base: { keywords: [], text: "" },
      radiant: { keywords: [], text: "" },
    };
    const state = newGame();
    registerCatalog({ ...registeredCatalog(), [drawer.id]: drawer });
    const script = { staticFlags: { castOnDraw: true }, cry: () => [drawEffect({ count: 1 })] };
    registerScripts({ ...registeredScripts(), [drawer.id]: { base: script, radiant: script } });
    const { events } = drawFrom(state, Array.from({ length: 40 }, () => drawer.id));

    // One draw set all of it off, so it is one chain: 20 casts, however deeply they nested, and the
    // cast-on-draw card each open draw then met went to the hand uncast (R58).
    expect(eventsOfType(events, "cardPlayed")).toHaveLength(CAST_ON_DRAW_CHAIN_CAP);
    expect(state.players.p1.hand.every((card) => card.defId === drawer.id)).toBe(true);
    // The draw that began the chain closed it (R217).
    expect(state.castChain).toBeUndefined();
  });

  it("Infinite Reserves turns an empty-library draw into a Rush Token card with no fatigue (#75)", () => {
    const state = newGame();
    put(state, infiniteReserves.id, slot("p1", "backrow", 2));
    const { events } = drawFrom(state, []);

    expect(state.players.p1.fatigueCount).toBe(0);
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH);
    expect(state.players.p1.hand).toHaveLength(1);
    expect(eventsOfType(events, "damage")).toHaveLength(0);
  });

  it("R58 casts a cast-on-draw card even when the hand is full", () => {
    const state = newGame();
    // Fill the hand to the cap, then draw Hinder with one more card behind it.
    for (let i = 0; i < HAND_CAP; i += 1) {
      const filler = newInstance(state, "fx-1", "p1", { z: "hand", player: "p1" });
      state.players.p1.hand.push(filler);
    }
    const { events } = drawFrom(state, [hinder.id, "fx-2"]);

    expect(state.players.p1.hand).toHaveLength(HAND_CAP);
    expect(state.players.p2.mana.nextTurnMod).toBe(-1); // it was cast, not burned
    expect(eventsOfType(events, "cardPlayed")).toHaveLength(1);
    // The card drawn behind it had nowhere to go, so that one burned.
    expect(eventsOfType(events, "burned")).toHaveLength(1);
    expect(state.players.p1.graveyard.map((c) => c.defId)).toContain(hinder.id);
  });

  it("drawOne reports what happened", () => {
    const state = newGame();
    setLibrary(state, "p1", [hinder.id, "fx-2"]);
    const sink = sinkFor(state);
    expect(drawOne(sink, "p1")).toBe("cast");
    expect(drawOne(sink, "p1")).toBe("fatigue");
  });
});

describe("library cap (R80, M1-T7)", () => {
  it("creates nothing once a library holds 60 cards", () => {
    const state = newGame();
    setLibrary(state, "p1", Array.from({ length: LIBRARY_CAP }, () => "fx-1"));
    const sink = sinkFor(state);
    const fresh = newInstance(state, "fx-2", "p1", { z: "library", player: "p1" });

    expect(shuffleIntoLibrary(sink, fresh, false)).toBe("dropped");
    expect(state.players.p1.library).toHaveLength(LIBRARY_CAP);
    expect(state.players.p1.graveyard).toHaveLength(0);
  });

  it("sends an existing card to its owner's graveyard instead", () => {
    const state = newGame();
    setLibrary(state, "p1", Array.from({ length: LIBRARY_CAP }, () => "fx-1"));
    const sink = sinkFor(state);
    const card = newInstance(state, "fx-2", "p1", { z: "hand", player: "p1" });
    state.players.p1.hand.push(card);

    expect(shuffleIntoLibrary(sink, card, true)).toBe("dropped");
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([card.id]);
  });

  it("shuffles into a random position below the cap", () => {
    const state = newGame();
    setLibrary(state, "p1", ["fx-1", "fx-2", "fx-3"]);
    const sink = sinkFor(state);
    const card = newInstance(state, "fx-4", "p1", { z: "library", player: "p1" });

    expect(shuffleIntoLibrary(sink, card, false)).toBe("library");
    expect(state.players.p1.library).toHaveLength(4);
    expect(state.players.p1.library.some((c) => c.id === card.id)).toBe(true);
  });
});
