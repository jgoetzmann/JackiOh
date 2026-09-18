import { describe, expect, it } from "vitest";
import { DECK_SIZE } from "../src/config";
import { createGame, newInstance, type CardInstance, type GameState } from "../src/state";
import {
  activeUnitsOf,
  adjacent,
  cardAt,
  dormantUnitsOf,
  fillBoardZones,
  firstFreeZone,
  isOpen,
  lockZone,
  moveToZone,
  openZones,
  placeOnField,
  removeFromField,
  reserveZone,
  ringNeighbor,
  ringOrder,
  slotsOf,
  type ZoneSlot,
} from "../src/zones";
import { spellDef, tokenDef, unitDef, vanillaCatalog, vanillaDeck } from "./fixtures/catalog";

const rushToken = tokenDef("rush");
const spellToken = { ...spellDef(900), id: "fx-token-spell", index: "T-spell", token: true, tags: ["Token"] as const };
const stackUnit = unitDef(500, { keywords: [{ kind: "Stack" }] });

const catalog = {
  ...vanillaCatalog(),
  [rushToken.id]: rushToken,
  [spellToken.id]: { ...spellToken, tags: [...spellToken.tags] },
  [stackUnit.id]: stackUnit,
};

function game(): GameState {
  return createGame({ seed: "zones", decks: [vanillaDeck(DECK_SIZE, 1), vanillaDeck(DECK_SIZE, 21)], catalog });
}

function put(state: GameState, defId: string, ref: ZoneSlot, stack = false): CardInstance {
  const card = newInstance(state, defId, ref.player, { z: "hand", player: ref.player });
  const ok = placeOnField(state, card, ref, { stack });
  expect(ok).toBe(true);
  return card;
}

const unitSlot = (player: "p1" | "p2", lane: number): ZoneSlot => ({ player, row: "units", lane });
const backSlot = (player: "p1" | "p2", lane: number): ZoneSlot => ({ player, row: "backrow", lane });

describe("adjacency (M1-T4)", () => {
  it("lane 1 has one neighbour, lane 3 has two, and never across sides", () => {
    expect(adjacent(unitSlot("p1", 1)).map((s) => s.lane)).toEqual([2]);
    expect(adjacent(unitSlot("p1", 3)).map((s) => s.lane)).toEqual([2, 4]);
    expect(adjacent(unitSlot("p1", 5)).map((s) => s.lane)).toEqual([4]);
    expect(adjacent(unitSlot("p1", 3)).every((s) => s.player === "p1" && s.row === "units")).toBe(true);
    expect(adjacent(backSlot("p2", 2)).map((s) => s.lane)).toEqual([1, 3]);
  });
});

describe("rotation rings (R14, M1-T4)", () => {
  it("runs your lanes 1-5 then the opponent's 5-1", () => {
    expect(ringOrder("units", "p1").map((s) => `${s.player}${s.lane}`)).toEqual([
      "p11", "p12", "p13", "p14", "p15", "p25", "p24", "p23", "p22", "p21",
    ]);
  });

  it("rotating right from your lane 5 lands on the opponent's lane 5", () => {
    expect(ringNeighbor(unitSlot("p1", 5), "right", "p1")).toEqual(unitSlot("p2", 5));
  });

  it("rotating right from the opponent's lane 1 lands on your lane 1", () => {
    expect(ringNeighbor(unitSlot("p2", 1), "right", "p1")).toEqual(unitSlot("p1", 1));
  });

  it("rotating left is the inverse of rotating right", () => {
    for (const slot of ringOrder("units", "p2")) {
      const right = ringNeighbor(slot, "right", "p2");
      expect(ringNeighbor(right, "left", "p2")).toEqual(slot);
    }
  });

  it("keeps the backrow ring independent of the unit ring", () => {
    expect(ringNeighbor(backSlot("p1", 5), "right", "p1")).toEqual(backSlot("p2", 5));
    expect(ringOrder("backrow", "p1").every((s) => s.row === "backrow")).toBe(true);
  });
});

describe("locks and free zones (M1-T4)", () => {
  it("a summon into a full row finds no zone and changes nothing", () => {
    const state = game();
    for (const lane of [1, 2, 3, 4, 5]) put(state, "fx-1", unitSlot("p1", lane));
    expect(firstFreeZone(state, "p1", "units")).toBeNull();

    const before = JSON.parse(JSON.stringify(state)) as GameState;
    const extra = newInstance(state, "fx-2", "p1", { z: "hand", player: "p1" });
    extra.id = "no-zone-probe";
    expect(placeOnField(state, extra, unitSlot("p1", 3))).toBe(false);
    expect(activeUnitsOf(state, "p1")).toHaveLength(5);
    expect(state.players.p1.units).toEqual(before.players.p1.units);
  });

  it("a locked zone refuses a summon and stays locked after its occupant leaves", () => {
    const state = game();
    const card = put(state, "fx-1", unitSlot("p1", 2));
    lockZone(state, unitSlot("p1", 2));
    removeFromField(state, card);

    expect(cardAt(state, unitSlot("p1", 2))).toBeNull();
    expect(isOpen(state, unitSlot("p1", 2))).toBe(false);
    expect(placeOnField(state, newInstance(state, "fx-3", "p1", { z: "hand", player: "p1" }), unitSlot("p1", 2))).toBe(false);
    expect(openZones(state, "p1", "units").map((s) => s.lane)).toEqual([1, 3, 4, 5]);
    expect(firstFreeZone(state, "p1", "units")).toEqual(unitSlot("p1", 1));
  });

  it("a zone reserved for a Reborn unit is not open (R64)", () => {
    const state = game();
    reserveZone(state, unitSlot("p1", 1));
    expect(isOpen(state, unitSlot("p1", 1))).toBe(false);
    expect(firstFreeZone(state, "p1", "units")).toEqual(unitSlot("p1", 2));
  });
});

