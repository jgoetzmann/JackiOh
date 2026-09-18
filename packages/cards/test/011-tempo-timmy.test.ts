// #11 Tempo Timmy (SPEC §8.1, BUILD M4-T4 row 11): "Attacks a unit on summon turn, not the hero;
// kills a 3-health unit unharmed; radiant may hit the hero".
//
// The card scripts nothing, so every clause here is a keyword behaving: §4.1's two sickness lifts
// (Rush for unit targets only, Charge for units and the hero) and §4.3 step 1's First Strike.
//
// HARNESS GAP: `SideSetup.hand` is `string[]`, so a RADIANT card cannot be seeded in a hand, and a
// radiant Cry or a radiant summoning-sick body can only be reached by playing one. Until `hand`
// takes `{ def, radiant }` the radiant tests set the flag on the hand instance themselves; see
// `playRadiant` below.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";
import { base, def, radiant } from "../src/scripts/011-tempo-timmy";

/** HARNESS GAP (see the header): make the hand copy radiant, then play it. */
function playRadiant(s: Scenario, card: string): Scenario {
  s.card(card).radiant = true;
  return s.play(card);
}

describe("#11 Tempo Timmy", () => {
  it("is keywords only: both faces print their keywords and neither script has a hook (§8)", () => {
    // §8 Conventions: a radiant cell that lists keywords without "Plus" is the COMPLETE radiant
    // list, so Rush is gone and Charge replaces it. Verified against the catalog here because a
    // mismatch would otherwise be papered over by a script that re-granted the keyword.
    expect(def.base.keywords.map((k) => k.kind)).toEqual(["Rush", "First Strike"]);
    expect(def.radiant.keywords.map((k) => k.kind)).toEqual(["Charge", "First Strike"]);
    expect(base).toEqual({});
    expect(radiant).toEqual({});
  });

  describe("base", () => {
    it("attacks a unit on its summon turn (Rush, §4.1)", () => {
      const s = scenario({
        p1: { hand: ["core-011", "core-005"], library: ["core-005"] },
        p2: { field: ["core-008"], library: ["core-005"] },
      });
      s.play("core-011");
      const vanilla = s.card("core-008");

      s.attack("core-011", "core-008");

      s.expectInZone(vanilla, "graveyard");
    });

    it("kills a 3-health unit unharmed (First Strike, §4.3 step 1)", () => {
      const s = scenario({
        p1: { hand: ["core-011", "core-005"], library: ["core-005"] },
        // Mr. Vanilla is 3/3 with no First Strike of its own, so §4.3's step 1 decides the exchange:
        // Timmy's 3 lands first, the defender has fallen and "deals nothing" back.
        p2: { field: ["core-008"], library: ["core-005"] },
      });
      s.play("core-011");
      const vanilla = s.card("core-008");

      s.attack("core-011", "core-008");

      s.expectInZone(vanilla, "graveyard");
      s.expectStats("core-011", { attack: 3, health: 3, maxHealth: 3 });
    });

    it("cannot hit the hero on its summon turn (Rush, not Charge, §4.2 step 2)", () => {
      const s = scenario({
        p1: { hand: ["core-011", "core-005"], library: ["core-005"] },
        p2: { field: ["core-008"], library: ["core-005"] },
      });
      s.play("core-011");

      expect(() => s.attack("core-011", "hero")).toThrow(/Rush cannot hit the hero on its summon turn/);
      s.expectHealth("p2", 30);
    });
  });

  describe("radiant", () => {
    it("may hit the hero on its summon turn (Charge, §4.1)", () => {
      const s = scenario({
        p1: { hand: ["core-011", "core-005"], library: ["core-005"] },
        p2: { field: ["core-008"], library: ["core-005"] },
      });
      playRadiant(s, "core-011");

      s.expectStats("core-011", { attack: 6, health: 6, maxHealth: 6 });
      s.attack("core-011", "hero");

      s.expectHealth("p2", 24);
    });

    it("still kills a 3-health unit unharmed (First Strike is kept, §8 Conventions)", () => {
      const s = scenario({
        p1: { hand: ["core-011", "core-005"], library: ["core-005"] },
        p2: { field: ["core-008"], library: ["core-005"] },
      });
      playRadiant(s, "core-011");
      const vanilla = s.card("core-008");

      s.attack("core-011", "core-008");

      s.expectInZone(vanilla, "graveyard");
      s.expectStats("core-011", { health: 6 });
    });
  });
});
