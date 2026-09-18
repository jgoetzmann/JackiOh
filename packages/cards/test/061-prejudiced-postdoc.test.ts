// #61 Prejudiced Postdoc — SPEC §8.3, BUILD M4-T4 row 61.
//
// Must-pass: "Vanilla copy of a Human keeps the target's form and buffs, no keywords or text, no
// damage; auras apply afresh; an Immutable target is legal (R23, R57); radiant any unit."

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import type { PlayerId, Selection } from "@jackioh/shared";
import { base, radiant } from "../src/scripts/061-prejudiced-postdoc";
import { scenario, type Scenario } from "./_harness";

const POSTDOC = "core-061"; // Unit, Human, 2 — 2/4 → 4/8
const TIMMY = "core-011"; // Unit, Human, 3/3, Rush + First Strike
const MR_VANILLA = "core-008"; // Unit, Human, 3/3, Immutable
const SHREDDER = "core-013"; // Unit, no tags, 8/10 — the radiant face's "any unit"
const PILLOW = "core-065-1"; // #65.1, the aura source for "auras apply afresh"
const SURGERY = "core-063"; // #63, the only buff this wave can put on an enemy unit

/** `s.unit()` is nullable; a lane assertion wants a hard failure when the lane is empty. */
function unitAt(s: Scenario, player: PlayerId, lane: number): CardInstance {
  const found = s.unit(player, lane);
  if (found === null) throw new Error(`expected a unit in ${player} lane ${lane}, found none`);
  return found;
}

function sel(card: CardInstance): Selection {
  return { pick: "instance", instanceId: card.id };
}

/**
 * The Postdoc is a Unit, so it takes p1's leftmost free lane itself (R64) and its copy takes the
 * next one. With an empty p1 board that is lane 1 for the Postdoc and lane 2 for the copy.
 */
const COPY_LANE = 2;

