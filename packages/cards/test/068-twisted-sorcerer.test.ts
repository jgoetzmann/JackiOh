// #68 Twisted Sorcerer — SPEC §8.3, BUILD M4-T4: "4 damage, 8 when hero < 10 at resolution;
// radiant 8 / 16" (R275 doubled the radiant numbers from 6 / 12).
//
// §8.3's row: "Cry: deal 4 damage to a target, 8 if your hero is below 10" → "8, or 16", Engine
// cell "Threshold read at resolution". R75 and §5.3: the source's "Spell, Unit" is read as a Unit,
// so this is a Cry and the body stays on the board.
//
// §8's Conventions: "target" is any legal unit or hero on either side, "your" is the controller, and
// a Cry whose target set is empty fizzles while the unit still enters. R81: the pick travels in the
// `play` action.
//
// R195's yellow glow (`conditionMet`): both answers of this card's hook, checked against the branch
// its resolution then takes, are in condition-active.test.ts with the other hooked cards (README §5).

import { describe, expect, it } from "vitest";
import { scenario, type ScenarioOptions } from "./_harness";
import { base, radiant } from "../src/scripts/068-twisted-sorcerer";

const SOURCERER = "core-068"; // Unit 5/5 → 10/10, cost 2.
const SPONGE = "core-019"; // Midrange Menace, 9/9 → 18/18, no Armor: a target that survives.

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

/** A declared pick of a unit on the board (R81: it travels in the play action, never a prompt). */
function onUnit(s: Board, player: "p1" | "p2", lane: number): { pick: "instance"; instanceId: string }[] {
  const unit = s.unit(player, lane);
  if (unit === null) throw new Error(`no unit for ${player} in lane ${lane}`);
  return [{ pick: "instance", instanceId: unit.id }];
}

const AT_ENEMY_HERO = [{ pick: "hero", player: "p2" }] as const;

