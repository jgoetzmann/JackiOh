// #18 Bread and Butter — SPEC §8.1 row 18, BUILD M4-T4 row 18.
//
// Must-pass (M4-T4): "Fires in the trap window at either player's end with unspent mana (R62), token
// to trap controller (R52), X = unspent, 0 → nothing, stays; radiant 3X".
//
// R62's sequence: "… end-of-turn triggers → end-of-turn trap window (Bread and Butter and Intern
// Stimmy on both sides, in R68 order) → end-of-turn delayed effects → cleanup". The trap watches the
// `turnEnded` event, which `traps.ts` reserves for that window alone (`TRAP_WINDOW_EVENTS`).
//
// R52: "The token always goes to the trap's controller, whichever player ended the turn with unspent
// mana" — which is why the opponent's-turn test asserts an EMPTY board on the ending player's side.
//
// §7 and R37: the Bread Token is printed 0/0 and "always summoned as X/X through `statsOverride`",
// so every assertion below reads the def id AND the stats: the def alone would pass at 0/0.

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import type { PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

const BREAD_TOKEN = "core-t-bread";

function unitAt(s: Scenario, player: PlayerId, lane: number): CardInstance {
  const found = s.unit(player, lane);
  if (found === null) throw new Error(`no unit in ${player} unit lane ${lane}`);
  return found;
}

function backrowAt(s: Scenario, player: PlayerId, lane: number): CardInstance {
  const found = s.backrow(player, lane);
  if (found === null) throw new Error(`no card in ${player} backrow lane ${lane}`);
  return found;
}

/** §7, R37: a Bread Token of exactly X/X, not the printed 0/0. */
function expectBread(s: Scenario, token: CardInstance, x: number): void {
  expect(token.defId).toBe(BREAD_TOKEN);
  s.expectStats(token, { attack: x, health: x, maxHealth: x });
}

describe("#18 Bread and Butter (base)", () => {
  it("R62 fires in the end-of-turn trap window of its controller's own turn", () => {
    const s = scenario({
      p1: { backrow: ["core-018"], mana: 2, library: ["core-010"] },
      p2: { field: ["core-012"], library: ["core-010"] },
    });

    s.endTurn();

    expectBread(s, unitAt(s, "p1", 1), 2);
    s.expectEvents("turnEnded", "trapFired", "summoned");
  });

  it("R62/R52 fires at the opponent's end of turn, and the token goes to the trap's controller", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: ["core-018"], field: ["core-012"], library: ["core-010"] },
      p2: { mana: 3, library: ["core-010"] },
    });

    s.endTurn();

    // R64: lane 1 is taken, so the token takes the leftmost free zone.
    expectBread(s, unitAt(s, "p1", 2), 3);
    // R52: p2 ended the turn with the unspent mana, and gets nothing for it.
    for (const lane of [1, 2, 3, 4, 5]) expect(s.unit("p2", lane)).toBeNull();
  });

  it("X is the ending player's unspent mana", () => {
    const s = scenario({
      p1: { backrow: ["core-018"], mana: 4, library: ["core-010"] },
      p2: { field: ["core-012"], library: ["core-010"] },
    });

    s.endTurn();

    expectBread(s, unitAt(s, "p1", 1), 4);
  });

  it("a turn ended with no unspent mana summons nothing and leaves the trap armed and face-down", () => {
    const s = scenario({
      p1: { backrow: ["core-018"], field: ["core-012"], mana: 0, library: ["core-010"] },
      p2: { field: ["core-020"], library: ["core-010"] },
    });
    const trap = backrowAt(s, "p1", 1);

    s.endTurn();

    for (const lane of [2, 3, 4, 5]) expect(s.unit("p1", lane)).toBeNull();
    s.expectInZone(trap, "field");
    // Nothing fired, so §5.1's reveal never happened and the opponent still sees a bare marker.
    expect(s.card(trap).faceUp).not.toBe(true);
    expect(s.view("p2").opponent.backrow[0]).toEqual({ faceDown: true });
  });

  it("§5.1 a Field Trap is not consumed: it stays on the field and pays out again", () => {
    const s = scenario({
      p1: { backrow: ["core-018"], mana: 1, library: ["core-010", "core-011"] },
      p2: { field: ["core-012"], library: ["core-010", "core-011"] },
    });
    const trap = backrowAt(s, "p1", 1);

    s.endTurn(); // p1 ends with 1 unspent

    expectBread(s, unitAt(s, "p1", 1), 1);
    s.expectInZone(trap, "field");
    // R33: a Field Trap that has fired is face-up to both players from then on.
    expect(s.card(trap).faceUp).toBe(true);

    s.endTurn(); // p2 ends, its mana refreshed to MAX_MANA and unspent

    expectBread(s, unitAt(s, "p1", 2), 4);
    s.expectInZone(trap, "field");
    expect(s.pile("p1", "graveyard").some((card) => card.id === trap.id)).toBe(false);
  });
});

describe("#18 Bread and Butter (radiant)", () => {
  it("summons a 3X/3X Bread Token", () => {
    const s = scenario({
      p1: { backrow: [{ def: "core-018", radiant: true }], mana: 2, library: ["core-010"] },
      p2: { field: ["core-012"], library: ["core-010"] },
    });

    s.endTurn();

    expectBread(s, unitAt(s, "p1", 1), 6);
  });

  it("R52 the 3X token still goes to the trap's controller at the opponent's end of turn", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [{ def: "core-018", radiant: true }], field: ["core-012"], library: ["core-010"] },
      p2: { mana: 1, library: ["core-010"] },
    });

    s.endTurn();

    expectBread(s, unitAt(s, "p1", 2), 3);
    for (const lane of [1, 2, 3, 4, 5]) expect(s.unit("p2", lane)).toBeNull();
  });

  it("3 × 0 is still nothing: no token at 0 unspent mana", () => {
    const s = scenario({
      p1: { backrow: [{ def: "core-018", radiant: true }], field: ["core-012"], mana: 0, library: ["core-010"] },
      p2: { field: ["core-020"], library: ["core-010"] },
    });
    const trap = backrowAt(s, "p1", 1);

    s.endTurn();

    for (const lane of [2, 3, 4, 5]) expect(s.unit("p1", lane)).toBeNull();
    s.expectInZone(trap, "field");
  });
});
