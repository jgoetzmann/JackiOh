// #8 Mr. Vanilla — SPEC §8.1 row 8, BUILD M4-T4 must-pass: "Sheepish fires and does nothing;
// Fuse-onto refused; Vanilla copy by Postdoc still allowed (copy is stats only)". Radiant (R275):
// a 7/7 with "Immutable, Divine Shield", both printed, so the shield is proved in combat here, on a
// Radiant card played from hand and on one made Radiant on the field (§5.2: newly gained keywords
// apply at once).
//
// All three clauses are about what OTHER cards may do to an Immutable unit (R23), so each test here
// drives the other card and asserts that Mr. Vanilla came through it unchanged. The clauses this
// file cannot reach at all are named in the report, not faked here:
//   - Fuse-onto (#85 Unlicensed Experimentation) has no script yet, and Fuse's own refusal is
//     covered by `packages/engine/test/fuse.test.ts`;
//   - `vanilla` applied to an existing card is not something any Core card does (R23 lists only
//     #41 and #83, both Transforms, and #85's Fuse), so the verb's refusal lives in
//     `packages/engine/test/effects-transform.test.ts` (effects/transform.ts:155).

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import { scenario, type Scenario } from "./_harness";

/** The unit view of a def on a side, as §10.8 shows it (so every §10.4 layer is already applied). */
function unitOf(s: Scenario, player: "p1" | "p2", defId: string) {
  const found = s
    .view(player)
    .you.units.find((unit) => unit !== null && unit.defId === defId);
  if (found === null || found === undefined) throw new Error(`${player} has no ${defId} on the field`);
  return found;
}

/** The §10.4-computed keyword kinds of a card on the field. */
function keywordKinds(s: Scenario, card: CardInstance): string[] {
  return s.stats(card).keywords.map((keyword) => keyword.kind);
}

const FILLER = "core-016"; // #16 Hit Job: an inert hand and library card, so no turn auto-ends.
const MENACE = "core-019"; // #19 Midrange Menace, 9/9 Taunt.
const GIGA = "core-029"; // #29 GIGA Glowy Jelly Bean.

