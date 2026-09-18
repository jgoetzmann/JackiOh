// #92 Felinor Fiender (SPEC §8 row 92, §3.2, §10.4 layer 2; R13, R39, R92).
//
// BUILD M4-T4 row 92: "Plays onto an occupied zone; card beneath is dormant; stats = printed + all
// your Felinors including dormant ones (R13, R39); radiant Charge".
//
// §8: printed 5/7 → 10/14, keywords Stack → Stack + Charge, text "Stack. Stats = printed plus the
// combined stats of all your Felinors, including ones under a Stack" and radiant "Stack, Charge;
// same". So the stat rule is identical on both faces and only the printed numbers and the keyword
// list move — which is what the two `describe` blocks below check separately (CLAUDE.md rule 6).
//
// R39 is the decided reading: "printed plus the combined Felinor stats, NEVER BELOW PRINTED". The
// floor is per sum, so "no Felinors at all" is the reachable boundary of the never clause and the
// first test below is it. A NEGATIVE total is unreachable with the Core set as it stands: only an
// aura (§10.4 layer 5) subtracts stats (#46 Suppressive Aura, #65.1 Spikey Pillow) and layer 2
// reads layer 4, so no card can hand a Felinor a negative permanent buff. Reported, not asserted.
//
// §10.4's wording — "Felinor Fiender adds the sum of your Felinors' LAYER-4 stats" — is the sharp
// part, and the Spikey Pillow test is what pins it: a Felinor whose aura-reduced attack differs
// from its buffed attack must contribute the buffed one.
//
// SPEC §8 TAGS #92 `Human`, NOT `Felinor` (flagged to the designer as possibly wrong for a card
// called Felinor Fiender). These tests assert what §8 actually says: a second Fiender contributes
// nothing, because neither is one of "your Felinors".

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";
import { cardDef } from "../src/catalog-data";

const FIENDER = "core-092";
/** #43 Big Felinor, 3/10, tagged Felinor — a Cry that never fires from a `field` setup (R1). */
const BIG_FELINOR = "core-043";
/** The shared Felinor Token, 1/1 (§7). */
const FELINOR_TOKEN = "core-t-felinor";
/** #65.1 Spikey Pillow: "your units have −2 attack" as an aura, i.e. §10.4 layer 5. */
const SPIKEY_PILLOW = "core-065-1";
/**
 * #44 True Strike: 4 damage to a target, for killing a Felinor mid-turn. (#35 Lunar Eclipse would
 * read more naturally at 3 damage, but its script throws — see the report.)
 */
const TRUE_STRIKE = "core-044";

function keywordKinds(s: Scenario, card: string): string[] {
  return s.stats(card).keywords.map((keyword) => keyword.kind);
}

// =============================================================================================
// base
// =============================================================================================

