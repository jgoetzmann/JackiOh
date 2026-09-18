// #84 Going Long — SPEC §8.4 row 84 ("Your hero has Armor 2 (paid 4: 5)" / radiant "Armor 4
// (paid 4: 10)", Engine cell "Hero armor in pipeline step 2"), BUILD M4-T4 row 84: "In opening
// hand; embiggen 2 → Armor 2, 4 → Armor 5 on the hero; radiant 4 / 10".
//
// The Armor is asserted where §4.4 reads it — through a real damage instance on the protected hero
// — and not off any number this card declares. Two axes multiply, so there are four numbers:
//
//        paid 2      paid 4 (embiggen)
//   base   2              5
//   radiant 4            10
//
// A card sitting in the backrow from the setup was never embiggened, which is the "paid 2" column;
// the "paid 4" column has to be PLAYED with `embiggen: true`, which is also where the price itself
// is proved (`expectMana`).
//
// R63 is the floor: "a hit that is 0 after Armor and the cap emits no `damage` event and triggers
// nothing" — it heals nothing either, so the hero's health is untouched and no `healed` event goes
// out. §4.4 step 2's "Ignores armor (True Strike) skips this" and #73's "it must stop when the
// Field Spell leaves the backrow" are the other two edges tested here.
//
// The attackers are placed by `field`, so no Cry of theirs ever fires (R1) and each attack is a
// bare damage instance through the §4.4 pipeline:
//   #2 Bigot        6/1, no keywords
//   #20 Pointmaster 7/2, First Strike (irrelevant against a hero)
//   #61 Postdoc     2/4, attack 2 — exactly the base Armor, so the hit floors at 0

import { describe, expect, it } from "vitest";
import { flagsOf } from "@jackioh/engine";
import type { PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

const GOING_LONG = "core-084"; // Field Spell, Quickdraw, cost 2 embiggen 4
const BIGOT = "core-002"; // 6/1
const POINTMASTER = "core-020"; // 7/2
const POSTDOC = "core-061"; // 2/4
const TRUE_STRIKE = "core-044"; // Spell, 1 — "Deal 4 damage to a target, ignoring Armor"
const MAGIC_JAMMED = "core-036"; // Spell, 1 — "Destroy target backrow card; Lock its zone"
const STOCKPILE = "core-005"; // the spare card that keeps a turn meaningful (§2.5)
const MENACE = "core-019";
const TIMMY = "core-011";
const SCARAB = "core-007"; // 1/1, no Taunt — a body of p1's so §2.5 never auto-ends the turn

const SPARE = { hand: [STOCKPILE, TIMMY], library: [MENACE, TIMMY] } as const;

function damageTo(s: Scenario, targetId: string): number[] {
  return s.events
    .flatMap((event) => (event.type === "damage" ? [event] : []))
    .filter((event) => event.targetId === targetId)
    .map((event) => event.amount);
}

function healedCount(s: Scenario): number {
  return s.events.filter((event) => event.type === "healed").length;
}

/** What the client is told this hero's Armor is (§10.8). */
function shownArmor(s: Scenario, player: PlayerId): number {
  return s.view(player).you.hero.armor;
}

function targeting(instanceId: string) {
  return [{ pick: "instance" as const, instanceId }];
}

describe("#84 Going Long — the opening hand", () => {
  it("§6.2 Quickdraw: the engine reads the flag off a real instance of either face", () => {
    // `setup.ts` moves every library card carrying `quickdraw` into the opening hand, replacing one
    // opening draw; that placement is the engine's own setup test. What this card owes is the flag,
    // and `flagsOf` is the engine's reader — it resolves the script through the instance's face, so
    // this asserts the radiant face carries it too rather than reading the script object.
    const s = scenario({
      p1: { library: [GOING_LONG, { def: GOING_LONG, radiant: true }] },
    });
    const [plain, shiny] = s.pile("p1", "library");

    expect(flagsOf(plain!).quickdraw).toBe(true);
    expect(flagsOf(shiny!).quickdraw).toBe(true);
  });
});

describe("#84 Going Long — base", () => {
  it("§4.4 step 2: paid 2 gives your hero Armor 2, so a 6-attack hit lands for 4", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [GOING_LONG], hand: [STOCKPILE] },
      p2: { field: [BIGOT], hand: [STOCKPILE] },
    });

    s.attack(BIGOT, "hero");

    expect(damageTo(s, "hero-p1")).toEqual([4]);
    s.expectHealth("p1", 26);
  });

  it("§10.8 the hero block shows the Armor the pipeline reads", () => {
    const s = scenario({
      p1: { backrow: [GOING_LONG], hand: [STOCKPILE] },
      p2: { ...SPARE },
    });

    expect(shownArmor(s, "p1")).toBe(2);
    expect(shownArmor(s, "p2")).toBe(0);
  });

  it("R63 a hit reduced to 0 by the Armor deals nothing, heals nothing and emits no damage", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [GOING_LONG], hand: [STOCKPILE] },
      p2: { field: [POSTDOC], hand: [STOCKPILE] }, // attack 2, exactly the Armor
    });

    s.attack(POSTDOC, "hero");

    expect(damageTo(s, "hero-p1")).toEqual([]);
    s.expectHealth("p1", 30);
    expect(healedCount(s)).toBe(0);
  });

  it("'YOUR hero': the Armor protects its controller only", () => {
    const s = scenario({
      p1: { backrow: [GOING_LONG], field: [BIGOT], hand: [STOCKPILE] },
      p2: { hand: [STOCKPILE] },
    });

    s.attack(BIGOT, "hero");

    expect(damageTo(s, "hero-p2")).toEqual([6]);
    s.expectHealth("p2", 24);
  });

  it("embiggen 4 costs 4 mana and gives Armor 5, so the same 6-attack hit lands for 1", () => {
    const s = scenario({
      p1: { hand: [GOING_LONG, STOCKPILE], field: [SCARAB], library: [MENACE, TIMMY] },
      p2: { field: [BIGOT], ...SPARE },
    });

    s.play(GOING_LONG, { zone: 1, embiggen: true });
    s.expectMana("p1", 0); // MAX_MANA 4 − the embiggen price 4

    s.endTurn(); // p2's turn
    s.attack(BIGOT, "hero");

    expect(damageTo(s, "hero-p1")).toEqual([1]);
    s.expectHealth("p1", 29);
  });

  it("the base price is still 2, and paying it gives Armor 2 rather than 5", () => {
    const s = scenario({
      p1: { hand: [GOING_LONG, STOCKPILE], field: [SCARAB], library: [MENACE, TIMMY] },
      p2: { field: [BIGOT], ...SPARE },
    });

    s.play(GOING_LONG, { zone: 1 });
    s.expectMana("p1", 2);

    s.endTurn();
    s.attack(BIGOT, "hero");

    expect(damageTo(s, "hero-p1")).toEqual([4]);
    s.expectHealth("p1", 26);
  });

  it("§4.4 step 2 'Ignores armor' skips it: True Strike lands whole where an attack is reduced", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [GOING_LONG], hand: [STOCKPILE] },
      p2: { field: [POINTMASTER], hand: [TRUE_STRIKE, STOCKPILE] },
    });

    s.play(TRUE_STRIKE, { targets: [{ pick: "hero", player: "p1" }] });
    expect(damageTo(s, "hero-p1")).toEqual([4]); // the printed 4, armor skipped

    s.attack(POINTMASTER, "hero");
    expect(damageTo(s, "hero-p1")).toEqual([4, 5]); // 7 − 2 armor
    s.expectHealth("p1", 21);
  });

  it("the Armor stops the moment the Field Spell leaves the backrow", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [GOING_LONG], hand: [STOCKPILE] },
      p2: { field: [BIGOT, BIGOT], hand: [MAGIC_JAMMED, STOCKPILE] },
    });
    const goingLong = s.backrow("p1", 1)!;
    const first = s.unit("p2", 1)!;
    const second = s.unit("p2", 2)!;

    s.attack(first, "hero"); // 6 − 2 = 4
    s.play(MAGIC_JAMMED, { targets: targeting(goingLong.id) });
    s.expectInZone(goingLong, "graveyard");
    s.attack(second, "hero"); // no Armor left: the whole 6

    expect(damageTo(s, "hero-p1")).toEqual([4, 6]);
    s.expectHealth("p1", 20);
    expect(shownArmor(s, "p1")).toBe(0);
  });
});

