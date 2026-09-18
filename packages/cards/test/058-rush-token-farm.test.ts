// #58 Rush Token Farm (SPEC §8.3, BUILD M4-T4 row 58: "Token each start of turn; radiant +3/+3
// aura only on Rush Tokens"). Engine cell: "Aura keyed on def T-rush".
//
// Rulings proved here: R62 and §6.2 (start-of-turn triggers fire on the controller's turn only, and
// after the mana refresh, before the draw), R64 (leftmost empty unlocked zone; a full row summons
// nothing), §10.4 layer 5 (the aura is a computed layer, not a buff), §7 ("Rush Token Farm radiant
// gives all your Rush Tokens +3/+3 as an aura").
//
// §8 Conventions: the radiant cell ends in "same", so the radiant face summons AND pumps.

import { describe, expect, it } from "vitest";
import type { PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

/** Every unit a side has on the field, lane 1 to 5. */
function unitsOf(g: Scenario, player: PlayerId): string[] {
  return [1, 2, 3, 4, 5].flatMap((lane) => {
    const unit = g.unit(player, lane);
    return unit === null ? [] : [unit.defId];
  });
}

/** Both sides need something to do, or R82's auto-end cascades the turn onward. */
const BUSY = { hand: ["core-005"], library: ["core-008", "core-011"] };

describe("#58 Rush Token Farm — base", () => {
  it("§6.2 summons a Rush Token at its controller's start of turn", () => {
    const g = scenario({
      p1: { ...BUSY, backrow: [{ def: "core-058", lane: 1 }] },
      p2: { ...BUSY },
    });

    g.startTurn();

    expect(unitsOf(g, "p1")).toEqual(["core-t-rush"]);
    g.expectStats("core-t-rush", { attack: 3, maxHealth: 3, health: 3 }).expectEvents("turnStarted", "summoned");
  });

  it("R62 and §6.2: it fires on the controller's turns only, never on the opponent's", () => {
    const g = scenario({
      p1: { ...BUSY, backrow: [{ def: "core-058", lane: 1 }] },
      p2: { ...BUSY },
    });

    g.startTurn();
    expect(unitsOf(g, "p1")).toHaveLength(1);

    // p2's turn: p1's Field Spell is in play but it is not p1's start of turn.
    g.endTurn();
    expect(unitsOf(g, "p1")).toHaveLength(1);
    expect(unitsOf(g, "p2")).toHaveLength(0);

    // Back to p1: a second token.
    g.endTurn();
    expect(unitsOf(g, "p1")).toEqual(["core-t-rush", "core-t-rush"]);
  });

  it("R64 takes the leftmost empty unit zone", () => {
    const g = scenario({
      p1: { ...BUSY, backrow: [{ def: "core-058", lane: 1 }], field: [{ def: "core-008", lane: 1 }] },
      p2: { ...BUSY },
    });

    g.startTurn();

    expect(g.unit("p1", 1)?.defId).toBe("core-008");
    expect(g.unit("p1", 2)?.defId).toBe("core-t-rush");
  });

  it("§3.2 a full row summons nothing and the trigger still resolves", () => {
    const g = scenario({
      p1: {
        ...BUSY,
        backrow: [{ def: "core-058", lane: 1 }],
        field: [
          { def: "core-008", lane: 1 },
          { def: "core-008", lane: 2 },
          { def: "core-008", lane: 3 },
          { def: "core-008", lane: 4 },
          { def: "core-008", lane: 5 },
        ],
      },
      p2: { ...BUSY },
    });

    g.startTurn();

    expect(unitsOf(g, "p1")).toEqual(Array.from({ length: 5 }, () => "core-008"));
    g.expectInZone("core-058", "field");
  });

  it("the base face has no aura: a Rush Token beside it is a plain 3/3", () => {
    const g = scenario({
      p1: { backrow: [{ def: "core-058", lane: 1 }], field: [{ def: "core-t-rush", lane: 1 }] },
    });

    g.expectStats("core-t-rush", { attack: 3, maxHealth: 3, health: 3 });
  });
});

describe("#58 Rush Token Farm — radiant", () => {
  it("§10.4 layer 5 gives your Rush Tokens +3/+3", () => {
    const g = scenario({
      p1: {
        backrow: [{ def: "core-058", radiant: true, lane: 1 }],
        field: [{ def: "core-t-rush", lane: 1 }],
      },
    });

    g.expectStats("core-t-rush", { attack: 6, maxHealth: 6, health: 6 });
  });

  it("the Engine cell's def key: only Rush Tokens, and only the ones you control", () => {
    const g = scenario({
      p1: {
        backrow: [{ def: "core-058", radiant: true, lane: 1 }],
        field: [
          { def: "core-t-rush", lane: 1 },
          // Mr. Vanilla is also a 3/3 — a stats match is not a def match.
          { def: "core-008", lane: 2 },
        ],
      },
      p2: { field: [{ def: "core-t-rush", lane: 1 }] },
    });

    const mine = g.unit("p1", 1);
    const theirs = g.unit("p2", 1);
    expect(mine).not.toBeNull();
    expect(theirs).not.toBeNull();
    if (mine === null || theirs === null) return;

    g.expectStats(mine, { attack: 6, maxHealth: 6 });
    g.expectStats("core-008", { attack: 3, maxHealth: 3 });
    // "your Rush Tokens": control, not ownership of the def (R12).
    g.expectStats(theirs, { attack: 3, maxHealth: 3 });
  });

  it("§10.4 layer 5 and not layer 4: the aura changes no `buffs` on the instance", () => {
    const g = scenario({
      p1: {
        backrow: [{ def: "core-058", radiant: true, lane: 1 }],
        field: [{ def: "core-t-rush", lane: 1 }],
      },
    });

    const token = g.unit("p1", 1);
    expect(token?.buffs).toEqual({ attack: 0, health: 0 });
    g.expectStats("core-t-rush", { attack: 6, maxHealth: 6 });
  });

  it('§8 Conventions "same": the radiant face still summons a token, and pumps that one too', () => {
    const g = scenario({
      p1: { ...BUSY, backrow: [{ def: "core-058", radiant: true, lane: 1 }] },
      p2: { ...BUSY },
    });

    g.startTurn();

    expect(unitsOf(g, "p1")).toEqual(["core-t-rush"]);
    g.expectStats("core-t-rush", { attack: 6, maxHealth: 6, health: 6 });
  });

  it("the +3/+3 is real in combat: a pumped token trades with a 6-attack unit", () => {
    const g = scenario({
      p1: {
        backrow: [{ def: "core-058", radiant: true, lane: 1 }],
        field: [{ def: "core-t-rush", lane: 1 }],
      },
      p2: { field: [{ def: "core-019", lane: 1 }] },
    });

    // 6 into Midrange Menace's 9/9, and 9 back into a 6-health token: the token dies (R11: a unit
    // token that leaves the field ceases to exist rather than reaching a graveyard).
    const token = g.unit("p1", 1);
    expect(token).not.toBeNull();
    if (token === null) return;

    g.attack(token, "core-019");

    g.expectStats("core-019", { health: 3, maxHealth: 9 }).expectInZone(token, "gone");
  });
});