describe("#92 Felinor Fiender — base", () => {
  it("R39 with no Felinors it is exactly its printed 5/7 (the never-below-printed floor)", () => {
    const s = scenario({
      seed: "core-092-alone",
      p1: { field: [FIENDER], hand: ["core-005"] },
      p2: { hand: ["core-005"] },
    });

    s.expectStats(FIENDER, { attack: 5, maxHealth: 7, health: 7 });
    expect(cardDef(FIENDER).base.attack).toBe(5);
  });

  it("R39 printed plus one Big Felinor's 3/10 is 8/17", () => {
    const s = scenario({
      seed: "core-092-one-felinor",
      p1: { field: [FIENDER, BIG_FELINOR], hand: ["core-005"] },
      p2: { hand: ["core-005"] },
    });

    s.expectStats(FIENDER, { attack: 8, maxHealth: 17, health: 17 });
    // The Felinor itself is untouched: the sum is one-way.
    s.expectStats(BIG_FELINOR, { attack: 3, maxHealth: 10 });
  });

  it("R39 the sum is over ALL your Felinors: 3/10 plus 1/1 makes it 9/18", () => {
    const s = scenario({
      seed: "core-092-two-felinors",
      p1: { field: [FIENDER, BIG_FELINOR, FELINOR_TOKEN], hand: ["core-005"] },
      p2: { hand: ["core-005"] },
    });

    s.expectStats(FIENDER, { attack: 9, maxHealth: 18 });
  });

  it('"YOUR Felinors": the enemy\'s Felinors are not counted', () => {
    const s = scenario({
      seed: "core-092-enemy-felinors",
      p1: { field: [FIENDER], hand: ["core-005"] },
      p2: { field: [BIG_FELINOR, FELINOR_TOKEN], hand: ["core-005"] },
    });

    s.expectStats(FIENDER, { attack: 5, maxHealth: 7 });
  });

  it("§8 tags it Human, so a second Fiender adds nothing to either of them", () => {
    const s = scenario({
      seed: "core-092-two-fienders",
      p1: { field: [FIENDER, FIENDER], hand: ["core-005"] },
      p2: { hand: ["core-005"] },
    });
    const first = s.unit("p1", 1);
    const second = s.unit("p1", 2);

    expect(cardDef(FIENDER).tags).toContain("Human");
    expect(cardDef(FIENDER).tags).not.toContain("Felinor");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first !== null) s.expectStats(first, { attack: 5, maxHealth: 7 });
    if (second !== null) s.expectStats(second, { attack: 5, maxHealth: 7 });
  });

  it("§10.4 layer 4 is MAX health, so a damaged Felinor contributes its full 10", () => {
    const s = scenario({
      seed: "core-092-damaged-felinor",
      p1: { field: [FIENDER, { def: BIG_FELINOR, damage: 7 }], hand: ["core-005"] },
      p2: { hand: ["core-005"] },
    });

    // The Felinor is at 3 health of 10; the Fiender still gains 10.
    s.expectStats(BIG_FELINOR, { health: 3, maxHealth: 10 });
    s.expectStats(FIENDER, { attack: 8, maxHealth: 17, health: 17 });
  });

  it("§10.4 layer 2 reads each Felinor's LAYER-4 stats, before auras", () => {
    // A Spikey Pillow's aura is layer 5: it takes the Big Felinor's attack from 3 to 1 and the
    // Fiender's own total by 2. Layer 2 must still add the Felinor's 3, giving 5 + 3 − 2 = 6.
    // An implementation that summed `unitView` (layer 5) would read 5 + 1 − 2 = 4.
    const s = scenario({
      seed: "core-092-aura-layers",
      p1: { field: [FIENDER, BIG_FELINOR, SPIKEY_PILLOW], hand: ["core-005"] },
      p2: { hand: ["core-005"] },
    });

    s.expectStats(BIG_FELINOR, { attack: 1, maxHealth: 10 });
    s.expectStats(FIENDER, { attack: 6, maxHealth: 17 });
  });

  it("the set-stat layer is recomputed continuously: a Felinor leaving drops the bonus at once", () => {
    const s = scenario({
      seed: "core-092-recompute",
      p1: { field: [FIENDER, FELINOR_TOKEN], hand: [TRUE_STRIKE, "core-005"] },
      p2: { hand: ["core-005"] },
    });
    const token = s.unit("p1", 2);
    expect(token?.defId).toBe(FELINOR_TOKEN);
    s.expectStats(FIENDER, { attack: 6, maxHealth: 8 });

    // 4 damage kills the 1/1 token, which — being a unit token — ceases to exist (R11).
    s.play(TRUE_STRIKE, { targets: [{ pick: "instance", instanceId: token?.id ?? "" }] });

    if (token !== null) s.expectInZone(token, "gone");
    s.expectStats(FIENDER, { attack: 5, maxHealth: 7 });
  });

  it("the bonus follows a Felinor arriving mid-turn too", () => {
    const s = scenario({
      seed: "core-092-arrival",
      p1: { field: [FIENDER], hand: [FELINOR_TOKEN, "core-005"] },
      p2: { hand: ["core-005"] },
    });
    s.expectStats(FIENDER, { attack: 5, maxHealth: 7 });

    s.play(FELINOR_TOKEN);

    s.expectStats(FIENDER, { attack: 6, maxHealth: 8 });
  });

  it("§8 the base face prints Stack and no Charge", () => {
    const s = scenario({
      seed: "core-092-keywords-base",
      p1: { field: [FIENDER], hand: ["core-005"] },
      p2: { hand: ["core-005"] },
    });

    expect(keywordKinds(s, FIENDER)).toContain("Stack");
    expect(keywordKinds(s, FIENDER)).not.toContain("Charge");
  });
});

// =============================================================================================
// §3.2 Stack — the dormancy rule this card exists for (R13, R92)
// =============================================================================================