describe("#84 Going Long — radiant", () => {
  it("'Armor 4': paid 2 on the radiant face, so a 6-attack hit lands for 2", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [{ def: GOING_LONG, radiant: true }], hand: [STOCKPILE] },
      p2: { field: [BIGOT], hand: [STOCKPILE] },
    });

    expect(shownArmor(s, "p1")).toBe(4);

    s.attack(BIGOT, "hero");

    expect(damageTo(s, "hero-p1")).toEqual([2]);
    s.expectHealth("p1", 28);
  });

  it("'(paid 4: 10)': the radiant embiggen price gives Armor 10, so a 6-attack hit is nothing (R63)", () => {
    const s = scenario({
      p1: { hand: [{ def: GOING_LONG, radiant: true }, STOCKPILE], field: [SCARAB], library: [MENACE, TIMMY] },
      p2: { field: [BIGOT], ...SPARE },
    });

    s.play(GOING_LONG, { zone: 1, embiggen: true });
    s.expectMana("p1", 0);
    expect(shownArmor(s, "p1")).toBe(10);

    s.endTurn();
    s.attack(BIGOT, "hero");

    expect(damageTo(s, "hero-p1")).toEqual([]);
    s.expectHealth("p1", 30);
    expect(healedCount(s)).toBe(0);
  });

  it("the radiant face still reduces rather than blocks: a 14-attack hit lands for 4 at Armor 10", () => {
    const s = scenario({
      p1: { hand: [{ def: GOING_LONG, radiant: true }, STOCKPILE], field: [SCARAB], library: [MENACE, TIMMY] },
      p2: { field: [{ def: POINTMASTER, radiant: true }], ...SPARE }, // radiant #20 is a 14/4
    });

    s.play(GOING_LONG, { zone: 1, embiggen: true });
    s.endTurn();
    s.attack(POINTMASTER, "hero");

    expect(damageTo(s, "hero-p1")).toEqual([4]); // 14 − 10
    s.expectHealth("p1", 26);
  });

  it("§6.2 the radiant face is still Quickdraw and still a Field Spell in the backrow", () => {
    const s = scenario({
      p1: { hand: [{ def: GOING_LONG, radiant: true }, STOCKPILE], field: [SCARAB], library: [MENACE, TIMMY] },
      p2: { ...SPARE },
    });

    s.play(GOING_LONG, { zone: 2 });

    const placed = s.backrow("p1", 2);
    expect(placed).not.toBeNull();
    expect(placed!.radiant).toBe(true);
    expect(flagsOf(placed!).quickdraw).toBe(true);
    s.expectMana("p1", 2);
  });
});
