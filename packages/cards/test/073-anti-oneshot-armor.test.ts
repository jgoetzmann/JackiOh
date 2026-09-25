// #73 Anti-oneshot Armor — SPEC §8.3, BUILD M4-T4: "A 12 hit becomes 5 (radiant 3), per instance,
// hero only; Cry draws 1 (radiant 2, R275)", plus R18's "lose health bypasses the cap".
//
// The 12-damage hit is a radiant core-002 Bigot (12/2). Its script is a Cry only, and a unit placed
// by a `field` setup never fires one (R1), so the attack is a bare 12-damage instance through the
// §4.4 pipeline with nothing else in it. R18's bypass is #27 Blood Ridden Glowy Jelly Bean's "you
// lose 5 health", read against the RADIANT cap of 3: 5 is below the base cap of 5, so only the
// radiant face can tell a clamp apart from a bypass.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

function damageTo(s: Scenario, targetId: string): number[] {
  return s.events
    .flatMap((event) => (event.type === "damage" ? [event] : []))
    .filter((event) => event.targetId === targetId)
    .map((event) => event.amount);
}

describe("#73 Anti-oneshot Armor (base)", () => {
  it("§4.4 step 3: a 12-damage hit on the protected hero becomes 5", () => {
    const s = scenario({
      seed: "core-073-cap-12",
      active: "p2",
      p1: { backrow: ["core-073"], hand: ["core-005"] },
      p2: { field: [{ def: "core-002", radiant: true }], hand: ["core-005"] },
    });
    const bigot = s.unit("p2", 1);
    s.expectStats(bigot!, { attack: 12 });

    s.attack(bigot!, "hero");

    s.expectHealth("p1", 25);
    expect(damageTo(s, "hero-p1")).toEqual([5]);
  });

  it("the cap is PER damage instance, so two 12-hits cost 5 each", () => {
    const s = scenario({
      seed: "core-073-per-instance",
      active: "p2",
      p1: { backrow: ["core-073"], hand: ["core-005"] },
      p2: {
        field: [
          { def: "core-002", radiant: true },
          { def: "core-002", radiant: true },
        ],
        hand: ["core-005"],
      },
    });
    const first = s.unit("p2", 1);
    const second = s.unit("p2", 2);

    s.attack(first!, "hero").attack(second!, "hero");

    s.expectHealth("p1", 20);
    expect(damageTo(s, "hero-p1")).toEqual([5, 5]);
  });

  it("hero ONLY: a unit on the protected side takes the whole 12", () => {
    const s = scenario({
      seed: "core-073-hero-only",
      active: "p2",
      // core-019 Midrange Menace is 9/9 with Taunt, so it is the only legal target anyway.
      p1: { field: ["core-019"], backrow: ["core-073"], hand: ["core-005"] },
      p2: { field: [{ def: "core-002", radiant: true }], hand: ["core-005"] },
    });
    const menace = s.unit("p1", 1);
    const bigot = s.unit("p2", 1);

    s.attack(bigot!, menace!);

    // A capped 5 would have left a 9-health unit alive; the full 12 kills it.
    expect(damageTo(s, menace!.id)).toEqual([12]);
    s.expectInZone(menace!, "graveyard");
    s.expectHealth("p1", 30);
  });

  it("§4.4 puts Armor (step 2) before the cap (step 3), so a hit already under the cap keeps its reduction", () => {
    const s = scenario({
      seed: "core-073-armor-order",
      active: "p2",
      p1: { backrow: ["core-073"], hand: ["core-005"], armor: 10 },
      p2: { field: [{ def: "core-002", radiant: true }], hand: ["core-005"] },
    });
    const bigot = s.unit("p2", 1);

    s.attack(bigot!, "hero");

    // 12 − 10 armor = 2, and min(2, 5) is 2 — not the cap's 5.
    s.expectHealth("p1", 28);
    expect(damageTo(s, "hero-p1")).toEqual([2]);
  });

  it("Cry: draw 1", () => {
    const s = scenario({
      seed: "core-073-cry",
      p1: { hand: ["core-073", "core-005"], library: ["core-035", "core-036"] },
      p2: { hand: ["core-005"] },
    });

    s.play("core-073");

    // Two in hand, one played, one drawn.
    expect(s.hand("p1")).toHaveLength(2);
    expect(s.hand("p1").map((card) => card.defId)).toContain("core-035");
    expect(s.pile("p1", "library")).toHaveLength(1);
    s.expectEvents("cardPlayed", "summoned", "drawn", "addedToHand");
    // §5.1: a Field Spell with a Cry — it went to the backrow and stayed there.
    // (§3.2 also makes a played Field Spell public, but `reduce.playCard` does not set `faceUp`
    // the way `effects/summon.ts` does; that engine gap is reported, not asserted here.)
    expect(s.backrow("p1", 1)?.defId).toBe("core-073");
  });

  it("R18: \"lose health\" is not damage, so the base cap of 5 never sees it", () => {
    const s = scenario({
      seed: "core-073-r18-base",
      p1: { backrow: ["core-073"], hand: ["core-027", "core-005"], library: ["core-035"] },
      p2: { hand: ["core-005"] },
    });

    // #27 Blood Ridden Glowy Jelly Bean: "you lose 5 health".
    s.play("core-027");

    s.expectHealth("p1", 25);
    s.expectEvents("healthLost");
    // Not a damage instance at all: nothing for the pipeline to clamp.
    expect(damageTo(s, "hero-p1")).toEqual([]);
  });
});