describe("#92 Felinor Fiender — §3.2 Stack", () => {
  it("§3.2 Stack: it plays onto an OCCUPIED unit zone and becomes the top of the pile", () => {
    const s = scenario({
      seed: "core-092-stack-play",
      p1: { field: [BIG_FELINOR], hand: [FIENDER, "core-005"] },
      p2: { hand: ["core-005"] },
    });

    s.play(FIENDER, { zone: 1 });

    // The pile is ordered top-first; the card beneath keeps its place and stops acting.
    expect(s.state.players.p1.units[0]?.map((card) => card.defId)).toEqual([FIENDER, BIG_FELINOR]);
    expect(s.unit("p1", 1)?.defId).toBe(FIENDER);
  });

  it("R13 a Felinor DORMANT under the Stack still counts — the one dormancy exception", () => {
    const s = scenario({
      seed: "core-092-stack-count",
      p1: { field: [BIG_FELINOR], hand: [FIENDER, "core-005"] },
      p2: { hand: ["core-005"] },
    });

    s.play(FIENDER, { zone: 1 });

    // 5 + 3 / 7 + 10, read off the Felinor nobody else on the board can see or target.
    s.expectStats(FIENDER, { attack: 8, maxHealth: 17 });
  });

  it("R92 the dormant card under the Stack has no position and cannot be switched", () => {
    const s = scenario({
      seed: "core-092-stack-position",
      p1: { field: [BIG_FELINOR], hand: [FIENDER, "core-005"] },
      p2: { hand: ["core-005"] },
    });

    s.play(FIENDER, { zone: 1 });
    const dormant = s.state.players.p1.units[0]?.[1];
    expect(dormant?.defId).toBe(BIG_FELINOR);

    expect(() => s.switchPosition(dormant?.id ?? "")).toThrow(/not on the field/);
    // The top of the pile switches normally.
    s.switchPosition(FIENDER);
    expect(s.stats(FIENDER).position).toBe("DEF");
  });

  it("R13 the card beneath is dormant: still on the field, keeping its damage, and not acting", () => {
    const s = scenario({
      seed: "core-092-stack-dormant",
      p1: { field: [{ def: BIG_FELINOR, damage: 4 }], hand: [FIENDER, "core-005"] },
      p2: { hand: ["core-005"] },
    });
    const felinor = s.unit("p1", 1);

    s.play(FIENDER, { zone: 1 });

    // The Fiender's own health is its own: the dormant card's 4 damage stays on the dormant card.
    s.expectStats(FIENDER, { attack: 8, maxHealth: 17, health: 17 });
    const dormant = s.state.players.p1.units[0]?.[1];
    expect(dormant?.id).toBe(felinor?.id);
    expect(dormant?.damage).toBe(4);
    // §3.2: only the top of the pile is the acting card, and the pile is still one field zone.
    expect(s.unit("p1", 1)?.defId).toBe(FIENDER);
    if (dormant !== undefined) s.expectInZone(dormant, "field");
  });
});

// =============================================================================================
// radiant
// =============================================================================================

describe("#92 Felinor Fiender — radiant", () => {
  it("§8 radiant prints 10/14 and, with no Felinors, is exactly that (R39)", () => {
    const s = scenario({
      seed: "core-092-radiant-alone",
      p1: { field: [{ def: FIENDER, radiant: true }], hand: ["core-005"] },
      p2: { hand: ["core-005"] },
    });

    s.expectStats(FIENDER, { attack: 10, maxHealth: 14, health: 14 });
  });

  it('"same": the radiant face runs the identical stat rule, so 10/14 + 3/10 is 13/24', () => {
    const s = scenario({
      seed: "core-092-radiant-sum",
      p1: { field: [{ def: FIENDER, radiant: true }, BIG_FELINOR, FELINOR_TOKEN], hand: ["core-005"] },
      p2: { hand: ["core-005"] },
    });

    // 10 + 3 + 1 / 14 + 10 + 1.
    s.expectStats(FIENDER, { attack: 14, maxHealth: 25 });
  });

  it("§8 radiant keyword list is Stack AND Charge", () => {
    const s = scenario({
      seed: "core-092-radiant-keywords",
      p1: { field: [{ def: FIENDER, radiant: true }], hand: ["core-005"] },
      p2: { hand: ["core-005"] },
    });

    expect(keywordKinds(s, FIENDER)).toContain("Stack");
    expect(keywordKinds(s, FIENDER)).toContain("Charge");
  });

  it("radiant Charge lets it attack the turn it is played, and it hits for its computed attack", () => {
    const s = scenario({
      seed: "core-092-radiant-charge",
      p1: { field: [BIG_FELINOR], hand: [{ def: FIENDER, radiant: true }, "core-005"] },
      p2: { hand: ["core-005"] },
    });

    // Lane 2 is free, so this is an ordinary summon — the Stack play is exercised above.
    s.play(FIENDER, { zone: 2 });
    const fiender = s.unit("p1", 2);
    expect(fiender?.defId).toBe(FIENDER);
    // 10 + 3 attack while the Big Felinor stands beside it.
    s.expectStats(FIENDER, { attack: 13, maxHealth: 24 });

    s.attack(FIENDER, "hero");

    s.expectHealth("p2", 30 - 13);
  });

  it("radiant keeps the enemy-Felinor exclusion too", () => {
    const s = scenario({
      seed: "core-092-radiant-enemy",
      p1: { field: [{ def: FIENDER, radiant: true }], hand: ["core-005"] },
      p2: { field: [BIG_FELINOR], hand: ["core-005"] },
    });

    s.expectStats(FIENDER, { attack: 10, maxHealth: 14 });
  });

  it("R13 radiant counts dormant Felinors as well (the rule is unchanged by the face)", () => {
    const s = scenario({
      seed: "core-092-radiant-stack",
      p1: { field: [BIG_FELINOR], hand: [{ def: FIENDER, radiant: true }, "core-005"] },
      p2: { hand: ["core-005"] },
    });

    s.play(FIENDER, { zone: 1 });

    s.expectStats(FIENDER, { attack: 13, maxHealth: 24 });
  });
});