describe("#8 Mr. Vanilla (§8.1 row 8)", () => {
  it("enters as a 3/3 with printed Immutable and no text of its own", () => {
    const s = scenario({
      seed: "core-008-base",
      p1: { hand: ["core-008"], mana: 4 },
      p2: { field: ["core-020"] },
    });

    s.play("core-008");

    s.expectStats("core-008", { attack: 3, health: 3, maxHealth: 3 });
    // The base face prints Immutable alone: the Divine Shield is the Radiant face's (R275).
    expect(unitOf(s, "p1", "core-008").keywords).toEqual([{ kind: "Immutable" }]);
    // "Keywords only": the play emits the play itself and nothing else — no Cry, no trigger.
    // `cardResolved` closes every play (§10.5 step 7, R17's second trap moment), so it is part of
    // the bare skeleton and not text of this card's.
    expect(s.lastEvents.map((event) => event.type)).toEqual([
      "manaChanged",
      "cardPlayed",
      "summoned",
      "cardResolved",
    ]);
  });

  it("R23 Radiant is still allowed on an Immutable card: the 7/7 face, Immutable and Divine Shield", () => {
    const s = scenario({
      seed: "core-008-radiant",
      // #26 Glowy Jelly Bean makes a chosen hand card Radiant (§8.2 row 26).
      p1: { hand: ["core-026", "core-008"], mana: 8 },
      p2: { field: ["core-020"] },
    });
    const vanilla = s.card("core-008");

    s.play("core-026", { targets: [{ pick: "instance", instanceId: vanilla.id }] });
    s.play(vanilla);

    s.expectStats(vanilla, { attack: 7, health: 7, maxHealth: 7 });
    expect(unitOf(s, "p1", "core-008").keywords).toContainEqual({ kind: "Immutable" });
    expect(unitOf(s, "p1", "core-008").keywords).toContainEqual({ kind: "Divine Shield" });
  });

  it("R275 radiant: the printed Divine Shield eats the first hit whole, and the next one lands", () => {
    const s = scenario({
      seed: "core-008-radiant-shield",
      p1: { hand: [FILLER], field: [{ def: "core-008", radiant: true }], library: [FILLER] },
      // #19 Midrange Menace, a 9/9: its 9 would kill a 7/7 outright.
      p2: { hand: [FILLER], field: [MENACE], library: [FILLER] },
    });
    const vanilla = s.card("core-008");
    const menace = s.card(MENACE);
    expect(keywordKinds(s, vanilla)).toEqual(expect.arrayContaining(["Immutable", "Divine Shield"]));

    s.attack(vanilla, menace);

    // §4.4 step 1: the strike-back of 9 is negated whole and the shield is spent.
    s.expectEvents("attackDeclared", "divineShieldLost");
    s.expectInZone(vanilla, "field").expectStats(vanilla, { attack: 7, health: 7, maxHealth: 7 });
    expect(s.card(vanilla).divineShieldSpent).toBe(true);
    expect(keywordKinds(s, vanilla)).not.toContain("Divine Shield");
    s.expectStats(menace, { health: 2, maxHealth: 9 });

    // The shield is one hit, not a wall: on p2's turn #19's 9 lands on the unshielded 7/7.
    s.endTurn();
    s.attack(menace, vanilla);
    s.expectInZone(vanilla, "graveyard");
  });

  it("§5.2 a Mr. Vanilla made Radiant on the field gains the Divine Shield at once", () => {
    const s = scenario({
      seed: "core-008-radiant-flip",
      // Radiant #29 GIGA Glowy Jelly Bean: "every card in your hand and all your permanents become
      // Radiant" (§8.2 row 29); cost 6, so the mana is seeded above the refresh (§2.3).
      p1: { hand: [{ def: GIGA, radiant: true }, FILLER], field: ["core-008"], mana: 6, library: [FILLER] },
      p2: { hand: [FILLER], field: [MENACE], library: [FILLER] },
    });
    const vanilla = s.card("core-008");
    expect(keywordKinds(s, vanilla)).toEqual(["Immutable"]);

    s.play(GIGA);

    // R22: the flag flips in place — the 7/7 face and both of its printed keywords, no Cry.
    expect(s.card(vanilla).radiant).toBe(true);
    s.expectStats(vanilla, { attack: 7, health: 7, maxHealth: 7 });
    expect(keywordKinds(s, vanilla)).toEqual(expect.arrayContaining(["Immutable", "Divine Shield"]));

    // And the shield works as one: on p2's turn #19's 9 is negated whole.
    s.endTurn();
    s.attack(MENACE, vanilla);
    s.expectInZone(vanilla, "field");
    expect(s.card(vanilla).damage).toBe(0);
    expect(s.card(vanilla).divineShieldSpent).toBe(true);
  });

  it("R23 Sheepish fires and does nothing: the Transform is refused and the trap is consumed (R17)", () => {
    const s = scenario({
      seed: "core-008-sheepish",
      p1: { hand: ["core-008"], mana: 4 },
      // #41 Sheepish: "When the opponent plays a Unit: Transform it into a Sheep Token" (§8.3).
      p2: { backrow: ["core-041"], field: ["core-020"] },
    });
    const sheepish = s.card("core-041");

    s.play("core-008");

    // R23: the Immutable unit is untouched — still Mr. Vanilla, still a 3/3, still on the field.
    s.expectInZone("core-008", "field");
    s.expectStats("core-008", { attack: 3, health: 3, maxHealth: 3 });
    expect(s.pile("p1", "graveyard")).toHaveLength(0);
    // R17: the trap still fired, so it is spent.
    s.expectInZone(sheepish, "graveyard");
  });

  it("R23 Prejudiced Postdoc may copy an Immutable unit: the Vanilla applies to the copy", () => {
    const s = scenario({
      seed: "core-008-postdoc",
      // #61 Prejudiced Postdoc: "Cry: choose a Human unit on the field; summon a Vanilla copy".
      p1: { hand: ["core-061"], field: ["core-008"], mana: 4 },
      p2: { field: ["core-020"] },
    });
    const original = s.card("core-008");

    s.play("core-061", { targets: [{ pick: "instance", instanceId: original.id }] });

    // The copy is a second 3/3 Mr. Vanilla; the original is untouched (R23, R57).
    const copies = s
      .view("p1")
      .you.units.filter((unit) => unit !== null && unit.defId === "core-008");
    expect(copies).toHaveLength(2);
    s.expectStats(original, { attack: 3, health: 3, maxHealth: 3 });
  });
});
