// #54 Straaza (SPEC §8.3, §5.1, §6.3 Add to hand; R4, R60, R65, R78, R215, R275).
// BUILD M4-T4 row 54: "2 random units of cost 3 or 4, no tokens, not #54, cost override 1; radiant
// Radiant units at 0".
//   Base:    "Cry: add 2 random Units costing 3 or 4 to your hand; they cost 1"
//   Radiant: "Cry: add 2 random Radiant Units costing 3 or 4 to your hand; they cost 0" — the same
//            pool, the cards Radiant as they are made (R275).
// R215: the price is the card's price in the hand, so a card the full hand burns reaches the
// graveyard without it — Radiant still, on the radiant face, since that flag is set as it is made.

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import { scenario, type Scenario } from "./_harness";
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

/** The one card a full hand burned (§2.4, R4), read back where it landed. */
function burnedCard(s: Scenario): CardInstance {
  const burned = s.events.filter((event) => event.type === "burned");
  expect(burned).toHaveLength(1);
  const event = burned[0];
  if (event?.type !== "burned") throw new Error("expected a burned event");
  const card = s.card(event.instanceId);
  s.expectInZone(card, "graveyard");
  expect(s.pile("p1", "graveyard").map((entry) => entry.id)).toEqual([card.id]);
  return card;
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

  it("R4, R215 a full hand burns the extra: nine other cards leave room for one", () => {
    const s = scenario({ seed: "straaza-cap", p1: { hand: ["core-054", ...FILLER] } });
    const before = new Set(s.hand("p1").map((card) => card.id));

    s.play("core-054");

    // Straaza left the hand for the field, so nine cards had ten slots: one add lands, one burns.
    expect(s.hand("p1")).toHaveLength(10);
    expect(s.pile("p1", "graveyard")).toHaveLength(1);
    s.expectEvents("addedToHand", "burned");

    // R215: "they cost 1" is the card's price in the hand, so the card that landed has it and the
    // burned one, which never reached the hand, lies in the graveyard without it.
    const kept = s.hand("p1").filter((card) => !before.has(card.id));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.costOverride).toBe(1);
    const burned = burnedCard(s);
    expect(POOL_IDS).toContain(burned.defId);
    expect(burned.radiant).toBe(false);
    expect(burned.costOverride).toBeUndefined();
  });
});

/** A Radiant Straaza in hand, with nothing else to do (the §5.2 flag, seeded by the harness). */
function radiantStraaza(seed: string, hand: readonly string[] = []): Scenario {
  return scenario({ seed, p1: { hand: [{ def: "core-054", radiant: true }, ...hand] } });
}

describe("#54 Straaza — radiant", () => {
  it("R275 adds 2 Radiant Units costing 3 or 4, each costing 0", () => {
    const s = radiantStraaza("straaza-radiant");

    s.play("core-054");

    const cards = added(s.hand("p1"));
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.radiant).toBe(true);
      expect(card.costOverride).toBe(0);
      expect(POOL_IDS).toContain(card.defId);
    }
    s.expectEvents("cardPlayed", "addedToHand", "addedToHand");
  });

  it("§5.2 the view shows each one's Radiant face, at 0 mana", () => {
    const s = radiantStraaza("straaza-radiant-view");

    s.play("core-054");

    const hand = s.view("p1").you.hand;
    if (!Array.isArray(hand)) throw new Error("the viewer's own hand should be cards, not a count");
    const shown = hand.filter((card) => card.defId !== "core-054");
    expect(shown).toHaveLength(2);
    for (const card of shown) {
      expect(card.radiant).toBe(true);
      expect(card.cost).toBe(0);
      // R243: a Unit in its owner's hand shows its Radiant face's printed stats.
      const face = cardDef(card.defId).radiant;
      expect(card.attack).toBe(face.attack);
    }
  });

  it("R275 the pool is the base clause's: still 2, still Units costing 3 or 4, still not #54", () => {
    const s = radiantStraaza("straaza-radiant");

    s.play("core-054");

    const defIds = added(s.hand("p1")).map((card) => card.defId);
    expect(defIds).toHaveLength(2);
    expect(defIds).not.toContain("core-054");
    for (const id of defIds) {
      expect(catalog.cost(cardDef(id))).toBeGreaterThanOrEqual(3);
      expect(catalog.cost(cardDef(id))).toBeLessThanOrEqual(4);
    }
  });

  it("R65/R78 the 0 is paid: a Radiant card it made is played for nothing", () => {
    const s = radiantStraaza("straaza-radiant-play");

    s.play("core-054");
    const made = added(s.hand("p1"))[0];
    if (made === undefined) throw new Error("Straaza should have added a card");
    s.expectMana("p1", 0);

    s.play(made);

    s.expectMana("p1", 0).expectInZone(made, "field");
    expect(s.card(made).radiant).toBe(true);
  });

  it("§5.2 the radiant body is a 16/16", () => {
    const s = radiantStraaza("straaza-radiant");

    s.play("core-054");

    s.expectStats("core-054", { attack: 16, health: 16, maxHealth: 16 });
  });

  it("R4, R215 a full hand burns the extra on the radiant face too: Radiant, and without the 0", () => {
    const s = radiantStraaza("straaza-radiant-cap", FILLER);
    const before = new Set(s.hand("p1").map((card) => card.id));

    s.play("core-054");

    expect(s.hand("p1")).toHaveLength(10);
    expect(s.pile("p1", "graveyard")).toHaveLength(1);
    const kept = s.hand("p1").filter((card) => !before.has(card.id));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.radiant).toBe(true);
    expect(kept[0]?.costOverride).toBe(0);

    // R215: the 0 is the card's price in the hand, and the burned card never reached one, so it
    // lies in the graveyard at its printed price; the Radiant flag was set as it was made (§5.2,
    // R74) and R215 keeps it there.
    const burned = burnedCard(s);
    expect(POOL_IDS).toContain(burned.defId);
    expect(burned.radiant).toBe(true);
    expect(burned.costOverride).toBeUndefined();
  });
});
