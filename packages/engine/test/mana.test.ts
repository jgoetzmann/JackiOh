import { describe, expect, it } from "vitest";
import { MAX_MANA } from "../src/config";
import { canAfford, effectiveCost, gainMana, maxManaFor, printedCost, refreshMana, spendMana } from "../src/mana";
import { addModifier } from "../src/modifiers";
import { newInstance, type GameState } from "../src/state";
import { newGame, sinkFor } from "./fixtures/harness";
import { goingLong, heroicPower, xBolt } from "./fixtures/scripts";

function handCard(state: GameState, defId: string): ReturnType<typeof newInstance> {
  const card = newInstance(state, defId, "p1", { z: "hand", player: "p1" });
  state.players.p1.hand.push(card);
  return card;
}

describe("R65 cost calculation (M1-T6)", () => {
  it("starts from the printed cost and adds the instance's costMod", () => {
    const state = newGame("cost-base");
    const card = handCard(state, "fx-1"); // printed cost 1
    expect(printedCost(state, card)).toBe(1);
    expect(effectiveCost(state, card)).toBe(1);

    card.costMod = 2;
    expect(effectiveCost(state, card)).toBe(3);
    card.costMod = -5;
    expect(effectiveCost(state, card)).toBe(0); // floors at 0
  });

  it("R65 prefers costOverride over the printed cost, then applies costMod", () => {
    const state = newGame("cost-override");
    const card = handCard(state, "fx-1");
    card.costOverride = 4;
    expect(effectiveCost(state, card)).toBe(4);
    card.costMod = -1;
    expect(effectiveCost(state, card)).toBe(3);
  });

  it("R65 applies a player discount, and only to the types it names", () => {
    const state = newGame("cost-discount");
    const unit = handCard(state, "fx-1");
    const sink = sinkFor(state);
    addModifier(sink, "p1", { kind: "costDiscount", amount: 1, expiry: { until: "thisTurn", turn: 1 } });
    expect(effectiveCost(state, unit)).toBe(0);

    const state2 = newGame("cost-discount-spell");
    const unit2 = handCard(state2, "fx-1");
    unit2.costMod = 3; // cost 4, so the discount below would otherwise bite
    const sink2 = sinkFor(state2);
    addModifier(sink2, "p1", {
      kind: "costDiscount",
      amount: 2,
      onlyType: "Spell",
      expiry: { until: "thisTurn", turn: 1 },
    });
    expect(effectiveCost(state2, unit2)).toBe(4);
  });

  it("R65 applies Professor Curvature last, and only when the cost is then 4 (R48)", () => {
    const state = newGame("curvature");
    state.turn = 2; // the turn after the one that made the modifier, so it is live (R48)
    const card = handCard(state, "fx-1");
    card.costMod = 3; // printed 1 + 3 = 4
    const sink = sinkFor(state);
    addModifier(sink, "p1", {
      kind: "costDiscount",
      amount: 1,
      onlyCurrentCost: 4,
      expiry: { until: "nextTurnOf", player: "p1", fromTurn: 0 },
    });
    expect(effectiveCost(state, card)).toBe(3);

    // A card that is not at 4 after the earlier steps is untouched.
    const other = handCard(state, "fx-2");
    expect(effectiveCost(state, other)).toBe(1);
  });

  it("R65 lets a general discount bring a card to 4, which Curvature then discounts", () => {
    const state = newGame("curvature-chain");
    const card = handCard(state, "fx-1");
    card.costMod = 4; // printed 1 + 4 = 5
    const sink = sinkFor(state);
    addModifier(sink, "p1", { kind: "costDiscount", amount: 1, expiry: { until: "thisTurn", turn: 1 } });
    addModifier(sink, "p1", {
      kind: "costDiscount",
      amount: 1,
      onlyCurrentCost: 4,
      expiry: { until: "thisTurn", turn: 1 },
    });
    expect(effectiveCost(state, card)).toBe(3);
  });

  it("R65 makes an X-cost card cost exactly X, ignoring modifiers, and 0 with an override", () => {
    const state = newGame("cost-x");
    const bolt = handCard(state, xBolt.id);
    expect(effectiveCost(state, bolt)).toBe(0); // out of play, X counts as 0

    bolt.x = 3;
    bolt.costMod = -2;
    const sink = sinkFor(state);
    addModifier(sink, "p1", { kind: "costDiscount", amount: 2, expiry: { until: "thisTurn", turn: 1 } });
    expect(effectiveCost(state, bolt)).toBe(3);

    // An override makes it free, whatever the override's own number says (R65).
    bolt.costOverride = 2;
    expect(effectiveCost(state, bolt)).toBe(0);
  });

  it("R48 a next-turn discount does nothing on the turn it was created", () => {
    const state = newGame("curvature-timing");
    state.turn = 1;
    const card = handCard(state, "fx-1");
    card.costMod = 3; // cost 4, which is what Curvature looks for
    const sink = sinkFor(state);
    addModifier(sink, "p1", {
      kind: "costDiscount",
      amount: 1,
      onlyCurrentCost: 4,
      expiry: { until: "nextTurnOf", player: "p1", fromTurn: state.turn },
    });

    expect(effectiveCost(state, card)).toBe(4); // this turn: untouched
    state.turn = 3; // their next turn
    expect(effectiveCost(state, card)).toBe(3);
  });

  it("R65 reads an embiggen card at its base price until the bigger price is chosen", () => {
    const state = newGame("cost-embiggen");
    const card = handCard(state, goingLong.id); // 2 embiggen 4
    expect(effectiveCost(state, card)).toBe(2);
    card.embiggened = true;
    expect(effectiveCost(state, card)).toBe(4);
    card.costMod = -1;
    expect(effectiveCost(state, card)).toBe(3);
  });

  it("R43 gives Heroic Power the cost of its power", () => {
    const state = newGame("cost-power");
    const power = handCard(state, heroicPower.id);
    expect(effectiveCost(state, power)).toBe(0); // no X chosen yet
    power.x = 2;
    expect(effectiveCost(state, power)).toBe(2);
  });

  it("canAfford compares against current mana, temporary mana included", () => {
    const state = newGame("afford");
    const card = handCard(state, "fx-1");
    state.players.p1.mana.current = 0;
    expect(canAfford(state, card)).toBe(false);
    gainMana(state.players.p1, 1);
    expect(canAfford(state, card)).toBe(true);
  });

  it("refreshes to min(turns started, 4) plus modifiers and clears the one-shot (§2.3)", () => {
    const state = newGame("refresh");
    const side = state.players.p1;

    side.turnsStarted = 3;
    refreshMana(side);
    expect(side.mana).toMatchObject({ current: 3, max: 3 });

    side.turnsStarted = 9;
    refreshMana(side);
    expect(side.mana.max).toBe(MAX_MANA);

    side.mana.nextTurnMod = -2;
    side.mana.permMod = 1;
    expect(maxManaFor(side)).toBe(3);
    refreshMana(side);
    expect(side.mana.max).toBe(3);
    expect(side.mana.nextTurnMod).toBe(0);

    gainMana(side, 3);
    expect(side.mana.current).toBe(6); // temporary mana may exceed max
    spendMana(side, 10);
    expect(side.mana.current).toBe(0); // and never goes below 0
  });
});
