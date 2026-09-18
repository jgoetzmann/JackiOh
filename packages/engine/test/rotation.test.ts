// Silly Silas's rotation (SPEC §3.1's rotation-topology ruling, R14, §8 #52; BUILD M3-T7).
// The fixture cards these tests need are defined here and registered on top of the shared fixture
// catalog, so no shared fixture has to grow for them (CLAUDE.md, BUILD §0).

import type { CardDef, GameEvent, Keyword, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { unitView } from "../src/layers";
import { rotateRings } from "../src/subsystems/rotation";
import { findInstance, newInstance, type CardInstance, type GameState } from "../src/state";
import { cardAt, lockZone, moveToZone, pileAt, placeOnField } from "../src/zones";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture cards.
// ---------------------------------------------------------------------------

let nextIndex = 700;

function unitDefOf(name: string, attack: number, health: number, keywords: Keyword[] = []): CardDef {
  nextIndex += 1;
  return {
    id: `rot-${name}`,
    index: String(nextIndex),
    name: `${name} (rotation)`,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { attack, health, keywords, text: name },
    radiant: { attack: attack * 2, health: health * 2, keywords, text: `${name} radiant` },
  };
}

/** A plain body, the control case for every rotation test. */
const plain = unitDefOf("plain", 2, 2);
/** #52 itself: it is on the field when its Cry resolves, so it rotates with everything else. */
const silas = unitDefOf("silas", 4, 4);
/** §3.2: a Stack card, so a whole pile can be rotated. */
const stacker = unitDefOf("stack", 3, 3, [{ kind: "Stack" }]);
/** A backrow card for the second ring; face-down until it fires (§3, R33). */
const trap: CardDef = {
  ...unitDefOf("trap", 0, 0),
  id: "rot-trap",
  type: "Trap",
  base: { keywords: [], text: "trap" },
  radiant: { keywords: [], text: "trap radiant" },
};

const DEFS: CardDef[] = [plain, silas, stacker, trap];

/** The shared fixture unit token (R11). */
const TOKEN_ID = "fx-token-rush";

/** A Stack card pushed onto an occupied unit zone (§3.2); the harness's `put` fills empty zones. */
function stackOnto(state: GameState, defId: string, player: PlayerId, lane: number): CardInstance {
  const card = newInstance(state, defId, player, { z: "hand", player });
  const ok = placeOnField(state, card, slot(player, "units", lane), { stack: true });
  expect(ok).toBe(true);
  return card;
}

function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((def) => [def.id, def])) });
  state.turn = 3;
  state.active = "p1";
  return state;
}

function rotate(
  state: GameState,
  direction: "left" | "right",
  options: { perspective?: PlayerId; radiant?: boolean } = {},
): { events: GameEvent[]; result: ReturnType<typeof rotateRings> } {
  const events: GameEvent[] = [];
  const result = rotateRings(sinkFor(state, events), {
    direction,
    perspective: options.perspective ?? "p1",
    ...(options.radiant === undefined ? {} : { radiant: options.radiant }),
  });
  return { events, result };
}

/** Where a card sits now, as "p2 units 5", for readable assertions. */
function whereIs(state: GameState, card: CardInstance): string {
  const found = findInstance(state, card.id);
  const zone = found?.zone;
  if (zone === undefined) return "gone";
  if (zone.z !== "field") return zone.z;
  return `${zone.player} ${zone.row} ${zone.lane}`;
}

