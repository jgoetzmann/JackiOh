// The three overflows of SPEC §2.4 as the event stream reports them, and what each seat reads of
// them (§10.3, §10.8): a draw from an empty library (`fatigue`, R315), a card a full library turns
// away (`libraryOverflow`, R316), and a card a full hand burns (`burned`, R317). The client animates
// each one on both seats (R318), so the proofs here are about the stream: the event exists, it
// comes in the order the board plays it, and `viewFor` gives each seat exactly what R97 allows.

import type { Action, ActionBody, GameEvent, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { FATIGUE_DAMAGE, HAND_CAP, LIBRARY_CAP } from "../src/config";
import { draw, drawOne, shuffleIntoLibrary } from "../src/draw";
import { beginGame, reduce } from "../src/reduce";
import { newInstance, type GameState } from "../src/state";
import { HIDDEN_ID, viewFor } from "../src/viewFor";
import { moveToZone } from "../src/zones";
import { eventsOfType, inHand, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";
import { cnVirus, infiniteReserves } from "./fixtures/scripts";

const TOKEN = "fx-token-rush";

let nonce = 0;

function step(state: GameState, body: ActionBody & { playerId: PlayerId }): { state: GameState; events: GameEvent[] } {
  nonce += 1;
  const result = reduce(state, { ...body, nonce: `ov${nonce}` } as Action);
  if (result.error !== undefined) throw new Error(`${body.type} refused: ${result.error}`);
  return { state: result.state, events: result.events };
}

/** Both mulligans kept whole: turn 1, p1's main phase. */
function started(seed: string): GameState {
  let state = beginGame(newGame(seed)).state;
  state = step(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" }).state;
  state = step(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" }).state;
  return state;
}

/** The events both seats' views carry, with the view's window holding exactly `events`. */
function seen(state: GameState, events: GameEvent[]): Record<PlayerId, GameEvent[]> {
  state.applied = [{ nonce: "overflow", events }];
  return { p1: viewFor(state, "p1").events, p2: viewFor(state, "p2").events };
}

describe("R315 fatigue", () => {
  it("R315 reports a fatigue draw as `fatigue` with its owner, its count and its hit, just before the hit, to both seats", () => {
    let state = started("r315");
    state.players.p2.library = [];
    const { state: after, events } = step(state, { type: "endTurn", playerId: "p1" });
    state = after;

    const at = events.findIndex((e) => e.type === "fatigue");
    expect(at, "p2's turn-start draw from an empty library reports fatigue").toBeGreaterThanOrEqual(0);
    expect(events[at]).toEqual({ type: "fatigue", player: "p2", count: 1, amount: FATIGUE_DAMAGE(1) });
    // The hit follows at once, so the board shows the empty library and then the hero taking it.
    expect(events[at + 1]).toEqual({ type: "damage", sourceId: null, targetId: "hero-p2", amount: 1, combat: false });
    // No card was drawn, so there is no `drawn` for it (R3).
    expect(eventsOfType(events, "drawn").filter((e) => e.player === "p2")).toEqual([]);

    // Public on both seats: it names a player and two numbers, and the fatigue count is in the view.
    for (const viewer of ["p1", "p2"] as const) {
      const view = viewFor(state, viewer);
      expect(eventsOfType(view.events, "fatigue")).toEqual([{ type: "fatigue", player: "p2", count: 1, amount: 1 }]);
    }
  });

  it("R315 counts each fatigue draw of a draw N on, 1, 2, 3", () => {
    const state = newGame("r315-count");
    setLibrary(state, "p1", []);
    const sink = sinkFor(state);
    draw(sink, "p1", 3);
    expect(eventsOfType(sink.events, "fatigue").map((e) => [e.count, e.amount])).toEqual([
      [1, FATIGUE_DAMAGE(1)],
      [2, FATIGUE_DAMAGE(2)],
      [3, FATIGUE_DAMAGE(3)],
    ]);
    // Each report is followed by its own hit.
    const order = sink.events.filter((e) => e.type === "fatigue" || e.type === "damage").map((e) => e.type);
    expect(order).toEqual(["fatigue", "damage", "fatigue", "damage", "fatigue", "damage"]);
  });

  it("R315 still reports a fatigue draw whose whole hit Armor absorbs, ahead of R240's zero", () => {
    const state = newGame("r315-armor");
    setLibrary(state, "p1", []);
    state.players.p1.hero.armor = 3;
    const sink = sinkFor(state);
    expect(drawOne(sink, "p1")).toBe("fatigue");
    expect(sink.events).toEqual([
      { type: "fatigue", player: "p1", count: 1, amount: 1 },
      { type: "damage", sourceId: null, targetId: "hero-p1", amount: 0, combat: false },
    ]);
  });

  it("R315 reports no fatigue for a draw #75 Infinite Reserves replaces with a Rush Token card", () => {
    const state = newGame("r315-reserves");
    setLibrary(state, "p1", []);
    put(state, infiniteReserves.id, slot("p1", "backrow", 1));
    const sink = sinkFor(state);
    expect(drawOne(sink, "p1")).toBe("token");
    expect(eventsOfType(sink.events, "fatigue")).toEqual([]);
    expect(eventsOfType(sink.events, "drawn").map((e) => e.defId)).toEqual([TOKEN]);
    expect(state.players.p1.fatigueCount).toBe(0);
  });
});

describe("R316 library overflow", () => {
  function fullLibrary(seed: string): GameState {
    const state = newGame(seed);
    setLibrary(state, "p1", Array.from({ length: LIBRARY_CAP }, () => "fx-1"));
    return state;
  }

  it("R316 reports a copy a full library refuses as `libraryOverflow` notCreated, public to both seats", () => {
    const state = fullLibrary("r316-new");
    const sink = sinkFor(state);
    const fresh = newInstance(state, "fx-2", "p1", { z: "library", player: "p1" });
    expect(shuffleIntoLibrary(sink, fresh, false)).toBe("dropped");

    const refused = { type: "libraryOverflow", player: "p1", instanceId: fresh.id, defId: "fx-2", outcome: "notCreated" };
    expect(sink.events).toEqual([refused]);
    // Never created, so it was never anywhere hidden: both seats read what was turned away.
    const views = seen(state, sink.events);
    expect(views.p1).toEqual([refused]);
    expect(views.p2).toEqual([refused]);
  });

  it("R316 reports an existing card a full library sends to the graveyard as `graveyard`, then its enteredGraveyard", () => {
    const state = fullLibrary("r316-existing");
    const card = inHand(state, "fx-2", "p1")[0];
    if (card === undefined) throw new Error("no card");
    const sink = sinkFor(state);
    expect(shuffleIntoLibrary(sink, card, true)).toBe("dropped");

    expect(sink.events).toEqual([
      { type: "libraryOverflow", player: "p1", instanceId: card.id, defId: "fx-2", outcome: "graveyard" },
      { type: "enteredGraveyard", instanceId: card.id, defId: "fx-2", owner: "p1" },
    ]);
    // It left p1's hand for a public graveyard, so the opponent reads it too (R97: judged by where
    // the card is now).
    const views = seen(state, sink.events);
    expect(eventsOfType(views.p2, "libraryOverflow")[0]?.defId).toBe("fx-2");
  });

  it("R316 reports an existing unit-token card a full library turns away as `ceased`, with no graveyard", () => {
    const state = fullLibrary("r316-token");
    const token = put(state, TOKEN, slot("p1", "units", 1));
    const sink = sinkFor(state);
    expect(shuffleIntoLibrary(sink, token, true)).toBe("dropped");

    expect(sink.events).toEqual([
      { type: "libraryOverflow", player: "p1", instanceId: token.id, defId: TOKEN, outcome: "ceased" },
    ]);
    expect(token.zone.z).toBe("gone");
    expect(eventsOfType(seen(state, sink.events).p2, "libraryOverflow")[0]?.instanceId).toBe(token.id);
  });

  it("R316 reports nothing below the cap, and a CN-Virus chain at the cap turns its second copy away", () => {
    const roomy = newGame("r316-roomy");
    setLibrary(roomy, "p1", ["fx-1"]);
    const roomySink = sinkFor(roomy);
    shuffleIntoLibrary(roomySink, newInstance(roomy, "fx-2", "p1", { z: "library", player: "p1" }), false);
    expect(eventsOfType(roomySink.events, "libraryOverflow")).toEqual([]);

    // A full library with a CN-Virus on top: the draw takes it (59 left), the cast shuffles two
    // copies in, the first fills the library to 60 and the second is never created.
    const state = newGame("r316-virus");
    setLibrary(state, "p1", [cnVirus.id, ...Array.from({ length: LIBRARY_CAP - 1 }, () => "fx-1")]);
    const sink = sinkFor(state);
    drawOne(sink, "p1");
    expect(eventsOfType(sink.events, "shuffledIn")).toHaveLength(1);
    const refused = eventsOfType(sink.events, "libraryOverflow");
    expect(refused.map((e) => [e.player, e.defId, e.outcome])).toEqual([["p1", cnVirus.id, "notCreated"]]);
    expect(state.players.p1.library.length).toBeLessThanOrEqual(LIBRARY_CAP);
  });
});

describe("R317 a full hand burns", () => {
  it("R317 burns the card a full hand cannot take, and both seats read it: drawn, burned, then its graveyard", () => {
    let state = started("r317");
    // p2's hand is full, so the draw at the start of p2's turn is burned.
    state.players.p2.hand = [];
    inHand(state, "fx-30", "p2", HAND_CAP);
    const top = state.players.p2.library[0];
    if (top === undefined) throw new Error("p2 has no library");
    const { state: after, events } = step(state, { type: "endTurn", playerId: "p1" });
    state = after;

    const mine = events.filter(
      (e) => (e.type === "drawn" || e.type === "burned" || e.type === "enteredGraveyard") && "instanceId" in e && e.instanceId === top.id,
    );
    expect(mine.map((e) => e.type)).toEqual(["drawn", "burned", "enteredGraveyard"]);
    expect(state.players.p2.hand).toHaveLength(HAND_CAP);
    expect(state.players.p2.graveyard.map((c) => c.id)).toContain(top.id);

    // It never reached the hand: it sits in a public graveyard, so the opponent reads the card that
    // burned as well as its owner does, the draw included (R97).
    for (const viewer of ["p1", "p2"] as const) {
      const burned = eventsOfType(viewFor(state, viewer).events, "burned");
      expect(burned, viewer).toEqual([{ type: "burned", instanceId: top.id, defId: top.defId, owner: "p2" }]);
      const drawn = eventsOfType(viewFor(state, viewer).events, "drawn").filter((e) => e.instanceId === top.id);
      expect(drawn.map((e) => e.defId), viewer).toEqual([top.defId]);
    }
  });

  it("R317 hides a burned card from the opponent once it returns to its owner's hand", () => {
    const state = newGame("r317-returned");
    setLibrary(state, "p1", ["fx-2"]);
    inHand(state, "fx-30", "p1", HAND_CAP);
    const sink = sinkFor(state);
    expect(drawOne(sink, "p1")).toBe("burned");
    const card = state.players.p1.graveyard[0];
    if (card === undefined) throw new Error("nothing burned");

    // #72 Reminisce's move: graveyard to hand. R97 judges the card by where it is now.
    state.players.p1.hand.splice(0, 1);
    moveToZone(state, card, "hand");
    const views = seen(state, sink.events);
    expect(eventsOfType(views.p1, "burned")[0]?.defId).toBe("fx-2");
    expect(eventsOfType(views.p2, "burned")).toEqual([
      { type: "burned", instanceId: HIDDEN_ID, defId: HIDDEN_ID, owner: "p1" },
    ]);
  });

  it("R317 burns a unit-token card out of existence: public, and no graveyard", () => {
    const state = newGame("r317-token");
    setLibrary(state, "p1", []);
    put(state, infiniteReserves.id, slot("p1", "backrow", 1));
    inHand(state, "fx-30", "p1", HAND_CAP);
    const sink = sinkFor(state);
    expect(drawOne(sink, "p1")).toBe("token");
    const burned = eventsOfType(sink.events, "burned");
    expect(burned.map((e) => e.defId)).toEqual([TOKEN]);
    expect(eventsOfType(sink.events, "enteredGraveyard")).toEqual([]);
    expect(eventsOfType(seen(state, sink.events).p2, "burned")[0]?.defId).toBe(TOKEN);
  });
});