describe("#73 Anti-oneshot Armor (radiant)", () => {
  it("radiant caps at 3: the same 12-damage hit becomes 3", () => {
    const s = scenario({
      seed: "core-073-radiant-cap",
      active: "p2",
      p1: { backrow: [{ def: "core-073", radiant: true }], hand: ["core-005"] },
      p2: { field: [{ def: "core-002", radiant: true }], hand: ["core-005"] },
    });
    const bigot = s.unit("p2", 1);
    expect(s.backrow("p1", 1)?.radiant).toBe(true);

    s.attack(bigot!, "hero");

    s.expectHealth("p1", 27);
    expect(damageTo(s, "hero-p1")).toEqual([3]);
  });

  it("radiant is still hero-only and still per instance", () => {
    const s = scenario({
      seed: "core-073-radiant-scope",
      active: "p2",
      p1: { field: ["core-019"], backrow: [{ def: "core-073", radiant: true }], hand: ["core-005"] },
      p2: {
        field: [
          { def: "core-002", radiant: true },
          { def: "core-002", radiant: true },
        ],
        hand: ["core-005"],
      },
    });
    const menace = s.unit("p1", 1);
    const first = s.unit("p2", 1);
    const second = s.unit("p2", 2);

    s.attack(first!, menace!);
    expect(damageTo(s, menace!.id)).toEqual([12]);

    // The Taunt unit is gone, so the hero is reachable; two instances would be 3 + 3.
    s.attack(second!, "hero");
    s.expectHealth("p1", 27);
    expect(damageTo(s, "hero-p1")).toEqual([3]);
  });

  it("radiant Cry: draw 2 (R275: the cap tightens and the Cry doubles)", () => {
    const s = scenario({
      seed: "core-073-radiant-cry",
      p1: {
        hand: [{ def: "core-073", radiant: true }, "core-005"],
        library: ["core-035", "core-036", "core-037"],
      },
      p2: { hand: ["core-005"] },
    });

    s.play("core-073");

    // Two in hand, one played, two drawn — the top two, the third left in the library.
    expect(s.hand("p1")).toHaveLength(3);
    expect(s.hand("p1").map((card) => card.defId)).toEqual(
      expect.arrayContaining(["core-035", "core-036"]),
    );
    expect(s.pile("p1", "library").map((card) => card.defId)).toEqual(["core-037"]);
    expect(s.events.filter((event) => event.type === "drawn")).toHaveLength(2);
    s.expectEvents("cardPlayed", "summoned", "drawn", "drawn");
    expect(s.backrow("p1", 1)?.radiant).toBe(true);
  });

  it("the base Cry still draws exactly 1 beside the radiant's 2", () => {
    const s = scenario({
      seed: "core-073-base-cry-count",
      p1: { hand: ["core-073", "core-005"], library: ["core-035", "core-036", "core-037"] },
      p2: { hand: ["core-005"] },
    });

    s.play("core-073");

    expect(s.events.filter((event) => event.type === "drawn")).toHaveLength(1);
    expect(s.pile("p1", "library")).toHaveLength(2);
  });

  it("R18: a 5-point \"lose health\" goes through in full past the radiant cap of 3", () => {
    const s = scenario({
      seed: "core-073-r18-radiant",
      p1: {
        backrow: [{ def: "core-073", radiant: true }],
        hand: ["core-027", "core-005"],
        library: ["core-035"],
      },
      p2: { hand: ["core-005"] },
    });

    s.play("core-027");

    // Were the cap to apply, this would be 27. R18 says it does not.
    s.expectHealth("p1", 25);
    s.expectEvents("healthLost");
    expect(damageTo(s, "hero-p1")).toEqual([]);
  });
});