describe("#61 Prejudiced Postdoc", () => {
  it("R57 the copy keeps the target's buffs and resets its damage", () => {
    const s = scenario({
      p1: { hand: [SURGERY, POSTDOC], mana: 8 },
      p2: { field: [{ def: TIMMY, damage: 2 }] },
    });
    const timmy = s.card(TIMMY);

    s.play(SURGERY, { targets: [sel(timmy)] });
    s.expectStats(timmy, { attack: 6, maxHealth: 6, health: 4 });

    s.play(POSTDOC, { targets: [sel(timmy)] });

    const copy = unitAt(s, "p1", COPY_LANE);
    expect(copy.defId).toBe(TIMMY);
    // The target's form and buffs, at full health: R57 copies buffs and resets damage.
    s.expectStats(copy, { attack: 6, maxHealth: 6, health: 6 });
    expect(copy.damage).toBe(0);
  });

  it("§8.3 the copy has no text and no granted keywords", () => {
    const s = scenario({
      p1: { hand: [SURGERY, POSTDOC], mana: 8 },
      p2: { field: [TIMMY] },
    });
    const timmy = s.card(TIMMY);

    s.play(SURGERY, { targets: [sel(timmy)] });
    expect(s.card(timmy).grantedKeywords).toHaveLength(1);

    s.play(POSTDOC, { targets: [sel(timmy)] });

    const copy = unitAt(s, "p1", COPY_LANE);
    // Vanilla: §10.4 drops the printed keywords (Rush, First Strike) on the read.
    expect(copy.vanilla).toBe(true);
    // "no granted keywords": Plastic Surgery's keyword stayed on the original.
    expect(copy.grantedKeywords).toEqual([]);
    expect(s.card(timmy).grantedKeywords).toHaveLength(1);
    // The original is untouched: only the copy is Vanilla.
    expect(s.card(timmy).vanilla).toBe(false);
  });

  it("§10.4 auras apply to the copy afresh instead of being copied", () => {
    const s = scenario({
      p1: { hand: [POSTDOC], mana: 4 },
      p2: { field: [PILLOW, TIMMY] },
    });
    const timmy = s.card(TIMMY);
    // p2's Spikey Pillow drains p2's units: 3 attack − 2.
    s.expectStats(timmy, { attack: 1 });

    s.play(POSTDOC, { targets: [sel(timmy)] });

    // The copy lands on p1, where no aura reaches it, so it reads its own layers from scratch.
    s.expectStats(unitAt(s, "p1", COPY_LANE), { attack: 3, maxHealth: 3 });
  });

  it("R23 an Immutable target is legal and the copy is the one that is made Vanilla", () => {
    const s = scenario({
      p1: { hand: [POSTDOC], mana: 4 },
      p2: { field: [MR_VANILLA] },
    });
    const immutable = s.card(MR_VANILLA);

    s.play(POSTDOC, { targets: [sel(immutable)] });

    const copy = unitAt(s, "p1", COPY_LANE);
    expect(copy.defId).toBe(MR_VANILLA);
    s.expectStats(copy, { attack: 3, maxHealth: 3 });
    expect(copy.vanilla).toBe(true);
    // R23 blocks Vanilla on the Immutable card itself, and nothing here touched it.
    expect(s.card(immutable).vanilla).toBe(false);
  });

  it("R74 the copy keeps the target's radiant flag", () => {
    const s = scenario({
      p1: { hand: [POSTDOC], mana: 4 },
      p2: { field: [{ def: TIMMY, radiant: true }] },
    });
    const timmy = s.card(TIMMY);
    s.expectStats(timmy, { attack: 6, maxHealth: 6 });

    s.play(POSTDOC, { targets: [sel(timmy)] });

    const copy = unitAt(s, "p1", COPY_LANE);
    expect(copy.radiant).toBe(true);
    s.expectStats(copy, { attack: 6, maxHealth: 6 });
  });

  it("R64 no free zone means no copy, and the Postdoc still enters", () => {
    const s = scenario({
      p1: { hand: [POSTDOC], field: [MR_VANILLA, "core-t-felinor", "core-t-rush", "core-t-sheep"], mana: 4 },
      p2: { field: [TIMMY] },
    });
    const timmy = s.card(TIMMY);

    s.play(POSTDOC, { targets: [sel(timmy)] });

    s.expectInZone(POSTDOC, "field");
    expect(unitAt(s, "p1", 5).defId).toBe(POSTDOC);
    // Every lane is taken, so the copy had nowhere to go and was never created.
    const p1Defs = [1, 2, 3, 4, 5].map((lane) => unitAt(s, "p1", lane).defId);
    expect(p1Defs).not.toContain(TIMMY);
  });

  it("radiant Prejudiced Postdoc copies a unit with no Human tag", () => {
    // §5.2's in-hand swap: the card is Radiant before it is played, so its radiant Cry runs.
    const s = scenario({
      p1: { hand: [{ def: POSTDOC, radiant: true }], mana: 4 },
      p2: { field: [SHREDDER] },
    });
    const shredder = s.card(SHREDDER);

    s.play(POSTDOC, { targets: [sel(shredder)] });

    // The radiant face's own stats prove the radiant text is the one that ran.
    s.expectStats(unitAt(s, "p1", 1), { attack: 4, maxHealth: 8 });
    const copy = unitAt(s, "p1", COPY_LANE);
    expect(copy.defId).toBe(SHREDDER);
    s.expectStats(copy, { attack: 8, maxHealth: 10 });
    expect(copy.vanilla).toBe(true);
  });

  it("R81 the base face declares a Human-only pick and the radiant face declares any unit", () => {
    // The pick travels in the play action, so the narrowing lives in the declaration `legalActions`
    // and R90 read — not in the hook. This is the only place the base/radiant difference exists.
    expect(base.targets).toEqual([
      { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit"], tags: ["Human"] } },
    ]);
    expect(radiant.targets).toEqual([
      { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit"] } },
    ]);
  });

  it("R90 a Human-only declaration refuses a non-Human pick", () => {
    const s = scenario({
      p1: { hand: [POSTDOC], mana: 4 },
      p2: { field: [SHREDDER] },
    });
    const shredder = s.card(SHREDDER);

    expect(() => s.play(POSTDOC, { targets: [sel(shredder)] })).toThrow(/Human|not a legal|option/i);
  });

  it("§8 Conventions a Cry with no legal target fizzles and the unit still enters", () => {
    const s = scenario({ p1: { hand: [POSTDOC], mana: 4 }, p2: {} });

    s.play(POSTDOC);

    s.expectInZone(POSTDOC, "field");
    expect(s.unit("p1", COPY_LANE)).toBeNull();
  });
});
