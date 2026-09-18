// #69 Call to Arms — SPEC §8.3, BUILD M4-T4: "Three top-down recruits of cost ≤1, library order
// otherwise kept, stops when the board fills; radiant ≤2".
//
// §8.3's row: "Recruit 3 Units costing 1 or less" → "2 or less", Engine cell "Three top-down scans;
// stops when the board is full".
//
// §6.3 Recruit: "Summon from library, scanning top down … first permanent card that matches the
// filter, summoned into its row per R64 … then the library keeps its order". R1: Recruit never
// fires a Cry. R64: no named zone means the leftmost empty, unlocked zone, left to right.
// R65: the filter reads a def's cost out of play.

import { describe, expect, it } from "vitest";
import { scenario, type ScenarioOptions } from "./_harness";
import { base, radiant } from "../src/scripts/069-call-to-arms";

const CALL = "core-069"; // Spell, cost 2.

// The library fixtures. Costs are the printed ones (R65: read out of play).
const TIMMY = "core-011"; // Unit, cost 1, 3/3 — no Cry.
const VANILLA = "core-008"; // Unit, cost 1, 3/3 Immutable — no Cry.
const DEFENDER = "core-003"; // Unit, cost 1, 1/1 Divine Shield + Reborn — no Cry.
const TOKEN_MAKER = "core-015"; // Unit, cost 1, 1/1 — "Cry: summon a Rush Token" (R1's probe).
const POINTMASTER = "core-020"; // Unit, cost 2, 7/2 — above the base ceiling, inside the radiant one.
const MENACE = "core-019"; // Unit, cost 3 — above both ceilings.
const TRAP = "core-041"; // Sheepish, Trap, cost 1 — a cheap permanent that is not a Unit.
const SPELL = "core-010"; // Rapid Replenish, Spell, cost 0 — never a Recruit candidate (§6.3).

type Board = ReturnType<typeof scenario>;

/**
 * R82: a turn whose only legal actions are ending it, conceding and offering a draw auto-ends by
 * itself, and `reduce` runs that check after EVERY action — so a play that empties the hand and
 * leaves no unit hands the turn over: the opponent draws (taking fatigue on an empty library),
 * start-of-turn triggers fire, and the numbers under test move underneath the assertion. Every
 * scenario below therefore keeps one free 0-cost Spell in p1's hand. It is never played; it only
 * keeps one legal action on the turn. (Reported as a harness gap: `scenario` could hold the turn
 * open by itself.)
 */
const ANCHOR = "core-010"; // Rapid Replenish, Spell, cost 0 — always an affordable play.

function board(opts: ScenarioOptions = {}): Board {
  const p1 = opts.p1 ?? {};
  return scenario({ ...opts, p1: { ...p1, hand: [...(p1.hand ?? []), ANCHOR] } });
}

function unitIds(s: Board): (string | null)[] {
  return [1, 2, 3, 4, 5].map((lane) => s.unit("p1", lane)?.defId ?? null);
}

function libraryIds(s: Board): string[] {
  return s.pile("p1", "library").map((card) => card.defId);
}

