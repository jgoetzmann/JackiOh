// #74 Adaptive UI — SPEC §8.3, BUILD M4-T4: "X=2: 2 damage, heal 2, draw 2, a 2/2 Rush Token;
// radiant 4 / 6 / 4 / 6-6; X=0 nothing but counts as played".
//
// X is a play choice (R81), so every test passes it as `play(..., { x })` alongside the declared
// target — never as an answered prompt. §10.6 says no Core card opens an `x` prompt, and these
// tests assert that by never having a prompt to answer.
//
// Each hero starts below HERO_HEALTH (`health: 20`) so the heal is visible as a number rather than
// as 30-plus-something; §3 gives a hero no maximum, so the direction is all that matters.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

function typesOfLastStep(s: Scenario): string[] {
  return s.lastEvents.map((event) => event.type);
}

describe("#74 Adaptive UI (base)", () => {
  it("X=2: 2 damage to the target, heal your hero 2, draw 2, and a 2/2 Rush Token, in §8's order", () => {
    const s = scenario({
      seed: "core-074-x2",
      p1: {
        hand: ["core-074", "core-005"],
        library: ["core-035", "core-036", "core-013"],
        health: 20,
      },
      p2: { hand: ["core-005"], health: 30 },
    });

    s.play("core-074", { x: 2, targets: [{ pick: "hero", player: "p2" }] });

    // Deal X damage to a target.
    s.expectHealth("p2", 28);
    // Heal your hero X.
    s.expectHealth("p1", 22);
    // Draw X: one card played out of two, two drawn.
    expect(s.hand("p1")).toHaveLength(3);
    expect(s.pile("p1", "library")).toHaveLength(1);
    // Summon an X/X Rush Token: the catalog's Rush Token with a §7 stat override, not a 3/3.
    const token = s.unit("p1", 1);
    expect(token?.defId).toBe("core-t-rush");
    s.expectStats(token!, { attack: 2, health: 2, maxHealth: 2 });
    // R65: an X-cost card being played costs exactly X.
    s.expectMana("p1", 2);
    // The four clauses resolve in the order §8 writes them.
    s.expectEvents("cardPlayed", "damage", "healed", "drawn", "drawn", "summoned");
  });

  it("the damage goes to the chosen unit while the heal always goes to your OWN hero", () => {
    const s = scenario({
      seed: "core-074-unit-target",
      p1: { hand: ["core-074", "core-005"], library: ["core-035", "core-036"], health: 20 },
      p2: { field: ["core-013"], hand: ["core-005"], health: 30 },
    });
    const shredder = s.unit("p2", 1);

    s.play("core-074", { x: 2, targets: [{ pick: "instance", instanceId: shredder!.id }] });

    s.expectStats(shredder!, { health: 8, maxHealth: 10 });
    s.expectHealth("p1", 22);
    // "Heal your hero X" is never the chosen target's hero.
    s.expectHealth("p2", 30);
  });

  it("X=0 does nothing at all, but still counts as played (§10.5 step 4, §8 Conventions)", () => {
    const s = scenario({
      seed: "core-074-x0",
      p1: { hand: ["core-074", "core-005"], library: ["core-035"], health: 20 },
      p2: { hand: ["core-005"], health: 30 },
    });

    s.play("core-074", { x: 0, targets: [{ pick: "hero", player: "p2" }] });

    s.expectHealth("p2", 30);
    s.expectHealth("p1", 20);
    // No draw: the one remaining hand card is the one that was there before.
    expect(s.hand("p1").map((card) => card.defId)).toEqual(["core-005"]);
    expect(s.pile("p1", "library")).toHaveLength(1);
    // Above all: no 0/0 token.
    expect(s.unit("p1", 1)).toBeNull();
    expect(typesOfLastStep(s)).not.toContain("summoned");
    expect(typesOfLastStep(s)).not.toContain("damage");
    expect(typesOfLastStep(s)).not.toContain("healed");
    expect(typesOfLastStep(s)).not.toContain("drawn");
    // Counts as played: the play counters and the event are the pipeline's, not the script's.
    s.expectEvents("cardPlayed");
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(1);
    expect(s.state.players.p1.turnLog.playedIds).toHaveLength(1);
    s.expectMana("p1", 4);
  });

  it("a full unit row fizzles only the summon; the other three clauses still happen (R64, §8 Conventions)", () => {
    const s = scenario({
      seed: "core-074-full-board",
      p1: {
        field: ["core-001", "core-002", "core-003", "core-004", "core-007"],
        hand: ["core-074", "core-005"],
        library: ["core-035", "core-036"],
        health: 20,
      },
      p2: { hand: ["core-005"], health: 30 },
    });

    s.play("core-074", { x: 2, targets: [{ pick: "hero", player: "p2" }] });

    s.expectHealth("p2", 28);
    s.expectHealth("p1", 22);
    expect(s.hand("p1")).toHaveLength(3);
    // Five lanes, five units already: no sixth.
    expect(s.unit("p1", 5)?.defId).toBe("core-007");
    expect(typesOfLastStep(s)).not.toContain("summoned");
  });
});

