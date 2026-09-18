// #6 Mana Well — SPEC §8.1 row 6, BUILD M4-T4 must-pass: "Turn-4 player has 5 mana; leaves → back
// to 4; radiant 6".
//
// The harness's default `turn: 9` gives the active side five started turns, so `refreshMana`
// computes §2.3's max of min(turnsStarted, MAX_MANA) = 4: every scenario here is already a
// "turn-4 player". `startTurn()` is the engine's own start of turn for the player who is active
// now — refresh, then the start-of-turn triggers, then the draw — which is the moment this card
// acts. Each side keeps a small library so that draw is a draw and not fatigue (§2.4, R3).

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";

const LIBRARY = ["core-011", "core-011", "core-011", "core-011"];

describe("#6 Mana Well (§8.1 row 6)", () => {
  it("a turn-4 player has 5 mana at the start of the turn, above a max of 4", () => {
    const s = scenario({
      seed: "core-006-base",
      p1: { backrow: ["core-006"], hand: ["core-011"], library: [...LIBRARY] },
      p2: { hand: ["core-011"], library: [...LIBRARY] },
    });

    // §2.3: the refresh at setup is the cap alone.
    s.expectMana("p1", 4);
    expect(s.view("p1").you.mana.max).toBe(4);

    s.startTurn();

    // 4 refreshed + 1 from the Well, and the max is untouched: temporary mana may exceed 4 (§2.3).
    s.expectMana("p1", 5);
    expect(s.view("p1").you.mana.max).toBe(4);
  });

  it("the gain is temporary, not cumulative: the next start of turn is 5 again", () => {
    const s = scenario({
      seed: "core-006-temporary",
      p1: { backrow: ["core-006"], hand: ["core-011"], library: [...LIBRARY] },
      p2: { hand: ["core-011"], library: [...LIBRARY] },
    });

    s.startTurn();
    s.expectMana("p1", 5);
    s.startTurn();

    // `refreshMana` set current back to max (4) before the Well gave its 1 again (§2.3).
    s.expectMana("p1", 5);
    expect(s.view("p1").you.mana.max).toBe(4);
  });

  it("only the controller gains, and only on their own turn (§2.2, R68)", () => {
    const s = scenario({
      seed: "core-006-controller",
      p1: { backrow: ["core-006"], hand: ["core-011"], library: [...LIBRARY] },
      p2: { hand: ["core-011"], library: [...LIBRARY] },
      active: "p2",
    });

    // p2 is active, so p2's start of turn runs; a Field Spell fires for its controller alone.
    s.startTurn();
    s.expectMana("p2", 4);
    s.expectMana("p1", 4);
  });

  it("the Field Spell leaves → back to 4", () => {
    const s = scenario({
      seed: "core-006-leaves",
      // #34 Collateral Damage exiles a chosen permanent on either side (§8.2 row 34).
      p1: { backrow: ["core-006"], hand: ["core-034", "core-011"], library: [...LIBRARY] },
      p2: { hand: ["core-011"], library: [...LIBRARY] },
    });
    const well = s.card("core-006");

    s.startTurn();
    s.expectMana("p1", 5);

    s.play("core-034", { targets: [{ pick: "instance", instanceId: well.id }] });
    s.expectInZone(well, "exile");

    s.startTurn();
    s.expectMana("p1", 4);
  });

  it("radiant gains 2: a turn-4 player has 6", () => {
    const s = scenario({
      seed: "core-006-radiant",
      p1: { backrow: [{ def: "core-006", radiant: true }], hand: ["core-011"], library: [...LIBRARY] },
      p2: { hand: ["core-011"], library: [...LIBRARY] },
    });

    s.startTurn();

    s.expectMana("p1", 6);
    expect(s.view("p1").you.mana.max).toBe(4);
  });
});
