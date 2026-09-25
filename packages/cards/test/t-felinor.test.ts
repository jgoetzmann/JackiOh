// T-felinor Felinor Token (SPEC §7; §3.2, §4.1, §5.1, §6.1, R11, R64, R74, R275). BUILD M4-T4's
// token row: "Vanish on leaving the field; … none in random pools; radiant … Felinor Token 2/2 Rush".
//
// §7 gives this token a Radiant face that is data only: 2/2 with Rush (R275: double the stats, and
// a keyword-only unit — here a unit with none — adds a keyword). The radiant Script is still the
// base Script, so both `describe`s below prove the shared behaviour on each face, and the radiant
// one adds Rush's.
//
// The token's whole point beyond its 1/1 is the Felinor TAG, so the tag is proved twice: as catalog
// data, and through #43 Big Felinor, whose "destroy all non-Felinor units" has to spare it (the same
// tag is what #92 Felinor Fiender's `setStat` counts, R39).

import { describe, expect, it } from "vitest";
import {
  defOf,
  findInstance,
  isUnitToken,
  keywordsOf,
  moveToZone,
  query,
  type CardInstance,
} from "@jackioh/engine";
import { cardDef } from "../src/catalog-data";
import { catalog } from "../src/query";
import { base, def, radiant } from "../src/scripts/t-felinor";
import { scenario, type Scenario } from "./_harness";

const SEED = "t-felinor";
const LANES = [1, 2, 3, 4, 5];

/** #62 Friend of Felinors: "Fill your board with Felinor Tokens" — the token's own summoner. */
const FRIEND_OF_FELINORS = "core-062";
/** #29 GIGA Glowy Jelly Bean, whose radiant face makes every permanent you control Radiant. */
const GIGA = "core-029";
/** #4 Gary is a 1/1 with a Cry and nothing else: inert on a `field` setup. */
const GARY = "core-004";
/** #5 Stockpile: a card in each hand, so §2.5's auto-end stays off the assertions. */
const STOCKPILE = "core-005";

/**
 * Felinor Tokens summoned this turn by a real play — #62 fills p1's empty board with them — so the
 * one in lane 1 is summoning sick (§4.1), facing #4 Gary in p2's lane 1. No Core card summons the
 * token on its Radiant face, so for `radiantFace` a Radiant #29 then turns the fresh tokens Radiant
 * on the field, still on the turn they arrived — the turn on which Rush lets a unit attack a unit
 * and not the hero (§6.1).
 */
function freshFelinorToken(radiantFace: boolean): { s: Scenario; token: CardInstance; gary: CardInstance } {
  const hand = radiantFace
    ? [FRIEND_OF_FELINORS, { def: GIGA, radiant: true }, STOCKPILE]
    : [FRIEND_OF_FELINORS, STOCKPILE];
  // R65's printed prices, read off the catalog: exactly the mana the plays below spend.
  const mana = catalog.cost(cardDef(FRIEND_OF_FELINORS)) + (radiantFace ? catalog.cost(cardDef(GIGA)) : 0);
  const s = scenario({ seed: SEED, p1: { hand, mana }, p2: { field: [GARY], hand: [STOCKPILE] } });

  s.play(FRIEND_OF_FELINORS);
  if (radiantFace) s.play(GIGA);

  const token = s.unit("p1", 1);
  if (token === null || token.defId !== def.id) throw new Error("#62 should have put a Felinor Token in lane 1");
  const gary = s.unit("p2", 1);
  if (gary === null) throw new Error("p2 should have #4 Gary in lane 1");
  // Still p1's turn, so the refusals below are the fresh token's (§4.1), not the turn's.
  expect(s.state.active).toBe("p1");
  expect(s.card(token).radiant).toBe(radiantFace);
  return { s, token, gary };
}

