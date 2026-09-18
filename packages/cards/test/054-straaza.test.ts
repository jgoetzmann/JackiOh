// #54 Straaza (SPEC §8.3, §5.1, §6.3 Add to hand; R4, R60, R65, R78).
// BUILD M4-T4 row 54: "2 random units of cost 3 or 4, no tokens, not #54, cost override 1;
// radiant 0".

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import { scenario } from "./_harness";
import { catalog, pool } from "../src/query";
import { cardDef } from "../src/catalog-data";

/** §5.1's pool for this card, which is what the script passes to the effect: the legal answers. */
const STRAAZA_POOL = pool("54", { type: "Unit", costRange: { min: 3, max: 4 } });
const POOL_IDS = STRAAZA_POOL.map((def) => def.id);

/** Nine cards to sit beside Straaza in a full hand (HAND_CAP 10), none of them Straaza. */
const FILLER = [
  "core-001",
  "core-002",
  "core-003",
  "core-004",
  "core-005",
  "core-006",
  "core-007",
  "core-008",
  "core-009",
];

function added(hand: readonly CardInstance[]): CardInstance[] {
  return hand.filter((card) => card.defId !== "core-054");
}

describe("#54 Straaza — the pool itself (§5.1)", () => {
  it("§5.1 holds only Units costing 3 or 4, no tokens, and never Straaza herself", () => {
    expect(POOL_IDS.length).toBeGreaterThan(2);
    expect(POOL_IDS).not.toContain("core-054");
    for (const def of STRAAZA_POOL) {
      expect(def.type).toBe("Unit");
      expect(def.token).toBe(false);
      expect(def.tags).not.toContain("Token");
      // R65: the cost is read out of play, so an X-cost card reads 0 and an embiggen card its base.
      expect(catalog.cost(def)).toBeGreaterThanOrEqual(3);
      expect(catalog.cost(def)).toBeLessThanOrEqual(4);
    }
    // The 1-cost unit tokens (Sheep, Rush, Felinor, Spikey Pillow) are out twice over.
    expect(POOL_IDS).not.toContain("core-t-rush");
    expect(POOL_IDS).not.toContain("core-t-sheep");
  });
});

describe("#54 Straaza — base", () => {
  it("adds 2 random Units costing 3 or 4 to your hand", () => {
    const s = scenario({ seed: "straaza-base", p1: { hand: ["core-054"] } });

    s.play("core-054");

    const cards = added(s.hand("p1"));
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(POOL_IDS).toContain(card.defId);
      const def = cardDef(card.defId);
      expect(def.type).toBe("Unit");
      expect(catalog.cost(def)).toBeGreaterThanOrEqual(3);
      expect(catalog.cost(def)).toBeLessThanOrEqual(4);
    }
    s.expectInZone("core-054", "field").expectEvents("cardPlayed", "addedToHand", "addedToHand");
  });

  it("R65/R78 they cost 1: a `costOverride` on each created instance, kept in every zone", () => {
    const s = scenario({ seed: "straaza-base", p1: { hand: ["core-054"] } });

    s.play("core-054");

    for (const card of added(s.hand("p1"))) expect(card.costOverride).toBe(1);
  });

  it("§9.3 the picks come from the seeded rng, so the same seed gives the same two cards", () => {
    const ids = (seed: string): string[] => {
      const s = scenario({ seed, p1: { hand: ["core-054"] } });
      s.play("core-054");
      return added(s.hand("p1")).map((card) => card.defId);
    };

    expect(ids("straaza-replay")).toEqual(ids("straaza-replay"));
  });

  it("R60 the two picks may repeat: nothing here asks for different cards", () => {
    // Both cards come out of the same pool with replacement, so a pair of the same def is legal —
    // this test pins the reading, not a particular seed: whatever comes out, it is in the pool.
    const s = scenario({ seed: "straaza-repeat", p1: { hand: ["core-054"] } });

    s.play("core-054");

    const defIds = added(s.hand("p1")).map((card) => card.defId);
    expect(defIds).toHaveLength(2);
    expect(defIds.every((id) => POOL_IDS.includes(id))).toBe(true);
  });

  it("R4 a full hand burns the extra: nine other cards leave room for one", () => {
    const s = scenario({ seed: "straaza-cap", p1: { hand: ["core-054", ...FILLER] } });

    s.play("core-054");

    // Straaza left the hand for the field, so nine cards had ten slots: one add lands, one burns.
    expect(s.hand("p1")).toHaveLength(10);
    expect(s.pile("p1", "graveyard")).toHaveLength(1);
    s.expectEvents("addedToHand", "burned");
  });
});

describe("#54 Straaza — radiant", () => {
  it("§8 Conventions: the restated clause replaces only the price, so they cost 0", () => {
    const s = scenario({ seed: "straaza-radiant", p1: { hand: ["core-054"] } });
    // HARNESS GAP (reported): `SideSetup.hand` takes no `{ def, radiant }` form.
    s.card("core-054").radiant = true;

    s.play("core-054");

    const cards = added(s.hand("p1"));
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.costOverride).toBe(0);
      expect(POOL_IDS).toContain(card.defId);
    }
  });

  it("the rest of the base clause is kept: still 2, still Units costing 3 or 4, still not #54", () => {
    const s = scenario({ seed: "straaza-radiant", p1: { hand: ["core-054"] } });
    s.card("core-054").radiant = true;

    s.play("core-054");

    const defIds = added(s.hand("p1")).map((card) => card.defId);
    expect(defIds).toHaveLength(2);
    expect(defIds).not.toContain("core-054");
    for (const id of defIds) expect(catalog.cost(cardDef(id))).toBeGreaterThanOrEqual(3);
  });

  it("the generated cards are ordinary non-Radiant cards: only the price clause changed", () => {
    const s = scenario({ seed: "straaza-radiant", p1: { hand: ["core-054"] } });
    s.card("core-054").radiant = true;

    s.play("core-054");

    for (const card of added(s.hand("p1"))) expect(card.radiant).toBe(false);
    s.expectStats("core-054", { attack: 16, maxHealth: 16 });
  });
});