describe("#74 Adaptive UI (radiant)", () => {
  it("X=2 radiant: 4 damage, heal 6, draw 4, and a 6/6 Rush Token", () => {
    const s = scenario({
      seed: "core-074-radiant-x2",
      p1: {
        hand: [{ def: "core-074", radiant: true }, "core-005"],
        library: ["core-035", "core-036", "core-013", "core-019", "core-043"],
        health: 20,
      },
      p2: { hand: ["core-005"], health: 30 },
    });
    expect(s.hand("p1")[0]?.radiant).toBe(true);

    s.play("core-074", { x: 2, targets: [{ pick: "hero", player: "p2" }] });

    // 2X damage.
    s.expectHealth("p2", 26);
    // Heal 3X.
    s.expectHealth("p1", 26);
    // Draw 2X.
    expect(s.hand("p1")).toHaveLength(5);
    expect(s.pile("p1", "library")).toHaveLength(1);
    // A 3X/3X token.
    const token = s.unit("p1", 1);
    expect(token?.defId).toBe("core-t-rush");
    s.expectStats(token!, { attack: 6, health: 6, maxHealth: 6 });
    // The token is summoned by an effect, so it is not itself Radiant (§5.2, R74).
    expect(token?.radiant).toBe(false);
    s.expectMana("p1", 2);
    s.expectEvents("cardPlayed", "damage", "healed", "drawn", "summoned");
  });

  it("X=1 radiant: 2 damage, heal 3, draw 2, a 3/3 token", () => {
    const s = scenario({
      seed: "core-074-radiant-x1",
      p1: {
        hand: [{ def: "core-074", radiant: true }, "core-005"],
        library: ["core-035", "core-036", "core-013"],
        health: 20,
      },
      p2: { hand: ["core-005"], health: 30 },
    });

    s.play("core-074", { x: 1, targets: [{ pick: "hero", player: "p2" }] });

    s.expectHealth("p2", 28);
    s.expectHealth("p1", 23);
    expect(s.hand("p1")).toHaveLength(3);
    s.expectStats(s.unit("p1", 1)!, { attack: 3, health: 3, maxHealth: 3 });
    s.expectMana("p1", 3);
  });

  it("X=0 radiant does nothing either, and still counts as played", () => {
    const s = scenario({
      seed: "core-074-radiant-x0",
      p1: {
        hand: [{ def: "core-074", radiant: true }, "core-005"],
        library: ["core-035"],
        health: 20,
      },
      p2: { hand: ["core-005"], health: 30 },
    });

    s.play("core-074", { x: 0, targets: [{ pick: "hero", player: "p2" }] });

    s.expectHealth("p2", 30);
    s.expectHealth("p1", 20);
    expect(s.unit("p1", 1)).toBeNull();
    expect(s.hand("p1")).toHaveLength(1);
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(1);
    s.expectMana("p1", 4);
  });
});
