// #57 Conjure KY (SPEC §8.3, BUILD M4-T4 row 57: "Pool exactly #31, #51, #82 with repeats allowed;
// radiant 2 base + 2 radiant"). The Engine cell is "KY pool = #31, #51, #82 (no tokens, not #57);
// repeats allowed", so the pool itself is asserted twice: once against §5.1's query directly, and
// once through seeded play.
//
// Rulings proved here: R60 (catalog-generated cards may repeat), R4 (hand cap 10, extras burned),
// R74/§5.2 (a generated Radiant card carries the instance flag), §5.1 (no tokens, never the
// generating card).

import { describe, expect, it } from "vitest";
import { pool, query } from "../src/query";
import { scenario, type Scenario } from "./_harness";

/** The def ids in p1's hand, in hand order. */
function handDefs(g: Scenario): string[] {
  return g.hand("p1").map((card) => card.defId);
}

const KY_POOL = ["core-031", "core-051", "core-082"];

describe("#57 Conjure KY — the pool", () => {
  it("§5.1 the KY pool is exactly #31, #51 and #82", () => {
    expect(pool("57", { tags: ["KY"] }).map((def) => def.id)).toEqual(KY_POOL);
  });

  it("§5.1 the pool never offers the Token-tagged KY card (#51.1) nor #57 itself", () => {
    const ids = pool("57", { tags: ["KY"] }).map((def) => def.id);

    expect(ids).not.toContain("core-051-1");
    expect(ids).not.toContain("core-057");
    // The token is only reachable by naming the token pool, which this card never does.
    expect(query({ tags: ["KY", "Token"] }).map((def) => def.id)).toEqual(["core-051-1"]);
  });
});

describe("#57 Conjure KY — base", () => {
  it("adds 3 random KY cards to your hand", () => {
    const g = scenario({ p1: { hand: ["core-057"] } });

    g.play("core-057");

    expect(handDefs(g)).toHaveLength(3);
    for (const defId of handDefs(g)) expect(KY_POOL).toContain(defId);
    g.expectEvents("cardPlayed", "addedToHand", "addedToHand", "addedToHand");
  });

  it("adds them to the caster's hand and nothing to the opponent's", () => {
    const g = scenario({ p1: { hand: ["core-057"] } });

    g.play("core-057");

    expect(g.hand("p2")).toHaveLength(0);
  });

  it("R60 three picks from a pool of three may repeat: nothing forces them to differ", () => {
    const seeds = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
    const hands = seeds.map((seed) => {
      const g = scenario({ seed, p1: { hand: ["core-057"] } });
      g.play("core-057");
      return handDefs(g);
    });

    // Every hand is 3 cards from the pool, and at least one seed repeats a def — which a
    // "3 different cards" implementation (R60's Discover rule) could never produce.
    for (const hand of hands) expect(hand).toHaveLength(3);
    expect(hands.some((hand) => new Set(hand).size < 3)).toBe(true);
  });

  it("adds no Radiant card on the base face", () => {
    const g = scenario({ p1: { hand: ["core-057"] } });

    g.play("core-057");

    expect(g.hand("p1").map((card) => card.radiant)).toEqual([false, false, false]);
  });

  it("R4 the hand caps at 10 and the extra add is burned to the graveyard", () => {
    const g = scenario({
      p1: {
        // 8 other cards plus Conjure KY: playing it leaves 8, and 3 adds would make 11.
        hand: [
          "core-057",
          "core-005",
          "core-008",
          "core-010",
          "core-011",
          "core-016",
          "core-019",
          "core-020",
          "core-025",
        ],
      },
    });

    g.play("core-057");

    expect(g.hand("p1")).toHaveLength(10);
    g.expectEvents("burned");
  });

  it("§10.5 step 7 the spell itself ends in the graveyard", () => {
    const g = scenario({ p1: { hand: ["core-057"] } });

    g.play("core-057").expectInZone("core-057", "graveyard");
  });
});

describe("#57 Conjure KY — radiant", () => {
  it("adds 2 random plus 2 random Radiant KY cards, the flag on exactly the last two", () => {
    const g = scenario({ p1: { hand: ["core-057"] } });

    // The setup builder takes `radiant` on the field and the backrow only, so a radiant card that
    // has to be PLAYED is flagged on the hand instance (reported as a harness gap).
    g.card("core-057").radiant = true;
    g.play("core-057");

    expect(handDefs(g)).toHaveLength(4);
    for (const defId of handDefs(g)) expect(KY_POOL).toContain(defId);
    expect(g.hand("p1").map((card) => card.radiant)).toEqual([false, false, true, true]);
  });

  it("§8 Conventions: the restated clause replaces the base one, so it is 4 cards and not 7", () => {
    const g = scenario({ p1: { hand: ["core-057"] } });

    g.card("core-057").radiant = true;
    g.play("core-057");

    expect(g.hand("p1")).toHaveLength(4);
  });

  it("R74 the two Radiant adds are the radiant form of a real card, not a separate def", () => {
    const g = scenario({ p1: { hand: ["core-057"] } });

    g.card("core-057").radiant = true;
    g.play("core-057");

    for (const card of g.hand("p1").slice(2)) {
      expect(KY_POOL).toContain(card.defId);
      expect(card.radiant).toBe(true);
    }
  });

  it("R4 the hand cap burns the extras on the radiant face too", () => {
    const g = scenario({
      p1: {
        hand: ["core-057", "core-005", "core-008", "core-010", "core-011", "core-016", "core-019", "core-020"],
      },
    });

    g.card("core-057").radiant = true;
    g.play("core-057");

    expect(g.hand("p1")).toHaveLength(10);
    g.expectEvents("burned");
  });
});
