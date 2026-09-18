// #63 Plastic Surgery — SPEC §8.3, BUILD M4-T4 row 63.
//
// Must-pass: "+3/+3 and one pool keyword the unit lacks (R21); radiant +6/+6 and two distinct
// keywords."

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
// R21's pool as a constant, so this test never restates the eleven keywords (SPEC §6.1).
import { RANDOM_KEYWORD_POOL } from "@jackioh/engine/config";
import type { KeywordKind, Selection } from "@jackioh/shared";
import { scenario } from "./_harness";

const SURGERY = "core-063"; // Spell, 1
const FELINOR = "core-t-felinor"; // 1/1 with no keywords at all: a clean slate for the grant
const TIMMY = "core-011"; // 3/3 with Rush and First Strike, both in the pool
const MENACE = "core-019"; // 9/9 with Taunt, in the pool

/** R21's pool as keyword KINDS: "Armor 1" is its one numbered entry (§6.1). */
const POOL_KINDS: KeywordKind[] = RANDOM_KEYWORD_POOL.map((entry) =>
  entry === "Armor 1" ? "Armor" : (entry as KeywordKind),
);

function sel(card: CardInstance): Selection {
  return { pick: "instance", instanceId: card.id };
}

function grantedKinds(card: CardInstance): KeywordKind[] {
  return card.grantedKeywords.map((keyword) => keyword.kind);
}

describe("#63 Plastic Surgery", () => {
  it("gives the target +3/+3 and one keyword from R21's pool", () => {
    const s = scenario({ p1: { hand: [SURGERY], field: [FELINOR], mana: 4 } });
    const felinor = s.card(FELINOR);

    s.play(SURGERY, { targets: [sel(felinor)] });

    s.expectStats(felinor, { attack: 4, maxHealth: 4 });
    const kinds = grantedKinds(s.card(felinor));
    expect(kinds).toHaveLength(1);
    expect(POOL_KINDS).toContain(kinds[0]);
    s.expectEvents("cardPlayed", "buffed", "keywordGranted");
  });

  it("buffs a unit on either side", () => {
    const s = scenario({ p1: { hand: [SURGERY], mana: 4 }, p2: { field: [FELINOR] } });
    const felinor = s.card(FELINOR);

    s.play(SURGERY, { targets: [sel(felinor)] });

    s.expectStats(felinor, { attack: 4, maxHealth: 4 });
  });

  it("R19 the buff raises max health, so a damaged unit keeps its damage", () => {
    const s = scenario({ p1: { hand: [SURGERY], field: [{ def: MENACE, damage: 4 }], mana: 4 } });
    const menace = s.card(MENACE);
    s.expectStats(menace, { attack: 9, maxHealth: 9, health: 5 });

    s.play(SURGERY, { targets: [sel(menace)] });

    s.expectStats(menace, { attack: 12, maxHealth: 12, health: 8 });
  });

  it("R21 never grants a keyword the unit already has", () => {
    const s = scenario({ p1: { hand: [SURGERY], field: [MENACE], mana: 4 } });
    const menace = s.card(MENACE);

    s.play(SURGERY, { targets: [sel(menace)] });

    // Taunt is printed on #19 and is in the pool, so the one draw cannot be Taunt.
    expect(grantedKinds(s.card(menace))).not.toContain("Taunt");
  });

  it("R21 radiant gives +6/+6 and two distinct keywords", () => {
    const s = scenario({ p1: { hand: [{ def: SURGERY, radiant: true }], field: [FELINOR], mana: 4 } });
    const felinor = s.card(FELINOR);

    s.play(SURGERY, { targets: [sel(felinor)] });

    s.expectStats(felinor, { attack: 7, maxHealth: 7 });
    const kinds = grantedKinds(s.card(felinor));
    expect(kinds).toHaveLength(2);
    expect(new Set(kinds).size).toBe(2);
    for (const kind of kinds) expect(POOL_KINDS).toContain(kind);
  });

  it("R21 radiant's two keywords avoid the ones the unit already has", () => {
    const s = scenario({ p1: { hand: [{ def: SURGERY, radiant: true }], field: [TIMMY], mana: 4 } });
    const timmy = s.card(TIMMY);

    s.play(SURGERY, { targets: [sel(timmy)] });

    const kinds = grantedKinds(s.card(timmy));
    expect(kinds).toHaveLength(2);
    expect(kinds).not.toContain("Rush");
    expect(kinds).not.toContain("First Strike");
  });

  it("§9.3 the same seed draws the same keywords", () => {
    const run = (): KeywordKind[] => {
      const s = scenario({ seed: "surgery-63", p1: { hand: [SURGERY], field: [FELINOR], mana: 4 } });
      const felinor = s.card(FELINOR);
      s.play(SURGERY, { targets: [sel(felinor)] });
      return grantedKinds(s.card(felinor));
    };

    expect(run()).toEqual(run());
  });

  it("§8 Conventions no target means the spell fizzles and still counts as played", () => {
    const s = scenario({ p1: { hand: [SURGERY], mana: 4 }, p2: {} });

    s.play(SURGERY);

    s.expectInZone(SURGERY, "graveyard");
    s.expectEvents("cardPlayed", "enteredGraveyard");
  });
});
