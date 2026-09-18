// #70 Spiteful Stab — SPEC §8.3, BUILD M4-T4: "2 + floor(missing/5) + exile count; radiant
// 4 + floor(missing/3) + exile".
//
// §8.3's row: "Deal 2 damage to a target, +1 per full 5 health your hero is below 30, +1 per card
// in your exile" → "4 base, per full 3 health", Engine cell "`missing = max(0, 30 − health)`, floor
// division; your own exile (R72)".
//
// R72 is the whole arithmetic: "'Cards in exile' means your own exile pile; missing health counts
// from 30 even when the hero has more". §3's zone table says the same: the exile count "feeds
// Echoes of the Forgotten and Spiteful Stab". §8's Conventions make the target any legal unit or
// hero on either side, and R81 makes it a play-time pick.

import { describe, expect, it } from "vitest";
import { scenario, type ScenarioOptions } from "./_harness";
import { base, radiant } from "../src/scripts/070-spiteful-stab";

const STAB = "core-070"; // Spell, cost 3.
const SPONGE = "core-019"; // Midrange Menace, 9/9, no Armor: a target that survives.
const FODDER = "core-010"; // Rapid Replenish, a Spell: filler for an exile pile.

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

const AT_ENEMY_HERO = [{ pick: "hero", player: "p2" }] as const;

/** N cards in a pile fixture, so a test names the exile COUNT and not particular cards (R72). */
function pileOf(count: number): string[] {
  return Array.from({ length: count }, () => FODDER);
}

function onUnit(s: Board, player: "p1" | "p2", lane: number): { pick: "instance"; instanceId: string }[] {
  const unit = s.unit(player, lane);
  if (unit === null) throw new Error(`no unit for ${player} in lane ${lane}`);
  return [{ pick: "instance", instanceId: unit.id }];
}

describe("#70 Spiteful Stab", () => {
  it("§8 Conventions declares one target over all units and heroes on either side (R90)", () => {
    const decl = [{ kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit", "hero"] } }];
    expect(base.targets).toEqual(decl);
    expect(radiant.targets).toEqual(decl);
    expect(base.modes).toBeUndefined();
  });

  // -------------------------------------------------------------------------------------------
  // Base: 2 + floor(missing / 5) + own exile count
  // -------------------------------------------------------------------------------------------

  it("§8.3 deals the bare 2 at 30 health with an empty exile", () => {
    const s = board({ p1: { hand: [STAB] } });
    s.play(STAB, { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 28);
  });

  it("R72 adds one per full 5 health missing from 30: 20 health is 2 + 2 = 4", () => {
    const s = board({ p1: { hand: [STAB], health: 20 } });
    s.play(STAB, { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 26);
  });

  it("R72 the division floors: 23 health is missing 7, so 2 + floor(7/5) = 3", () => {
    const s = board({ p1: { hand: [STAB], health: 23 } });
    s.play(STAB, { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 27);
  });

  it("R72 missing health counts from 30 even when the hero has more: 35 health is missing 0", () => {
    const s = board({ p1: { hand: [STAB], health: 35 } });
    s.play(STAB, { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 28);
  });

  it("§8.3 adds one per card in the exile pile: 3 exiled is 2 + 3 = 5", () => {
    const s = board({ p1: { hand: [STAB], exile: pileOf(3) } });
    expect(s.pile("p1", "exile")).toHaveLength(3);
    s.play(STAB, { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 25);
  });

  it("R72 'cards in exile' is YOUR OWN pile: the opponent's exile adds nothing", () => {
    const s = board({ p1: { hand: [STAB] }, p2: { exile: pileOf(4) } });
    s.play(STAB, { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 28);
  });

  it("§8.3 the two bonuses stack: 13 health (missing 17) and 2 exiled is 2 + 3 + 2 = 7", () => {
    const s = board({ p1: { hand: [STAB], health: 13, exile: pileOf(2) } });
    s.play(STAB, { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 23);
  });

  it("§8 Conventions the target may be a unit on either side", () => {
    const s = board({ p1: { hand: [STAB], health: 20, exile: pileOf(1) }, p2: { field: [SPONGE] } });
    s.play(STAB, { targets: onUnit(s, "p2", 1) });
    // 2 + floor(10/5) + 1 = 5.
    s.expectStats(SPONGE, { health: 4, maxHealth: 9 });
  });

  it("§4.4 the whole amount is one pipeline instance, so Armor absorbs it once", () => {
    // #25 4-mana 7/7 prints Armor 7; 2 + floor(10/5) = 4 is fully absorbed and R63 makes it a
    // non-event rather than four separate hits.
    const s = board({ p1: { hand: [STAB], health: 20 }, p2: { field: ["core-025"] } });
    s.play(STAB, { targets: onUnit(s, "p2", 1) });
    s.expectStats("core-025", { health: 7, maxHealth: 7 });
  });

  it("§10.5 the spell goes to the graveyard and counts as played", () => {
    const s = board({ p1: { hand: [STAB] } });
    s.play(STAB, { targets: AT_ENEMY_HERO });
    s.expectInZone(STAB, "graveyard").expectMana("p1", 1).expectEvents("cardPlayed", "damage", "enteredGraveyard");
  });

  it("R90 refuses a play that names no target, because a hero is always legal", () => {
    const s = board({ p1: { hand: [STAB] } });
    expect(() => s.play(STAB)).toThrow(/target/i);
  });

  // -------------------------------------------------------------------------------------------
  // Radiant: "4 base, per full 3 health" (§8 Conventions — only those two numbers move)
  // -------------------------------------------------------------------------------------------

  it("§8.3 the radiant base is 4 at 30 health with an empty exile", () => {
    const s = board({ p1: { hand: [{ def: STAB, radiant: true }] } });
    s.play(STAB, { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 26);
  });

  it("§8.3 the radiant step is a full 3 health: 21 health is missing 9, so 4 + 3 = 7", () => {
    const s = board({ p1: { hand: [{ def: STAB, radiant: true }], health: 21 } });
    s.play(STAB, { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 23);
  });

  it("§8.3 the radiant division floors too: 23 health is missing 7, so 4 + floor(7/3) = 6", () => {
    const s = board({ p1: { hand: [{ def: STAB, radiant: true }], health: 23 } });
    s.play(STAB, { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 24);
  });

  it("§8 Conventions the radiant cell keeps the exile clause: 23 health and 2 exiled is 8", () => {
    const s = board({ p1: { hand: [{ def: STAB, radiant: true }], health: 23, exile: pileOf(2) } });
    s.play(STAB, { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 22);
  });

  it("R72 the radiant face measures from 30 as well: 35 health is still missing 0", () => {
    const s = board({ p1: { hand: [{ def: STAB, radiant: true }], health: 35 } });
    s.play(STAB, { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 26);
  });

  it("§8 Conventions the radiant face still targets a unit on either side", () => {
    const s = board({
      p1: { hand: [{ def: STAB, radiant: true }], health: 24, exile: pileOf(1) },
      p2: { field: [SPONGE] },
    });
    s.play(STAB, { targets: onUnit(s, "p2", 1) });
    // 4 + floor(6/3) + 1 = 7.
    s.expectStats(SPONGE, { health: 2, maxHealth: 9 });
  });
});
