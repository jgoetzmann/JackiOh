// The two cost-changing effects (BUILD M3-T1). R65 owns the order the inputs combine and
// `effectiveCost` is the only thing that reads them; these tests assert that order rather than
// recomputing it, plus R78's rule that both inputs travel with the card between zones.

import type { PlayerId, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { setCostMod, setCostOverride } from "../src/effects/cost";
import { effectiveCost } from "../src/mana";
import { addModifier } from "../src/modifiers";
import type { EngineSink } from "../src/resolve";
import { makeContext } from "../src/resolve";
import type { Effect } from "../src/script";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import { moveToZone } from "../src/zones";
import { plain } from "./fixtures/combat";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";
import { xBolt } from "./fixtures/scripts";

function run(
  sink: EngineSink,
  effect: Effect,
  options: { self?: CardInstance | null; controller?: PlayerId; targets?: Selection[] } = {},
): void {
  const { self = null, ...rest } = options;
  effect.apply(makeContext(sink, self, rest));
}

function handCard(state: GameState, defId: string): CardInstance {
  const card = newInstance(state, defId, "p1", { z: "hand", player: "p1" });
  state.players.p1.hand.push(card);
  return card;
}

function onInstance(instance: CardInstance): Selection[] {
  return [{ pick: "instance", instanceId: instance.id }];
}

describe("setCostMod (§6.3 Cost, R65, M3-T1)", () => {
  it("R65 adds to the instance's costMod and reports the new effective cost", () => {
    const state = newGame("costmod");
    const card = handCard(state, "fx-1"); // printed cost 1
    const sink = sinkFor(state);

    run(sink, setCostMod({ target: { of: "chosen" }, amount: -1 }), { targets: onInstance(card) });

    expect(card.costMod).toBe(-1);
    expect(effectiveCost(state, card)).toBe(0);
    expect(eventsOfType(sink.events, "costChanged")).toEqual([
      { type: "costChanged", instanceId: card.id, cost: 0 },
    ]);

    // #31: each application adds, and the event carries the cost after R65's floor at 0.
    run(sink, setCostMod({ target: { of: "chosen" }, amount: 3 }), { targets: onInstance(card) });
    expect(card.costMod).toBe(2);
    expect(effectiveCost(state, card)).toBe(3);
    expect(eventsOfType(sink.events, "costChanged").map((e) => e.cost)).toEqual([0, 3]);
  });

  it("R65: the cost the event reports is the effective one, with the player's discount included", () => {
    const state = newGame("costmod-discount");
    const card = handCard(state, "fx-1");
    const sink = sinkFor(state);
    addModifier(sink, "p1", { kind: "costDiscount", amount: 2, expiry: { until: "thisTurn", turn: 1 } });

    run(sink, setCostMod({ target: { of: "chosen" }, amount: 4 }), { targets: onInstance(card) });

    // printed 1 + costMod 4 − discount 2 = 3.
    expect(card.costMod).toBe(4);
    expect(eventsOfType(sink.events, "costChanged")).toEqual([
      { type: "costChanged", instanceId: card.id, cost: 3 },
    ]);
  });

  it("R65: a costMod never changes what an X-cost card costs, but an override makes it free", () => {
    const state = newGame("costmod-x");
    const card = handCard(state, xBolt.id); // cost "X"
    card.x = 3;
    const sink = sinkFor(state);

    run(sink, setCostMod({ target: { of: "chosen" }, amount: -2 }), { targets: onInstance(card) });
    expect(card.costMod).toBe(-2);
    expect(effectiveCost(state, card)).toBe(3);
    expect(eventsOfType(sink.events, "costChanged")).toEqual([
      { type: "costChanged", instanceId: card.id, cost: 3 },
    ]);

    run(sink, setCostOverride({ target: { of: "chosen" }, cost: 1 }), { targets: onInstance(card) });
    expect(effectiveCost(state, card)).toBe(0);
    expect(card.x).toBe(3);
  });

  it("does nothing without a card: a hero selection, an empty selection or a zero amount", () => {
    const state = newGame("costmod-fizzle");
    const card = handCard(state, "fx-1");
    const sink = sinkFor(state);

    run(sink, setCostMod({ target: { of: "enemyHero" }, amount: -1 }), { controller: "p1" });
    run(sink, setCostMod({ target: { of: "chosen" }, amount: -1 }), { targets: [] });
    run(sink, setCostMod({ target: { of: "self" }, amount: 0 }), { self: card });

    expect(card.costMod).toBe(0);
    expect(sink.events).toHaveLength(0);
  });
});

describe("setCostOverride (§6.3 Cost, R65, M3-T1)", () => {
  it("R65 replaces the printed cost, #54 Straaza's 1 and #41r Sheepish's 0", () => {
    const state = newGame("override");
    const card = handCard(state, "fx-1"); // printed 1
    const dear = handCard(state, "fx-2");
    dear.costMod = 3; // printed 1 + 3 = 4 before the override
    const sink = sinkFor(state);

    run(sink, setCostOverride({ target: { of: "chosen" }, cost: 1 }), { targets: onInstance(card) });
    expect(card.costOverride).toBe(1);
    expect(effectiveCost(state, card)).toBe(1);

    run(sink, setCostOverride({ target: { of: "chosen" }, cost: 0 }), { targets: onInstance(dear) });
    expect(dear.costOverride).toBe(0);
    // R65 starts from the override and still adds the instance's costMod.
    expect(effectiveCost(state, dear)).toBe(3);
    expect(eventsOfType(sink.events, "costChanged")).toEqual([
      { type: "costChanged", instanceId: card.id, cost: 1 },
      { type: "costChanged", instanceId: dear.id, cost: 3 },
    ]);
  });

  it("R65 and R48: override, then costMod, then the player discount, then Curvature", () => {
    const state = newGame("override-order");
    state.turn = 2; // the turn after the one that made it, so Curvature is live (R48)
    const card = handCard(state, "fx-1");
    const sink = sinkFor(state);

    addModifier(sink, "p1", { kind: "costDiscount", amount: 1, expiry: { until: "thisTurn", turn: 2 } });
    addModifier(sink, "p1", {
      kind: "costDiscount",
      amount: 1,
      onlyCurrentCost: 4,
      expiry: { until: "nextTurnOf", player: "p1", fromTurn: 0 },
    });

    run(sink, setCostOverride({ target: { of: "chosen" }, cost: 6 }), { targets: onInstance(card) });
    run(sink, setCostMod({ target: { of: "chosen" }, amount: -1 }), { targets: onInstance(card) });

    // 6 (override) − 1 (costMod) − 1 (discount) = 4, which Curvature then takes to 3.
    expect(effectiveCost(state, card)).toBe(3);
    expect(eventsOfType(sink.events, "costChanged").map((e) => e.cost)).toEqual([5, 3]);

    // Take the override away from 4 and Curvature no longer bites: 3 − 1 − 1 = 1.
    run(sink, setCostOverride({ target: { of: "chosen" }, cost: 3 }), { targets: onInstance(card) });
    expect(effectiveCost(state, card)).toBe(1);
  });

  it("R65: a negative override is floored at 0 rather than turning into a discount", () => {
    const state = newGame("override-floor");
    const card = handCard(state, "fx-1");
    const sink = sinkFor(state);

    run(sink, setCostOverride({ target: { of: "chosen" }, cost: -5 }), { targets: onInstance(card) });

    expect(card.costOverride).toBe(0);
    expect(effectiveCost(state, card)).toBe(0);
  });

  it("R78: costMod and costOverride persist when the card leaves the field, while buffs reset", () => {
    const state = newGame("cost-persists");
    const unit = put(state, plain.id, slot("p1", "units", 1));
    const sink = sinkFor(state);

    run(sink, setCostMod({ target: { of: "self" }, amount: 2 }), { self: unit });
    run(sink, setCostOverride({ target: { of: "self" }, cost: 3 }), { self: unit });
    unit.buffs = { attack: 1, health: 1 };

    moveToZone(state, unit, "graveyard");

    expect(unit.costMod).toBe(2);
    expect(unit.costOverride).toBe(3);
    expect(unit.buffs).toEqual({ attack: 0, health: 0 });
    expect(effectiveCost(state, unit)).toBe(5);
  });
});

describe("a price for a card in a hand (inHandOnly, R4)", () => {
  it("R4 a price given with inHandOnly lands on a card in a hand and on nothing a full hand burned (§2.4, R78)", () => {
    const state = newGame("price-in-hand");
    const inHand = handCard(state, "fx-1");
    const burned = newInstance(state, "fx-1", "p1", { z: "graveyard", player: "p1" });
    state.players.p1.graveyard.push(burned);
    const sink = sinkFor(state);

    // #31's "+1", #37r's and #72's "costs 1 less", #72r's "costs 0": written after the move, each is
    // the price of a card that reached the hand, and a card the move burned keeps its cost.
    for (const card of [inHand, burned]) {
      run(sink, setCostMod({ target: { of: "chosen" }, amount: -1, inHandOnly: true }), { targets: onInstance(card) });
      run(sink, setCostOverride({ target: { of: "chosen" }, cost: 0, inHandOnly: true }), { targets: onInstance(card) });
    }

    expect({ costMod: inHand.costMod, costOverride: inHand.costOverride }).toEqual({ costMod: -1, costOverride: 0 });
    expect({ costMod: burned.costMod, costOverride: burned.costOverride }).toEqual({ costMod: 0, costOverride: undefined });
    expect(eventsOfType(sink.events, "costChanged").map((event) => event.instanceId)).toEqual([inHand.id, inHand.id]);
  });
});
