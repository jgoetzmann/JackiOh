// #43 Big Felinor (SPEC §8.2, §4.5, §6.3 Destroy; R11, R46, R59, R69).
//
// The must-pass row (BUILD M4-T4 #43): "Non-Felinors on both sides destroyed, Felinors and itself
// survive; radiant enemy side only."
//
// R59 is what makes the two deaths one event rather than two: `destroy` only MARKS a card, §4.5
// step 1 collects every mark "at once", and the state check runs after the whole Cry, never between
// two effects of it. So a single play producing two `destroyed` events — one per side — is the
// assertion, not a sequence of separate checks.
//
// The board keeps one def per slot so a string reference is never ambiguous (harness header):
//   p1  lane 2  #20 Pointmaster   7/2 Human            non-Felinor, dies (base) / lives (radiant)
//   p1  lane 4  Felinor Token     1/1 Felinor, Token   survives both faces
//   p2  lane 1  #12 Duplicating Felinors 3/4 Felinor   survives both faces
//   p2  lane 2  #25 4-mana 7/7    7/7 Armor 7          non-Felinor, dies on both faces
// Nothing on that board has a Cry that could fire (units placed by the builder are not played), and
// Armor is irrelevant to a destroy, which is not damage (§6.3).

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";

/** Big Felinor waits in p1's hand; #21 Hinder rides along so the turn does not auto-end (R82). */
function board(radiantEnemy = false): ReturnType<typeof scenario> {
  return scenario({
    seed: "big-felinor",
    p1: {
      hand: ["core-043", "core-021"],
      field: [
        { def: "core-020", lane: 2 },
        { def: "core-t-felinor", lane: 4 },
      ],
    },
    p2: {
      field: [
        { def: "core-012", lane: 1 },
        { def: "core-025", radiant: radiantEnemy, lane: 2 },
      ],
    },
  });
}

describe("#43 Big Felinor — base", () => {
  it("R59 destroys every non-Felinor unit on both sides in one state check", () => {
    const s = board().play("core-043", { zone: 3 });

    s.expectInZone("core-020", "graveyard");
    s.expectInZone("core-025", "graveyard");
    // Two deaths out of one Cry: neither died before the other was marked.
    s.expectEvents("cardPlayed", "destroyed", "destroyed");
    expect(s.unit("p1", 2)).toBe(null);
    expect(s.unit("p2", 2)).toBe(null);
  });

  it("spares Felinor units on both sides", () => {
    const s = board().play("core-043", { zone: 3 });

    s.expectInZone("core-012", "field");
    s.expectInZone("core-t-felinor", "field");
    expect(s.unit("p2", 1)?.defId).toBe("core-012");
    expect(s.unit("p1", 4)?.defId).toBe("core-t-felinor");
  });

  it("spares itself, because Big Felinor is Felinor-tagged and `notTags` already excludes it", () => {
    const s = board().play("core-043", { zone: 3 });

    s.expectInZone("core-043", "field");
    s.expectStats("core-043", { attack: 3, health: 10, maxHealth: 10 });
    expect(s.unit("p1", 3)?.defId).toBe("core-043");
  });

  it("R46 an Indestructible non-Felinor ignores the destroy mark and switches to Attack Position", () => {
    // Radiant #25 4-mana 7/7 is Indestructible, so §4.5 step 1 leaves it on the field.
    const s = board(true).play("core-043", { zone: 3 });

    s.expectInZone("core-025", "field");
    expect(s.unit("p2", 2)?.position).toBe("ATK");
    // The other non-Felinor is not Indestructible and still dies in the same check.
    s.expectInZone("core-020", "graveyard");
  });

  it("§8 Conventions: an empty target set fizzles and the unit still enters the field", () => {
    const s = scenario({ seed: "big-felinor", p1: { hand: ["core-043", "core-021"] } }).play(
      "core-043",
      { zone: 1 },
    );

    s.expectInZone("core-043", "field");
    s.expectEvents("cardPlayed", "summoned");
    expect(s.events.some((event) => event.type === "destroyed")).toBe(false);
  });
});

describe("#43 Big Felinor — radiant", () => {
  it("§8 Conventions: the restated clause replaces the base one, so only enemy non-Felinors die", () => {
    const s = board();
    s.card("core-043").radiant = true;
    s.play("core-043", { zone: 3 });

    s.expectInZone("core-025", "graveyard");
    // Your own non-Felinor is untouched: that is the whole difference between the faces.
    s.expectInZone("core-020", "field");
    expect(s.unit("p1", 2)?.defId).toBe("core-020");
  });

  it("still spares Felinors on both sides, and itself", () => {
    const s = board();
    s.card("core-043").radiant = true;
    s.play("core-043", { zone: 3 });

    s.expectInZone("core-012", "field");
    s.expectInZone("core-t-felinor", "field");
    s.expectInZone("core-043", "field");
    s.expectStats("core-043", { attack: 6, health: 20, maxHealth: 20 });
  });

  it("R59 the one enemy death is still the single state check after the whole Cry", () => {
    const s = board();
    s.card("core-043").radiant = true;
    s.play("core-043", { zone: 3 });

    s.expectEvents("cardPlayed", "destroyed");
    expect(s.events.filter((event) => event.type === "destroyed")).toHaveLength(1);
  });

  it("R46 an Indestructible enemy non-Felinor survives the radiant face too", () => {
    const s = board(true);
    s.card("core-043").radiant = true;
    s.play("core-043", { zone: 3 });

    s.expectInZone("core-025", "field");
    expect(s.events.some((event) => event.type === "destroyed")).toBe(false);
  });
});
