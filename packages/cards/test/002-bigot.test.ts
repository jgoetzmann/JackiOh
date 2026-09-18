// SPEC §8.1 #2 Bigot. BUILD M4-T4 row 2: "Destroys chosen enemy non-Human, Human not targetable,
// no target → enters anyway; radiant clears every enemy non-Human, Humans survive".
//
// The pick is a play-time choice (R81), so it travels in the `play` action as a `Selection` and
// never opens a prompt; R90 is what refuses an illegal pick and what keeps the play legal when the
// board has no legal pick at all (§8's Conventions: the Cry fizzles, the unit still enters).
//
// Non-Human units used here: #25 "4-mana 7/7" (no tags, no hooks) and #12 Duplicating Felinors
// (Felinor; its Cry only fires on a play, never on a board the harness placed).
// Human units used here: #8 Mr. Vanilla and #20 Pointmaster.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";

describe("#2 Bigot", () => {
  it("destroys the chosen enemy non-Human unit", () => {
    const s = scenario({ p1: { hand: ["core-002"] }, p2: { field: ["core-025", "core-008"] } });
    s.play("core-002", { targets: [{ pick: "instance", instanceId: s.card("core-025").id }] });
    s.expectInZone("core-025", "graveyard");
    s.expectInZone("core-008", "field");
    s.expectInZone("core-002", "field");
  });

  it("R90 a Human is not targetable: the play is refused", () => {
    const s = scenario({ p1: { hand: ["core-002"] }, p2: { field: ["core-008"] } });
    const human = s.card("core-008").id;
    expect(() => s.play("core-002", { targets: [{ pick: "instance", instanceId: human }] })).toThrow();
    s.expectInZone("core-008", "field");
    s.expectInZone("core-002", "hand");
  });

  it("R90 no legal target: the play is still legal, the unit enters and the Cry fizzles", () => {
    const s = scenario({ p1: { hand: ["core-002"] }, p2: { field: ["core-008"] } });
    s.play("core-002");
    s.expectInZone("core-002", "field");
    s.expectInZone("core-008", "field");
  });

  it("radiant clears every enemy non-Human while the Humans survive", () => {
    const s = scenario({
      p1: { hand: [{ def: "core-002", radiant: true }] },
      p2: { field: ["core-025", "core-008", "core-012", "core-020"] },
    });
    s.play("core-002");
    s.expectInZone("core-025", "graveyard");
    s.expectInZone("core-012", "graveyard");
    s.expectInZone("core-008", "field");
    s.expectInZone("core-020", "field");
    s.expectInZone("core-002", "field");
  });

  it("radiant needs no target and destroys nothing when every enemy unit is Human", () => {
    const s = scenario({
      p1: { hand: [{ def: "core-002", radiant: true }] },
      p2: { field: ["core-008", "core-020"] },
    });
    s.play("core-002");
    s.expectInZone("core-008", "field");
    s.expectInZone("core-020", "field");
    s.expectStats("core-002", { attack: 12, maxHealth: 2 });
  });
});
