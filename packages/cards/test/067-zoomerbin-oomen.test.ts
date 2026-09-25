// #67 Zoomerbin Oomen — SPEC §8.3, BUILD M4-T4: "Random trap face-down and unpaid into own lane's
// backrow; occupied or Locked → nothing (R47); pool = six traps".
//
// §8.3's row: "Cry: summon a random 1-cost Trap face-down into your backrow zone in this lane" →
// "A random Radiant Trap" (R275), Engine cell "All six Core traps cost 1, so the base pool is #18,
// #41, #60, #71, #85, #96 and the radiant face's is the same six, summoned Radiant; zone occupied or
// Locked → fizzles". A Radiant face-down trap is still hidden from the opponent, face and all (R33,
// R97, R177).
//
// §3.1 fixes what "this lane" means: "the backrow zone in the same column as the unit". §8's
// Conventions fix the fizzle: the Cry does nothing and "the unit still enters". R1 fixes the
// unpaid, dormant arrival: a summon fires no Cry and pays no mana.

import { describe, expect, it } from "vitest";
import { scenario, type ScenarioOptions } from "./_harness";
import { base, radiant } from "../src/scripts/067-zoomerbin-oomen";
import { TRAP_TYPES, catalog } from "../src/query";

const OOMEN = "core-067"; // Unit 1/2 → 2/4, cost 1, Human.
const MANA_WELL = "core-006"; // A Field Spell: something to occupy a backrow zone with.

/** The Engine cell's pool, by catalog id: #18, #41, #60, #71, #85, #96. */
const TRAP_POOL = ["core-018", "core-041", "core-060", "core-071", "core-085", "core-096"];

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

const LANE = 3;

/** Every backrow zone p1 holds, by catalog id, with `null` for an empty one. */
function backrowIds(s: Board): (string | null)[] {
  return [1, 2, 3, 4, 5].map((lane) => s.backrow("p1", lane)?.defId ?? null);
}