describe("#68 Twisted Sorcerer", () => {
  // -------------------------------------------------------------------------------------------
  // The declaration (§8 Conventions, R81, R90)
  // -------------------------------------------------------------------------------------------

  it("§8 Conventions declares one target over all units and heroes on either side (R90)", () => {
    // R90: a bare `target` declaration means a unit only, so the heroes have to be named.
    const decl = [{ kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit", "hero"] } }];
    expect(base.targets).toEqual(decl);
    expect(radiant.targets).toEqual(decl);
    expect(base.modes).toBeUndefined();
  });

  // -------------------------------------------------------------------------------------------
  // Base: 4, or 8 below 10 (§4.4, §8.3)
  // -------------------------------------------------------------------------------------------

  it("§8.3 deals 4 to a chosen enemy unit with the hero at full health", () => {
    const s = board({ p1: { hand: [SOURCERER] }, p2: { field: [SPONGE] } });
    s.play(SOURCERER, { targets: onUnit(s, "p2", 1) });
    s.expectStats(SPONGE, { health: 5, maxHealth: 9 }).expectStats(SOURCERER, { attack: 5, health: 5 });
  });

  it("§8.3 deals 4 to a chosen hero, on either side", () => {
    const s = board({ p1: { hand: [SOURCERER] } });
    s.play(SOURCERER, { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 26);

    const own = board({ p1: { hand: [SOURCERER] } });
    own.play(SOURCERER, { targets: [{ pick: "hero", player: "p1" }] });
    own.expectHealth("p1", 26);
  });

  it("§8.3 deals 8 when the controller's hero is below 10 at resolution", () => {
    const s = board({ p1: { hand: [SOURCERER], health: 9 }, p2: { field: [SPONGE] } });
    s.play(SOURCERER, { targets: onUnit(s, "p2", 1) });
    s.expectStats(SPONGE, { health: 1, maxHealth: 9 });
  });

  it("§8.3 'below 10' is strict: exactly 10 still deals 4", () => {
    const s = board({ p1: { hand: [SOURCERER], health: 10 }, p2: { field: [SPONGE] } });
    s.play(SOURCERER, { targets: onUnit(s, "p2", 1) });
    s.expectStats(SPONGE, { health: 5, maxHealth: 9 });
  });

  it("§8.3 the threshold reads the CONTROLLER's hero, not the opponent's", () => {
    // A low opponent must not raise the amount: "your hero" is the controller's (§8 Conventions).
    const s = board({ p1: { hand: [SOURCERER], health: 30 }, p2: { field: [SPONGE], health: 3 } });
    s.play(SOURCERER, { targets: onUnit(s, "p2", 1) });
    s.expectStats(SPONGE, { health: 5, maxHealth: 9 });
  });

  it("§4.4 the damage is one pipeline instance, so Armor absorbs it", () => {
    // #25 4-mana 7/7 prints Armor 7: §4.4 step 2 subtracts it, and R63 makes a 0 hit a non-event.
    const s = board({ p1: { hand: [SOURCERER] }, p2: { field: ["core-025"] } });
    s.play(SOURCERER, { targets: onUnit(s, "p2", 1) });
    s.expectStats("core-025", { health: 7, maxHealth: 7 });
  });

  it("R90 refuses a play that names no target, because a hero is always legal", () => {
    // §8's "empty target set fizzles" cannot arise for this card: both heroes are in the filter, so
    // `legalSelectionsFor` is never empty and R90's "asks for what the board has" is still 1.
    const s = board({ p1: { hand: [SOURCERER] } });
    expect(() => s.play(SOURCERER)).toThrow(/target/i);
  });

  // -------------------------------------------------------------------------------------------
  // Radiant: "8, or 16" (§8 Conventions — only the numbers move; R275)
  // -------------------------------------------------------------------------------------------

  it("R275 the radiant face is 10/10 and deals 8 with the hero at full health", () => {
    const s = board({ p1: { hand: [{ def: SOURCERER, radiant: true }] }, p2: { field: [SPONGE] } });
    s.play(SOURCERER, { targets: onUnit(s, "p2", 1) });
    s.expectStats(SOURCERER, { attack: 10, health: 10, maxHealth: 10 }).expectStats(SPONGE, { health: 1, maxHealth: 9 });
  });

  it("R275 the radiant face deals 16 when the controller's hero is below 10", () => {
    const s = board({
      p1: { hand: [{ def: SOURCERER, radiant: true }], health: 9 },
      p2: { field: [{ def: SPONGE, radiant: true }] },
    });
    s.play(SOURCERER, { targets: onUnit(s, "p2", 1) });
    s.expectStats(SPONGE, { health: 2, maxHealth: 18 });
  });

  it("§8.3 the radiant threshold is the same strict 'below 10': at 10 it deals 8", () => {
    const s = board({
      p1: { hand: [{ def: SOURCERER, radiant: true }], health: 10 },
      p2: { field: [{ def: SPONGE, radiant: true }] },
    });
    s.play(SOURCERER, { targets: onUnit(s, "p2", 1) });
    s.expectStats(SPONGE, { health: 10, maxHealth: 18 });
  });

  it("§8.3 the radiant threshold reads the controller's hero, not the opponent's", () => {
    const s = board({
      p1: { hand: [{ def: SOURCERER, radiant: true }], health: 30 },
      p2: { field: [{ def: SPONGE, radiant: true }], health: 3 },
    });
    s.play(SOURCERER, { targets: onUnit(s, "p2", 1) });
    s.expectStats(SPONGE, { health: 10, maxHealth: 18 });
  });

  it("R275 the radiant face still hits a hero, for 8 and for 16", () => {
    const high = board({ p1: { hand: [{ def: SOURCERER, radiant: true }] } });
    high.play(SOURCERER, { targets: AT_ENEMY_HERO });
    high.expectHealth("p2", 22);

    const low = board({ p1: { hand: [{ def: SOURCERER, radiant: true }], health: 1 } });
    low.play(SOURCERER, { targets: AT_ENEMY_HERO });
    low.expectHealth("p2", 14);
  });

  it("§4.4 the radiant 8 is one instance too: Armor 7 lets 1 through", () => {
    const s = board({ p1: { hand: [{ def: SOURCERER, radiant: true }] }, p2: { field: ["core-025"] } });
    s.play(SOURCERER, { targets: onUnit(s, "p2", 1) });
    s.expectStats("core-025", { health: 6, maxHealth: 7 });
  });
});