describe("#69 Call to Arms", () => {
  it("R81 the spell asks for nothing: no declared target and no mode", () => {
    expect(base.targets).toBeUndefined();
    expect(base.modes).toBeUndefined();
    expect(radiant.targets).toBeUndefined();
    expect(typeof base.cry).toBe("function");
  });

  // -------------------------------------------------------------------------------------------
  // Base: three top-down scans of cost ≤ 1 (§6.3, R64, R65)
  // -------------------------------------------------------------------------------------------

  it("§8.3 recruits three cost-1 Units, top down, into lanes 1-3 (§6.3, R64)", () => {
    const s = board({
      p1: { hand: [CALL], library: [SPELL, MENACE, TIMMY, TRAP, VANILLA, POINTMASTER, DEFENDER, TIMMY] },
    });
    s.play(CALL);

    // Top down: the Spell is not a permanent, Menace costs 3, Timmy is the first match, the Trap is
    // not a Unit, Mr. Vanilla is the second, Pointmaster costs 2, the Right-house defender is third.
    expect(unitIds(s)).toEqual([TIMMY, VANILLA, DEFENDER, null, null]);
  });

  it("§6.3 the library keeps its order, minus exactly the three cards taken", () => {
    const s = board({
      p1: { hand: [CALL], library: [SPELL, MENACE, TIMMY, TRAP, VANILLA, POINTMASTER, DEFENDER, TIMMY] },
    });
    s.play(CALL);

    expect(libraryIds(s)).toEqual([SPELL, MENACE, TRAP, POINTMASTER, TIMMY]);
  });

  it("§6.3 a Spell is never recruited, and neither is a Trap: Recruit takes Units here", () => {
    const s = board({ p1: { hand: [CALL], library: [SPELL, TRAP, SPELL, TRAP] } });
    s.play(CALL);

    expect(unitIds(s)).toEqual([null, null, null, null, null]);
    expect(libraryIds(s)).toEqual([SPELL, TRAP, SPELL, TRAP]);
    // §8 Conventions: the spell still counts as played, and it goes to the graveyard (§10.5).
    s.expectInZone(CALL, "graveyard").expectMana("p1", 2);
  });

  it("R65 'costing 1 or less' skips a 2-cost Unit on the base face", () => {
    const s = board({ p1: { hand: [CALL], library: [POINTMASTER, POINTMASTER, TIMMY] } });
    s.play(CALL);

    expect(unitIds(s)).toEqual([TIMMY, null, null, null, null]);
    expect(libraryIds(s)).toEqual([POINTMASTER, POINTMASTER]);
  });

  it("BUILD row 69 stops when the board fills, leaving the rest of the library in order", () => {
    const s = board({
      p1: {
        hand: [CALL],
        field: [TIMMY, TIMMY, TIMMY],
        library: [DEFENDER, VANILLA, TIMMY, POINTMASTER],
      },
    });
    s.play(CALL);

    // Two free zones, three scans: the first two recruit, the third finds Timmy but no zone, so it
    // does nothing and leaves him in the library (`summonExisting` looks for the zone first).
    expect(unitIds(s)).toEqual([TIMMY, TIMMY, TIMMY, DEFENDER, VANILLA]);
    expect(libraryIds(s)).toEqual([TIMMY, POINTMASTER]);
  });

  it("R64 a Locked unit zone is skipped, and a full-but-locked row stops the recruiting", () => {
    const s = board({ p1: { hand: [CALL], library: [TIMMY, VANILLA, DEFENDER] } });
    // §3.2 Lock is a zone flag; the harness exposes no setter (reported as a harness gap).
    s.state.players.p1.locks.units[0] = true;
    s.state.players.p1.locks.units[1] = true;
    s.state.players.p1.locks.units[3] = true;
    s.state.players.p1.locks.units[4] = true;
    s.play(CALL);

    // Only lane 3 is open, so one recruit lands and the other two scans find no zone.
    expect(unitIds(s)).toEqual([null, null, TIMMY, null, null]);
    expect(libraryIds(s)).toEqual([VANILLA, DEFENDER]);
  });

  it("R1 a recruited unit fires no Cry: Me and Mr Token brings no Rush Token", () => {
    const s = board({ p1: { hand: [CALL], library: [TOKEN_MAKER] } });
    s.play(CALL);

    expect(unitIds(s)).toEqual([TOKEN_MAKER, null, null, null, null]);
    // A Rush Token would have taken lane 2; §6.3 Summon fires no Cry, which is R1's whole point.
    expect(unitIds(s)).not.toContain("core-t-rush");
  });

  it("§8 Conventions an empty library leaves the spell as a played no-op", () => {
    const s = board({ p1: { hand: [CALL], library: [] } });
    s.play(CALL);

    expect(unitIds(s)).toEqual([null, null, null, null, null]);
    s.expectInZone(CALL, "graveyard").expectEvents("cardPlayed", "enteredGraveyard");
  });

  // -------------------------------------------------------------------------------------------
  // Radiant: "2 or less" (§8 Conventions — only the number moves)
  // -------------------------------------------------------------------------------------------

  it("§8.3 the radiant face recruits cost-2 Units as well, still three of them, still top down", () => {
    const s = board({
      p1: {
        hand: [{ def: CALL, radiant: true }],
        library: [MENACE, POINTMASTER, SPELL, TIMMY, MENACE, POINTMASTER],
      },
    });
    s.play(CALL);

    expect(unitIds(s)).toEqual([POINTMASTER, TIMMY, POINTMASTER, null, null]);
    expect(libraryIds(s)).toEqual([MENACE, SPELL, MENACE]);
  });

  it("§8.3 the radiant face still refuses a 3-cost Unit", () => {
    const s = board({ p1: { hand: [{ def: CALL, radiant: true }], library: [MENACE, MENACE] } });
    s.play(CALL);

    expect(unitIds(s)).toEqual([null, null, null, null, null]);
    expect(libraryIds(s)).toEqual([MENACE, MENACE]);
  });

  it("§8.3 the radiant face stops when the board fills too", () => {
    const s = board({
      p1: {
        hand: [{ def: CALL, radiant: true }],
        field: [TIMMY, TIMMY, TIMMY, TIMMY],
        library: [POINTMASTER, TIMMY, VANILLA],
      },
    });
    s.play(CALL);

    expect(unitIds(s)).toEqual([TIMMY, TIMMY, TIMMY, TIMMY, POINTMASTER]);
    expect(libraryIds(s)).toEqual([TIMMY, VANILLA]);
  });
});
