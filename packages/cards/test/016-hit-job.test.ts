// #16 Hit Job — SPEC §8.1 row 16, BUILD M4-T4 row 16.
//
// Must-pass (M4-T4): "Target destroyed; Indestructible survives; radiant also kills same-side
// neighbours, never across".
//
// Engine cell: "Adjacency 3.1; Indestructible survives" (R46). §3.1: "Adjacent means index N-1 and
// N+1 on the same side and same row", so a radiant Hit Job can never reach over the centre line.
//
// The target travels in the `play` action (R81), never as a prompt, so every test here names it with
// `play(..., { targets })` and no test answers anything.

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import type { PlayerId, Selection } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

/**
 * HARNESS GAP: `SideSetup.hand` is `string[]`, so a test cannot put a RADIANT card in a hand the way
 * `field`/`backrow` take `{ def, radiant: true }`. Until it does, the radiant face is reached by
 * setting the flag on the instance the setup created — which is exactly the state §5.2's
 * `setRadiant` leaves behind on a card in hand (R60), so the play that follows is a real one.
 */
function makeRadiant(s: Scenario, ref: string): Scenario {
  s.card(ref).radiant = true;
  return s;
}

function unitAt(s: Scenario, player: PlayerId, lane: number): CardInstance {
  const found = s.unit(player, lane);
  if (found === null) throw new Error(`no unit in ${player} unit lane ${lane}`);
  return found;
}

/** R81: one declared `target`, carried in the play action's flat `targets` list. */
function aim(card: CardInstance): Selection[] {
  return [{ pick: "instance", instanceId: card.id }];
}

describe("#16 Hit Job (base)", () => {
  it("destroys the target unit", () => {
    const s = scenario({
      p1: { hand: ["core-016", "core-010"], mana: 4 },
      p2: { field: ["core-019"] },
    });
    const victim = unitAt(s, "p2", 1);

    s.play("core-016", { targets: aim(victim) });

    s.expectInZone(victim, "graveyard");
    expect(s.unit("p2", 1)).toBeNull();
    s.expectEvents("cardPlayed", "destroyed", "enteredGraveyard");
  });

  it("R46 an Indestructible unit ignores the destroy mark and survives", () => {
    const s = scenario({
      p1: { hand: ["core-016", "core-010"], mana: 4 },
      // #25 radiant "4-mana 7/7" is Indestructible (§8.2 row 25).
      p2: { field: [{ def: "core-025", radiant: true }] },
    });
    const survivor = unitAt(s, "p2", 1);

    s.play("core-016", { targets: aim(survivor) });

    s.expectInZone(survivor, "field");
    s.expectStats(survivor, { attack: 14, health: 14, maxHealth: 14 });
  });

  it("destroys an ally as readily as an enemy: \"target unit\" is narrowed to neither side", () => {
    const s = scenario({
      p1: { hand: ["core-016", "core-010"], field: ["core-012"], mana: 4 },
      p2: { field: ["core-019"] },
    });
    const mine = unitAt(s, "p1", 1);

    s.play("core-016", { targets: aim(mine) });

    s.expectInZone(mine, "graveyard");
    s.expectInZone("core-019", "field");
  });

  it("fizzles with no unit on the board, and the spell still counts as played (§8 Conventions)", () => {
    const s = scenario({ p1: { hand: ["core-016", "core-010"], mana: 4 }, p2: {} });

    s.play("core-016");

    s.expectInZone("core-016", "graveyard");
    s.expectMana("p1", 2);
    s.expectEvents("cardPlayed");
  });
});

describe("#16 Hit Job (radiant)", () => {
  it("§3.1 also destroys the units adjacent to the target on its own side", () => {
    const s = scenario({
      p1: { hand: ["core-016"], field: ["core-011", "core-025", "core-012"], mana: 4 },
      // lanes 1-4: the target sits in lane 2, so lanes 1 and 3 are adjacent and lane 4 is not.
      p2: { field: ["core-002", "core-019", "core-020", "core-008"] },
    });
    makeRadiant(s, "core-016");
    const left = unitAt(s, "p2", 1);
    const target = unitAt(s, "p2", 2);
    const right = unitAt(s, "p2", 3);
    const far = unitAt(s, "p2", 4);

    s.play("core-016", { targets: aim(target) });

    s.expectInZone(target, "graveyard");
    s.expectInZone(left, "graveyard");
    s.expectInZone(right, "graveyard");
    // Lane 4 is two lanes away: §3.1's adjacency is N-1 and N+1 and nothing wider.
    s.expectInZone(far, "field");
    // R59: one effect, one state check, so all three deaths land together.
    s.expectEvents("destroyed", "destroyed", "destroyed");
  });

  it("§3.1 never reaches across the centre line", () => {
    const s = scenario({
      p1: { hand: ["core-016"], field: ["core-011", "core-025", "core-012"], mana: 4 },
      p2: { field: ["core-002", "core-019", "core-020"] },
    });
    makeRadiant(s, "core-016");
    const acrossLeft = unitAt(s, "p1", 1);
    const acrossTarget = unitAt(s, "p1", 2);
    const acrossRight = unitAt(s, "p1", 3);

    s.play("core-016", { targets: aim(unitAt(s, "p2", 2)) });

    // The target's lane and both its neighbours, on the other side of the line: all untouched.
    s.expectInZone(acrossLeft, "field");
    s.expectInZone(acrossTarget, "field");
    s.expectInZone(acrossRight, "field");
  });

  it("R46 spares an Indestructible neighbour and kills the rest", () => {
    const s = scenario({
      p1: { hand: ["core-016"], mana: 4 },
      p2: { field: [{ def: "core-025", radiant: true }, "core-019", "core-012"] },
    });
    makeRadiant(s, "core-016");
    const indestructible = unitAt(s, "p2", 1);
    const target = unitAt(s, "p2", 2);
    const neighbour = unitAt(s, "p2", 3);

    s.play("core-016", { targets: aim(target) });

    s.expectInZone(indestructible, "field");
    s.expectInZone(target, "graveyard");
    s.expectInZone(neighbour, "graveyard");
  });

  it("§3.1 \"on its side\" cuts both ways: an ally target takes your own neighbours with it", () => {
    const s = scenario({
      p1: { hand: ["core-016"], field: ["core-011", "core-025", "core-012"], mana: 4 },
      p2: { field: ["core-002", "core-019", "core-020"] },
    });
    makeRadiant(s, "core-016");
    const myLeft = unitAt(s, "p1", 1);
    const myTarget = unitAt(s, "p1", 2);
    const myRight = unitAt(s, "p1", 3);
    const theirs = unitAt(s, "p2", 2);

    s.play("core-016", { targets: aim(myTarget) });

    s.expectInZone(myTarget, "graveyard");
    s.expectInZone(myLeft, "graveyard");
    s.expectInZone(myRight, "graveyard");
    s.expectInZone(theirs, "field");
  });

  it("kills the target alone when its neighbouring lanes are empty", () => {
    const s = scenario({
      p1: { hand: ["core-016", "core-010"], mana: 4 },
      p2: { field: [{ def: "core-019", lane: 3 }] },
    });
    makeRadiant(s, "core-016");
    const target = unitAt(s, "p2", 3);

    s.play("core-016", { targets: aim(target) });

    s.expectInZone(target, "graveyard");
  });
});