describe("T-felinor Felinor Token (SPEC §7)", () => {
  describe("card data (§7)", () => {
    it("§7 prints a 1-cost Unit/Felinor Token with 1/1, no keywords and no text", () => {
      expect(def.index).toBe("T-felinor");
      expect(def.cost).toBe(1);
      expect(def.type).toBe("Unit");
      expect(def.token).toBe(true);
      expect(def.tags).toContain("Felinor");
      expect(def.tags).toContain("Token");
      expect(def.base.attack).toBe(1);
      expect(def.base.health).toBe(1);
      expect(def.base.keywords).toEqual([]);
      expect(def.base.text).toBe("");
    });

    it("§7 R275 gives the Felinor Token a Radiant face: 2/2 with Rush (BUILD M4-T1)", () => {
      expect(def.radiant.attack).toBe(2);
      expect(def.radiant.health).toBe(2);
      expect(def.radiant.keywords).toEqual([{ kind: "Rush" }]);
      expect(def.base.attack, "and the base face is untouched at 1/1").toBe(1);
      expect(def.base.keywords, "with no keywords").toEqual([]);
    });

    it("§7 needs no script for either face, and the radiant Script is the base Script (R74)", () => {
      expect(base).toEqual({});
      expect(radiant).toBe(base);
    });
  });

  describe("base", () => {
    it("§7 and R64 #62 fills every empty unit zone with 1/1 Felinor Tokens", () => {
      const s = scenario({ seed: SEED, p1: { hand: ["core-062"] } });

      s.play("core-062");

      for (const lane of LANES) {
        const token = s.unit("p1", lane);
        expect(token?.defId, `lane ${lane} should hold a Felinor Token`).toBe(def.id);
        s.expectStats(token as CardInstance, { attack: 1, health: 1, maxHealth: 1 });
        expect(keywordsOf(s.state, token as CardInstance)).toEqual([]);
      }
    });

    it("§7 the Felinor Token carries the Felinor tag, so #43's non-Felinor sweep spares it", () => {
      const s = scenario({
        seed: SEED,
        p1: { hand: ["core-043"], field: ["core-t-felinor", "core-025"] },
        p2: { field: ["core-025"] },
      });
      const token = s.unit("p1", 1) as CardInstance;
      const ally = s.unit("p1", 2) as CardInstance;
      const enemy = s.unit("p2", 1) as CardInstance;
      expect(defOf(s.state, token.defId).tags).toContain("Felinor");

      // Base #43: "Cry: destroy all non-Felinor units on both sides".
      s.play("core-043");

      s.expectInZone(token, "field");
      s.expectStats(token, { attack: 1, health: 1, maxHealth: 1 });
      s.expectInZone(ally, "graveyard");
      s.expectInZone(enemy, "graveyard");
      s.expectInZone("core-043", "field");
    });

    it("R11 a Felinor Token that dies in combat ceases to exist and never reaches a graveyard", () => {
      const s = scenario({ seed: SEED, p1: { field: ["core-t-felinor"] }, p2: { field: ["core-025"] } });
      const token = s.unit("p1", 1) as CardInstance;
      expect(isUnitToken(s.state, token)).toBe(true);

      s.attack(token, s.unit("p2", 1) as CardInstance);

      s.expectEvents("destroyed");
      s.expectInZone(token, "gone");
      // R11: "nothing can reach it again" — the engine's own lookup no longer finds it. (The
      // instance this test holds is a pre-`reduce` snapshot, so its own `zone` is stale; the
      // `gone` tag is asserted below, where `moveToZone` mutates the live instance in place.)
      expect(findInstance(s.state, token.id)).toBeUndefined();
      expect(s.pile("p1", "graveyard")).toEqual([]);
      expect(s.pile("p1", "exile")).toEqual([]);
    });

    it('R11 and §3.2 "Bounce all units clears them": a bounced Felinor Token reaches no hand', () => {
      const s = scenario({ seed: SEED, p1: { field: ["core-t-felinor"] } });
      const token = s.unit("p1", 1) as CardInstance;

      // Called directly so this test holds the instance the engine mutates (`reduce` clones).
      expect(moveToZone(s.state, token, "hand")).toBe("vanished");

      s.expectInZone(token, "gone");
      expect(token.zone.z).toBe("gone");
      expect(s.hand("p1")).toEqual([]);
      expect(s.unit("p1", 1)).toBeNull();
    });

    it("R11 a unit token never enters a graveyard or exile, so a fixture may not put one there", () => {
      expect(() => scenario({ seed: SEED, p1: { graveyard: ["core-t-felinor"] } })).toThrow(/unit token/);
      expect(() => scenario({ seed: SEED, p1: { exile: ["core-t-felinor"] } })).toThrow(/unit token/);
    });

    it("§5.1 and §7 a Felinor pool never offers the token unless it also asks for tokens", () => {
      const ids = (defs: { id: string }[]): string[] => defs.map((entry) => entry.id);

      expect(ids(query({ tags: ["Felinor"] }))).not.toContain(def.id);
      expect(ids(query({ type: "Unit" }))).not.toContain(def.id);
      expect(ids(query({ tags: ["Felinor", "Token"] }))).toContain(def.id);
      expect(ids(query({ token: true }))).toContain(def.id);
      expect(ids(query({ index: "T-felinor" }))).toEqual([def.id]);
    });
  });

  // §7's radiant face is data: R74 sets the flag, and the flag selects the 2/2 Rush face and the same
  // (empty) Script. Every base case holds for a radiant instance, and Rush is added.
  describe("radiant (§7: 2/2, Rush)", () => {
    it("R74 R275 a radiant Felinor Token is a 2/2 with Rush, and keeps the Felinor tag", () => {
      const s = scenario({ seed: SEED, p1: { field: [{ def: "core-t-felinor", radiant: true }] } });
      const token = s.unit("p1", 1) as CardInstance;

      expect(token.radiant).toBe(true);
      s.expectStats(token, { attack: 2, health: 2, maxHealth: 2 });
      expect(keywordsOf(s.state, token)).toEqual([{ kind: "Rush" }]);
      expect(defOf(s.state, token.defId).tags).toContain("Felinor");
    });

    it("R275 Rush (§6.1): summoned this turn, a radiant Felinor Token may attack a unit but not the hero", () => {
      const { s, token, gary } = freshFelinorToken(true);
      expect(keywordsOf(s.state, s.card(token))).toEqual([{ kind: "Rush" }]);

      expect(() => s.attack(token, "hero")).toThrow(/Rush cannot hit the hero on its summon turn/);
      s.attack(token, gary);
      s.expectInZone(gary, "graveyard");
      s.expectStats(token, { attack: 2, health: 1, maxHealth: 2 });
    });

    it("§4.1 the base face has no Rush: summoned this turn, it may attack nothing", () => {
      const { s, token, gary } = freshFelinorToken(false);
      expect(keywordsOf(s.state, s.card(token))).toEqual([]);

      expect(() => s.attack(token, gary)).toThrow(/summoning sick/);
      expect(() => s.attack(token, "hero")).toThrow(/summoning sick/);
    });

    it("§7 a radiant Felinor Token is spared by #43's non-Felinor sweep exactly as the base face is", () => {
      const s = scenario({
        seed: SEED,
        p1: { hand: ["core-043"], field: [{ def: "core-t-felinor", radiant: true }, { def: "core-025" }] },
      });
      const token = s.unit("p1", 1) as CardInstance;
      const ally = s.unit("p1", 2) as CardInstance;

      s.play("core-043");

      s.expectInZone(token, "field");
      s.expectInZone(ally, "graveyard");
    });

    it("R11 a radiant Felinor Token that leaves the field ceases to exist just as the base face does", () => {
      const s = scenario({ seed: SEED, p1: { field: [{ def: "core-t-felinor", radiant: true }] } });
      const token = s.unit("p1", 1) as CardInstance;

      expect(moveToZone(s.state, token, "exile")).toBe("vanished");

      s.expectInZone(token, "gone");
      expect(token.zone.z).toBe("gone");
      expect(s.pile("p1", "exile")).toEqual([]);
    });
  });
});
