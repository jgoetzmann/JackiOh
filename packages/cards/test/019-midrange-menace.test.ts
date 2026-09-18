// #19 Midrange Menace — SPEC §8.1 row 19, BUILD M4-T4 row 19.
//
// Must-pass (M4-T4): "Taunt enforced; heals to full at own end of turn; radiant Immutable refuses
// Sheepish".
//
// Engine cell: "Heal removes all damage". §4: "Damage stays on a unit between turns: no phase and no
// cleanup step clears it, and only a heal (§6.3) or leaving the field (R78) takes it off" — which is
// why the heal is worth a card at all.
//
// The radiant cell lists keywords without "Plus", so `[Taunt, Immutable]` is the radiant form's
// COMPLETE keyword list, and "same" restates the end-of-turn clause (§8 Conventions): both are
// asserted below, base and radiant.
//
// R23's "refuses Sheepish" clause: #41 Sheepish is the Trap that transforms a unit into a Sheep
// Token, and its script belongs to another card file, so the transform half of R23 must be proved
// from THAT side. What this file owns is the half that makes R23 apply here — that the radiant face
// really carries Immutable, printed and visible in the view — plus the base face NOT carrying it.

import { describe, expect, it } from "vitest";
import type { Keyword, PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

/** §10.8: the keywords the view publishes for a unit, which is what §10.4's layers computed. */
function keywordsOf(s: Scenario, player: PlayerId, lane: number): string[] {
  const view = s.view(player);
  const side = view.you.player === player ? view.you : view.opponent;
  const unit = side.units[lane - 1];
  if (unit === undefined || unit === null) throw new Error(`no unit in ${player} unit lane ${lane}`);
  return unit.keywords.map((keyword: Keyword) => keyword.kind);
}

describe("#19 Midrange Menace (base)", () => {
  it("is a printed 9/9 with Taunt and without Immutable", () => {
    const s = scenario({ p1: { field: ["core-019"] }, p2: { field: ["core-012"] } });

    s.expectStats("core-019", { attack: 9, health: 9, maxHealth: 9 });
    expect(keywordsOf(s, "p1", 1)).toContain("Taunt");
    expect(keywordsOf(s, "p1", 1)).not.toContain("Immutable");
  });

  it("§4.2 step 3 Taunt is enforced: the enemy hero cannot be attacked while it stands", () => {
    const s = scenario({ p1: { field: ["core-011"] }, p2: { field: ["core-019"] } });

    expect(() => s.attack("core-011", "hero")).toThrow(/Taunt/);
    s.expectHealth("p2", 30);

    // The refusal left the state untouched (§9.3), so the attacker still has its exertion and may
    // take the Taunt unit — which is the only legal target.
    s.attack("core-011", "core-019");
    s.expectStats("core-019", { health: 6 });
  });

  it("heals to full at its own end of turn, removing all damage", () => {
    const s = scenario({
      p1: { field: [{ def: "core-019", damage: 5 }], library: ["core-010"] },
      p2: { field: ["core-012"], library: ["core-010"] },
    });
    s.expectStats("core-019", { health: 4, maxHealth: 9 });

    s.endTurn();

    s.expectStats("core-019", { health: 9, maxHealth: 9 });
    s.expectEvents("healed");
  });

  it("§6.2 does not heal at the opponent's end of turn", () => {
    const s = scenario({
      active: "p2",
      p1: { field: [{ def: "core-019", damage: 5 }], library: ["core-010"] },
      p2: { field: ["core-012"], library: ["core-010"] },
    });

    s.endTurn(); // p2's end of turn: an end-of-turn hook fires for its own controller only

    s.expectStats("core-019", { health: 4 });
  });

  it("heals nothing when it is undamaged, and never raises max health", () => {
    const s = scenario({
      p1: { field: ["core-019"], library: ["core-010"] },
      p2: { field: ["core-012"], library: ["core-010"] },
    });

    s.endTurn();

    s.expectStats("core-019", { health: 9, maxHealth: 9 });
  });
});

describe("#19 Midrange Menace (radiant)", () => {
  it("R23 is a printed 18/18 with Taunt and Immutable — the keyword that refuses Sheepish", () => {
    const s = scenario({ p1: { field: [{ def: "core-019", radiant: true }] }, p2: { field: ["core-012"] } });

    s.expectStats("core-019", { attack: 18, health: 18, maxHealth: 18 });
    expect(keywordsOf(s, "p1", 1)).toEqual(expect.arrayContaining(["Taunt", "Immutable"]));
  });

  it("§4.2 step 3 the radiant face still walls the hero off", () => {
    const s = scenario({
      p1: { field: ["core-011"] },
      p2: { field: [{ def: "core-019", radiant: true }] },
    });

    expect(() => s.attack("core-011", "hero")).toThrow(/Taunt/);
    s.expectHealth("p2", 30);
  });

  it('"same": the radiant face heals to full at its own end of turn too', () => {
    const s = scenario({
      p1: { field: [{ def: "core-019", radiant: true, damage: 10 }], library: ["core-010"] },
      p2: { field: ["core-012"], library: ["core-010"] },
    });
    s.expectStats("core-019", { health: 8, maxHealth: 18 });

    s.endTurn();

    s.expectStats("core-019", { health: 18, maxHealth: 18 });
  });

  it("§6.2 the radiant face does not heal at the opponent's end of turn either", () => {
    const s = scenario({
      active: "p2",
      p1: { field: [{ def: "core-019", radiant: true, damage: 10 }], library: ["core-010"] },
      p2: { field: ["core-012"], library: ["core-010"] },
    });

    s.endTurn();

    s.expectStats("core-019", { health: 8 });
  });
});
