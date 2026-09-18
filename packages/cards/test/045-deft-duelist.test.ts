// #45 Deft Duelist (SPEC §8.2, §4.1, §4.2, §4.4; R6, R49, R63).
//
// The must-pass row (BUILD M4-T4 #45): "Charge; attack then switch and switch then attack in one
// turn (R49); radiant Armor 1."
//
// R6 fixes what "switch then attack" has to mean: "attacking from Defense is not allowed and
// switching to Attack spends the turn's exertion — #45 is the exception". So the second order is a
// unit that starts in Defense, switches to Attack and then attacks: for every other unit the switch
// has spent the turn, and each control case below proves that on #20 Pointmaster.
//
// Charge and Armor 1 are printed keywords, so the tests read them through their effect (a summon
// turn attack; a 1-damage hit reduced to nothing) rather than off the def.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import { base as deftBase, radiant as deftRadiant } from "../src/scripts/045-deft-duelist";

/** Deft Duelist in hand, an enemy hero to hit; #21 Hinder keeps the turn alive (R82). */
function fromHand(radiantDuelist = false): ReturnType<typeof scenario> {
  const s = scenario({
    seed: "deft-duelist",
    p1: { hand: ["core-045", "core-021"] },
    p2: { health: 30 },
  });
  // The builder only takes `radiant` on the board, so a radiant hand card is flagged by hand.
  if (radiantDuelist) s.card("core-045").radiant = true;
  return s;
}

/** Already on the field in Defense Position, so the "switch then attack" order can be taken. */
function inDefense(def: string, radiantUnit = false): ReturnType<typeof scenario> {
  return scenario({
    seed: "deft-duelist",
    p1: {
      hand: ["core-021"],
      field: [{ def, radiant: radiantUnit, position: "DEF", lane: 1 }],
    },
    p2: { health: 30 },
  });
}

describe("#45 Deft Duelist — base", () => {
  it("R49 the two exertions are a static flag on both faces, which `combat.ts` reads", () => {
    expect(deftBase.staticFlags?.deftDuelist).toBe(true);
    expect(deftRadiant.staticFlags?.deftDuelist).toBe(true);
  });

  it("§6.1 Charge lets it attack a unit on its summon turn", () => {
    const s = scenario({
      seed: "deft-duelist",
      p1: { hand: ["core-045", "core-021"] },
      p2: { field: [{ def: "core-t-felinor", lane: 1 }], health: 30 },
    })
      .play("core-045", { zone: 1 })
      .attack("core-045", "core-t-felinor");

    // 4 into a 1/1 kills it; the 1 back leaves the 4/3 at 2 health.
    expect(s.unit("p2", 1)).toBe(null);
    s.expectStats("core-045", { attack: 4, health: 2, maxHealth: 3 });
  });

  it("§6.1 Charge lets it attack the enemy hero on its summon turn", () => {
    const s = fromHand().play("core-045", { zone: 1 }).attack("core-045", "hero");

    s.expectHealth("p2", 26);
  });

  it("R49 attacks and then switches position in the same turn", () => {
    const s = fromHand().play("core-045", { zone: 1 }).attack("core-045", "hero");
    s.switchPosition("core-045");

    s.expectHealth("p2", 26);
    expect(s.unit("p1", 1)?.position).toBe("DEF");
    s.expectEvents("cardPlayed", "attackDeclared", "positionSwitched");
  });

  it("R49 switches position and then attacks in the same turn, which R6 forbids every other unit", () => {
    const s = inDefense("core-045").switchPosition("core-045");
    s.attack("core-045", "hero");

    expect(s.unit("p1", 1)?.position).toBe("ATK");
    s.expectHealth("p2", 26);
    s.expectEvents("positionSwitched", "attackDeclared");
  });

  it("R6 a plain unit that switched to Attack Position has spent its exertion and cannot attack", () => {
    const s = inDefense("core-020").switchPosition("core-020");

    expect(() => s.attack("core-020", "hero")).toThrow(/already acted/);
    s.expectHealth("p2", 30);
  });

  it("§4.1 a plain unit that attacked cannot then switch: one exertion, not two", () => {
    const s = scenario({
      seed: "deft-duelist",
      p1: { hand: ["core-021"], field: [{ def: "core-020", lane: 1 }] },
      p2: { health: 30 },
    }).attack("core-020", "hero");

    s.expectHealth("p2", 23);
    expect(() => s.switchPosition("core-020")).toThrow(/already acted/);
  });

  it("R49 is one attack and one switch, not two of either", () => {
    const s = fromHand().play("core-045", { zone: 1 }).attack("core-045", "hero");
    s.switchPosition("core-045");

    expect(() => s.attack("core-045", "hero")).toThrow(/already acted/);
    expect(() => s.switchPosition("core-045")).toThrow(/already acted/);
    s.expectHealth("p2", 26);
  });

  it("§8.2 the base stats are 4/3", () => {
    const s = fromHand().play("core-045", { zone: 1 });

    s.expectStats("core-045", { attack: 4, health: 3, maxHealth: 3 });
  });
});

describe("#45 Deft Duelist — radiant", () => {
  it("§8.2 the radiant stats are 8/6 and Charge still lets it hit the hero on its summon turn", () => {
    const s = fromHand(true).play("core-045", { zone: 1 }).attack("core-045", "hero");

    s.expectStats("core-045", { attack: 8, health: 6, maxHealth: 6 });
    s.expectHealth("p2", 22);
  });

  it("R49 'same': the radiant face also attacks and then switches in one turn", () => {
    const s = fromHand(true).play("core-045", { zone: 1 }).attack("core-045", "hero");
    s.switchPosition("core-045");

    expect(s.unit("p1", 1)?.position).toBe("DEF");
    s.expectHealth("p2", 22);
  });

  it("R49 'same': and switches and then attacks in one turn", () => {
    const s = inDefense("core-045", true).switchPosition("core-045");
    s.attack("core-045", "hero");

    expect(s.unit("p1", 1)?.position).toBe("ATK");
    s.expectHealth("p2", 22);
  });

  it("R63 Armor 1 reduces an incoming 1-damage hit to nothing, so no damage lands", () => {
    const s = scenario({
      seed: "deft-duelist",
      p1: { hand: ["core-021"], field: [{ def: "core-045", radiant: true, lane: 1 }], health: 30 },
      p2: { hand: ["core-021"], field: [{ def: "core-t-felinor", lane: 1 }], health: 30 },
    });
    s.endTurn();
    s.attack("core-t-felinor", "core-045");

    // 1 − Armor 1 = 0, and R63 makes a hit that is 0 after Armor a non-event.
    s.expectStats("core-045", { attack: 8, health: 6, maxHealth: 6 });
    // The 8 it strikes back with kills the 1/1 token, which ceases to exist (R11).
    expect(s.unit("p2", 1)).toBe(null);
  });
});
