// #71 Intern Stimmy — SPEC §8.3, BUILD M4-T4: "Trap window at the end of any turn with library >
// opponent's → recruit ≤1 (R62); fires again next qualifying turn; radiant ≤2".
//
// Library fillers are deliberately Spells (core-005 Stockpile, core-035 Lunar Eclipse): Recruit
// takes permanents only (§6.3), so a Spell in the library can pad a count without ever being the
// card recruited. The Units used are core-001 Big D-fender (cost 2), core-003 Right-house defender
// (cost 1) and core-004 Gary the Gambler (cost 1) — none of them has a turn trigger, and Recruit
// fires no Cry (R1), so nothing they do can be mistaken for the trap's work.
//
// Every test gives BOTH sides a playable card in hand, because §2.5/R82 auto-ends a turn with
// nothing meaningful left on it and would otherwise cascade several turns past the one under test.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

function trapFirings(s: Scenario): number {
  return s.events.filter((event) => event.type === "trapFired").length;
}

describe("#71 Intern Stimmy (base)", () => {
  it("R62 fires in the end-of-turn trap window of its controller's own turn and recruits a Unit costing 1 or less", () => {
    const s = scenario({
      seed: "core-071-own-turn",
      p1: {
        backrow: ["core-071"],
        library: ["core-001", "core-003", "core-005"],
        hand: ["core-005"],
      },
      p2: { library: ["core-005"], hand: ["core-005"] },
    });
    const trap = s.backrow("p1", 1);
    const bigDfender = s.pile("p1", "library")[0];
    const righthouse = s.pile("p1", "library")[1];
    expect(trap?.defId).toBe("core-071");

    s.endTurn();

    // The condition held (3 cards to 1), so the trap fired and recruited.
    s.expectEvents("turnEnded");
    s.expectEvents("trapFired", "summoned");
    expect(trapFirings(s)).toBe(1);
    expect(s.unit("p1", 1)?.defId).toBe("core-003");
    s.expectInZone(righthouse!, "field");

    // "Costing 1 or less": the 2-cost Unit sitting above it in the library is skipped, not taken.
    s.expectInZone(bigDfender!, "library");
  });

  it("R62 fires on the OPPONENT's turn end, and R52's reading of \"your\" makes it the trap's controller who recruits", () => {
    const s = scenario({
      seed: "core-071-enemy-turn",
      active: "p2",
      p1: {
        backrow: ["core-071"],
        library: ["core-001", "core-003", "core-005"],
        hand: ["core-005"],
      },
      p2: { library: ["core-005", "core-023"], hand: ["core-005"] },
    });

    // p2 ends the turn; p1's library (3) is still larger than p2's (2).
    s.endTurn();

    expect(trapFirings(s)).toBe(1);
    expect(s.unit("p1", 1)?.defId).toBe("core-003");
    // The recruited Unit belongs to the trap's controller, not to the player who ended the turn.
    expect(s.unit("p2", 1)).toBeNull();
  });

  it("fires again on the next qualifying turn end, because a Field Trap is never consumed (§5.1, R33)", () => {
    const s = scenario({
      seed: "core-071-again",
      p1: {
        backrow: ["core-071"],
        library: ["core-001", "core-003", "core-004", "core-005", "core-035"],
        hand: ["core-005"],
      },
      p2: { library: ["core-005"], hand: ["core-005"] },
    });
    const trap = s.backrow("p1", 1);

    // p1's turn ends: 5 cards to 1.
    s.endTurn();
    expect(s.unit("p1", 1)?.defId).toBe("core-003");

    // p2's turn ends: p1 still leads (4 cards to 0 after p2's own draw), so it fires a second time.
    s.endTurn();
    expect(s.unit("p1", 2)?.defId).toBe("core-004");

    expect(trapFirings(s)).toBe(2);
    // Never consumed: still in the backrow, and R33 makes a fired Field Trap public.
    s.expectInZone(trap!, "field");
    expect(s.backrow("p1", 1)?.id).toBe(trap?.id);
    expect(s.backrow("p1", 1)?.faceUp).toBe(true);
  });

  it("does nothing when the library is not STRICTLY larger, and the trap stays armed and face-down", () => {
    const s = scenario({
      seed: "core-071-equal",
      p1: { backrow: ["core-071"], library: ["core-001", "core-003"], hand: ["core-005"] },
      p2: { library: ["core-005", "core-023"], hand: ["core-005"] },
    });
    const trap = s.backrow("p1", 1);
    const righthouse = s.pile("p1", "library")[1];

    // Two cards each: "more cards than" is not met.
    s.endTurn();

    expect(trapFirings(s)).toBe(0);
    expect(s.unit("p1", 1)).toBeNull();
    s.expectInZone(righthouse!, "library");
    // A trap that did not answer the event is still armed, and still hidden (R33's contrapositive).
    s.expectInZone(trap!, "field");
    expect(s.backrow("p1", 1)?.faceUp).not.toBe(true);
  });

  it("does nothing when the library is smaller", () => {
    const s = scenario({
      seed: "core-071-behind",
      p1: { backrow: ["core-071"], library: ["core-003"], hand: ["core-005"] },
      p2: { library: ["core-005", "core-023", "core-035"], hand: ["core-005"] },
    });

    s.endTurn();

    expect(trapFirings(s)).toBe(0);
    expect(s.unit("p1", 1)).toBeNull();
  });
});

describe("#71 Intern Stimmy (radiant)", () => {
  it("radiant raises the ceiling to 2 or less, so the 2-cost Unit above it in the library is taken", () => {
    const s = scenario({
      seed: "core-071-radiant",
      p1: {
        backrow: [{ def: "core-071", radiant: true }],
        library: ["core-001", "core-003", "core-005"],
        hand: ["core-005"],
      },
      p2: { library: ["core-005"], hand: ["core-005"] },
    });
    const righthouse = s.pile("p1", "library")[1];

    s.endTurn();

    expect(trapFirings(s)).toBe(1);
    // Base takes core-003 out of this very library (see the first test); radiant reaches core-001.
    expect(s.unit("p1", 1)?.defId).toBe("core-001");
    s.expectInZone(righthouse!, "library");
  });

  it("radiant keeps the condition, the trap window and the \"never consumed\" of the base face", () => {
    const s = scenario({
      seed: "core-071-radiant-equal",
      active: "p2",
      p1: {
        backrow: [{ def: "core-071", radiant: true }],
        library: ["core-001", "core-003"],
        hand: ["core-005"],
      },
      p2: { library: ["core-005", "core-023"], hand: ["core-005"] },
    });
    const trap = s.backrow("p1", 1);

    // Equal libraries on the opponent's turn end: the radiant face is no more eager than the base.
    s.endTurn();
    expect(trapFirings(s)).toBe(0);
    expect(s.unit("p1", 1)).toBeNull();
    s.expectInZone(trap!, "field");
  });
});
