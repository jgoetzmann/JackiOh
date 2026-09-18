// #41 Sheepish (SPEC §8.2, §5.1, §10.3, §10.5 step 4; R17, R23, R33, R61).
//
// The must-pass row (BUILD M4-T4 #41): "Opponent's unit becomes a Sheep before its Cry (R17); trap
// consumed; Immutable target → consumed with no effect; radiant adds 0-cost Lava Golem."
//
// "Before its Cry" is proved with an observable Cry rather than with event order: #53 Reno's Cry is
// "if your hero is below 30, set it to 30", so a p1 hero left at 10 that is STILL at 10 after the
// play is a Cry that never ran — R17's "the Cry is lost".

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import { base as sheepishBase, radiant as sheepishRadiant } from "../src/scripts/041-sheepish";

/**
 * p1 is active with `card` to play; p2 holds Sheepish face-down in backrow lane 1.
 *
 * #21 Hinder rides along in p1's hand purely so the turn has something meaningful left after the
 * play and does not auto-end into p2's turn (R82; see the harness header).
 */
function trapSet(card: string, radiantTrap = false) {
  return scenario({
    seed: "sheepish",
    p1: { hand: [card, "core-021"], health: 10, mana: 10 },
    p2: { backrow: [{ def: "core-041", radiant: radiantTrap, lane: 1 }], health: 30 },
  });
}

function firedTrap(events: readonly { type: string }[]): boolean {
  return events.some((event) => event.type === "trapFired");
}

function transformed(events: readonly { type: string }[]): boolean {
  return events.some((event) => event.type === "transformed");
}

describe("#41 Sheepish — base", () => {
  it("R17 transforms the opponent's played Unit into a Sheep Token before its Cry, so the Cry is lost", () => {
    const s = trapSet("core-053").play("core-053", { zone: 1 });

    // §10.5 step 4 emits `cardPlayed`, the trap fires on it, and only then would step 5's Cry run.
    s.expectEvents("cardPlayed", "trapFired", "transformed");
    expect(s.unit("p1", 1)?.defId).toBe("core-t-sheep");
    // #53 Reno would have set p1's hero to 30. It is still 10: the Cry never resolved.
    s.expectHealth("p1", 10);
  });

  it("§7 the replacement is the 1/1 Sheep Token, in the played unit's own zone (§6.3 Transform)", () => {
    const s = trapSet("core-053").play("core-053", { zone: 1 });

    s.expectInZone("core-t-sheep", "field");
    s.expectStats("core-t-sheep", { attack: 1, health: 1, maxHealth: 1 });
  });

  it("§5.1 the Trap is consumed: it leaves the backrow for its owner's graveyard", () => {
    const s = trapSet("core-053").play("core-053", { zone: 1 });

    s.expectInZone("core-041", "graveyard");
    expect(s.backrow("p2", 1)).toBe(null);
  });

  it("R17 an Immutable target still fires the trap, which is consumed with no effect (R23)", () => {
    // #8 Mr. Vanilla is Immutable, and R23 makes Immutable refuse Transform on the card itself.
    const s = trapSet("core-008").play("core-008", { zone: 1 });

    expect(firedTrap(s.events)).toBe(true);
    expect(transformed(s.events)).toBe(false);
    expect(s.unit("p1", 1)?.defId).toBe("core-008");
    s.expectInZone("core-041", "graveyard");
  });

  it("R61 a Spell leaves the trap armed and face-down: the condition is a `when`, not an empty `run`", () => {
    const s = scenario({
      seed: "sheepish",
      p1: { hand: ["core-044", "core-021"], mana: 10 },
      p2: { backrow: [{ def: "core-041", lane: 1 }], health: 30 },
    }).play("core-044", { targets: [{ pick: "hero", player: "p2" }] });

    // The spell resolved, so the play really happened and the trap really saw the event.
    s.expectHealth("p2", 26);
    expect(firedTrap(s.events)).toBe(false);
    s.expectInZone("core-041", "field");
  });

  it("§8 fires only on the OPPONENT's play: the controller's own Unit leaves it armed", () => {
    const s = scenario({
      seed: "sheepish",
      active: "p2",
      turn: 2,
      p2: {
        hand: ["core-053", "core-021"],
        backrow: [{ def: "core-041", lane: 1 }],
        health: 10,
        mana: 10,
      },
    }).play("core-053", { zone: 1 });

    expect(firedTrap(s.events)).toBe(false);
    s.expectInZone("core-041", "field");
    expect(s.unit("p2", 1)?.defId).toBe("core-053");
    // Reno's own Cry ran, because nothing interrupted it.
    s.expectHealth("p2", 30);
  });

  it("R81 the trap declares no play-time choice and watches `cardPlayed`", () => {
    expect(sheepishBase.targets).toBeUndefined();
    expect(sheepishBase.modes).toBeUndefined();
    expect(sheepishBase.triggers?.map((trigger) => trigger.on)).toEqual([["cardPlayed"]]);
  });
});

describe("#41 Sheepish — radiant", () => {
  it("transforms the played Unit AND adds a Lava Golem costing 0 to the trap controller's hand", () => {
    const s = trapSet("core-053", true).play("core-053", { zone: 1 });

    expect(s.unit("p1", 1)?.defId).toBe("core-t-sheep");
    s.expectHealth("p1", 10);

    const golem = s.hand("p2").find((card) => card.defId === "core-055");
    expect(golem).toBeDefined();
    // R65: a `costOverride` of 0 is what "costing 0" means, and it survives every zone.
    expect(golem?.costOverride).toBe(0);
  });

  it("R17 the radiant trap is consumed too, once, and the Sheep replaces the unit", () => {
    const s = trapSet("core-053", true).play("core-053", { zone: 1 });

    s.expectEvents("cardPlayed", "trapFired", "transformed", "addedToHand");
    s.expectInZone("core-041", "graveyard");
    expect(s.hand("p2").filter((card) => card.defId === "core-055")).toHaveLength(1);
  });

  it("R120 an Also clause stands on its own: an Immutable target refuses the Transform and the rest of the text still resolves", () => {
    // §8 Conventions: "Also" adds a clause of its own, so it does not depend on the Transform.
    const s = trapSet("core-008", true).play("core-008", { zone: 1 });

    expect(firedTrap(s.events)).toBe(true);
    expect(transformed(s.events)).toBe(false);
    expect(s.unit("p1", 1)?.defId).toBe("core-008");
    expect(s.hand("p2").some((card) => card.defId === "core-055" && card.costOverride === 0)).toBe(true);
    s.expectInZone("core-041", "graveyard");
  });

  it("R61 the radiant face arms on the same condition: a Spell does not fire it", () => {
    const s = scenario({
      seed: "sheepish",
      p1: { hand: ["core-044", "core-021"], mana: 10 },
      p2: { backrow: [{ def: "core-041", radiant: true, lane: 1 }], health: 30 },
    }).play("core-044", { targets: [{ pick: "hero", player: "p2" }] });

    expect(firedTrap(s.events)).toBe(false);
    expect(s.hand("p2").some((card) => card.defId === "core-055")).toBe(false);
    s.expectInZone("core-041", "field");
  });

  it("R74 both faces watch the same event, so the radiant text changes what fires, not when", () => {
    expect(sheepishRadiant.triggers?.map((trigger) => trigger.on)).toEqual([["cardPlayed"]]);
  });
});
