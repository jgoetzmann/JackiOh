// Plague Tokens on an instance and Locks on a zone (BUILD M3-T1): §6.3's Plague Token row with
// R78's reset, and §3.2's Lock, which the current occupant survives and which outlives it.

import type { PlayerId, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { clearPlague, lock, plague } from "../src/effects/counters";
import type { EngineSink } from "../src/resolve";
import { makeContext } from "../src/resolve";
import type { Effect } from "../src/script";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import {
  cardAt,
  firstFreeZone,
  isLocked,
  isOpen,
  moveToZone,
  openZones,
  placeOnField,
} from "../src/zones";
import { plain } from "./fixtures/combat";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";
import { manaWell } from "./fixtures/scripts";

function run(
  sink: EngineSink,
  effect: Effect,
  options: { self?: CardInstance | null; controller?: PlayerId; targets?: Selection[] } = {},
): void {
  const { self = null, ...rest } = options;
  effect.apply(makeContext(sink, self, rest));
}

function onInstance(instance: CardInstance): Selection[] {
  return [{ pick: "instance", instanceId: instance.id }];
}

function handCard(state: GameState, defId: string): CardInstance {
  const card = newInstance(state, defId, "p1", { z: "hand", player: "p1" });
  state.players.p1.hand.push(card);
  return card;
}

describe("plague (§6.3 Plague Token, M3-T1)", () => {
  it("#91: adds Plague Tokens, any number of them, and reports the new count", () => {
    const state = newGame("plague-add");
    const unit = put(state, plain.id, slot("p1", "units", 1));
    const sink = sinkFor(state);

    run(sink, plague({ target: { of: "chosen" }, amount: 1 }), { targets: onInstance(unit) });
    run(sink, plague({ target: { of: "self" }, amount: 1 }), { self: unit });
    run(sink, plague({ target: { of: "self" }, amount: 5 }), { self: unit });

    expect(unit.counters.plague).toBe(7);
    expect(eventsOfType(sink.events, "counterChanged")).toEqual([
      { type: "counterChanged", instanceId: unit.id, counter: "plague", value: 1 },
      { type: "counterChanged", instanceId: unit.id, counter: "plague", value: 2 },
      { type: "counterChanged", instanceId: unit.id, counter: "plague", value: 7 },
    ]);
  });

  it("takes tokens off, floors the count at 0, and clears the counter outright", () => {
    const state = newGame("plague-clear");
    const card = put(state, manaWell.id, slot("p1", "backrow", 1));
    const sink = sinkFor(state);

    run(sink, plague({ target: { of: "self" }, amount: 3 }), { self: card });
    run(sink, plague({ target: { of: "self" }, amount: -2 }), { self: card });
    expect(card.counters.plague).toBe(1);

    // Removing more than the card has leaves it at 0, not below.
    run(sink, plague({ target: { of: "self" }, amount: -9 }), { self: card });
    expect(card.counters.plague).toBeUndefined();
    expect(eventsOfType(sink.events, "counterChanged").map((e) => e.value)).toEqual([3, 1, 0]);

    // A count that does not change emits nothing: no tokens to remove, none to clear.
    run(sink, plague({ target: { of: "self" }, amount: -1 }), { self: card });
    run(sink, clearPlague({ target: { of: "self" } }), { self: card });
    expect(eventsOfType(sink.events, "counterChanged")).toHaveLength(3);

    run(sink, plague({ target: { of: "self" }, amount: 4 }), { self: card });
    run(sink, clearPlague(), { self: card });
    expect(card.counters.plague).toBeUndefined();
    expect(eventsOfType(sink.events, "counterChanged").map((e) => e.value)).toEqual([3, 1, 0, 4, 0]);
  });

  it("R78: Plague Tokens reset when the card leaves the field", () => {
    const state = newGame("plague-leaves");
    const unit = put(state, plain.id, slot("p1", "units", 1));
    const sink = sinkFor(state);

    run(sink, plague({ target: { of: "self" }, amount: 3 }), { self: unit });
    expect(unit.counters.plague).toBe(3);

    moveToZone(state, unit, "graveyard");
    expect(unit.counters.plague).toBeUndefined();
  });

  it("does nothing without a card: a hero selection, an empty selection or a zero amount", () => {
    const state = newGame("plague-fizzle");
    const unit = put(state, plain.id, slot("p1", "units", 1));
    const sink = sinkFor(state);

    run(sink, plague({ target: { of: "enemyHero" }, amount: 2 }), { controller: "p1" });
    run(sink, plague({ target: { of: "chosen" }, amount: 2 }), { targets: [] });
    run(sink, plague({ target: { of: "self" }, amount: 0 }), { self: unit });

    expect(unit.counters.plague).toBeUndefined();
    expect(sink.events).toHaveLength(0);
  });
});

describe("lock (§3.2, M3-T1)", () => {
  it("§3.2: the current occupant is unaffected and the lock outlives it", () => {
    const state = newGame("lock-occupant");
    const occupant = put(state, plain.id, slot("p2", "units", 2));
    const sink = sinkFor(state);

    run(sink, lock({ zone: { of: "chosen" } }), { targets: onInstance(occupant), controller: "p1" });

    // The occupant stays where it was, with its stats and its zone untouched.
    expect(cardAt(state, slot("p2", "units", 2))?.id).toBe(occupant.id);
    expect(occupant.zone).toEqual({ z: "field", player: "p2", row: "units", lane: 2 });
    expect(isLocked(state, slot("p2", "units", 2))).toBe(true);
    expect(isOpen(state, slot("p2", "units", 2))).toBe(false);
    expect(eventsOfType(sink.events, "locked")).toEqual([
      { type: "locked", player: "p2", row: "units", lane: 2 },
    ]);

    // Once it leaves, the zone still accepts nothing: the lock lasts until the game ends.
    moveToZone(state, occupant, "graveyard");
    expect(cardAt(state, slot("p2", "units", 2))).toBeNull();
    expect(isLocked(state, slot("p2", "units", 2))).toBe(true);
    const newcomer = newInstance(state, plain.id, "p2", { z: "hand", player: "p2" });
    expect(placeOnField(state, newcomer, slot("p2", "units", 2))).toBe(false);
    expect(openZones(state, "p2", "units").map((ref) => ref.lane)).toEqual([1, 3, 4, 5]);
  });

  it("#36 Magic Jammed: locks a named backrow zone, and locking it again changes nothing", () => {
    const state = newGame("lock-backrow");
    const trap = put(state, manaWell.id, slot("p2", "backrow", 4));
    const sink = sinkFor(state);

    run(sink, lock({ zone: { of: "chosen" } }), { targets: onInstance(trap), controller: "p1" });
    moveToZone(state, trap, "graveyard");

    expect(isLocked(state, slot("p2", "backrow", 4))).toBe(true);
    // Only that row and lane: the unit zone in the same lane is untouched.
    expect(isLocked(state, slot("p2", "units", 4))).toBe(false);
    expect(isLocked(state, slot("p1", "backrow", 4))).toBe(false);

    run(sink, lock({ zone: { of: "lane", player: "enemy", row: "backrow", lane: 4 } }), {
      controller: "p1",
    });
    expect(eventsOfType(sink.events, "locked")).toHaveLength(1);
  });

  it("§3.1: locks a lane by index, and R64's placement then skips it", () => {
    const state = newGame("lock-lane");
    const sink = sinkFor(state);

    run(sink, lock({ zone: { of: "lane", row: "units", lane: 1 } }), { controller: "p1" });

    expect(eventsOfType(sink.events, "locked")).toEqual([
      { type: "locked", player: "p1", row: "units", lane: 1 },
    ]);
    expect(firstFreeZone(state, "p1", "units")?.lane).toBe(2);
    expect(firstFreeZone(state, "p2", "units")?.lane).toBe(1);
  });

  it("locks the zone the card running the effect sits in (§3.1 'this lane')", () => {
    const state = newGame("lock-self");
    const self = put(state, plain.id, slot("p1", "units", 3));
    const sink = sinkFor(state);

    run(sink, lock({ zone: { of: "self" } }), { self });

    expect(isLocked(state, slot("p1", "units", 3))).toBe(true);
    expect(eventsOfType(sink.events, "locked")).toHaveLength(1);
  });

  it("does nothing when the zone cannot be named: no card, an off-field card, a bad lane", () => {
    const state = newGame("lock-fizzle");
    const inHandCard = handCard(state, plain.id);
    const sink = sinkFor(state);

    run(sink, lock({ zone: { of: "self" } }), { self: null });
    run(sink, lock({ zone: { of: "chosen" } }), { targets: [] });
    run(sink, lock({ zone: { of: "chosen" } }), { targets: onInstance(inHandCard) });
    run(sink, lock({ zone: { of: "lane", row: "units", lane: 6 } }), { controller: "p1" });
    run(sink, lock({ zone: { of: "lane", row: "backrow", lane: 0 } }), { controller: "p1" });

    expect(sink.events).toHaveLength(0);
    expect(state.players.p1.locks).toEqual({
      units: [false, false, false, false, false],
      backrow: [false, false, false, false, false],
    });
  });
});