describe("rotation (R14, M3-T7)", () => {
  it("R14 rotates the unit ring one step right, so your lane 5 crosses to the opponent's lane 5", () => {
    const state = game("rotate-right");
    const lane1 = put(state, plain.id, slot("p1", "units", 1));
    const lane5 = put(state, plain.id, slot("p1", "units", 5));

    const { events, result } = rotate(state, "right");

    expect(whereIs(state, lane1)).toBe("p1 units 2");
    expect(whereIs(state, lane5)).toBe("p2 units 5");
    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
    expect(result.moved).toEqual([lane1.id, lane5.id]);

    // Control changes only for the card that crossed the centre line (§3.1).
    expect(lane1.controller).toBe("p1");
    expect(lane5.controller).toBe("p2");
    expect(result.crossed).toEqual([lane5.id]);
    expect(result.bounced).toEqual([]);

    // One `rotated` for the rotation, whatever moved (§10.3).
    expect(eventsOfType(events, "rotated")).toEqual([{ type: "rotated", direction: "right" }]);
    expect(eventsOfType(events, "controlChanged")).toEqual([
      { type: "controlChanged", instanceId: lane5.id, controller: "p2", row: "units", lane: 5 },
    ]);
    expect(eventsOfType(events, "bounced")).toEqual([]);
  });

  it("R14 rotates left as the mirror of right, so your lane 1 crosses to the opponent's lane 1", () => {
    const state = game("rotate-left");
    const lane1 = put(state, plain.id, slot("p1", "units", 1));
    const lane3 = put(state, plain.id, slot("p1", "units", 3));

    const { events, result } = rotate(state, "left");

    expect(whereIs(state, lane1)).toBe("p2 units 1");
    expect(whereIs(state, lane3)).toBe("p1 units 2");
    expect(lane1.controller).toBe("p2");
    expect(result.crossed).toEqual([lane1.id]);
    expect(eventsOfType(events, "rotated")).toEqual([{ type: "rotated", direction: "left" }]);

    // And one step back the other way puts the card that stayed home where it started.
    rotate(state, "right");
    expect(whereIs(state, lane3)).toBe("p1 units 3");
  });

  it("R14 turns the backrow ring independently of the unit ring", () => {
    const state = game("rotate-both-rings");
    const unit = put(state, plain.id, slot("p1", "units", 3));
    const back = put(state, trap.id, slot("p1", "backrow", 5));
    const enemyBack = put(state, trap.id, slot("p2", "backrow", 1));

    const { events, result } = rotate(state, "right");

    // The unit ring turned one step and so did the backrow ring, each on its own zones.
    expect(whereIs(state, unit)).toBe("p1 units 4");
    expect(whereIs(state, back)).toBe("p2 backrow 5");
    expect(whereIs(state, enemyBack)).toBe("p1 backrow 1");
    expect(back.controller).toBe("p2");
    expect(enemyBack.controller).toBe("p1");
    expect(result.crossed).toEqual([back.id, enemyBack.id]);
    expect(eventsOfType(events, "rotated")).toHaveLength(1);
    expect(eventsOfType(events, "controlChanged").map((e) => e.row)).toEqual(["backrow", "backrow"]);
  });

  it("R12 a rotated card changes controller but never owner, and still leaves to its owner's zones", () => {
    const state = game("rotate-ownership");
    const card = put(state, plain.id, slot("p1", "units", 5));

    rotate(state, "right");
    expect(card.controller).toBe("p2");
    expect(card.owner).toBe("p1");

    // Off the field a card always belongs to its owner (R12, §3.2).
    moveToZone(state, card, "graveyard");
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([card.id]);
    expect(state.players.p2.graveyard).toHaveLength(0);
    expect(card.controller).toBe("p1");
  });

  it("R14 damage and buffs travel with a rotated card", () => {
    const state = game("rotate-keeps-state");
    const card = put(state, plain.id, slot("p1", "units", 5));
    card.damage = 1;
    card.buffs = { attack: 3, health: 4 };
    card.grantedKeywords = [{ kind: "Taunt" }];
    card.counters = { plague: 2 };
    card.position = "DEF";
    card.summonedTurn = state.turn;

    rotate(state, "right");

    expect(whereIs(state, card)).toBe("p2 units 5");
    expect(card.damage).toBe(1);
    expect(card.buffs).toEqual({ attack: 3, health: 4 });
    expect(card.counters).toEqual({ plague: 2 });
    expect(card.grantedKeywords).toEqual([{ kind: "Taunt" }]);
    // A rotation never takes the card off the field, so R78's reset never runs.
    expect(unitView(state, card)).toMatchObject({ attack: 5, maxHealth: 6, health: 5, position: "DEF" });
    expect(card.summonedTurn).toBe(3);
  });

  it("R14 bounces a card whose destination is Locked to its owner's hand", () => {
    const state = game("rotate-locked");
    const crossing = put(state, plain.id, slot("p1", "units", 5));
    crossing.damage = 1;
    crossing.buffs = { attack: 2, health: 2 };
    const staying = put(state, plain.id, slot("p1", "units", 1));
    lockZone(state, slot("p2", "units", 5));

    const { events, result } = rotate(state, "right");

    expect(whereIs(state, crossing)).toBe("hand");
    expect(state.players.p1.hand.map((c) => c.id)).toContain(crossing.id);
    expect(cardAt(state, slot("p2", "units", 5))).toBeNull();
    expect(result.bounced).toEqual([crossing.id]);
    expect(result.crossed).toEqual([]);
    expect(eventsOfType(events, "bounced")).toEqual([
      { type: "bounced", instanceId: crossing.id, defId: plain.id, owner: "p1" },
    ]);
    expect(eventsOfType(events, "controlChanged")).toEqual([]);
    // It left the field, so it resets on the way to the hand (R78), and costs its printed price.
    expect(crossing.damage).toBe(0);
    expect(crossing.buffs).toEqual({ attack: 0, health: 0 });
    expect(crossing.costOverride).toBeUndefined();

    // The rest of the ring still turned.
    expect(whereIs(state, staying)).toBe("p1 units 2");
  });

  it("R14 radiant Silly Silas bounces every crossing card to its owner's hand at cost 0", () => {
    const state = game("rotate-radiant");
    const mine = put(state, plain.id, slot("p1", "units", 5));
    const theirs = put(state, plain.id, slot("p2", "units", 1));
    const staying = put(state, plain.id, slot("p1", "units", 2));

    const { events, result } = rotate(state, "right", { radiant: true });

    // Both cards would have crossed, so both went home instead, each to its own owner (R12).
    expect(whereIs(state, mine)).toBe("hand");
    expect(whereIs(state, theirs)).toBe("hand");
    expect(state.players.p1.hand.map((c) => c.id)).toContain(mine.id);
    expect(state.players.p2.hand.map((c) => c.id)).toContain(theirs.id);
    expect(mine.costOverride).toBe(0);
    expect(theirs.costOverride).toBe(0);

    // Nothing crossed, so no control changed.
    expect(result.crossed).toEqual([]);
    expect(eventsOfType(events, "controlChanged")).toEqual([]);
    expect(result.bounced).toEqual([mine.id, theirs.id]);
    expect(eventsOfType(events, "bounced").map((e) => e.instanceId)).toEqual([mine.id, theirs.id]);

    // A card that stays on its own side rotates as usual, at its printed cost.
    expect(whereIs(state, staying)).toBe("p1 units 3");
    expect(result.moved).toEqual([staying.id]);
    expect(staying.costOverride).toBeUndefined();
  });

  it("§8 #52 Silas rotates along with everything else", () => {
    const state = game("rotate-silas");
    const self = put(state, silas.id, slot("p1", "units", 3));
    const ally = put(state, plain.id, slot("p1", "units", 4));
    const back = put(state, trap.id, slot("p1", "backrow", 3));

    const { result } = rotate(state, "right");

    expect(whereIs(state, self)).toBe("p1 units 4");
    expect(whereIs(state, ally)).toBe("p1 units 5");
    expect(whereIs(state, back)).toBe("p1 backrow 4");
    expect(result.moved).toEqual([self.id, ally.id, back.id]);
  });

  it("R14 rotating a full ring is atomic: every card moves one step and none is overwritten", () => {
    const state = game("rotate-full-ring");
    const ids = new Map<string, string>();
    for (const player of ["p1", "p2"] as const) {
      for (const lane of [1, 2, 3, 4, 5]) {
        ids.set(`${player} units ${lane}`, put(state, plain.id, slot(player, "units", lane)).id);
      }
    }

    const { result } = rotate(state, "right");

    // The ring is p1 lanes 1-5 then p2 lanes 5-1, so every card is one step along it (§3.1).
    const expected: Record<string, string> = {
      "p1 units 1": "p1 units 2",
      "p1 units 2": "p1 units 3",
      "p1 units 3": "p1 units 4",
      "p1 units 4": "p1 units 5",
      "p1 units 5": "p2 units 5",
      "p2 units 5": "p2 units 4",
      "p2 units 4": "p2 units 3",
      "p2 units 3": "p2 units 2",
      "p2 units 2": "p2 units 1",
      "p2 units 1": "p1 units 1",
    };
    for (const [from, to] of Object.entries(expected)) {
      const id = ids.get(from);
      const card = id === undefined ? undefined : findInstance(state, id);
      expect(card).toBeDefined();
      expect(card === undefined ? "gone" : whereIs(state, card)).toBe(to);
    }

    // Ten cards in, ten cards out: nothing was overwritten and nothing was bounced.
    expect(result.moved).toHaveLength(10);
    expect(result.bounced).toEqual([]);
    expect(result.crossed).toHaveLength(2);
    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p2.hand).toHaveLength(0);
  });

  it("R33 a face-down trap that crosses answers to its new controller and stays face down", () => {
    const state = game("rotate-trap-visibility");
    const card = put(state, trap.id, slot("p1", "backrow", 5));
    expect(card.faceUp).toBeUndefined();

    const { events } = rotate(state, "right");

    expect(whereIs(state, card)).toBe("p2 backrow 5");
    expect(card.controller).toBe("p2");
    expect(card.owner).toBe("p1");
    // Who may read it follows from the controller alone, so the card is still face down (R33).
    expect(card.faceUp).toBeUndefined();
    expect(eventsOfType(events, "controlChanged")).toEqual([
      { type: "controlChanged", instanceId: card.id, controller: "p2", row: "backrow", lane: 5 },
    ]);
  });

  it("§3.2 a Stack pile rotates whole, keeping the same card on top", () => {
    const state = game("rotate-stack");
    const under = put(state, plain.id, slot("p1", "units", 5));
    under.damage = 1;
    const top = stackOnto(state, stacker.id, "p1", 5);

    const { result } = rotate(state, "right");

    expect(pileAt(state, slot("p1", "units", 5))).toBeNull();
    expect(pileAt(state, slot("p2", "units", 5))?.map((c) => c.id)).toEqual([top.id, under.id]);
    expect(cardAt(state, slot("p2", "units", 5))?.id).toBe(top.id);
    // The dormant card came along and kept its damage (§3.2, R14).
    expect(under.damage).toBe(1);
    expect(top.controller).toBe("p2");
    expect(under.controller).toBe("p2");
    expect(result.crossed).toEqual([top.id, under.id]);
  });

  it("R11 a unit token bounced by a Locked destination ceases to exist", () => {
    const state = game("rotate-token-bounce");
    const token = put(state, TOKEN_ID, slot("p1", "units", 5));
    lockZone(state, slot("p2", "units", 5));

    const { events, result } = rotate(state, "right");

    expect(result.bounced).toEqual([token.id]);
    expect(eventsOfType(events, "bounced").map((e) => e.instanceId)).toEqual([token.id]);
    expect(findInstance(state, token.id)).toBeUndefined();
    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p1.graveyard).toHaveLength(0);
  });
});