describe("#67 Zoomerbin Oomen", () => {
  // -------------------------------------------------------------------------------------------
  // The pool (§5.1, R60)
  // -------------------------------------------------------------------------------------------

  it("BUILD row 67 the pool is exactly the six Core traps, and both faces draw from it", () => {
    const indices = (defs: { index: string }[]): string[] => defs.map((entry) => entry.index);
    // The base face asks for 1-cost traps, the radiant face for any trap; every Core trap costs 1,
    // so the two queries are the same six defs. Field Trap counts as Trap (§8 #51, R35, R61).
    expect(indices(catalog.query({ type: TRAP_TYPES, cost: 1 }))).toEqual(["18", "41", "60", "71", "85", "96"]);
    expect(indices(catalog.query({ type: TRAP_TYPES }))).toEqual(["18", "41", "60", "71", "85", "96"]);
  });

  it("R81 the Cry asks for nothing: the lane is the unit's own, not a declared pick", () => {
    expect(base.targets).toBeUndefined();
    expect(base.modes).toBeUndefined();
    expect(radiant.targets).toBeUndefined();
    expect(typeof base.cry).toBe("function");
    expect(typeof radiant.cry).toBe("function");
  });

  // -------------------------------------------------------------------------------------------
  // Base: the summon (§3.1, §3.2, R1, R33)
  // -------------------------------------------------------------------------------------------

  it("§8.3 summons a trap from the pool into the unit's OWN lane's backrow zone", () => {
    const s = board({ p1: { hand: [OOMEN] } });
    s.play(OOMEN, { zone: LANE });

    const trap = s.backrow("p1", LANE);
    expect(trap).not.toBeNull();
    expect(TRAP_POOL).toContain(trap?.defId);
    // §3.1: only that column, never the leftmost free zone (R64's fallback is not what this says).
    expect(backrowIds(s)).toEqual([null, null, trap?.defId ?? null, null, null]);
  });

  it("§3.2/R33 the trap arrives face-down and not Radiant, and R1 leaves it unpaid", () => {
    const s = board({ p1: { hand: [OOMEN] } });
    s.play(OOMEN, { zone: LANE });

    expect(s.backrow("p1", LANE)?.faceUp).not.toBe(true);
    // The base face makes an ordinary trap: "Radiant" is the radiant face's word (R275).
    expect(s.backrow("p1", LANE)?.radiant).toBe(false);
    // Only Oomen's own cost of 1 was paid: a summon pays nothing (R1, §6.3 Summon).
    s.expectMana("p1", 3).expectEvents("cardPlayed", "summoned", "summoned");
  });

  it("R60 the seeded pick stays inside the pool and reaches every member of it", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 40; seed += 1) {
      const s = board({ seed: `oomen-${seed}`, p1: { hand: [OOMEN] } });
      s.play(OOMEN, { zone: LANE });
      const trap = s.backrow("p1", LANE);
      expect(trap).not.toBeNull();
      expect(TRAP_POOL).toContain(trap?.defId);
      if (trap !== null) seen.add(trap.defId);
    }
    expect([...seen].sort()).toEqual([...TRAP_POOL].sort());
  });

  it("R60 the same seed gives the same trap: the pick replays (§9.3)", () => {
    const pick = (): string | undefined => {
      const s = board({ seed: "oomen-replay", p1: { hand: [OOMEN] } });
      s.play(OOMEN, { zone: LANE });
      return s.backrow("p1", LANE)?.defId;
    };
    expect(pick()).toBe(pick());
  });

  // -------------------------------------------------------------------------------------------
  // Base: the fizzle (R47, §8 Conventions)
  // -------------------------------------------------------------------------------------------

  it("R47 an occupied backrow zone fizzles the summon, and the unit still enters", () => {
    const s = board({ p1: { hand: [OOMEN], backrow: [{ def: MANA_WELL, lane: LANE }] } });
    s.play(OOMEN, { zone: LANE });

    s.expectInZone(OOMEN, "field");
    // Nothing moved, nothing spilled into another lane (§3.1: this card names one zone only).
    expect(backrowIds(s)).toEqual([null, null, MANA_WELL, null, null]);
  });

  it("R47 a Locked backrow zone fizzles the summon, and the unit still enters", () => {
    const s = board({ p1: { hand: [OOMEN] } });
    // §3.2 Lock is a zone flag. The harness exposes no way to lock a zone (reported as a harness
    // gap: `SideSetup.locks` or `s.lock(player, row, lane)`), and #36 Magic Jammed only locks the
    // zone of a backrow card it destroys, so the flag is set here directly — a test-only liberty.
    s.state.players.p1.locks.backrow[LANE - 1] = true;
    s.play(OOMEN, { zone: LANE });

    s.expectInZone(OOMEN, "field");
    expect(backrowIds(s)).toEqual([null, null, null, null, null]);
  });

  it("§3.1 lane 1 and lane 5 are read as the unit's own column too", () => {
    for (const lane of [1, 5]) {
      const s = board({ p1: { hand: [OOMEN] } });
      s.play(OOMEN, { zone: lane });
      expect(s.backrow("p1", lane)).not.toBeNull();
      expect(TRAP_POOL).toContain(s.backrow("p1", lane)?.defId);
    }
  });

  it("§3.1 the trap never lands on the opponent's side ('YOUR backrow zone')", () => {
    const s = board({ p1: { hand: [OOMEN] } });
    s.play(OOMEN, { zone: LANE });
    expect([1, 2, 3, 4, 5].map((lane) => s.backrow("p2", lane))).toEqual([null, null, null, null, null]);
  });

  // -------------------------------------------------------------------------------------------
  // Radiant: "a random Radiant Trap" (§8 Conventions, R275)
  // -------------------------------------------------------------------------------------------

  it("R275 the radiant face is 2/4 and summons a Radiant trap into its own lane, face-down", () => {
    const s = board({ p1: { hand: [{ def: OOMEN, radiant: true }] } });
    s.play(OOMEN, { zone: LANE });

    s.expectStats(OOMEN, { attack: 2, health: 4, maxHealth: 4 });
    const trap = s.backrow("p1", LANE);
    expect(trap).not.toBeNull();
    expect(TRAP_POOL).toContain(trap?.defId);
    expect(trap?.radiant).toBe(true);
    expect(trap?.faceUp).not.toBe(true);
    expect(backrowIds(s)).toEqual([null, null, trap?.defId ?? null, null, null]);
    // Still a summon: only Oomen's own cost was paid (R1).
    s.expectMana("p1", 3);
  });

  it("R33, R97 the Radiant trap is hidden from the opponent, face and all; its controller reads it", () => {
    const s = board({ seed: "oomen-radiant-hidden", p1: { hand: [{ def: OOMEN, radiant: true }] } });
    s.play(OOMEN, { zone: LANE });
    const trap = s.backrow("p1", LANE);
    if (trap === null) throw new Error("the Radiant Oomen should have summoned a trap");

    // The opponent is told the zone is occupied and nothing more (§10.8).
    const theirs = s.view("p2");
    expect(theirs.opponent.backrow[LANE - 1]).toEqual({ faceDown: true });
    // Nowhere in their view — the board, the events, a prompt — is the card named or its face shown.
    const serialized = JSON.stringify(theirs);
    expect(serialized).not.toContain(`"${trap.id}"`);
    expect(serialized).not.toContain(`"${trap.defId}"`);

    // Its controller reads it, Radiant face included (R33).
    const mine = s.view("p1").you.backrow[LANE - 1];
    expect(mine).toMatchObject({ faceDown: false, defId: trap.defId, radiant: true });
  });

  it("§8.3 the radiant pool drops the cost clause and still reaches every Core trap, each Radiant", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 40; seed += 1) {
      const s = board({ seed: `oomen-radiant-${seed}`, p1: { hand: [{ def: OOMEN, radiant: true }] } });
      s.play(OOMEN, { zone: LANE });
      const trap = s.backrow("p1", LANE);
      expect(trap?.radiant).toBe(true);
      if (trap !== null) seen.add(trap.defId);
    }
    expect([...seen].sort()).toEqual([...TRAP_POOL].sort());
  });

  it("R47 the radiant face fizzles on an occupied zone, and the unit still enters", () => {
    const s = board({ p1: { hand: [{ def: OOMEN, radiant: true }], backrow: [{ def: MANA_WELL, lane: LANE }] } });
    s.play(OOMEN, { zone: LANE });

    s.expectInZone(OOMEN, "field");
    expect(backrowIds(s)).toEqual([null, null, MANA_WELL, null, null]);
    // The Field Spell already there is not made Radiant: the summon made nothing.
    expect(s.backrow("p1", LANE)?.radiant).toBe(false);
  });

  it("R47 the radiant face fizzles on a Locked zone too, and the unit still enters", () => {
    const s = board({ p1: { hand: [{ def: OOMEN, radiant: true }] } });
    s.state.players.p1.locks.backrow[LANE - 1] = true;
    s.play(OOMEN, { zone: LANE });

    s.expectInZone(OOMEN, "field").expectStats(OOMEN, { attack: 2, health: 4 });
    expect(backrowIds(s)).toEqual([null, null, null, null, null]);
  });
});
