// A card's stay, read off the event stream (SPEC §10.3, R174, R212): `stays.ts`'s two readers.

import type { GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { leftFieldSince, movesIn, noteMoved, noteReported, noteUncovered, uncoveredBy } from "../src/stays";
import { newGame } from "./fixtures/harness";

const summoned = (id: string): GameEvent => ({ type: "summoned", player: "p1", instanceId: id, defId: "fx", row: "units", lane: 1 });
const destroyed = (id: string): GameEvent => ({
  type: "destroyed",
  instanceId: id,
  defId: "fx",
  owner: "p1",
  attack: 1,
  maxHealth: 1,
  killerId: null,
});
const damage = (id: string): GameEvent => ({ type: "damage", sourceId: null, targetId: id, amount: 1, combat: false });
const stolen = (id: string, controller: "p1" | "p2"): GameEvent => ({
  type: "controlChanged",
  instanceId: id,
  controller,
  row: "units",
  lane: 1,
});

describe("stays.leftFieldSince (R174)", () => {
  it("R174 finds a card that left the field after a point, and nothing before it", () => {
    const events = [destroyed("c1"), damage("c2"), destroyed("c2"), summoned("c2")];
    expect(leftFieldSince(events, 1, "c2")).toBe(true);
    expect(leftFieldSince(events, 1, "c1")).toBe(false);
    expect(leftFieldSince(events, 0, "c1")).toBe(true);
  });
});

describe("stays.movesIn (R212)", () => {
  it("R212 names every card a zone change moved, and a Reborn body among them", () => {
    const later = movesIn([destroyed("c1"), summoned("c1"), damage("c2")]);
    expect([...later.moved].sort()).toEqual(["c1"]);
  });

  it("R212 moves both sides of a Replace and only the ingredients a Fuse used up", () => {
    const later = movesIn([
      { type: "transformed", instanceId: "c1", fromDefId: "a", toDefId: "b", newInstanceId: "c9" },
      { type: "fused", instanceIds: ["c2", "c3"], resultInstanceId: "c3", defId: "t-1:a+b" },
    ]);
    expect([...later.moved].sort()).toEqual(["c1", "c2", "c9"]);
  });

  it("R212 reads the controller a card had before the first change of control, and a change of control is no move (R171)", () => {
    const later = movesIn([stolen("c1", "p2"), stolen("c1", "p1"), stolen("c2", "p1")]);
    expect(later.controllerBefore.get("c1")).toBe("p1");
    expect(later.controllerBefore.get("c2")).toBe("p2");
    expect(later.moved.size).toBe(0);
  });
});

describe("stays: a Stack note belongs to one removal (R212, §3.2)", () => {
  const exiled = (id: string): GameEvent => ({ type: "exiled", instanceId: id, defId: "fx", owner: "p1" });

  it("R212 a removal's note is read off its reports until the card that left has moved again and the loop has dispatched them", () => {
    const state = newGame("stays-uncovered");
    noteUncovered(state, "c1", "c4");
    // Still owed: the death that uncovered c4, and anything owed behind it, read as its resume.
    expect(uncoveredBy(state, destroyed("c1"))).toEqual(["c4"]);
    expect(movesIn([damage("c9"), destroyed("c1")], state).moved.has("c4")).toBe(true);
    // An event that reports no removal of c1 is no report of it.
    noteReported(state, damage("c1"));
    // The loop dispatched the death; the death's other reports still read it while c1 lies where it fell.
    noteReported(state, destroyed("c1"));
    expect(uncoveredBy(state, destroyed("c1"))).toEqual(["c4"]);

    // c1 moves on out of its graveyard: that move is no removal from a pile's top.
    noteMoved(state, "c1");
    expect(uncoveredBy(state, exiled("c1"))).toEqual([]);
    expect(movesIn([damage("c9"), exiled("c1")], state).moved.has("c4")).toBe(false);
  });

  it("R212 a card that moves on before the loop reaches its removal's report keeps the note for that report alone", () => {
    const state = newGame("stays-uncovered-moved");
    noteUncovered(state, "c1", "c4");
    noteMoved(state, "c1");
    // The death is still owed, and so is everything before it: c4 resumed after all of that.
    expect(movesIn([damage("c9"), destroyed("c1"), exiled("c1")], state).moved.has("c4")).toBe(true);
    noteReported(state, destroyed("c1"));
    expect(uncoveredBy(state, exiled("c1"))).toEqual([]);
  });

  it("R212 a removal that uncovers nothing still ends the note of an earlier one once that one is reported", () => {
    const state = newGame("stays-uncovered-again");
    noteUncovered(state, "c1", "c4");
    noteReported(state, stolen("c1", "p2"));
    // Stolen off the top of its pile, and later killed alone on the thief's side.
    noteUncovered(state, "c1", undefined);
    expect(uncoveredBy(state, destroyed("c1"))).toEqual([]);
  });
});
