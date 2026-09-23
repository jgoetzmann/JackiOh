// Forced attacks and whose side their target is on, and when a run is over (SPEC §4.2, §6.3 Forced
// attack, R53, R96, R173, R174). Found by the polish-4 edge-case hunt (docs/polish/4-edge-cases.md,
// lenses L1 and L5); every case here failed before its fix.
//
//  - R173: a forced attack is made on an enemy. When #86 "Miss" Mrow dies to #9 Moths to the
//    Flame's strike back and its Death steals Moths, the rest of the run is on Moths's new side and
//    does not attack it; radiant #60 Bear Honeypot's tokens do not attack a played unit that #52
//    Silly Silas has already rotated onto their own side.
//  - R174: a run stops once its target has left the field, even when Reborn puts it straight back.

import type { GameEvent } from "@jackioh/shared";
import type { CardInstance } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const VANILLA = "core-008";
const MOTHS = "core-009";
const STOCKPILE = "core-005";
const TIMMY = "core-011";
const HIT_JOB = "core-016";
const SILAS = "core-052";
const HONEYPOT = "core-060";
const SAINTESS = "core-081";
const MROW = "core-086";

function unitAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.unit(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a unit in lane ${lane}`);
  return card;
}

function declared(events: readonly GameEvent[]): Extract<GameEvent, { type: "attackDeclared" }>[] {
  return events.flatMap((event) => (event.type === "attackDeclared" ? [event] : []));
}

describe("R173: a forced attack is made on an enemy", () => {
  it("R173 once Moths to the Flame is stolen by the attackers' side mid-run, the rest of the run does not attack it (§8 #9, #86)", () => {
    const g = scenario({
      seed: "hunt-cw-moths-mrow",
      p1: { hand: [VANILLA], field: [{ def: MOTHS, lane: 3 }], library: [TIMMY, TIMMY] },
      p2: { hand: [VANILLA], field: [{ def: MROW, lane: 1 }, { def: VANILLA, lane: 2 }], library: [TIMMY] },
    });
    const moths = unitAt(g, "p1", 3);
    const mrow = unitAt(g, "p2", 1);
    const vanilla = unitAt(g, "p2", 2);

    // p1's start of turn: "every enemy unit attacks this". Mrow goes first and dies to the strike
    // back; its Death steals every p1 unit, Moths included, for p2.
    g.startTurn();
    g.expectInZone(mrow, "graveyard");
    expect(g.card(moths).controller).toBe("p2");

    // Moths is p2's own unit now, so p2's Mr. Vanilla is passed over in silence (R96's way).
    expect(declared(g.events).map((event) => event.attackerId)).toEqual([mrow.id]);
    expect(g.card(vanilla).damage).toBe(0);
    g.expectStats(moths, { health: 13 });
  });

  it("R173 radiant Bear Honeypot's tokens do not attack a played unit that has crossed to their own side (§8 #60, #52)", () => {
    const g = scenario({
      p1: { hand: [SILAS, VANILLA] },
      p2: { hand: [VANILLA], backrow: [{ def: HONEYPOT, radiant: true, lane: 3, faceUp: false }] },
    });

    // Silas enters p1's lane 5 and rotates right: he crosses to p2's lane 5 and is p2's (§3.1).
    const silas = g.card(SILAS);
    g.play(silas, { zone: 5, modes: ["right"] });
    expect(g.events).toContainEqual({ type: "controlChanged", instanceId: silas.id, controller: "p2", row: "units", lane: 5 });

    // p2's trap answers p1's play (radiant: any card) and fills p2's board with Rush Tokens. "If it
    // was a Unit, they attack it" — but the unit is on their own side now.
    expect(g.events.some((event) => event.type === "trapFired")).toBe(true);
    expect(declared(g.events).filter((event) => event.targetId === silas.id)).toEqual([]);
    g.expectInZone(silas, "field");
    expect(g.card(silas).damage).toBe(0);
  });
});

describe("R174: a forced run and a target that left the field", () => {
  it("R174 a forced run stops once its target has left the field, even though Reborn brings it back (R53, R83)", () => {
    // p1's base Bear Honeypot answers p2's 1-cost Radiant Saintess (2/2, Reborn): two Rush Tokens
    // attack it. The first kills it; Reborn returns it at 1 health, and the second token does not
    // attack the body that came back.
    const g = scenario({
      seed: "hunt-cw-reborn-run",
      active: "p2",
      p1: { backrow: [{ def: HONEYPOT, faceUp: false, lane: 3 }] },
      p2: { hand: [SAINTESS, STOCKPILE], library: [TIMMY, HIT_JOB] },
    });

    g.play(SAINTESS, { zone: 1 });

    expect(declared(g.events).filter((event) => event.forced)).toHaveLength(1);
    expect(g.events.filter((event) => event.type === "destroyed")).toHaveLength(1);
    const saintess = unitAt(g, "p2", 1);
    expect(saintess.defId).toBe(SAINTESS);
    g.expectStats(saintess, { health: 1 });
  });
});