describe("Stack piles (§3.2, M1-T4)", () => {
  it("makes the pushed card the top, keeps only it active, and resumes the card beneath with its damage", () => {
    const state = game();
    const under = put(state, "fx-1", unitSlot("p1", 1));
    under.damage = 3;

    const top = put(state, stackUnit.id, unitSlot("p1", 1), true);
    expect(cardAt(state, unitSlot("p1", 1))?.id).toBe(top.id);
    expect(activeUnitsOf(state, "p1").map((c) => c.id)).toEqual([top.id]);
    expect(dormantUnitsOf(state, "p1").map((c) => c.id)).toEqual([under.id]);

    removeFromField(state, top);
    expect(cardAt(state, unitSlot("p1", 1))?.id).toBe(under.id);
    expect(under.damage).toBe(3);
  });

  it("refuses an occupied zone without Stack", () => {
    const state = game();
    put(state, "fx-1", unitSlot("p1", 1));
    const other = newInstance(state, "fx-2", "p1", { z: "hand", player: "p1" });
    expect(placeOnField(state, other, unitSlot("p1", 1))).toBe(false);
  });
});

describe("tokens leaving a zone (R11, M1-T4)", () => {
  it("a bounced or exiled unit token is in no hand, library, graveyard or exile", () => {
    for (const zone of ["hand", "exile", "graveyard"] as const) {
      const state = game();
      const token = put(state, rushToken.id, unitSlot("p1", 1));
      expect(moveToZone(state, token, zone)).toBe("vanished");

      const side = state.players.p1;
      const everywhere = [...side.hand, ...side.library, ...side.graveyard, ...side.exile];
      expect(everywhere.some((c) => c.id === token.id)).toBe(false);
      expect(activeUnitsOf(state, "p1")).toHaveLength(0);
    }
  });

  it("a spell token that resolves goes to the graveyard", () => {
    const state = game();
    const card = newInstance(state, spellToken.id, "p1", { z: "hand", player: "p1" });
    state.players.p1.hand.push(card);
    expect(moveToZone(state, card, "graveyard")).toBe("moved");
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([card.id]);
    expect(state.players.p1.hand).toHaveLength(0);
  });

  it("a non-token card leaving the field resets but keeps costMod and radiant (R78)", () => {
    const state = game();
    const card = put(state, "fx-1", unitSlot("p1", 1));
    card.damage = 2;
    card.buffs = { attack: 3, health: 3 };
    card.radiant = true;
    card.costMod = -1;
    card.counters = { plague: 2 };

    moveToZone(state, card, "hand");
    expect(card.damage).toBe(0);
    expect(card.buffs).toEqual({ attack: 0, health: 0 });
    expect(card.counters).toEqual({});
    expect(card.radiant).toBe(true);
    expect(card.costMod).toBe(-1);
    expect(card.zone).toEqual({ z: "hand", player: "p1" });
  });

  it("a card always goes to its owner's zone even under another controller (R12)", () => {
    const state = game();
    const card = newInstance(state, "fx-1", "p2", { z: "hand", player: "p2" });
    placeOnField(state, card, unitSlot("p1", 1));
    expect(card.controller).toBe("p1");

    moveToZone(state, card, "graveyard");
    expect(state.players.p2.graveyard.map((c) => c.id)).toEqual([card.id]);
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(card.controller).toBe("p2");
  });

  it("shuffles into a library at a chosen position", () => {
    const state = game();
    const card = newInstance(state, "fx-1", "p1", { z: "hand", player: "p1" });
    state.players.p1.hand.push(card);
    moveToZone(state, card, "library", { position: 3 });
    expect(state.players.p1.library[3]?.id).toBe(card.id);
    expect(state.players.p1.library).toHaveLength(DECK_SIZE + 1);
  });
});

describe("fill your board (R64, M1-T4)", () => {
  it("lists every empty unlocked unit zone, left to right", () => {
    const state = game();
    put(state, "fx-1", unitSlot("p1", 2));
    lockZone(state, unitSlot("p1", 4));
    expect(fillBoardZones(state, "p1").map((s) => s.lane)).toEqual([1, 3, 5]);
  });

  it("lists nothing when the row is full", () => {
    const state = game();
    for (const lane of [1, 2, 3, 4, 5]) put(state, "fx-1", unitSlot("p1", lane));
    expect(fillBoardZones(state, "p1")).toEqual([]);
  });
});

describe("slots", () => {
  it("lists five zones per row per player", () => {
    expect(slotsOf("p1", "units")).toHaveLength(5);
    expect(slotsOf("p2", "backrow").map((s) => s.lane)).toEqual([1, 2, 3, 4, 5]);
  });
});
