// SPEC §8.1 #1 Big D-fender. BUILD M4-T4 row 1: "DEF ally takes 3 less (1 position + 2 aura), ATK
// ally unaffected; it never attacks; radiant +4".
//
// The aura is only observable through the damage pipeline (§4.4 step 2 subtracts total Armor), so
// every case here is one combat and one health assertion.
//   attacker  #25 "4-mana 7/7" — 7 attack, 7 health, printed Armor 7, no hooks at all. Its own
//             Armor keeps it alive through the retaliation, so nothing else moves.
//   ally      #19 Midrange Menace — 9/9 with printed Taunt, so the attack MUST go to it (§4.2
//             step 3) whatever position it is in, and 9 health is enough to survive every case.
// 7 damage less (1 Defense Position + 2 aura) = 4, so a 9/9 ends at 5; without the aura, 2; with
// the radiant aura's 4, 7.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";

describe("#1 Big D-fender", () => {
  it("a Defense-Position ally takes 3 less: 1 from the position (§4.1) and 2 from the aura", () => {
    scenario({
      active: "p2",
      p1: { field: ["core-001", { def: "core-019", position: "DEF" }] },
      p2: { field: ["core-025"] },
    })
      .attack("core-025", "core-019")
      .expectStats("core-019", { health: 5, maxHealth: 9 });
  });

  it("an Attack-Position ally is unaffected", () => {
    scenario({
      active: "p2",
      p1: { field: ["core-001", "core-019"] },
      p2: { field: ["core-025"] },
    })
      .attack("core-025", "core-019")
      .expectStats("core-019", { health: 2, maxHealth: 9 });
  });

  it("radiant gives +4 Armor instead, so a Defense-Position ally takes 5 less", () => {
    scenario({
      active: "p2",
      p1: { field: [{ def: "core-001", radiant: true }, { def: "core-019", position: "DEF" }] },
      p2: { field: ["core-025"] },
    })
      .attack("core-025", "core-019")
      .expectStats("core-019", { health: 7, maxHealth: 9 });
  });

  it("R7 never attacks: a 0-attack unit cannot declare an attack on a unit or the hero", () => {
    const s = scenario({ p1: { field: ["core-001", "core-019"] }, p2: { field: ["core-025"] } });
    expect(() => s.attack("core-001", "hero")).toThrow();
    expect(() => s.attack("core-001", "core-025")).toThrow();
    // The board is untouched: no exertion was spent and nothing was damaged.
    s.expectStats("core-025", { health: 7 });
  });

  it('the aura is "your units": an enemy unit in Defense Position gets nothing', () => {
    scenario({
      p1: { field: ["core-001", "core-019"] },
      p2: { field: [{ def: "core-025", position: "DEF" }] },
    })
      .attack("core-019", "core-025")
      // 9 attack − (7 printed Armor + 1 Defense Position) = 1. If the aura reached across the
      // board it would be 9 − 10 = 0 and the enemy would be untouched.
      .expectStats("core-025", { health: 6, maxHealth: 7 });
  });
});
