// #20 Pointmaster — SPEC §8.1 row 20, BUILD M4-T4 row 20.
//
// Must-pass (M4-T4): "First Strike; radiant Divine Shield". Engine cell: "Keywords only".
//
// Both keyword lists are printed in the catalog and applied by §10.4's layers, so the script is
// empty and these tests prove the PRINTED keywords actually reach combat — the only thing a
// keywords-only card can get wrong. §4.3 step 1: one First Striker hits alone and the other side
// answers in step 2 only if it survives; §4.4 step 1: Divine Shield negates the whole hit and is
// gone.

import { describe, expect, it } from "vitest";
import type { Keyword, PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

function keywordsOf(s: Scenario, player: PlayerId, lane: number): string[] {
  const view = s.view(player);
  const side = view.you.player === player ? view.you : view.opponent;
  const unit = side.units[lane - 1];
  if (unit === undefined || unit === null) throw new Error(`no unit in ${player} unit lane ${lane}`);
  return unit.keywords.map((keyword: Keyword) => keyword.kind);
}

describe("#20 Pointmaster (base)", () => {
  it("is a printed 7/2 Human with First Strike and no Divine Shield", () => {
    const s = scenario({ p1: { field: ["core-020"] }, p2: { field: ["core-012"] } });

    s.expectStats("core-020", { attack: 7, health: 2, maxHealth: 2 });
    expect(keywordsOf(s, "p1", 1)).toEqual(["First Strike"]);
  });

  it("§4.3 step 1 First Strike kills the defender before it can strike back", () => {
    // A 3/4 would kill a 7/2 on the exchange; First Strike is the whole reason it does not.
    const s = scenario({ p1: { field: ["core-020"] }, p2: { field: ["core-012"] } });

    s.attack("core-020", "core-012");

    s.expectInZone("core-012", "graveyard");
    s.expectInZone("core-020", "field");
    s.expectStats("core-020", { health: 2 });
  });

  it("§4.3 step 2 a defender that survives the First Strike still answers", () => {
    const s = scenario({ p1: { field: ["core-020"] }, p2: { field: ["core-019"] } });

    s.attack("core-020", "core-019");

    // 7 into a 9/9 leaves it standing, and its 9 back kills a 7/2: base has no Divine Shield.
    s.expectStats("core-019", { health: 2 });
    s.expectInZone("core-020", "graveyard");
  });

  it("§4.3 two First Strikers strike simultaneously, so neither is spared", () => {
    const s = scenario({ p1: { field: ["core-020"] }, p2: { field: ["core-011"] } });

    // #11 Tempo Timmy is a 3/3 with First Strike: both are in step 1, so the exchange is mutual.
    s.attack("core-020", "core-011");

    s.expectInZone("core-011", "graveyard");
    s.expectInZone("core-020", "graveyard");
  });
});

describe("#20 Pointmaster (radiant)", () => {
  it("is a printed 14/4 with First Strike and Divine Shield", () => {
    const s = scenario({
      p1: { field: [{ def: "core-020", radiant: true }] },
      p2: { field: ["core-012"] },
    });

    s.expectStats("core-020", { attack: 14, health: 4, maxHealth: 4 });
    expect(keywordsOf(s, "p1", 1)).toEqual(expect.arrayContaining(["First Strike", "Divine Shield"]));
  });

  it("§4.4 step 1 Divine Shield negates the whole counter-attack and is then gone", () => {
    const s = scenario({
      p1: { field: [{ def: "core-020", radiant: true }] },
      // A radiant #19 is an 18/18 with Taunt: it survives the 14 and hits back for 18.
      p2: { field: [{ def: "core-019", radiant: true }] },
    });
    const pointmaster = s.card("core-020");

    s.attack("core-020", "core-019");

    s.expectStats("core-019", { health: 4, maxHealth: 18 });
    s.expectInZone(pointmaster, "field");
    s.expectStats(pointmaster, { health: 4, maxHealth: 4 });
    // The shield is spent, so the next hit lands: a shield that never spends is R63's bug.
    expect(s.card(pointmaster).divineShieldSpent).toBe(true);
  });

  it("First Strike still lets the radiant face kill outright without taking a hit", () => {
    const s = scenario({
      p1: { field: [{ def: "core-020", radiant: true }] },
      p2: { field: ["core-019"] },
    });

    // 14 into a base 9/9 kills it in step 1, so the Divine Shield is never even called on.
    s.attack("core-020", "core-019");

    s.expectInZone("core-019", "graveyard");
    s.expectStats("core-020", { health: 4 });
    expect(s.card("core-020").divineShieldSpent).not.toBe(true);
  });
});
