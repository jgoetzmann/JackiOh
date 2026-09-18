// #53 Reno (SPEC §8.3, §6.3 Heal, §3, R19; BUILD M4-T4 row 53: "12 → 30; 35 stays 35; radiant 60").

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";

describe("#53 Reno — base", () => {
  it("§6.3 raises a hero at 12 to 30", () => {
    const s = scenario({ p1: { hand: ["core-053"], health: 12 } });

    s.play("core-053").expectHealth("p1", 30);
    s.expectEvents("cardPlayed", "summoned", "healed");
  });

  it("§6.3 'Heal up to 30' is a floor, not a ceiling: a hero at 35 stays 35", () => {
    const s = scenario({ p1: { hand: ["core-053"], health: 35 } });

    s.play("core-053").expectHealth("p1", 35);
    // Nothing was healed, so §3 never gave the hero a maximum to be pulled down to.
    expect(s.lastEvents.filter((event) => event.type === "healed")).toHaveLength(0);
  });

  it("a hero exactly at 30 is untouched, and 29 goes up by 1", () => {
    scenario({ p1: { hand: ["core-053"], health: 30 } }).play("core-053").expectHealth("p1", 30);
    scenario({ p1: { hand: ["core-053"], health: 29 } }).play("core-053").expectHealth("p1", 30);
  });

  it("§8 Conventions 'your' means the controller: the enemy hero is not raised", () => {
    const s = scenario({ p1: { hand: ["core-053"], health: 12 }, p2: { health: 12 } });

    s.play("core-053").expectHealth("p1", 30).expectHealth("p2", 12);
  });

  it("the unit still enters the field with its printed 4/6 (§10.4 layer 1)", () => {
    const s = scenario({ p1: { hand: ["core-053"], health: 12 } });

    s.play("core-053").expectInZone("core-053", "field").expectStats("core-053", { attack: 4, maxHealth: 6 });
  });
});

describe("#53 Reno — radiant", () => {
  it("§8 Conventions: only the number changes, so 35 becomes 60", () => {
    const s = scenario({ p1: { hand: ["core-053"], health: 35 } });
    // HARNESS GAP (reported): `SideSetup.hand` takes no `{ def, radiant }` form, so the flag is set
    // on the instance the way §5.2 models it — Radiant is one flag on the card, in any zone.
    s.card("core-053").radiant = true;

    s.play("core-053").expectHealth("p1", 60);
  });

  it("raises a hero at 12 straight to 60 in one heal", () => {
    const s = scenario({ p1: { hand: ["core-053"], health: 12 } });
    s.card("core-053").radiant = true;

    s.play("core-053").expectHealth("p1", 60);
    expect(s.lastEvents.filter((event) => event.type === "healed")).toHaveLength(1);
  });

  it("R19 a hero already above 60 keeps its health: 70 stays 70", () => {
    const s = scenario({ p1: { hand: ["core-053"], health: 70 } });
    s.card("core-053").radiant = true;

    s.play("core-053").expectHealth("p1", 70);
    expect(s.lastEvents.filter((event) => event.type === "healed")).toHaveLength(0);
  });

  it("the radiant unit enters as 8/12 (§5.2)", () => {
    const s = scenario({ p1: { hand: ["core-053"], health: 12 } });
    s.card("core-053").radiant = true;

    s.play("core-053").expectStats("core-053", { attack: 8, maxHealth: 12 });
  });
});
